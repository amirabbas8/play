// Shared timeline: every listener maps the clock onto the same playlist.
// ponytail: tracks without duration use SLOT seconds, so a shorter file goes
// silent until the slot ends and a longer file is cut. Set duration (seconds)
// on a track in playlist.js when you know it.

const EPOCH = Date.UTC(2026, 0, 1);
const SLOT = 240;

function positionAt(nowMs, tracks, epoch, slot) {
  const lengths = tracks.map((track) => {
    const n = Number(track.duration);
    return Number.isFinite(n) && n > 0 ? n : slot;
  });
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (!tracks.length || total <= 0) return null;
  let elapsed = ((nowMs - epoch) / 1000) % total;
  if (elapsed < 0) elapsed += total;
  if (elapsed >= total) elapsed = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (elapsed < lengths[i] || i === tracks.length - 1) {
      return { index: i, offset: Math.min(elapsed, lengths[i]), lengths, total };
    }
    elapsed -= lengths[i];
  }
  return null;
}

function fmt(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { positionAt, EPOCH, SLOT };
}

if (typeof document !== "undefined") {
  const audio = document.getElementById("audio");
  const playButton = document.getElementById("play");
  const titleEl = document.getElementById("title");
  const artistEl = document.getElementById("artist");
  const statusEl = document.getElementById("status");
  const placeEl = document.getElementById("place");
  const barEl = document.getElementById("bar");
  const nextEl = document.getElementById("next");
  const volume = document.getElementById("volume");

  let playing = false;
  let loadedIndex = -1;
  let broken = "";

  audio.volume = Number(volume.value);
  volume.addEventListener("input", () => {
    audio.volume = Number(volume.value);
  });

  function onPlayFail(err) {
    if (err && err.name === "NotAllowedError") {
      playing = false;
      playButton.textContent = "پخش";
    }
  }

  function seekLive(pos) {
    const duration = audio.duration;
    if (Number.isFinite(duration) && pos.offset >= duration - 0.35) return;
    const cap = Number.isFinite(duration) ? duration - 0.25 : pos.offset;
    const target = Math.min(pos.offset, Math.max(0, cap));
    if (Math.abs(audio.currentTime - target) > 0.4) audio.currentTime = target;
  }

  function follow(pos) {
    const track = PLAYLIST[pos.index];
    if (broken === track.url) return;
    const over = loadedIndex === pos.index && Number.isFinite(audio.duration) && pos.offset >= audio.duration - 0.35;

    if (loadedIndex !== pos.index) {
      const index = pos.index;
      loadedIndex = index;
      broken = "";
      audio.src = track.url;
      audio.addEventListener("loadedmetadata", function onMeta() {
        audio.removeEventListener("loadedmetadata", onMeta);
        if (loadedIndex !== index) return;
        const live = positionAt(Date.now(), PLAYLIST, EPOCH, SLOT);
        if (!live || live.index !== index) return;
        seekLive(live);
      });
      const attempt = audio.play();
      if (attempt) attempt.catch(onPlayFail);
      return;
    }

    if (over) {
      if (!audio.paused) audio.pause();
      return;
    }

    if (audio.paused && audio.readyState >= 2) {
      seekLive(pos);
      const attempt = audio.play();
      if (attempt) attempt.catch(onPlayFail);
      return;
    }

    if (!audio.seeking && audio.readyState >= 2 && Math.abs(audio.currentTime - pos.offset) > 5) {
      seekLive(pos);
    }
  }

  function render(pos) {
    const track = PLAYLIST[pos.index];
    const slotLen = pos.lengths[pos.index];
    const over = loadedIndex === pos.index && Number.isFinite(audio.duration) && pos.offset >= audio.duration - 0.35;
    titleEl.textContent = track.title;
    artistEl.textContent = track.artist;
    placeEl.textContent = (pos.index + 1) + " / " + PLAYLIST.length + " · " + fmt(pos.offset) + " / " + fmt(slotLen);
    barEl.style.width = Math.min(100, (pos.offset / slotLen) * 100) + "%";

    if (!playing) statusEl.textContent = "پخش، شما را به همین لحظهٔ مشترک می‌رساند.";
    else if (broken === track.url) statusEl.textContent = "این فایل باز نشد. بعدی تا " + fmt(slotLen - pos.offset);
    else if (over) statusEl.textContent = "این آهنگ تمام شد. بعدی تا " + fmt(slotLen - pos.offset);
    else statusEl.textContent = "زنده";

    nextEl.replaceChildren();
    let wait = slotLen - pos.offset;
    for (let n = 1; n <= 6; n++) {
      const i = (pos.index + n) % PLAYLIST.length;
      const next = PLAYLIST[i];
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = fmt(wait);
      const who = next.artist ? next.artist + " — " : "";
      li.append(time, " " + who + next.title);
      nextEl.append(li);
      wait += pos.lengths[i];
    }
  }

  audio.addEventListener("error", () => {
    if (!audio.error || audio.error.code === 1 || loadedIndex < 0) return;
    broken = PLAYLIST[loadedIndex].url;
  });

  playButton.addEventListener("click", () => {
    if (playing) {
      playing = false;
      audio.pause();
      playButton.textContent = "پخش";
      return;
    }
    playing = true;
    playButton.textContent = "توقف";
    const pos = positionAt(Date.now(), PLAYLIST, EPOCH, SLOT);
    if (pos) follow(pos);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !playing) return;
    const pos = positionAt(Date.now(), PLAYLIST, EPOCH, SLOT);
    if (pos) follow(pos);
  });

  function tick() {
    if (typeof PLAYLIST === "undefined" || !PLAYLIST.length) {
      titleEl.textContent = "فهرست خالی است";
      return;
    }
    const pos = positionAt(Date.now(), PLAYLIST, EPOCH, SLOT);
    if (!pos) return;
    render(pos);
    if (playing) follow(pos);
  }

  setInterval(tick, 500);
  tick();
}
