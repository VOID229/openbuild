// The side panel's pull requests tab, app side (server/pullRequestView.ts does the asking): reading
// and acting on pull requests, what a pull request's state means for merging it, and reads that stay
// fresh while they're showing. Every read is kept (lists and pull requests across reloads too) and
// asked for ahead of time, so the tab shows what it last knew at once and catches up after.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PullDetail, PullList, PullListState, PullMergeMethod, PullPatch } from "../../shared/types";
import { apiUrl } from "./devices";
import { json } from "./git";
import { folderKey } from "./panel";
import type { TerminalFolder } from "./terminal";

type Folder = Pick<TerminalFolder, "deviceId" | "cwd">;

// A paired device can run an older server than this one.
const answer = <T>(res: Response) => (res.status === 404 ? Promise.reject<T>(new Error("This server is too old for pull requests. Restart it to update.")) : json<T>(res));

const read = <T>(folder: Folder, path: string, query: Record<string, string | number | true | undefined>) => {
  const params = new URLSearchParams({ cwd: folder.cwd ?? "" });
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  return fetch(apiUrl(folder.deviceId, `/api/workspaces/pulls${path}?${params}`)).then((r) => answer<T>(r));
};

const act = (folder: Folder, path: string, body: Record<string, unknown>) =>
  fetch(apiUrl(folder.deviceId, `/api/workspaces/pulls/${path}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: folder.cwd, ...body }) }).then((r) => answer<{ ok: boolean }>(r));

/** `fresh`: past the server's few seconds of sharing a read, as the Refresh button wants. */
export const listPulls = (folder: Folder, state: PullListState, fresh = false) => read<PullList>(folder, "", { state, fresh: fresh || undefined });
export const viewPull = (folder: Folder, number: number, fresh = false) => read<PullDetail>(folder, "/view", { number, fresh: fresh || undefined });
// A folder's repository doesn't change, so it's asked once (again after a failure).
const repos = new Map<string, Promise<string | undefined>>();
const repoUrls = new Map<string, string | undefined>();
const folderId = (folder: Folder) => `${folder.deviceId ?? "local"}:${folder.cwd ?? ""}`;

/** The folder's GitHub repository (`https://github.com/o/r`), or undefined when it has none or gh can't say. */
export function pullRepo(folder: Folder): Promise<string | undefined> {
  const key = folderId(folder);
  let known = repos.get(key);
  if (!known) {
    known = read<{ url: string }>(folder, "/repo", {}).then(
      ({ url }) => (repoUrls.set(key, url), url),
      () => (repos.delete(key), undefined),
    );
    repos.set(key, known);
  }
  return known;
}

/** The folder's repository if it's already known: `null` while it hasn't been asked or answered. */
export const knownPullRepo = (folder: Folder): string | undefined | null => (repoUrls.has(folderId(folder)) ? repoUrls.get(folderId(folder)) : null);


export const pullPatch = (folder: Folder, number: number, sha?: string) => read<PullPatch>(folder, "/patch", { number, sha });
/** Asks the app to load its threads again now, rather than at its next poll. */
export const RELOAD_THREADS = "openbuild:reload-threads";

/** Merge, then pick up the thread the merge closed (the server closes it before answering). */
export const mergePull = (folder: Folder, number: number, method: PullMergeMethod, headSha: string, deleteBranch: boolean) =>
  act(folder, "merge", { number, method, headSha, deleteBranch }).then((r) => {
    window.dispatchEvent(new Event(RELOAD_THREADS));
    return r;
  });
export const editPull = (folder: Folder, number: number, title: string, body: string) => act(folder, "edit", { number, title, body });
export const commentOnPull = (folder: Folder, number: number, body: string) => act(folder, "comment", { number, body });
export const setPullState = (folder: Folder, number: number, action: "close" | "reopen" | "ready") => act(folder, "state", { number, action });

// The merge the user picked last, shared by the pull request tab and the Commit menu.
export const METHOD_KEY = "openbuild:pr-merge-method";
export const DELETE_KEY = "openbuild:pr-delete-branch";

/** The merge method to use without asking: the last one picked, if this repository allows it. */
export function preferredMethod(methods: PullMergeMethod[]): PullMergeMethod {
  const last = localStorage.getItem(METHOD_KEY) as PullMergeMethod | null;
  return last && methods.includes(last) ? last : (methods[0] ?? "merge");
}

export { mergeReadiness, mergeUnsettled, type Readiness } from "../../shared/pullReadiness";

/** How soon to read a pull request again while GitHub is still working out whether it can merge. */
export const SETTLE_REFRESH = 3_000;

// The last answer to each read, so showing the tab again doesn't start from nothing. Lists and pull
// requests are also kept in localStorage for the next load; diffs can be big, so they aren't.
const CACHE_SIZE = 60;
const STORE_KEY = "openbuild:pulls-cache";
const STORED = 30;
const cache = new Map<string, { at: number; value: unknown }>();
const stored = (key: string) => !key.includes("|patch|");

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as [string, { at: number; value: unknown }][];
  for (const [key, entry] of saved) if (entry && typeof entry.at === "number") cache.set(key, entry);
} catch {
  // Nothing kept, or it isn't readable: start from nothing.
}

let saving: ReturnType<typeof setTimeout> | undefined;
function persist() {
  if (saving) return;
  saving = setTimeout(() => {
    saving = undefined;
    const keep = [...cache].filter(([key]) => stored(key)).slice(-STORED);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(keep));
    } catch {
      // Out of room: better nothing kept than half.
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {}
    }
  }, 500);
}

