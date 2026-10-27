// The thread header's Commit menu, app side (server/workspaceGit.ts does the git): the checkout's
// changes, which of them this thread made, and committing, pushing and opening a pull request.
//
// A thread owns the files its edit and write tools touched. When threads share a checkout, a commit
// can take only this thread's files, so each thread's work lands in its own commit. That's by file:
// a file two threads both edited goes in whole, with a note saying so. Files changed some other way
// (a formatter run from bash, say) belong to no thread and only go in with "All changes". A thread in
// its own worktree is isolated already, so it simply commits everything.
import { useEffect, useState } from "react";
import type { GitChange, GitChanges, Workspace } from "../../shared/types";
import { apiUrl } from "./devices";
import { generateText } from "./naming";
import type { Chat } from "./types";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}
const post = <T>(ws: Workspace, path: string, body: Record<string, unknown> = {}) =>
  fetch(apiUrl(ws.deviceId, path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ws.cwd, ...body }) }).then((r) => json<T>(r));

export const gitChanges = (ws: Workspace) => fetch(apiUrl(ws.deviceId, `/api/workspaces/changes?cwd=${encodeURIComponent(ws.cwd)}`)).then((r) => json<GitChanges>(r));
export const gitDiff = (ws: Workspace, paths?: string[]) => post<{ diff: string; recent: string[] }>(ws, "/api/workspaces/diff", { paths });
export const gitCommit = (ws: Workspace, message: string, paths?: string[]) => post<{ sha: string }>(ws, "/api/workspaces/commit", { message, paths });
export const gitPush = (ws: Workspace) => post<{ upstream: string }>(ws, "/api/workspaces/push");
export const gitPullRequest = (ws: Workspace) => post<{ url: string; existing: boolean }>(ws, "/api/workspaces/pr");

/** A tool's path argument, whichever name the tool gives it. */
const toolPath = (args?: Record<string, unknown>) => {
  const p = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof p === "string" && p ? p.replace(/^@/, "") : undefined;
};

/** `a/./b/../c` → `a/c`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
}

/**
 * The files a thread's edit and write tools touched, relative to the repository's top (`root`), with
 * the thread's folder sitting at `prefix` inside it.
 */
export function threadFiles(chat: Chat, root: string, prefix: string): Set<string> {
  const cwd = chat.workspace?.cwd ?? "";
  const files = new Set<string>();
  for (const m of chat.messages) {
    for (const part of m.parts ?? []) {
      if (part.type !== "tool" || (part.name !== "edit" && part.name !== "write")) continue;
      const raw = toolPath(part.args);
      if (!raw) continue;
      let rel: string | undefined;
      if (raw.startsWith("/")) {
        const abs = normalize(raw);
        if (abs.startsWith(`${root}/`)) rel = abs.slice(root.length + 1);
        else if (cwd && abs.startsWith(`${normalize(cwd)}/`)) rel = prefix + abs.slice(normalize(cwd).length + 1);
      } else if (!raw.startsWith("~")) rel = normalize(prefix + raw);
      if (rel && !rel.startsWith("..")) files.add(rel);
    }
  }
  return files;
}

const sameFolder = (a?: Workspace, b?: Workspace) => !!a && !!b && a.cwd === b.cwd && (a.deviceId ?? "") === (b.deviceId ?? "");

export interface CommitScope {
  /** Changes this thread made. */
  mine: GitChange[];
  /** Of those, the files other threads in this checkout edited too, and which threads. */
  shared: { path: string; threads: string[] }[];
  /** Whether committing only this thread's files leaves other changes behind (so the choice matters). */
  separable: boolean;
}

/** Which of the checkout's changes are this thread's, given the other threads working in the same folder. */
export function commitScope(chat: Chat, changes: GitChanges, chats: Chat[]): CommitScope {
  const root = changes.root ?? "";
  const prefix = changes.prefix ?? "";
  const own = threadFiles(chat, root, prefix);
  const mine = changes.files.filter((f) => own.has(f.path) || (f.from !== undefined && own.has(f.from)));
  const shared: CommitScope["shared"] = [];
  const others = chats.filter((c) => c.id !== chat.id && sameFolder(c.workspace, chat.workspace)).map((c) => ({ title: c.title, files: threadFiles(c, root, prefix) }));
  for (const f of mine) {
    const threads = others.filter((o) => o.files.has(f.path)).map((o) => o.title);
    if (threads.length) shared.push({ path: f.path, threads });
  }
  return { mine, shared, separable: !chat.workspace?.worktree && mine.length > 0 && mine.length < changes.files.length };
}

/** The paths to hand `git commit` for these changes (a rename brings its old path, so the delete goes in too). */
export const commitPaths = (files: GitChange[]) => [...new Set(files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))];

const COMMIT_SYSTEM =
  "You write git commit messages. Reply with only the message: a subject line of at most 72 characters in the imperative mood, " +
  "then, only when the change needs explaining, a blank line and a short body wrapped at 72 columns. " +
  "Follow the style of the repository's recent commits (for example a conventional-commit prefix like feat: or fix: if they use one). " +
  "No code fences, no quotes, no explanation of what you are doing.";

export function cleanCommitMessage(raw: string): string {
  let t = raw.trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  t = t.replace(/^(commit message|message)\s*:\s*/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  const [subject = "", ...body] = t.split("\n");
  if (!subject.trim()) return "";
  return [subject.trim().slice(0, 100), ...body].join("\n").trim().slice(0, 4000);
}

/** A commit message for these paths, written by the text generation models (Settings → General). */
export async function writeCommitMessage(ws: Workspace, chat: Chat | undefined, paths?: string[]): Promise<string> {
  const { diff, recent } = await gitDiff(ws, paths);
  if (!diff.trim()) throw new Error("Nothing to commit");
  const asked = chat?.messages.find((m) => m.role === "user")?.content.trim();
  const content = [
    recent.length ? `Recent commits in this repository:\n${recent.map((s) => `- ${s}`).join("\n")}` : "",
    asked ? `What the user asked for in this thread:\n${asked.slice(0, 800)}` : "",
    `The changes to commit:\n${diff}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 19_000);
  const message = await generateText({ system: COMMIT_SYSTEM, content, sessionId: `${chat?.id ?? "commit"}-commit`, chat, clean: cleanCommitMessage, timeoutMs: 60_000 });
  if (!message) throw new Error("No text generation model could write a commit message. Type one, or choose models in Settings → General.");
  return message;
}

/**
 * The checkout's changes, kept fresh: read when the thread opens, after each reply, when the page
 * comes back into view, every few seconds while it's in view, and whenever `tick` changes.
 */
export function useGitChanges(ws: Workspace | undefined, streaming: boolean, tick: number) {
  const [changes, setChanges] = useState<GitChanges>();
  const key = ws ? `${ws.deviceId ?? ""}:${ws.cwd}` : "";
  useEffect(() => setChanges(undefined), [key]);
  useEffect(() => {
    if (!ws) return;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      gitChanges(ws).then((c) => live && setChanges(c), () => {});
    };
    load();
    // While a reply is coming in, files change under it: a slower poll, and one more when it ends.
    const timer = setInterval(load, streaming ? 8000 : 5000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [key, streaming, tick]);
  return changes;
}
