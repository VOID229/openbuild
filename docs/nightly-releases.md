# Automatic nightly releases

Pushing to `main` runs `.github/workflows/nightly.yml`, which publishes a GitHub
prerelease of that exact commit. Nothing is checked again there: every change
reaches `main` through a pull request, and `.github/workflows/checks.yml` ran
the typecheck and the full test suite on it. Stable releases remain manual.

## The checks

A pull request runs the typecheck and the suite in four parallel jobs
(`bun run test --shard 1/4` … `4/4`), and the `checks` job, the one branch
protection requires, is green only when all of them are. `scripts/test.ts` deals
the files out so the four take about as long as each other, using the timings in
`scripts/test-timings.json`; `bun run test --timings` records them again after a
full passing run, which is worth doing when slow tests are added or removed.

Run the same suite locally with `bun run test` (optionally followed by a test
filename filter). Each file gets a fresh process so browser globals, fetch mocks,
and storage modules cannot affect later files. Plain `bun test` on Bun 1.3.8
shares that state between files and is not the release check. Files run in
parallel, half as many as there are CPUs and at most 3 with a headless Chrome;
`TEST_JOBS` and `TEST_BROWSER_JOBS` change that, and `TEST_JOBS=1` runs them one
at a time with live output. A passing file prints one line (`TEST_VERBOSE=1`
prints its output too, and so does a GitHub log, folded under the file's line);
a failing one prints its output.

A file that fails is run once more at the end, on its own. If it passes then, it
is listed as flaky (a warning on the pull request) and the run still passes: the
suite has tests of real timing, real browsers and real processes, and a busy
machine now and then starves one. A failure that repeats fails the run.
`TEST_RETRIES=0` turns the second run off.

## Releases

Tags use the highest stable version tag in the commit's history, followed by
`-nightly.<commit-date>.<workflow-run-number>` (for example,
`0.1.7-nightly.20261102.123`). Tags are permanent; rerunning a successful workflow
does not replace its release. No version-bump commit is needed.

New pushes cancel older runs. The publish step also skips commits that are no
longer the tip of `main`, including manually rerun workflows. The workflow can
be started manually with **Run workflow** on `main`.

GitHub Actions must be enabled, and repository rules must allow the workflow's
`GITHUB_TOKEN` to create release tags. No personal access token is needed.
Only the publish job has `contents: write` permission.

The existing nightly installer and updater discover published prereleases.
Publishing a release does not install it or restart running installations.
