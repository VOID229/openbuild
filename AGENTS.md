# Working on OpenBuild

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
   every check passes. Don't skip, disable or weaken a test to get there; if a failure is unrelated
   to the change (flaky, or broken on `main`), say so with the evidence instead.
5. **Report** the PR link and its check status. Don't merge it: merging is the user's call. Once it
   merges, OpenBuild closes the thread and removes its worktree by itself.

If a thread is on `main` in the project's own checkout rather than a worktree, ask before
committing; don't push to `main`.

## Running server

The OpenBuild server on this machine runs from the main checkout in production mode. Never restart
it unless asked; say when a change needs a restart to go live.
