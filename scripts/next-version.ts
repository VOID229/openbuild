// The tag for a commit merged to main, for .github/workflows/nightly.yml: the next version after the
// newest one tagged, as x.y.z-nightly, or the tag the commit already has when its workflow is rerun.
//   bun scripts/next-version.ts <commit>
import { nightlyTagFor } from "../shared/version";

const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `git ${args[0]} failed`);
  return p.stdout.toString().split("\n").filter(Boolean);
};

try {
  const commit = process.argv[2] ?? "HEAD";
  console.log(nightlyTagFor(git("tag", "--points-at", commit), git("tag")));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
