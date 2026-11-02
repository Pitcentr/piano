import { buildLayout, keyCenter, paintKeyboard, renderKeyboard } from "./keyboard.js";
import {
  RANGES,
  buildSequence,
  centsBetween,
  describeFreq,
  etFreq,
  fullName,
  isBlackName,
  midiToName,
  nameToMidi,
  parseNote,
  rangeById,
  ruOctave,
  ruOctaveShort,
  ruStep,
} from "./notes.js";
import { analyze, matchesTarget } from "./pitch.js";
import { SONGS, beatWord, songFigure, songFits, songSpan } from "./songs.js";

const STORAGE_KEY = "piano-lessons-v1";
const LOOKAHEAD = 2.4;
const SCREENS = ["intro", "cal", "songs", "play", "done"];

const $ = (id) => document.getElementById(id);

const state = {
  screen: "intro",
  practice: false,
  calibration: loadCalibration(),
  audio: null,
  noiseFloor: 0.012,
  sensitivity: "4",
  cal: null,
  play: null,
};

const ear = {
  freq: null,
  confidence: 0,
  rms: 0,
  samples: null,
  sampleRate: 48000,
  stableFreq: null,
  stableSince: 0,
  pitchSamples: [],
  history: [],
  matchStreak: 0,
  wrongStreak: 0,
  lastDetect: 0,
};

function loadCalibration() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const range = RANGES.find((item) => item.id === data?.rangeId);
    if (!range || range.start !== data.start || range.end !== data.end || !data.map) return null;
    const needed = buildSequence(data.start, data.end);
    const known = needed.every((name) => Object.prototype.hasOwnProperty.call(data.map, name));
    const count = needed.filter((name) => typeof data.map[name] === "number").length;
    if (!known || count < 8) return null;
    return data;
  } catch {
    return null;
  }
}

function numericCount(map) {
  return Object.values(map).filter((freq) => typeof freq === "number").length;
}

function show(name) {
  state.screen = name;
  document.body.dataset.screen = name;
  for (const screen of SCREENS) $(`screen-${screen}`).hidden = screen !== name;
  if (name === "intro") renderIntro();
}

function renderIntro() {
  const saved = state.calibration;
  $("intro-saved").hidden = !saved;
  $("intro-fresh").hidden = !!saved;
  if (!saved) return;
  const range = rangeById(saved.rangeId);
  const count = numericCount(saved.map);
  $("saved-detail").textContent = `${range.detail}. Записано клавиш: ${count}. Можно сразу выбирать мелодию.`;
}

function showMicError(text) {
  const el = $("mic-error");
  el.hidden = !text;
  el.textContent = text || "";
}

async function enableMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMicError("Этот браузер не отдаёт микрофон странице. Откройте её через localhost.");
    return false;
  }
  if (state.audio) {
    if (state.audio.ctx.state === "suspended") await state.audio.ctx.resume();
    showMicError("");
    return true;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (error) {
      if (error.name !== "OverconstrainedError" && error.name !== "NotSupportedError") throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    if (ctx.state === "suspended") await ctx.resume();
    state.audio = { ctx, analyser, stream, source };
    showMicError("");
    return true;
  } catch (error) {
    ctx.close();
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
    showMicError(
      denied
        ? "Браузер не дал доступ к микрофону. Разрешите его в настройках сайта — значок слева от адреса — и попробуйте снова."
        : "Не удалось открыть микрофон. Проверьте, что он подключён, или репетируйте мышкой.",
    );
    return false;
  }
}

function beginCal() {
  state.practice = false;
  state.cal = {
    phase: "choose",
    rangeId: null,
    start: 0,
    end: 0,
    seq: [],
    map: {},
    index: 0,
    ignoreUntil: 0,
    heard: false,
    layout: null,
    issues: [],
  };
  renderRangeCards();
  show("cal");
  showCalPhase("choose");
}

function renderRangeCards() {
  const root = $("range-cards");
  root.replaceChildren();
  for (const range of RANGES) {
    const count = SONGS.filter((song) => songFits(song, range.start, range.end)).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `range-card${range.recommended ? " recommended" : ""}`;
    button.dataset.action = "range";
    button.dataset.id = range.id;
    const title = document.createElement("strong");
    title.textContent = range.label;
    const detail = document.createElement("p");
    detail.textContent = `${range.detail}. ${range.keys}.`;
    const meta = document.createElement("p");
    meta.textContent = `${count} из ${SONGS.length} мелодий`;
    button.append(title, detail, meta);
    if (range.recommended) {
      const badge = document.createElement("em");
      badge.textContent = "Все мелодии";
      button.append(badge);
    }
    root.append(button);
  }
}

function showCalPhase(phase) {
  state.cal.phase = phase;
  for (const name of ["choose", "listen", "run", "review"]) {
    $(`cal-${name}`).hidden = name !== phase;
  }
  const live = phase === "listen" || phase === "run";
  $("tuner").hidden = !live;
  $("cal-board").hidden = !live;
  $("listen-actions").hidden = phase !== "listen";
  $("stability").hidden = phase !== "run";
  $("tuner").classList.remove("good", "warn");
}

