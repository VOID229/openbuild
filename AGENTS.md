# Working on OpenBuild

These instructions apply to every agent and harness working in this repository, including Codex,
Claude Code, Pi, and OpenCode. `CLAUDE.md` imports this file so the workflow stays in one place.

## Every change lands through a pull request

Each OpenBuild thread works in its own worktree, on its own `openbuild/…` branch. Nothing is pushed
to `main` directly. When you finish an implementation, a fix or any other change:

1. **Verify it locally**: `bun run typecheck`, plus `bun run test <filter>` for the areas you touched
   (the whole suite with `bun run test` when the change is broad).
2. **Commit** on the thread's branch with a conventional message (`feat(scope): …`, `fix(scope): …`,
   `perf(scope): …`), matching `git log`. Split unrelated changes into separate commits.
3. **Open a pull request** against `main`: `git push -u origin HEAD`, then
   `gh pr create --base main --fill` (or with a written `--title`/`--body` when `--fill` says too
   little). If the branch already has an open PR, push to it instead of opening another.
4. **Babysit it until green**: `gh pr checks --watch`. When a check fails, read the log
   (`gh run view <id> --log-failed`), fix the cause, commit, push, and watch again. Repeat until
   every check passes. This is required after every push, including follow-up changes to an existing
   PR and documentation-only changes. Do not end the task while checks are pending or failing just
   because the PR was opened or local tests passed.
   A test file that fails is run once more on its own by the runner; one that passes then is marked
   flaky (a warning on the pull request) and doesn't fail the run, so a red check is a failure that
   repeated.
   Don't skip, disable or weaken a test to get there. Investigate unrelated failures too: retry a
   suspected flaky check and watch the retry to completion. If a persistent failure is broken on
   `main` or an external blocker prevents progress, report the evidence and the remaining blocker
   explicitly; never call the PR ready or green while any check is pending or failing.
5. **Report** the PR link and its check status. Don't merge it: merging is the user's call. Once it
   merges, OpenBuild closes the thread and removes its worktree by itself.

If a thread is on `main` in the project's own checkout rather than a worktree, ask before
committing; don't push to `main`.

## Running server

The OpenBuild server on this machine runs from the main checkout in production mode. Never restart
it unless asked; say when a change needs a restart to go live.