function remember(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  if (stored(key)) persist();
}

const held = <T>(key: string) => cache.get(key)?.value as T | undefined;

// One ask per key at a time, whether it's the tab or a look ahead that asked.
const asking = new Map<string, Promise<unknown>>();

function fetchInto<T>(key: string, load: () => Promise<T>): Promise<T> {
  const pending = asking.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .finally(() => asking.delete(key));
  asking.set(key, p);
  return p;
}

/** How long something read ahead counts as fresh enough not to read again. */
const AHEAD_FRESH = 20_000;

/** Read `key` in the background unless it's been read lately; what comes back waits in the cache. */
function ahead<T>(key: string, load: () => Promise<T>): Promise<T | undefined> {
  const known = cache.get(key);
  if (known && Date.now() - known.at < AHEAD_FRESH) return Promise.resolve(known.value as T);
  return fetchInto(key, load).catch(() => undefined);
}

export const listKey = (folder: Folder, state: PullListState) => `${folderKey(folder)}|list|${state}`;
export const pullKey = (folder: Folder, number: number) => `${folderKey(folder)}|pull|${number}`;
export const patchKey = (folder: Folder, number: number, sha: string) => `${folderKey(folder)}|patch|${number}|${sha}`;

/** How many of a list's pull requests to read ahead, from the top. */
const AHEAD_PULLS = 4;

/**
 * Read a folder's pull requests before they're asked for: the open ones, this branch's in full, and
 * with `all`, the merged and closed lists and the first few open ones too.
 */
export async function prefetchPulls(folder: Folder, all = false) {
  if (!folder.cwd) return;
  const open = await ahead(listKey(folder, "open"), () => listPulls(folder, "open"));
  if (!open?.gh || !open.repo) return;
  const numbers = [...new Set([open.current, ...(all ? open.pulls.slice(0, AHEAD_PULLS).map((p) => p.number) : [])])].filter((n): n is number => typeof n === "number");
  await Promise.all([
    ...numbers.map((n) => prefetchPull(folder, n)),
    ...(all ? (["merged", "closed"] as const).map((state) => ahead(listKey(folder, state), () => listPulls(folder, state))) : []),
  ]);
}

/** Read one pull request ahead (pointing at its row, say). */
export const prefetchPull = (folder: Folder, number: number) => ahead(pullKey(folder, number), () => viewPull(folder, number));

/** Read a pull request's whole diff ahead, while its overview is showing. */
export const prefetchPatch = (folder: Folder, number: number, sha: string) => ahead(patchKey(folder, number, sha), () => pullPatch(folder, number));

/**
 * A read named by `key`, redone every `every` ms while the page is in view (0: once per key). What
 * was read last shows at once, then is read again. `load(true)` should skip the server's sharing.
 */
export function usePullRead<T>(key: string, load: (fresh: boolean) => Promise<T>, every: number) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(() => ({ key, data: held<T>(key) }));
  const [loading, setLoading] = useState(false);
  const loader = useRef(load);
  loader.current = load;
  const latest = useRef(key);
  latest.current = key;
  const reload = useCallback(async (quiet = false, fresh = false) => {
    const asked = latest.current;
    if (!quiet) setLoading(true);
    try {
      const data = await (fresh ? loader.current(true).then((value) => (remember(asked, value), value)) : fetchInto(asked, () => loader.current(false)));
      if (latest.current === asked) setState({ key: asked, data });
    } catch (err) {
      if (latest.current === asked) setState((s) => ({ key: asked, data: s.key === asked ? s.data : undefined, error: (err as Error).message }));
    } finally {
      if (!quiet && latest.current === asked) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setState({ key, data: held<T>(key) });
    // Diffs are kept by commit, so one already here can't be out of date.
    const known = cache.get(key);
    if (!(every === 0 && known)) void reload(!!known);
    if (!every) return;
    const tick = () => document.visibilityState === "visible" && void reload(true);
    const timer = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [key, every, reload]);
  // Between a key changing and the effect above, what's held still belongs to the old key.
  const current = state.key === key ? state : { key, data: held<T>(key) };
  return { data: current.data as T | undefined, error: "error" in current ? current.error : undefined, loading, reload };
}
