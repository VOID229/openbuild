// Draws one `ob` animation. It runs as its own process because the CLI blocks its event loop
// (spawnSync, git, bun install), and it alone writes to the terminal until bin/motion.ts says stop.
import { closeSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { colorDepth, wordmarkFits, type MotionState } from "./motion";

const FULL = ".8ceffc4.............................ffffdc4..........af5.af.......ed 8f7...3fd..cc.cc4....8ccc...cc.cc4...f5...ff..cc...c4.8c..af...8cc4ff ff.....af4.ff333fd.8f733bf4.ff333fd..fdcccf1..ff...ff.af5.af..ef333ff ff.....ef1.ff...af5affffff5.ff...ff..f7..3bf4.ff...ff.af5.af..f5...ff 2fdcccef3..ffc.8ff.2fd4.cc4.ff...ff..fdcccef1.bf4.cff.af5.af..bf4.cff ..33333....ff2333....33331..33...33..333333....333133.231.23...333133 ...........ff........................................................".split(" ");
const COMPACT = "8e7bd4.................af3bc.......3.e5....f f1..2f.f63f48e3bc.f63f.adccf.a5.a5.f.f58f3bf f4..8f.f..a5a7333.f..f5a733f4a5.a5.f.f5a5..f 2bdc71.fdcf12bce7.f..f5afcc712fcb5.f.f52fc6f .......f....................................".split(" ");
const UNICODE = { cells: " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█", spinner: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", done: "✓", failed: "✗", idle: "·", knob: "●", rail: "─" };
const ASCII = { cells: " '`\",[/P.\\]?_LJ#", spinner: "|/-\\", done: "+", failed: "x", idle: ".", knob: "o", rail: "-" };
const SCRAMBLE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LEVELS = 48, FRAME_MS = 33, SWEEP = 34, PERIOD = 96, OUTRO = 26, SLIDE = 22;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => { v = clamp(v); return v * v * (3 - 2 * v); };
const ease = (v: number) => 1 - (1 - clamp(v)) ** 3;

const statePath = process.argv[2]!;
const parent = process.ppid;
const depth = colorDepth(process.env);
const reset = depth === "none" ? "" : "\x1b[0m";
const size = () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

/** Ask the terminal itself: its background colour, and how wide it thinks one UTF-8 block is. */
function probeTerminal() {
  let tty: number | undefined;
  let saved: string | undefined;
  let reply = "";
  try {
    tty = openSync("/dev/tty", "r+");
    const stty = (...args: string[]) => spawnSync("stty", args, { stdio: [tty, "pipe", "ignore"], encoding: "utf8" });
    saved = stty("-g").stdout?.trim();
    if (!saved) throw new Error("no stty");
    stty("-echo", "-icanon", "min", "0", "time", "1");
    // Everything answers the position report, so it doubles as the end of the replies.
    writeSync(tty, "\r█\x1b]11;?\x1b\\\x1b[6n\r\x1b[K");
    const buffer = Buffer.alloc(128);
    for (let empty = 0; empty < 3 && !/\x1b\[\d+;\d+R/.test(reply);) {
      const count = readSync(tty, buffer, 0, buffer.length, null);
      if (count) reply += buffer.toString("latin1", 0, count);
      else empty++;
    }
    stty(saved);
  } catch {}
  if (tty !== undefined) try { closeSync(tty); } catch {}
  const rgb = /rgb:([0-9a-f])[0-9a-f]*\/([0-9a-f])[0-9a-f]*\/([0-9a-f])/i.exec(reply);
  const column = /\x1b\[\d+;(\d+)R/.exec(reply)?.[1];
  const localeUtf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "");
  return {
    light: !!rgb && parseInt(rgb[1]!, 16) + parseInt(rgb[2]!, 16) + parseInt(rgb[3]!, 16) >= 24,
    // A locale says what programs expect; the cursor says what the terminal actually did.
    utf8: process.env.TERM !== "linux" && (column ? Number(column) === 2 : localeUtf8),
  };
}

const terminal = probeTerminal();
const glyphs = terminal.utf8 ? UNICODE : ASCII;
const ramp = Array.from({ length: LEVELS }, (_, q) => {
  const [from, to] = terminal.light ? [232, 24] : [34, 240];
  const gray = Math.round(from + (to - from) * q / (LEVELS - 1));
  if (depth === "truecolor") return `\x1b[38;2;${gray};${gray};${gray}m`;
  if (depth === "256") return `\x1b[38;5;${232 + Math.floor((gray - 8) / 10.1)}m`;
  if (depth === "basic") return q < LEVELS * 0.45 ? "\x1b[0;2m" : q < LEVELS * 0.85 ? "\x1b[0m" : "\x1b[0;1m";
  return "";
});
const shade = (v: number) => {
  const q = Math.round(clamp(v) * (LEVELS - 1));
  return q === LEVELS - 1 && depth !== "none" && depth !== "basic" ? "\x1b[39m" : ramp[q]!;
};
const tint = (code: number) => depth === "none" ? "" : `\x1b[${code}m`;

let state: MotionState = JSON.parse(readFileSync(statePath, "utf8"));
const reserved = () => state.scene === "pair" ? state.steps.length + 11 : state.steps.length + 3;

/** The largest wordmark this window holds; the two-line labels decide what's left. */
function chooseMark() {
  const { columns, rows } = size();
  for (const art of [FULL, COMPACT]) if (wordmarkFits(art[0]!.length, art.length, reserved(), columns, rows)) return art;
  return undefined;
}

let mark = chooseMark();
let SPAN = mark?.[0]!.length ?? 9, ROWS = mark?.length ?? 1;
let EDGE = Math.max(3, SPAN * 0.26), GLOW = Math.max(3, SPAN * 0.29);
let lastSize = JSON.stringify(size());
let frame = 0;
// The opening power comes by argument: the state file may already hold the first change.
let power = Number(process.argv[3]);
let sweep: { from: number; to: number; start: number } | undefined;
// Actions often finish before a transition could be seen, so every power change plays in order
// and the steps tick over one at a time. Only the animation's own clock sets the pace.
let played = 0;
let holdUntil = 0;
let shown = 0;
let settled = 0;
let outro = -1;
let height = 0;

/** Rising power washes left to right (or upward for updates); falling power drains right to left. */
function reach(x: number, r: number, to: number) {
  if (state.scene === "update" && to > 0) return (ROWS - 1 - r) * SPAN / ROWS + x * 0.15;
  return (to > 0 ? x : SPAN - x) + (ROWS - 1 - r) * 1.6;
}

function level(x: number, r: number) {
  let value = power;
  if (sweep) {
    const head = ease((frame - sweep.start) / SWEEP) * (SPAN + EDGE);
    value = sweep.from + (sweep.to - sweep.from) * smooth((head - reach(x, r, sweep.to)) / EDGE);
  }
  if (value > 0 && power > 0 && !state.end) {
    const rest = 1 - 0.45 * smooth((frame - settled) / 24);
    const position = state.sonar ? Math.abs(x - SPAN / 2) * 2 : x + (ROWS - 1 - r) * 1.6;
    const gap = (position - (-GLOW + (SPAN + 2 * GLOW) * ((frame % PERIOD) / PERIOD))) / GLOW;
    value *= rest + (1 - rest) * smooth(1 - Math.abs(gap));
  }
  if (outro >= 0) {
    const head = ease(outro / OUTRO) * (SPAN + EDGE);
    value += (1 - value) * smooth((head - x - (ROWS - 1 - r) * 1.6) / EDGE);
    // A soft dip travels with the head so the finish shows on an already solid wordmark too.
    value *= 1 - 0.5 * smooth(1 - Math.abs(head - EDGE / 2 - x - (ROWS - 1 - r) * 1.6) / GLOW) * (1 - smooth(outro / OUTRO - 0.8) );
  }
  return value;
}

function wordmark(final: boolean) {
  return Array.from({ length: ROWS }, (_, r) => {
    let line = "  ", last = -1;
    for (let x = 0; x < SPAN; x++) {
      const glyph = mark ? glyphs.cells[parseInt(mark[r]![x]!, 16) || 0]! : "OpenBuild"[x]!;
      if (glyph === " ") { line += " "; continue; }
      const value = final ? 1 : level(x, r);
      const q = Math.round(clamp(value) * (LEVELS - 1));
      // Without colour the only level left is on or off.
      if (q < 1 || (depth === "none" && value < 0.5)) { line += " "; continue; }
      if (q !== last) { line += shade(value); last = q; }
      line += glyph;
    }
    return `${line}${reset}`;
  });
}

function stepLines() {
  return state.steps.map((step, i) => {
    const alpha = state.end ? 1 : smooth((frame - 12 - (i + 1) * 3) / 10);
    const finished = i < shown || (state.end === "done" && shown >= state.current && i === shown);
    const failed = state.end === "fail" && i === shown;
    const tone = finished ? 0.62 : i === shown ? 1 : 0.35;
    const spinner = glyphs.spinner[Math.floor(frame / 3) % glyphs.spinner.length]!;
    const sign = alpha < 1 ? glyphs.idle : finished ? tint(32) + glyphs.done : failed ? tint(31) + glyphs.failed : i === shown ? spinner : glyphs.idle;
    const color = shade(alpha * tone);
    const detail = step.detail ? `  ${shade(alpha * 0.5)}${step.detail}` : "";
    return `  ${color}${sign}${reset} ${color}${step.label}${detail}${reset}`;
  });
}

/** The code settles out of random characters from left to right. */
function codeLine(code: string) {
  const start = 8;
  let text = "";
  for (let i = 0; i < code.length; i++) {
    const open = frame >= start + i * 3 + 10 || code[i] === "-";
    const char = open ? code[i] : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
    text += `${shade(open ? 1 : 0.4)}${char}`;
  }
  return `  ${shade(0.62)}Pairing code${reset}   ${tint(1)}${text}${reset}`;
}

function trackLine() {
  const { from = 0, to = 0 } = state.track ?? {};
  const t = smooth(frame / SLIDE);
  const rail_length = Math.max(6, Math.min(26, size().columns - 24));
  // Already there: the knob leans toward the other side and settles back.
  const lean = from === to ? (from ? -1 : 1) * 0.22 * Math.sin(Math.PI * t) : 0;
  const place = (from + (to - from) * t + lean) * (rail_length - 1);
  let rail = "";
  for (let x = 0; x < rail_length; x++) {
    const near = Math.abs(x - place);
    rail += near < 0.5 ? `${shade(1)}${glyphs.knob}` : `${shade(0.22 + 0.5 * smooth(1 - near / 7))}${glyphs.rail}`;
  }
  const active = from + (to - from) * t;
  return `  ${shade(1 - 0.65 * active)}stable${reset}  ${rail}${reset}  ${shade(0.35 + 0.65 * active)}nightly${reset}`;
}

function paint(final = false) {
  const fixed = ROWS + state.steps.length + (state.code ? 2 : 0) + 3;
  const room = Math.max(0, size().rows - 1 - fixed);
  const body = state.scene === "track"
    ? ["", trackLine(), ""]
    : ["", ...wordmark(final), "", ...(state.code ? [codeLine(state.code), ""] : []), ...stepLines(), ...(state.lines ?? []).slice(0, room).map(line => `  ${shade(0.5)}${line}${reset}`), ""];
  let out = "\x1b[?2026h";
  for (const line of body) out += `\r${line}\x1b[K\n`;
  out += "\x1b[J";
  height = body.length;
  if (!final) out += `\x1b[${height}A\r`;
  write(`${out}\x1b[?2026l`);
}

function write(text: string) {
  let data = Buffer.from(text);
  for (let tries = 0; data.length && tries < 200; tries++) {
    try { data = data.subarray(writeSync(1, data)); }
    catch { Bun.sleepSync(2); }
  }
}

function finish() {
  try { writeFileSync(`${statePath}.done`, ""); } catch {}
  process.exit(0);
}

function bail() {
  write(`\x1b[?2026l\x1b[0m\x1b[?7h\x1b[?25h\x1b[${height}B\r`);
  finish();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, bail);

// With wrapping off a resize can't fold a line and throw off the cursor arithmetic.
write("\x1b[?25l\x1b[?7l");
function leave() { write("\x1b[?7h\x1b[?25h"); finish(); }
setInterval(() => {
  if (process.ppid !== parent) bail();
  const current = JSON.stringify(size());
  if (current !== lastSize) {
    lastSize = current;
    mark = chooseMark();
    SPAN = mark?.[0]!.length ?? 9; ROWS = mark?.length ?? 1;
    EDGE = Math.max(3, SPAN * 0.26); GLOW = Math.max(3, SPAN * 0.29);
  }
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  if (sweep && frame - sweep.start >= SWEEP) {
    power = sweep.to;
    sweep = undefined;
    settled = frame;
    holdUntil = frame + (power === 0 ? 8 : 0);
  }
  if (!sweep && frame >= holdUntil && played < state.powers.length) {
    const to = state.powers[played++]!;
    if (to !== power) sweep = { from: power, to, start: frame };
  }
  if (state.end === "fail") shown = state.current;
  else if (shown < state.current && frame % 10 === 0) shown++;

  if (state.end === "fail") { paint(true); leave(); }
  const introDone = state.scene === "track" ? frame >= SLIDE + 4 : !sweep && played === state.powers.length && shown >= state.current && frame >= 14;
  if (state.end === "done" && introDone) {
    if (state.scene === "track") { paint(true); leave(); }
    if (power === 0) { write("\x1b[J"); leave(); }
    if (outro < 0) outro = 0;
    if (outro > OUTRO) { paint(true); leave(); }
  }
  paint();
  frame++;
  if (outro >= 0) outro++;
}, FRAME_MS);
