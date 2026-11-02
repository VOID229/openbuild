# Automatic nightly releases

Pushing to `main` runs `.github/workflows/nightly.yml`. A frozen Bun dependency
install, typecheck, and full test suite must pass before publishing a GitHub
prerelease of that exact commit. Stable releases remain manual.

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
