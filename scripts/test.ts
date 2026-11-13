// Runs each test file in a process of its own, so browser globals, module mocks and captured storage
// backends can't leak between files (this also works on Bun 1.3.8, which has no --isolate flag).
//
//   bun run test [filter…]      files whose path includes a filter; all of them without one
//   --shard 2/5                 only the second fifth of them (CI runs the fifths side by side)
//   --timings                   after a full passing run, record how long each file took (the shards' balance)
//
// Files run in parallel: TEST_JOBS at once, at most TEST_BROWSER_JOBS of them driving a headless
// Chrome (TEST_JOBS=1 runs them one after another with live output). A passing file prints one line
// (TEST_VERBOSE=1, or a GitHub log, where it folds: its output too); a failing one prints its output,
// and is run once more on its own at the end (TEST_RETRIES=0 turns that off): a failure that doesn't
// repeat is reported as flaky and doesn't fail the run.
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "../server/pi/extensions/html-render";
import { expectedSeconds, expectedWall, parseShard, shard, usesBrowser, type Entry } from "./testPlan";

const TIMINGS = join(import.meta.dir, "test-timings.json");
// A file that never exits (a browser left alive, a bundler that spins, Bun 1.3.8 stuck before its
// first test) is killed: after a minute, or four times as long as the file is expected to take.
const fileLimit = (expected: number) => Math.max(60, Math.ceil(expected * 4));

const whole = (name: string, least: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < least) throw new Error(`${name} must be a whole number of at least ${least}, not ${JSON.stringify(raw)}.`);
  return value;
};
const jobs = whole("TEST_JOBS", 1) ?? Math.max(1, Math.floor(availableParallelism() / 2));
// Half the slots, and never more than 3: at 4 a 16-thread machine already drops animation frames.
const browserJobs = Math.min(jobs, whole("TEST_BROWSER_JOBS", 1) ?? Math.max(1, Math.min(3, Math.floor(jobs / 2))));
const retries = whole("TEST_RETRIES", 0) ?? 1;
const verbose = process.env.TEST_VERBOSE === "1";
const actions = process.env.GITHUB_ACTIONS === "true";

const filters: string[] = [];
let part: { index: number; total: number } | undefined;
let record = false;
for (let args = process.argv.slice(2), i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--timings") record = true;
  else if (arg === "--shard") part = parseShard(args[++i] ?? "");
  else if (arg.startsWith("--shard=")) part = parseShard(arg.slice(8));
  else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
  else filters.push(arg);
}
if (record && (filters.length || part)) throw new Error("--timings records a full run: leave out the filter and --shard.");

const timings: Record<string, number> = JSON.parse(readFileSync(TIMINGS, "utf8"));
const all: Entry[] = [...new Bun.Glob("tests/**/*.test.ts").scanSync()].sort()
  .filter(file => !filters.length || filters.some(filter => file.includes(filter)))
  .map(file => {
    const browser = usesBrowser(readFileSync(file, "utf8"));
    return { file, browser, seconds: expectedSeconds(file, browser, timings) };
  });
const entries = part ? shard(all, part.index, part.total) : all;
// Browser files are the slow ones and run one or a few at a time: start them first, longest first,
// so they don't trail at the end on their own.
entries.sort((a, b) => Number(b.browser) - Number(a.browser) || b.seconds - a.seconds || a.file.localeCompare(b.file));

type Result = { file: string; code: number | null; seconds: number; killed: boolean; limit: number; output: string };
const live = jobs === 1;
const logs = mkdtempSync(join(tmpdir(), "openbuild-test-logs-"));
const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test" };
// tests/guardSystemd.ts gives every file a data directory of its own, but only when none is set:
// one inherited from the shell would be shared by files running at the same time (or be real data).
delete env.OPENCHAT_DATA_DIR;
// Output goes to a file and is printed if the file fails; keep the colours a terminal would get.
if (!live && process.stdout.isTTY && env.NO_COLOR === undefined) env.FORCE_COLOR ??= "1";
// Ctrl-C reaches the running files too (same process group); Bun skips `finally` on a signal.
process.once("SIGINT", () => { rmSync(logs, { recursive: true, force: true }); process.exit(130); });

