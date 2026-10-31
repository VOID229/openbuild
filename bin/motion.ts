// The animated stage behind `ob start`, `stop`, `restart`, `update`, `--set-track` and `pair`.
// Without an animating terminal every call degrades to plain output, so callers never branch.
// OPENBUILD_NO_MOTION=1 turns it off.
// Preview without touching anything: bun bin/motion.ts start|stop|restart|update|track|pair
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Scene = "lifecycle" | "update" | "track" | "pair";
export interface MotionStep { label: string; detail?: string }
export interface MotionState {
  scene: Scene;
  /** 1 lights the wordmark, 0 drains it. A stage that ends on 0 erases itself. */
  power: number;
  /** Every power change so far. The renderer plays them all, however quickly they came. */
  powers: number[];
  steps: MotionStep[];
  current: number;
  sonar?: boolean;
  code?: string;
  lines?: string[];
  track?: { from: number; to: number };
  end?: "done" | "fail";
}
type Opening = Pick<MotionState, "scene"> & Partial<Pick<MotionState, "power" | "track" | "sonar">> & { steps?: string[] };

/** Below this even the one-line wordmark and a step label stop reading as anything. */
const MIN_COLS = 24, MIN_ROWS = 4;

export type ColorDepth = "truecolor" | "256" | "basic" | "none";

/** NO_COLOR removes colour, not motion. */
export function colorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  if (env.NO_COLOR) return "none";
  if (/truecolor|24bit/.test(env.COLORTERM ?? "")) return "truecolor";
  if (/256|kitty|alacritty|foot|ghostty|wezterm|direct/.test(env.TERM ?? "")) return "256";
  return "basic";
}

/** `reserve` counts the rows around the wordmark: steps, spacing and any labels. */
export const wordmarkFits = (width: number, height: number, reserve: number, columns: number, rows: number) =>
  width + 4 <= columns && height + reserve + 2 <= rows;

/** Anything that can move a cursor animates. Only logs, pipes and dumb terminals can't. */
export function animates(env: NodeJS.ProcessEnv, tty: { isTTY?: boolean; columns?: number; rows?: number }, steps: number) {
  if (!tty.isTTY || env.CI || env.OPENBUILD_NO_MOTION) return false;
  if (!env.TERM || env.TERM === "dumb") return false;
  return (tty.columns ?? 80) >= MIN_COLS && (tty.rows ?? 24) >= steps + MIN_ROWS;
}

class Stage {
  private child?: ChildProcess;
  private dir?: string;
  private state?: MotionState;
  private queued: string[] = [];

  /** Returns true only for the caller that opened it; a nested caller joins the running stage. */
  open({ steps = [], ...opening }: Opening) {
    if (this.state) return false;
    if (!animates(process.env, process.stdout, steps.length)) return false;
    this.dir = mkdtempSync(join(tmpdir(), "openbuild-motion-"));
    this.state = { power: 1, powers: [], ...opening, steps: steps.map(label => ({ label })), current: 0 };
    this.save();
    this.child = spawn(process.execPath, [join(import.meta.dir, "motionRender.ts"), join(this.dir, "state"), String(this.state.power)], { stdio: ["ignore", "inherit", "ignore"], env: process.env });
    this.child.unref();
    process.once("exit", () => this.abort());
    return true;
  }

  /** Advance to a labelled step. Labels the stage wasn't opened with are ignored. */
  step(label: string, detail?: string) {
    if (!this.state) return;
    const index = this.state.steps.findIndex(step => step.label === label);
    if (index < 0) return;
    this.state.current = index;
    if (detail) this.state.steps[index]!.detail = detail;
    this.save();
  }

  update(patch: Partial<MotionState>) {
    if (!this.state) return;
    if (patch.power !== undefined && patch.power !== this.state.power) this.state.powers.push(patch.power);
    Object.assign(this.state, patch);
    this.save();
  }

  /** Results wait below the finished stage. */
  print(line = "") {
    if (this.state) this.queued.push(line);
    else console.log(line);
  }

  discard() { this.queued = []; }

  /** Blocks until the outro has played, so `fail` can still call it on its way out. */
  end(outcome: "done" | "fail" = "done") {
    if (!this.state) return;
    this.state.end = outcome;
    this.save();
    const marker = join(this.dir!, "state.done");
    for (let i = 0; i < 800 && !existsSync(marker); i++) Bun.sleepSync(10);
    // The renderer died: the cursor it hid is still ours to give back.
    if (!existsSync(marker)) process.stdout.write("\x1b[?2026l\x1b[0m\x1b[?25h\n");
    this.close();
  }

  /** An exit nobody announced: restore the terminal and drop the results. */
  abort() {
    if (!this.state) return;
    this.child?.kill("SIGTERM");
    const marker = join(this.dir!, "state.done");
    for (let i = 0; i < 50 && !existsSync(marker); i++) Bun.sleepSync(10);
    this.close();
  }

  private save() {
    const next = join(this.dir!, "state.next");
    writeFileSync(next, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(next, join(this.dir!, "state"));
  }

  private close() {
    rmSync(this.dir!, { recursive: true, force: true });
    this.state = undefined;
    const lines = this.queued;
    this.queued = [];
    for (const line of lines) console.log(line);
  }
}

export const stage = new Stage();

if (import.meta.main) {
  const pause = Bun.sleepSync;
  const stepped = (labels: string[]) => labels.forEach(label => { stage.step(label); pause(700); });
  const stopping = ["Stopping the server"], starting = ["Preparing the network", "Starting the server"];
  switch (process.argv[2]) {
    case "start":
      stage.open({ scene: "lifecycle", power: 0, steps: starting });
      stage.update({ power: 1 });
      stepped(starting);
      break;
    case "stop":
      stage.open({ scene: "lifecycle", steps: stopping });
      pause(350);
      stage.update({ power: 0 });
      stepped(stopping);
      break;
    case "restart":
      stage.open({ scene: "lifecycle", steps: [...stopping, ...starting] });
      pause(350);
      stage.update({ power: 0 });
      stepped(stopping);
      pause(500);
      stage.update({ power: 1 });
      stepped(starting);
      break;
    case "update":
      stage.open({ scene: "update", power: 0, steps: ["Checking for a new release", "Downloading", "Installing dependencies"] });
      stage.update({ power: 1 });
      stepped(["Checking for a new release", "Downloading", "Installing dependencies"]);
      break;
    case "track":
      stage.open({ scene: "track", track: { from: 0, to: 1 } });
      break;
    case "pair":
      stage.open({ scene: "pair", power: 0, sonar: true, steps: ["Starting the server", "Waiting for the other device"] });
      stage.update({ power: 1 });
      stage.step("Starting the server");
      pause(900);
      stage.step("Waiting for the other device");
      stage.update({ code: "K7QX-3MPD", lines: ["http://localhost:3100", "On the other computer, run: ob pair --client"] });
      pause(4000);
      break;
    default:
      console.error("usage: bun bin/motion.ts start|stop|restart|update|track|pair");
      process.exit(1);
  }
  stage.end();
}
