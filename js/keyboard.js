import { midiToName, parseNote, ruOctaveShort, ruStep } from "./notes.js";

const BLACK_SHIFT = {
  1: -0.07,
  3: 0.09,
  6: -0.1,
  8: 0.0,
  10: 0.1,
};

export function buildLayout(startMidi, endMidi) {
  const whites = [];
  for (let midi = startMidi; midi <= endMidi; midi++) {
    const pc = ((midi % 12) + 12) % 12;
    if (pc !== 1 && pc !== 3 && pc !== 6 && pc !== 8 && pc !== 10) whites.push(midi);
  }
  const whiteW = 100 / whites.length;
  const indexOf = new Map(whites.map((midi, index) => [midi, index]));
  const keys = [];

  whites.forEach((midi, index) => {
    keys.push({
      midi,
      name: midiToName(midi),
      black: false,
      left: index * whiteW,
      width: whiteW,
    });
  });

  for (let midi = startMidi; midi <= endMidi; midi++) {
    const pc = ((midi % 12) + 12) % 12;
    if (!BLACK_SHIFT.hasOwnProperty(pc)) continue;
    const prev = indexOf.get(midi - 1);
    if (prev === undefined) continue;
    const width = whiteW * 0.58;
    const center = (prev + 1) * whiteW + BLACK_SHIFT[pc] * whiteW;
    keys.push({
      midi,
      name: midiToName(midi),
      black: true,
      left: center - width / 2,
      width,
    });
  }

  return {
    startMidi,
    endMidi,
    keys,
    byName: new Map(keys.map((key) => [key.name, key])),
  };
}

export function renderKeyboard(root, layout, { practice = false } = {}) {
  root.replaceChildren();
  root.dataset.practice = practice ? "1" : "0";
  const whites = layout.keys.filter((key) => !key.black);
  const blacks = layout.keys.filter((key) => key.black);
  for (const key of [...whites, ...blacks]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `key ${key.black ? "black" : "white"}`;
    button.dataset.name = key.name;
    button.style.left = `${key.left}%`;
    button.style.width = `${key.width}%`;
    button.tabIndex = practice ? 0 : -1;
    button.setAttribute("aria-label", key.name);
    const label = document.createElement("span");
    label.className = "key-label";
    const times = document.createElement("span");
    times.className = "key-times";
    button.append(label, times);
    if (!key.black && parseNote(key.name).step === "C") {
      const tick = document.createElement("span");
      tick.className = "key-tick";
      tick.textContent = ruOctaveShort(parseNote(key.name).oct);
      button.append(tick);
    }
    root.append(button);
  }
}

export function paintKeyboard(root, { target = null, heard = null, bad = null, done = null, times = 1 } = {}) {
  if (!root) return;
  root.querySelectorAll(".key").forEach((key) => {
    const name = key.dataset.name;
    const isTarget = name === target;
    key.classList.toggle("target", isTarget);
    key.classList.toggle("heard", !!heard && name === heard && name !== target);
    key.classList.toggle("live", !!heard && name === heard && name === target);
    key.classList.toggle("bad", !!bad && name === bad);
    key.classList.toggle("done", !!done && done.has(name));
    key.classList.toggle("repeat", isTarget && times > 1);
    if (isTarget) key.setAttribute("aria-current", "true");
    else key.removeAttribute("aria-current");
    const label = key.querySelector(".key-label");
    if (label) {
      const black = key.classList.contains("black");
      label.textContent = isTarget && !black ? ruStep(name) : "";
    }
    const mark = key.querySelector(".key-times");
    if (mark) mark.textContent = isTarget && times > 1 ? `x${times}` : "";
  });
}

export function keyCenter(layout, name) {
  const key = layout?.byName.get(name);
  if (!key) return null;
  return { left: key.left, width: key.width, center: key.left + key.width / 2, black: key.black };
}
