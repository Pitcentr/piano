const STEPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const RU = {
  C: "До",
  "C#": "До♯",
  D: "Ре",
  "D#": "Ре♯",
  E: "Ми",
  F: "Фа",
  "F#": "Фа♯",
  G: "Соль",
  "G#": "Соль♯",
  A: "Ля",
  "A#": "Ля♯",
  B: "Си",
};

const OCTAVE = {
  3: "малая октава",
  4: "первая октава",
  5: "вторая октава",
  6: "третья октава",
};

const OCTAVE_SHORT = {
  3: "малая",
  4: "1-я",
  5: "2-я",
  6: "3-я",
};

const BLACK = new Set([1, 3, 6, 8, 10]);

export function nameToMidi(name) {
  const match = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Неизвестная нота: ${name}`);
  const pc = STEPS.indexOf(match[1]);
  if (pc < 0) throw new Error(`Неизвестная нота: ${name}`);
  return (Number(match[2]) + 1) * 12 + pc;
}

export function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return STEPS[pc] + oct;
}

export function parseNote(name) {
  const midi = nameToMidi(name);
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return { name, step: STEPS[pc], oct, midi, black: BLACK.has(pc) };
}

export function isBlackName(name) {
  return name.includes("#");
}

export function etFreq(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function centsBetween(a, b) {
  return 1200 * Math.log2(a / b);
}

export function ruStep(name) {
  return RU[parseNote(name).step];
}

export function ruOctave(oct) {
  return OCTAVE[oct] || `${oct}-я октава`;
}

export function ruOctaveShort(oct) {
  return OCTAVE_SHORT[oct] || String(oct);
}

export function fullName(name) {
  const { step, oct } = parseNote(name);
  return `${RU[step]} · ${ruOctave(oct)}`;
}

export function describeFreq(freq) {
  if (!freq || !Number.isFinite(freq) || freq < 40 || freq > 5000) return null;
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  if (midi < 15 || midi > 120) return null;
  const ref = etFreq(midi);
  return {
    midi,
    name: midiToName(midi),
    cents: centsBetween(freq, ref),
    freq,
  };
}

export const RANGES = [
  {
    id: "c4c5",
    label: "Одна октава",
    detail: "До первой — До второй",
    keys: "8 белых и 5 чёрных",
    start: 60,
    end: 72,
  },
  {
    id: "c4c6",
    label: "Две октавы",
    detail: "До первой — До третьей",
    keys: "15 белых и 10 чёрных",
    start: 60,
    end: 84,
    recommended: true,
  },
];

export function rangeById(id) {
  return RANGES.find((range) => range.id === id) || RANGES[1];
}

export function buildSequence(start, end) {
  const whites = [];
  const blacks = [];
  for (let midi = start; midi <= end; midi++) {
    const name = midiToName(midi);
    if (BLACK.has(((midi % 12) + 12) % 12)) blacks.push(name);
    else whites.push(name);
  }
  return [...whites, ...blacks];
}