let spawned = 0;
async function run({ file, seconds: expected }: Entry, alone = live): Promise<Result> {
  const limit = fileLimit(expected);
  const log = join(logs, `${spawned++}.log`);
  // One descriptor for both streams keeps stdout and stderr in the order they were written.
  const fd = alone && live ? undefined : openSync(log, "a");
  const started = performance.now();
  // Bun's 5 s default per test is a hang guard, and several files at once is contention this runner
  // adds: a test that takes 4 s alone (a few CLI processes in a row) can take 6 under it, or on a slow
  // CI machine. Tests with a timeout of their own keep it, and so do the waits inside tests.
  const args = live ? [] : ["--timeout", "15000"];
  const child = Bun.spawn([process.execPath, "test", ...args, `./${file}`], {
    env,
    stdin: fd === undefined ? "inherit" : "ignore",
    stdout: fd ?? "inherit",
    stderr: fd ?? "inherit",
  });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, limit * 1000);
  const code = await child.exited;
  clearTimeout(timer);
  let output = "";
  if (fd !== undefined) {
    closeSync(fd);
    output = readFileSync(log, "utf8").trimEnd();
    rmSync(log, { force: true });
  }
  return { file, code, seconds: (performance.now() - started) / 1000, killed, limit, output };
}

const outcome = (result: Result) => result.code === 0 ? "passed" : result.killed ? `KILLED after ${result.limit} s` : "FAILED";
function report(result: Result, note = "") {
  const failed = result.code !== 0;
  if (live && !result.output) {
    if (result.killed) console.log(`\n${result.file} was killed after ${result.limit} s.`);
    return;
  }
  const line = `${failed ? "✗" : "✓"} ${result.file} · ${outcome(result)}${note} · ${result.seconds.toFixed(1)} s`;
  // A GitHub log folds each file's output under its line, so all of it is kept there: a passing
  // file's per-test times are what a slow run is explained with.
  if (!failed && !verbose && !actions) return console.log(line);
  console.log(actions ? `::group::${line}` : `\n━━ ${line}`);
  if (result.output) console.log(result.output);
  console.log(actions ? "::endgroup::" : "");
}

/**
 * The first Chrome on a machine that hasn't run one (every CI runner) takes 10 to 30 s to start, and
 * the test that started it would sit through that. Start one here, and let it go, before any
 * browser file runs: the other files have every slot meanwhile.
 */