function chooseRange(id) {
  const range = rangeById(id);
  const cal = state.cal;
  cal.rangeId = range.id;
  cal.start = range.start;
  cal.end = range.end;
  cal.seq = buildSequence(range.start, range.end);
  cal.map = {};
  cal.index = 0;
  cal.heard = false;
  cal.layout = buildLayout(range.start, range.end);
  renderKeyboard($("cal-keys"), cal.layout);
  $("listen-next").disabled = true;
  resetStability();
  showCalPhase("listen");
}

function goRun() {
  const cal = state.cal;
  if (cal.index >= cal.seq.length) cal.index = 0;
  cal.ignoreUntil = 0;
  resetStability();
  showCalPhase("run");
  renderCalPrompt();
}

function renderCalPrompt() {
  const cal = state.cal;
  const name = cal.seq[cal.index];
  const black = isBlackName(name);
  const whites = cal.seq.filter((note) => !isBlackName(note)).length;
  const localIndex = black ? cal.index - whites : cal.index;
  const localTotal = black ? cal.seq.length - whites : whites;
  $("cal-kicker").textContent = black ? "Чёрные клавиши" : "Белые клавиши";
  $("cal-step").textContent = `${localIndex + 1} из ${localTotal} · всего ${cal.index + 1} из ${cal.seq.length}`;
  $("cal-ask").textContent = `Нажмите ${fullName(name)}`;
  $("cal-find").hidden = name !== "C4";
  $("cal-bar").style.width = `${(cal.index / cal.seq.length) * 100}%`;
  $("undo").disabled = cal.index === 0;
  paintKeyboard($("cal-keys"), { target: name, done: doneSet() });
}

function doneSet() {
  return new Set(
    Object.entries(state.cal.map)
      .filter(([, freq]) => typeof freq === "number")
      .map(([name]) => name),
  );
}

function expectedFreq(name, map) {
  let sum = 0;
  let count = 0;
  for (const [note, freq] of Object.entries(map)) {
    if (typeof freq !== "number") continue;
    sum += centsBetween(freq, etFreq(nameToMidi(note)));
    count += 1;
  }
  const base = etFreq(nameToMidi(name));
  if (!count) return base;
  return base * 2 ** (sum / count / 1200);
}

function resetStability() {
  ear.stableSince = 0;
  ear.stableFreq = null;
  ear.pitchSamples = [];
}

