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

function synchsafe(b, o) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}

// ponytail: plain ID3v2.3/2.4 APIC only. Unsynchronised tags and hosts that
// omit Access-Control-Allow-Origin yield no picture; set track.image to a
// direct image URL to skip the tag.
function coverBytes(tag) {
  if (!tag || tag.length < 10 || tag[0] !== 0x49 || tag[1] !== 0x44 || tag[2] !== 0x33) return null;
  if (tag[5] & 0xc0) return null;
  const ver = tag[3];
  const end = Math.min(tag.length, 10 + synchsafe(tag, 6));
  let i = 10;
  while (i + 10 <= end && tag[i] !== 0) {
    const id = String.fromCharCode(tag[i], tag[i + 1], tag[i + 2], tag[i + 3]);
    const n = ver >= 4 ? synchsafe(tag, i + 4) : ((tag[i + 4] << 24) | (tag[i + 5] << 16) | (tag[i + 6] << 8) | tag[i + 7]);
    const start = i + 10;
    i = start + n;
    if (id !== "APIC" || n < 8 || start + n > tag.length) continue;
    const body = tag.subarray(start, start + n);
    let m = 1;
    while (m < body.length && body[m] !== 0) m++;
    let d = m + 2;
    if (body[0] === 1 || body[0] === 2) {
      while (d + 1 < body.length && !(body[d] === 0 && body[d + 1] === 0)) d += 2;
      d += 2;
    } else {
      while (d < body.length && body[d] !== 0) d++;
      d += 1;
    }
    const img = body.subarray(d);
    if (img.length > 32 && (img[0] === 0xff || img[0] === 0x89 || img[0] === 0x52)) return img;
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { positionAt, EPOCH, SLOT, coverBytes };
  if (require.main === module) {
    const jpeg = [0xff, 0xd8, 0xff, 0xd9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
    const body = [0, 105, 109, 97, 103, 101, 47, 106, 112, 101, 103, 0, 3, 120, 0, ...jpeg];
    const tagSize = 10 + body.length;
    const ss = [(tagSize >> 21) & 127, (tagSize >> 14) & 127, (tagSize >> 7) & 127, tagSize & 127];
    const n = body.length;
    const tag = Uint8Array.from([
      0x49, 0x44, 0x33, 3, 0, 0, ...ss,
      0x41, 0x50, 0x49, 0x43, (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255, 0, 0,
      ...body,
    ]);
    const img = coverBytes(tag);
    if (!img || img[0] !== 0xff || img.length !== jpeg.length) {
      console.error("cover check failed");
      process.exit(1);
    }
  }
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
  const coverEl = document.getElementById("cover");
  const volume = document.getElementById("volume");

  let playing = false;
  let loadedIndex = -1;
  let coverIndex = -1;
  let coverToken = 0;
  let coverBlobUrl = "";
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

  async function coverUrl(url) {
    const headRes = await fetch(url, { headers: { Range: "bytes=0-9" }, referrerPolicy: "no-referrer" });
    if (headRes.status !== 206) return "";
    const head = new Uint8Array(await headRes.arrayBuffer());
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33 || head[5] & 0xc0) return "";
    const size = synchsafe(head, 6);
    if (size < 20 || size > 1500000) return "";
    const tagRes = await fetch(url, { headers: { Range: "bytes=0-" + (size + 9) }, referrerPolicy: "no-referrer" });
    if (tagRes.status !== 206) return "";
    const img = coverBytes(new Uint8Array(await tagRes.arrayBuffer()));
    if (!img) return "";
    const type = img[0] === 0x89 ? "image/png" : img[0] === 0x52 ? "image/webp" : "image/jpeg";
    return URL.createObjectURL(new Blob([img], { type }));
  }

  function showCover(track, index) {
    if (coverIndex === index) return;
    coverIndex = index;
    const token = ++coverToken;
    coverEl.hidden = true;
    coverEl.alt = "";
    if (coverBlobUrl) {
      URL.revokeObjectURL(coverBlobUrl);
      coverBlobUrl = "";
    }
    const job = track.image ? Promise.resolve(track.image) : coverUrl(track.url);
    job.then((src) => {
      if (token !== coverToken || !src) return;
      if (String(src).startsWith("blob:")) coverBlobUrl = src;
      coverEl.alt = track.title || "";
      coverEl.src = src;
      coverEl.hidden = false;
    }).catch(() => {});
  }

  coverEl.addEventListener("error", () => {
    coverEl.hidden = true;
  });

  function render(pos) {
    const track = PLAYLIST[pos.index];
    const slotLen = pos.lengths[pos.index];
    const over = loadedIndex === pos.index && Number.isFinite(audio.duration) && pos.offset >= audio.duration - 0.35;
    titleEl.textContent = track.title;
    artistEl.textContent = track.artist;
    showCover(track, pos.index);
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