async function warmBrowser() {
  const browser = findBrowser();
  if (!browser) return;
  const warmEnv = { ...process.env };
  // As tests/chromePage.ts: current Chrome can't parse a runner's `disabled:` bus address.
  delete warmEnv.DBUS_SESSION_BUS_ADDRESS;
  delete warmEnv.DBUS_SYSTEM_BUS_ADDRESS;
  const began = performance.now();
  const child = Bun.spawn([browser, "--headless", "--disable-gpu", "--use-gl=stub", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${join(logs, "chrome")}`,
    ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--dump-dom", "about:blank"], { env: warmEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  await child.exited;
  clearTimeout(timer);
  const seconds = (performance.now() - began) / 1000;
  if (seconds > 2) console.log(`The first Chrome took ${seconds.toFixed(1)} s to start; browser files waited for it.`);
}

// Run `queue` with up to `limit` files at once, at most `browserLimit` of them using a browser, and
// none of those before `browserReady`.
async function pool(queue: Entry[], limit: number, browserLimit: number, browserReady: Promise<unknown>, done: (result: Result) => void) {
  let running = 0, browsers = 0, ready = false;
  await new Promise<void>(finished => {
    const next = () => {
      if (!queue.length && !running) return finished();
      while (running < limit) {
        const at = queue.findIndex(item => !item.browser || (ready && browsers < browserLimit));
        if (at < 0) break;
        const [item] = queue.splice(at, 1);
        running++;
        if (item!.browser) browsers++;
        void run(item!).then(done).finally(() => {
          running--;
          if (item!.browser) browsers--;
          next();
        });
      }
    };
    void browserReady.catch(() => {}).then(() => { ready = true; next(); });
    next();
  });
}

const started = performance.now();
const first: Result[] = [];
const flaky: Result[] = [];
const failed: Result[] = [];
const scope = part ? `shard ${part.index} of ${part.total}: ${entries.length} of ${all.length} test files` : `${entries.length} test files`;
// The estimate is for CI's two files at a time, one with a browser.
console.log(`Running ${scope}, ${jobs} at a time (${browserJobs} with a browser)${part ? `; about ${Math.ceil(expectedWall(entries))} s on CI` : ""}.`);
try {
  await pool([...entries], jobs, browserJobs, entries.some(entry => entry.browser) ? warmBrowser() : Promise.resolve(), result => {
    first.push(result);
    report(result, result.code !== 0 && retries ? " (will be run again)" : "");
  });
  // Again, one at a time with nothing beside it: what failed for want of CPU or frames passes now,
  // and what is broken fails the same way.
  for (const before of first.filter(result => result.code !== 0).sort((a, b) => a.file.localeCompare(b.file))) {
    let last = before;
    for (let attempt = 0; attempt < retries && last.code !== 0; attempt++) {
      last = await run(entries.find(entry => entry.file === before.file)!, true);
      report(last, last.code === 0 ? " on another run: flaky" : " again");
    }
    (last.code === 0 ? flaky : failed).push(before);
  }
} finally {
  rmSync(logs, { recursive: true, force: true });
}

const wall = (performance.now() - started) / 1000;
const total = first.reduce((sum, result) => sum + result.seconds, 0);
const slowest = [...first].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
const names = (list: Result[]) => list.map(result => `  ${result.file}${result.killed ? ` (killed after ${result.limit} s)` : ""}`).join("\n");
if (!live) console.log(`\nSlowest files:\n${slowest.map(result => `  ${result.seconds.toFixed(1).padStart(6)} s  ${result.file}`).join("\n")}`);
console.log(`\n${first.length} files in ${wall.toFixed(0)} s (${total.toFixed(0)} s of file time, ${jobs} at a time).`);
if (flaky.length) console.log(`\nFlaky (failed, then passed on their own):\n${names(flaky)}`);
if (failed.length) console.log(`\nFailed:\n${names(failed)}`);
console.log(`\n${failed.length} test files failed.`);

if (actions) {
  // Annotations show on the pull request; the summary on the run's page.
  for (const result of flaky) console.log(`::warning file=${result.file},title=Flaky test file::${result.file} failed, then passed when run again on its own.`);
  for (const result of failed) console.log(`::error file=${result.file},title=Test file failed::${result.file} ${result.killed ? "never finished" : "failed"}${retries ? ", twice" : ""}.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = (title: string, list: Result[]) => list.length ? `**${title}**\n\n${list.map(result => `- \`${result.file}\` (${result.seconds.toFixed(1)} s)`).join("\n")}\n\n` : "";
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${scope}: ${failed.length ? `${failed.length} failed` : "passed"} in ${wall.toFixed(0)} s\n\n${rows("Failed", failed)}${rows("Flaky", flaky)}${rows("Slowest", slowest.slice(0, 5))}`);
  }
}

if (record) {
  if (failed.length || flaky.length) console.log("\nTimings not recorded: the run has to pass first time.");
  else {
    // Only what's slow enough to matter to the balance; the rest count as a second each.
    const slow = first.filter(result => result.seconds >= 2).sort((a, b) => a.file.localeCompare(b.file));
    writeFileSync(TIMINGS, `${JSON.stringify(Object.fromEntries(slow.map(result => [result.file, Math.round(result.seconds * 10) / 10])), null, 2)}\n`);
    console.log(`\nRecorded ${slow.length} timings in scripts/test-timings.json.`);
  }
}
process.exit(failed.length ? 1 : 0);