function medianFreq() {
  const values = ear.pitchSamples;
  if (!values.length) return ear.freq;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trackStability(now) {
  const freq = ear.freq;
  if (!freq || ear.confidence < 0.82) {
    resetStability();
    return 0;
  }
  if (ear.stableFreq && Math.abs(centsBetween(freq, ear.stableFreq)) > 25) {
    ear.stableSince = now;
    ear.stableFreq = freq;
    ear.pitchSamples = [freq];
    return 0;
  }
  if (!ear.stableSince) ear.stableSince = now;
  ear.stableFreq = freq;
  ear.pitchSamples.push(freq);
  if (ear.pitchSamples.length > 12) ear.pitchSamples.shift();
  return Math.min(1, (now - ear.stableSince) / 480);
}

function setStability(amount, mode) {
  $("stability-fill").style.width = `${Math.max(0, Math.min(1, amount)) * 100}%`;
  $("stability").classList.toggle("good", mode === "good");
  $("stability").classList.toggle("warn", mode === "warn");
  $("tuner").classList.toggle("good", mode === "good");
  $("tuner").classList.toggle("warn", mode === "warn");
}

function paintCalTuner() {
  const heard = ear.freq ? describeFreq(ear.freq) : null;
  $("tuner-note").textContent = heard ? ruStep(heard.name) : ear.rms > gate() * 0.45 ? "…" : "Слушаю…";
  $("tuner-hz").textContent = heard ? `${Math.round(heard.freq)} Гц · ${fullName(heard.name)}` : "Жду ноту";
  $("tuner").classList.toggle("is-hot", !!heard);
  paintMeter($("meter"), ear.rms, gate());
}

function updateListen() {
  paintCalTuner();
  const heard = ear.freq ? describeFreq(ear.freq) : null;
  const onBoard = heard && state.cal.layout.byName.has(heard.name) ? heard.name : null;
  paintKeyboard($("cal-keys"), { heard: onBoard });
  if (heard && ear.confidence > 0.8) state.cal.heard = true;
  $("listen-next").disabled = !state.cal.heard;
  $("tuner-hint").textContent = heard
    ? "Микрофон слышит пианино. Можно переходить к клавишам."
    : "Сыграйте любую клавишу в обычной громкости.";
}

function updateRun(now) {
  const cal = state.cal;
  const name = cal.seq[cal.index];
  paintCalTuner();
  const heard = ear.freq ? describeFreq(ear.freq) : null;
  const onBoard = heard && cal.layout.byName.has(heard.name) ? heard.name : null;
  paintKeyboard($("cal-keys"), { target: name, heard: onBoard, done: doneSet() });
  if (now < cal.ignoreUntil) {
    resetStability();
    setStability(0, "");
    $("tuner-hint").textContent = "Записано";
    $("capture").disabled = true;
    return;
  }
  const stability = trackStability(now);
  const freq = medianFreq();
  const expected = expectedFreq(name, cal.map);
  const close = !!(freq && Math.abs(centsBetween(freq, expected)) <= 55);
  const mode = close && stability > 0.2 ? "good" : !close && stability > 0.35 && freq ? "warn" : "";
  setStability(stability, mode);
  const ready = stability >= 0.3 && !!freq;
  const button = $("capture");
  button.disabled = !ready;
  button.textContent = !freq || close ? "Записать клавишу" : "Всё равно записать";
  if (close && stability >= 1) {
    capture(freq);
    return;
  }
  if (!freq) {
    $("tuner-hint").textContent = ear.rms > gate() * 0.55 ? "Чуть ровнее и подольше" : "Сыграйте клавишу и подержите её";
  } else if (!close && stability > 0.35) {
    const about = describeFreq(freq);
    $("tuner-hint").textContent = about
      ? `Слышно ${fullName(about.name)}. Если это точно нужная клавиша — запишите вручную.`
      : "Высота не совпадает с ожидаемой клавишей.";
  } else if (close) {
    $("tuner-hint").textContent = "Держите, полоска заполняется";
  } else {
    $("tuner-hint").textContent = "Слушаю…";
  }
}

function capture(freq) {
  const cal = state.cal;
  if (!cal || cal.phase !== "run" || !freq) return;
  if (performance.now() < cal.ignoreUntil) return;
  cal.ignoreUntil = performance.now() + 560;
  cal.map[cal.seq[cal.index]] = Math.round(freq * 100) / 100;
  cal.index += 1;
  resetStability();
  if (cal.index >= cal.seq.length) finishCal();
  else renderCalPrompt();
}

function undoKey() {
  const cal = state.cal;
  if (!cal || cal.index === 0) return;
  cal.index -= 1;
  delete cal.map[cal.seq[cal.index]];
  cal.ignoreUntil = 0;
  resetStability();
  renderCalPrompt();
}

function skipKey() {
  const cal = state.cal;
  if (!cal || cal.phase !== "run") return;
  cal.map[cal.seq[cal.index]] = null;
  cal.index += 1;
  cal.ignoreUntil = performance.now() + 280;
  resetStability();
  if (cal.index >= cal.seq.length) finishCal();
  else renderCalPrompt();
}

function monotonicIssues(names, map) {
  const issues = [];
  let prev = null;
  for (const name of names) {
    const freq = map[name];
    if (typeof freq !== "number") continue;
    if (prev) {
      const semis = 12 * Math.log2(freq / prev.freq);
      if (semis < 0.55) issues.push({ prev: prev.name, name });
    }
    prev = { name, freq };
  }
  return issues;
}

function finishCal() {
  const cal = state.cal;
  const whites = cal.seq.filter((name) => !isBlackName(name));
  const blacks = cal.seq.filter((name) => isBlackName(name));
  cal.issues = [...monotonicIssues(whites, cal.map), ...monotonicIssues(blacks, cal.map)];
  const saved = persistCal();
  cal.saved = saved;
  renderReview();
  showCalPhase("review");
}

function persistCal() {
  const cal = state.cal;
  if (numericCount(cal.map) < 8) return false;
  const map = {};
  for (const name of cal.seq) map[name] = cal.map[name] ?? null;
  const data = {
    rangeId: cal.rangeId,
    start: cal.start,
    end: cal.end,
    map,
    savedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  state.calibration = data;
  return true;
}

function renderReview() {
  const cal = state.cal;
  const skipped = cal.seq.filter((name) => cal.map[name] == null);
  const issues = cal.issues || [];
  if (cal.saved && !issues.length && !skipped.length) {
    $("review-title").textContent = "Пианино записано";
    $("review-body").textContent = "Все клавиши на месте. Можно выбирать мелодию — палочка покажет, куда нажимать.";
  } else if (!cal.saved) {
    $("review-title").textContent = "Мало клавиш";
    $("review-body").textContent = "Чтобы открыть мелодии, нужно записать хотя бы одну октаву белых клавиш.";
  } else {
    $("review-title").textContent = "Проверьте калибровку";
    $("review-body").textContent = "Часть клавиш звучит не по порядку. Играть уже можно, но эти ноты лучше перезаписать.";
  }
  const list = $("review-issues");
  list.replaceChildren();
  for (const issue of issues.slice(0, 4)) {
    const item = document.createElement("li");
    item.textContent = `${fullName(issue.name)} звучит не выше, чем ${fullName(issue.prev)}. `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-btn";
    button.dataset.action = "redo-from";
    button.dataset.name = issue.name;
    button.textContent = "Исправить отсюда";
    item.append(button);
    list.append(item);
  }
  if (skipped.length) {
    const item = document.createElement("li");
    item.textContent = `Пропущено: ${skipped.map((name) => fullName(name)).join(", ")}. Эти ноты в мелодиях не засчитаются.`;
    list.append(item);
  }
  $("review-songs").hidden = !state.calibration;
}

function redoFrom(name) {
  const cal = state.cal;
  const index = cal.seq.indexOf(name);
  if (index < 0) return;
  for (let i = index; i < cal.seq.length; i++) delete cal.map[cal.seq[i]];
  cal.index = index;
  cal.ignoreUntil = 0;
  resetStability();
  showCalPhase("run");
  renderCalPrompt();
}

function redoAll() {
  const cal = state.cal;
  cal.map = {};
  cal.index = 0;
  cal.ignoreUntil = 0;
  resetStability();
  showCalPhase("run");
  renderCalPrompt();
}

function activeBounds() {
  if (state.practice) return { start: 60, end: 84 };
  return { start: state.calibration.start, end: state.calibration.end };
}

function canPlay(song) {
  const bounds = activeBounds();
  if (!songFits(song, bounds.start, bounds.end)) return false;
  if (state.practice) return true;
  return song.notes.every((note) => typeof state.calibration.map[note] === "number");
}

function lockReason(song) {
  const bounds = activeBounds();
  const span = songSpan(song);
  if (span.low < bounds.start || span.high > bounds.end) {
    const edge = span.high > bounds.end ? span.high : span.low;
    return `Нужна ${fullName(midiToName(edge))}`;
  }
  if (!state.practice) {
    const missing = song.notes.find((note) => typeof state.calibration.map[note] !== "number");
    if (missing) return `Не записана ${fullName(missing)}`;
  }
  return "Пока недоступно";
}

function notesWord(count) {
  const n10 = count % 10;
  const n100 = count % 100;
  if (n10 === 1 && n100 !== 11) return `${count} нота`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${count} ноты`;
  return `${count} нот`;
}

function sparkline(notes) {
  const midis = notes.map(nameToMidi);
  const min = Math.min(...midis);
  const max = Math.max(...midis);
  const width = 180;
  const height = 40;
  const step = notes.length > 1 ? width / (notes.length - 1) : 0;
  const points = midis
    .map((midi, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - 4 - ((midi - min) / (max - min || 1)) * (height - 10)).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points);
  svg.append(line);
  return svg;
}

function openSongs() {
  if (!state.practice && !state.calibration) {
    show("intro");
    return;
  }
  renderSongs();
  show("songs");
}

function renderSongs() {
  $("songs-lead").textContent = state.practice
    ? "Огоньки считают доли. Нажимайте клавишу на экране, когда палочка её касается."
    : "Огоньки считают доли. Нажимайте, когда палочка касается клавиши.";
  const root = $("song-list");
  root.replaceChildren();
  for (const song of SONGS) {
    const open = canPlay(song);
    const card = document.createElement(open ? "button" : "div");
    card.className = `song${open ? "" : " locked"}`;
    card.dataset.level = song.level;
    if (open) {
      card.type = "button";
      card.dataset.action = "play-song";
      card.dataset.id = song.id;
    }
    const level = document.createElement("div");
    level.className = "level";
    level.textContent = song.level;
    const title = document.createElement("h2");
    title.textContent = song.title;
    const about = document.createElement("p");
    about.className = "about";
    about.textContent = song.about;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = open ? notesWord(song.notes.length) : lockReason(song);
    card.append(level, title, about, sparkline(song.notes), meta);
    root.append(card);
  }
}

async function startSong(id) {
  if (!state.practice && !state.audio) {
    const ok = await enableMic();
    if (!ok) {
      show("intro");
      return;
    }
  }
  const song = SONGS.find((item) => item.id === id);
  if (!song || !canPlay(song)) return;
  const bounds = activeBounds();
  const layout = buildLayout(bounds.start, bounds.end);
  renderKeyboard($("play-keys"), layout, { practice: state.practice });
  const figure = songFigure(song);
  const beatMs = 60000 / (song.bpm || 80);
  const meter = song.meter || 4;
  const dues = [];
  let cursor = meter * beatMs;
  for (const step of figure) {
    dues.push(cursor);
    cursor += step.beats * beatMs;
  }
  state.play = {
    song,
    figure,
    dues,
    beatMs,
    meter,
    index: 0,
    mistakes: 0,
    onTime: 0,
    early: 0,
    late: 0,
    anchorReal: performance.now(),
    anchorMusical: 0,
    holding: false,
    heldMusical: 0,
    holdReal: 0,
    badName: null,
    badUntil: 0,
    message: "",
    layout,
    openUntil: 0,
    attackAt: 0,
    wrongLock: 0,
    released: true,
    earlyHold: false,
    sustain: null,
  };
  ear.history = [];
  ear.matchStreak = 0;
  ear.wrongStreak = 0;
  show("play");
  $("play-title").textContent = song.title;
  const countName = meter === 3 ? "три" : "четыре";
  const where = state.practice ? "клавишу на экране" : "клавишу на пианино";
  $("play-mode").textContent =
    `Сначала ${countName} доли без игры. Нажимайте ${where}, когда палочка касается клавиши: она заполняется, пока ноту держат, и вспыхивает, когда её пора отпустить.`;
  $("play-listen").hidden = state.practice;
  $("sens-play").hidden = state.practice;
  $("sticks").replaceChildren();
  showTiming("", "");
  paintSens();
  refreshPlayNote();
}

function refreshPlayNote() {
  const play = state.play;
  const name = play.song.notes[play.index];
  const note = parseNote(name);
  $("hero-name").textContent = ruStep(name);
  $("hero-oct").textContent = ruOctave(note.oct);
  const missing = !state.practice && typeof state.calibration.map[name] !== "number";
  $("hero-msg").textContent = play.message || (missing ? "Эта клавиша не записана. Её можно пропустить." : "");
  $("hero-note").classList.toggle("shake", !!play.message);
  $("play-count").textContent = `${play.index + 1} / ${play.song.notes.length}`;
  $("play-bar").style.width = `${(play.index / play.song.notes.length) * 100}%`;
  $("play-miss").hidden = play.mistakes === 0;
  $("play-miss").textContent = `Мимо: ${play.mistakes}`;
  const list = $("upcoming");
  list.replaceChildren();
  play.song.notes.slice(play.index, play.index + 5).forEach((coming, index) => {
    const item = document.createElement("li");
    if (index === 0) item.className = "now";
    item.textContent = ruStep(coming);
    list.append(item);
  });
  paintKeyboard($("play-keys"), { target: name });
  placeGuide();
}

function placeGuide() {
  const play = state.play;
  if (!play) return;
  const name = play.song.notes[play.index];
  const spot = keyCenter(play.layout, name);
  if (!spot) return;
  const lane = $("lane");
  lane.hidden = false;
  lane.style.left = `${spot.left}%`;
  lane.style.width = `${spot.width}%`;
}

function musicalNow(now) {
  const play = state.play;
  if (play.holding) return play.heldMusical;
  return play.anchorMusical + (now - play.anchorReal);
}

function resumeClock(now, musical) {
  const play = state.play;
  play.holding = false;
  play.anchorReal = now;
  play.anchorMusical = musical;
}

function showTiming(kind, text) {
  const el = $("timing");
  el.textContent = text;
  el.className = kind || "";
}

function beatsUntil(now) {
  const play = state.play;
  return (play.dues[play.index] - musicalNow(now)) / play.beatMs;
}

function inHitWindow(now) {
  return beatsUntil(now) <= 0.7;
}

function advanceNote() {
  const play = state.play;
  play.index += 1;
  play.openUntil = 0;
  play.attackAt = 0;
  play.message = "";
  play.badName = null;
  play.badUntil = 0;
  play.earlyHold = false;
  ear.history = [];
  ear.matchStreak = 0;
  ear.wrongStreak = 0;
  if (play.index >= play.figure.length) {
    finishSong();
    return;
  }
  refreshPlayNote();
}

function finishSong() {
  const play = state.play;
  const clean = play.mistakes === 0 && play.early === 0 && play.late === 0;
  const parts = [];
  if (play.onTime) parts.push(`В такт: ${play.onTime}`);
  if (play.early) parts.push(`Рано: ${play.early}`);
  if (play.late) parts.push(`Поздно: ${play.late}`);
  const miss = play.mistakes === 0 ? "Ни одной мимо клавиши." : `Мимо клавиши: ${play.mistakes}.`;
  $("done-title").textContent = clean ? "Чисто" : "Мелодия сыграна";
  $("done-song").textContent = play.song.title;
  $("done-score").textContent = parts.length ? `${miss} ${parts.join(" · ")}` : miss;
  $("sticks").replaceChildren();
  $("highway").querySelectorAll(".stick-burst").forEach((burst) => burst.remove());
  $("lane").hidden = true;
  showTiming("", "");
  show("done");
}

function beginSustain(now) {
  const play = state.play;
  const beats = play.figure[play.index].beats;
  const from = musicalNow(now);
  const writtenEnd = play.dues[play.index] + beats * play.beatMs;
  play.sustain = {
    index: play.index,
    name: play.figure[play.index].name,
    from,
    until: Math.max(writtenEnd, from + Math.min(play.beatMs * 0.35, beats * play.beatMs)),
  };
}

function burstStick(name) {
  const play = state.play;
  if (!play) return;
  const spot = keyCenter(play.layout, name);
  const burst = document.createElement("div");
  burst.className = "stick-burst";
  burst.style.left = spot ? `${spot.center}%` : "50%";
  for (let i = 0; i < 12; i += 1) {
    const spark = document.createElement("i");
    const angle = (i / 12) * Math.PI * 2;
    const reach = i % 2 === 0 ? 72 : 40;
    spark.style.setProperty("--dx", `${Math.cos(angle) * reach}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * reach * 0.72 - 12}px`);
    burst.append(spark);
  }
  $("highway").append(burst);
  setTimeout(() => burst.remove(), 1600);
}

function paintHold(progress) {
  const play = state.play;
  const name = play.sustain?.name;
  $("play-keys").querySelectorAll(".key").forEach((key) => {
    const on = !!name && key.dataset.name === name && progress > 0;
    key.classList.toggle("sustain", on);
    if (on) key.style.setProperty("--hold", progress.toFixed(3));
    else key.style.removeProperty("--hold");
  });
}

function tryHit(now) {
  const play = state.play;
  if (!play || play.sustain || play.index >= play.figure.length) return false;
  const due = play.dues[play.index];
  const earlyMs = due - musicalNow(now);
  const beat = play.beatMs;
  if (!play.holding && earlyMs > beat * 0.55) {
    showTiming("early", "Рано — дождитесь касания");
    return false;
  }
  let label = "В такт";
  let kind = "on";
  if (play.holding) {
    const late = now - play.holdReal;
    if (late > beat * 0.45) {
      play.late += 1;
      label = "Поздно";
      kind = "late";
    } else play.onTime += 1;
    resumeClock(now, play.heldMusical);
  } else if (earlyMs > beat * 0.22) {
    play.early += 1;
    label = "Чуть рано";
    kind = "early";
  } else play.onTime += 1;
  play.message = "";
  play.openUntil = 0;
  play.earlyHold = false;
  $("hero-msg").textContent = "";
  $("hero-note").classList.remove("shake");
  showTiming(kind, label);
  beginSustain(now);
  return true;
}

function sameStepLabel(name) {
  const note = parseNote(name);
  return `${ruStep(name)} · ${ruOctaveShort(note.oct)}`;
}

function onWrong(now, name) {
  const play = state.play;
  if (!play || now < play.wrongLock) return;
  const target = play.song.notes[play.index];
  play.wrongLock = now + 560;
  play.mistakes += 1;
  play.badName = name;
  play.badUntil = now + 1200;
  play.message = `Это ${sameStepLabel(name)}, а нужна ${sameStepLabel(target)}`;
  play.openUntil = 0;
  ear.wrongStreak = 0;
  $("hero-msg").textContent = play.message;
  $("play-miss").hidden = false;
  $("play-miss").textContent = `Мимо: ${play.mistakes}`;
  paintKeyboard($("play-keys"), { target, bad: name });
  const hero = $("hero-note");
  hero.classList.remove("shake");
  void hero.offsetWidth;
  hero.classList.add("shake");
}

function skipNote() {
  const play = state.play;
  if (!play || state.screen !== "play" || play.index >= play.figure.length) return;
  const now = performance.now();
  play.mistakes += 1;
  if (play.holding) resumeClock(now, play.heldMusical);
  play.earlyHold = false;
  play.sustain = null;
  paintHold(0);
  advanceNote();
}

function onKeyClick(name) {
  if (state.screen !== "play" || !state.practice || !state.play || state.play.sustain) return;
  const now = performance.now();
  const target = state.play.song.notes[state.play.index];
  if (name === target) tryHit(now);
  else if (inHitWindow(now)) onWrong(now, name);
  else showTiming("early", "Ещё рано");
}

function gate() {
  return Math.max(0.008, state.noiseFloor * Number(state.sensitivity));
}

function observeNoise(rms) {
  if (rms < state.noiseFloor * 1.8) {
    state.noiseFloor = state.noiseFloor * 0.92 + rms * 0.08;
  }
  state.noiseFloor = Math.min(0.06, Math.max(0.003, state.noiseFloor));
}

function paintMeter(el, rms, threshold) {
  if (!el) return;
  const level = rms / (threshold * 5);
  el.querySelectorAll("i").forEach((bar, index) => {
    const on = level > index / 8;
    bar.classList.toggle("on", on);
    bar.classList.toggle("hot", on && rms > threshold);
  });
}

function paintSens() {
  document.querySelectorAll("[data-sens]").forEach((button) => {
    button.classList.toggle("on", button.dataset.sens === state.sensitivity);
  });
}

function nearestMapped(freq, map, maxCents) {
  let best = null;
  let bestAbs = maxCents;
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== "number") continue;
    const delta = Math.abs(centsBetween(freq, value));
    if (delta < bestAbs) {
      bestAbs = delta;
      best = name;
    }
  }
  return best;
}

function isAttack(now, rms, threshold) {
  const history = ear.history;
  history.push({ t: now, rms });
  while (history.length && now - history[0].t > 280) history.shift();
  if (history.length < 4) return false;
  let min = Infinity;
  for (let i = 0; i < history.length - 1; i++) min = Math.min(min, history[i].rms);
  return rms > threshold && rms > min * 1.55 && rms - min > Math.max(0.006, threshold * 0.35);
}

function paintPlayHeard(nearest) {
  const el = $("play-heard");
  if (!ear.freq) {
    el.textContent = ear.rms > gate() * 0.7 ? "Слышу звук…" : "Слушаю пианино";
    return;
  }
  if (nearest) {
    el.textContent = `Слышу: ${ruStep(nearest)}`;
    return;
  }
  const heard = describeFreq(ear.freq);
  el.textContent = heard ? `Слышу около ${ruStep(heard.name)}` : "Слышу звук…";
}

function readEar() {
  const { analyser, ctx } = state.audio;
  if (ctx.state === "suspended") ctx.resume();
  const full = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(full);
  const recent = full.subarray(full.length - 2048);
  const { rms, signal, pitch } = analyze(recent, ctx.sampleRate);
  ear.rms = rms;
  ear.samples = signal;
  ear.sampleRate = ctx.sampleRate;
  ear.freq = pitch?.freq ?? null;
  ear.confidence = pitch?.confidence ?? 0;
  observeNoise(rms);
  if (rms < gate()) {
    ear.freq = null;
    ear.confidence = 0;
  }
}

function updatePlayEar(now) {
  const play = state.play;
  if (!play || play.index >= play.figure.length) return;
  const threshold = gate();
  if (ear.rms < threshold * 0.75) {
    play.released = true;
    play.earlyHold = false;
  }
  const target = play.song.notes[play.index];
  const targetFreq = state.calibration.map[target];
  const nearest = ear.freq ? nearestMapped(ear.freq, state.calibration.map, 60) : null;
  paintKeyboard($("play-keys"), {
    target,
    heard: nearest,
    bad: now < play.badUntil ? play.badName : null,
  });
  paintPlayHeard(nearest);
  paintMeter($("play-meter"), ear.rms, gate());
  if (play.sustain || typeof targetFreq !== "number") return;
  const hearing = ear.freq && matchesTarget(ear.freq, targetFreq, ear.samples, ear.sampleRate);
  if (play.earlyHold && hearing && inHitWindow(now)) {
    tryHit(now);
    return;
  }
  if (isAttack(now, ear.rms, threshold) && play.released && now > play.openUntil) {
    play.released = false;
    play.attackAt = now;
    play.openUntil = now + 620;
    ear.matchStreak = 0;
    ear.wrongStreak = 0;
  }
  if (!play.openUntil || now < play.attackAt + 70 || now > play.openUntil || !ear.freq) return;
  if (hearing) {
    ear.matchStreak += 1;
    ear.wrongStreak = 0;
    if (ear.matchStreak >= 2 && !tryHit(now)) play.earlyHold = true;
    return;
  }
  ear.matchStreak = 0;
  if (!inHitWindow(now)) return;
  if (nearest && nearest !== target) {
    ear.wrongStreak += 1;
    if (ear.wrongStreak >= 2) onWrong(now, nearest);
  }
}

function paintBeat(now, musical) {
  const play = state.play;
  const beatIndex = Math.max(0, Math.floor(musical / play.beatMs));
  const slot = beatIndex % play.meter;
  const late = play.holding && now - play.holdReal > play.beatMs * 0.4;
  const row = $("beats");
  if (row.childElementCount !== play.meter) {
    row.replaceChildren();
    for (let i = 0; i < play.meter; i += 1) row.append(document.createElement("i"));
  }
  [...row.children].forEach((dot, index) => {
    dot.classList.toggle("on", index === slot && !late);
    dot.classList.toggle("late", index === slot && late);
  });
  const word = $("beat-word");
  word.textContent = beatWord(play.meter, beatIndex);
  word.classList.toggle("late", late);
  const counting = musical < play.dues[0] - play.beatMs * 0.12;
  $("play-kicker").textContent = counting ? "Считайте" : "Сыграйте";
  if (late) showTiming("late", "Пора");
}

function updateStick(now) {
  const play = state.play;
  if (!play || state.screen !== "play" || play.index >= play.figure.length) return;
  let musical = musicalNow(now);
  if (play.sustain && musical >= play.sustain.until) {
    const name = play.sustain.name;
    play.sustain = null;
    paintHold(0);
    burstStick(name);
    advanceNote();
    if (!state.play || state.screen !== "play" || state.play.index >= state.play.figure.length) return;
    musical = musicalNow(now);
  }
  const due = play.dues[play.index];
  if (!play.sustain && !play.holding && musical >= due) {
    play.holding = true;
    play.heldMusical = due;
    play.holdReal = now;
    musical = due;
  }
  paintBeat(now, musical);
  let holdProgress = 0;
  if (play.sustain) {
    const span = Math.max(1, play.sustain.until - play.sustain.from);
    holdProgress = Math.min(1, Math.max(0, (musical - play.sustain.from) / span));
    $("play-kicker").textContent = holdProgress > 0.82 ? "Отпустите" : "Держите";
    if (holdProgress > 0.82) showTiming("release", "Отпустите");
    else if (holdProgress > 0.22) showTiming("on", "Держите");
  }
  paintHold(holdProgress);
  const height = $("highway").clientHeight;
  if (height < 40) return;
  const pxPerBeat = height / LOOKAHEAD;
  const pool = $("sticks");
  const visible = [];
  for (let i = play.index; i < play.figure.length; i += 1) {
    const away = (play.dues[i] - musical) / play.beatMs;
    if (away > LOOKAHEAD + 0.35) break;
    visible.push(i);
  }
  while (pool.children.length < visible.length) {
    const el = document.createElement("div");
    el.className = "note-stick";
    const body = document.createElement("div");
    body.className = "stick-body";
    const fill = document.createElement("div");
    fill.className = "stick-fill";
    body.append(fill);
    el.append(body);
    pool.append(el);
  }
  while (pool.children.length > visible.length) pool.lastElementChild.remove();
  visible.forEach((noteIndex, slot) => {
    const el = pool.children[slot];
    const step = play.figure[noteIndex];
    const spot = keyCenter(play.layout, step.name);
    const away = Math.max(0, (play.dues[noteIndex] - musical) / play.beatMs);
    const stickH = Math.max(28, Math.min(height * 0.92, step.beats * pxPerBeat));
    const filling = play.sustain && noteIndex === play.sustain.index;
    el.style.left = spot ? `${spot.center}%` : "50%";
    el.style.height = `${stickH}px`;
    el.style.transform = `translate(-50%, ${height - away * pxPerBeat - stickH}px)`;
    el.style.zIndex = noteIndex === play.index ? "2" : "1";
    el.classList.toggle("now", noteIndex === play.index);
    el.classList.toggle("waiting", noteIndex === play.index && play.holding && !filling);
    el.classList.toggle("sustain", !!filling);
    el.classList.toggle("ghost", noteIndex !== play.index);
    const fill = el.querySelector(".stick-fill");
    if (fill) fill.style.height = filling ? `${holdProgress * 100}%` : "0%";
  });
  if (play.badUntil && now > play.badUntil) {
    play.badUntil = 0;
    play.badName = null;
    play.message = "";
    $("hero-msg").textContent = "";
    $("hero-note").classList.remove("shake");
    paintKeyboard($("play-keys"), { target: play.song.notes[play.index] });
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  const listening =
    state.audio &&
    !state.practice &&
    (state.screen === "play" ||
      (state.screen === "cal" && (state.cal?.phase === "listen" || state.cal?.phase === "run")));
  if (listening && now - ear.lastDetect > 40) {
    ear.lastDetect = now;
    readEar();
    if (state.screen === "cal" && state.cal.phase === "listen") updateListen();
    if (state.screen === "cal" && state.cal.phase === "run") updateRun(now);
    if (state.screen === "play") updatePlayEar(now);
  }
  if (state.screen === "play") updateStick(now);
}

async function onStartMic() {
  const button = $("start-mic");
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Открываю микрофон…";
  const ok = await enableMic();
  button.disabled = false;
  button.textContent = previous;
  if (ok) beginCal();
}

async function recalibrate() {
  show("intro");
  const ok = await enableMic();
  if (ok) beginCal();
}

function onClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "start-mic") onStartMic();
  else if (action === "practice") {
    state.practice = true;
    openSongs();
  }   else if (action === "play-saved") {
    state.practice = false;
    enableMic().then((ok) => {
      if (ok) openSongs();
    });
  } else if (action === "home") show("intro");
  else if (action === "recal") recalibrate();
  else if (action === "range") chooseRange(button.dataset.id);
  else if (action === "listen-next") goRun();
  else if (action === "capture") capture(medianFreq());
  else if (action === "undo") undoKey();
  else if (action === "skip-key") skipKey();
  else if (action === "redo-from") redoFrom(button.dataset.name);
  else if (action === "redo-all") redoAll();
  else if (action === "songs") openSongs();
  else if (action === "play-song") startSong(button.dataset.id);
  else if (action === "skip-note") skipNote();
  else if (action === "replay") startSong(state.play.song.id);
  else if (action === "sens") {
    state.sensitivity = button.dataset.sens;
    paintSens();
  }
}

function onKey(event) {
  if (event.repeat) return;
  if (state.screen === "cal" && state.cal?.phase === "run" && (event.key === " " || event.key === "Enter")) {
    event.preventDefault();
    if (!$("capture").disabled) capture(medianFreq());
  }
  if (event.key === "Escape" && (state.screen === "play" || state.screen === "done")) openSongs();
}

$("play-keys").addEventListener("click", (event) => {
  const key = event.target.closest(".key");
  if (key) onKeyClick(key.dataset.name);
});
document.body.addEventListener("click", onClick);
window.addEventListener("keydown", onKey);
new ResizeObserver(() => {
  if (state.screen === "play") placeGuide();
}).observe($("highway"));
window.addEventListener("pagehide", () => {
  state.audio?.stream.getTracks().forEach((track) => track.stop());
});

renderIntro();
requestAnimationFrame(tick);
