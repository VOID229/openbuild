# Automatic nightly releases

Pushing to `main` runs `.github/workflows/nightly.yml`, which publishes a GitHub
prerelease of that exact commit. Nothing is checked again there: every change
reaches `main` through a pull request, and `.github/workflows/checks.yml` ran
the typecheck and the full test suite on it. Promoting a version to stable is
manual (below).

## The checks

A pull request runs the typecheck and the suite in four parallel jobs
(`bun run test --shard 1/4` … `4/4`), and the `checks` job, the one branch
protection requires, is green only when all of them are. `scripts/test.ts` deals
the files out so the four take about as long as each other, using the timings in
`scripts/test-timings.json`; `bun run test --timings` records them again after a
full passing run, which is worth doing when slow tests are added or removed.

A fresh runner's first Chrome takes 10 to 30 seconds to start. The workflow
starts one in the background before the install, and the test runner holds the
browser files back until a Chrome has started, giving the other files every
slot meanwhile.

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

OpenBuild has one line of versions, `x.y.z`. Every merge to `main` is the next
one: `z` goes up by 1, and after `z = 99` it rolls over to the next `y` at
`z = 0` (`0.1.99` → `0.2.0`). The workflow tags the commit `x.y.z-nightly` and
publishes it as a prerelease (`scripts/next-version.ts`, `shared/version.ts`).
No version-bump commit is needed. Tags are permanent; rerunning a successful
workflow keeps the commit's tag and does not replace its release.

New pushes cancel older runs. The publish step also skips commits that are no
longer the tip of `main`, including manually rerun workflows. The workflow can
be started manually with **Run workflow** on `main`.

GitHub Actions must be enabled, and repository rules must allow the workflow's
`GITHUB_TOKEN` to create release tags. No personal access token is needed.
Only the publish jobs have `contents: write` permission.

Publishing a release does not install it or restart running installations.

## Promoting a version to stable

Stable isn't a number of its own: it's a version declared stable. Run
**Promote to stable** (`.github/workflows/promote.yml`) with the version, for
example `0.1.9`. It adds a plain `0.1.9` tag on the commit `0.1.9-nightly`
names, published as a full (non-prerelease) release. Any version can be
promoted, so stable can be `0.2.x` while the nightlies are further on.

A plain tag is what makes a version stable, so everything finds it from the
repository's tags (`git ls-remote --tags`), without GitHub's API:

- the installer: `install.sh` installs the newest plain tag, and
  `install.sh --nightly` the newest version of any kind, by its nightly tag;
- `ob update` and the server's update notice, on the installation's track;
- the sidebar, which shows a promoted version as stable.

Installations from before this go by GitHub's prerelease flag, which the
promoted release doesn't have, so they find it too.

Tags from before this scheme keep working. The plain tags up to `0.1.8` are
stable releases, and an `x.y.z-nightly.<date>.<run>` tag is a nightly from
after the `x.y.z` it names: `0.1.8-nightly.20261111.275` is newer than `0.1.8`
and older than `0.1.9-nightly`.

## The version in the sidebar

The foot of the sidebar names the running release: `Nightly 0.1.9`, or
`Stable 0.1.9` once `0.1.9` is promoted. There is no build step to stamp a
version, so the server reads it from the version tags in its commit's history
when it starts (`server/version.ts`) and sends it with `/api/config`:

- An installation is a checkout of a release tag (`install.sh`, `ob update`),
  so HEAD's own tags name it.
- A checkout between releases is named after the newest release in its
  history (by commit date; never an ancestor before its descendant).
- A source archive has no `.git`; git writes the commit and its ref names into
  `.release-ref` as it makes the archive (`export-subst` in `.gitattributes`),
  and the server reads that instead.
- A version promoted after it was installed shows as stable once the release
  check (at most hourly) has seen its plain tag.
- With nothing to go on (an archive of an untagged commit, a history without
  release tags), the sidebar shows no version.

An update moves the checkout on, but the label keeps naming the release the
server started as until it restarts.
