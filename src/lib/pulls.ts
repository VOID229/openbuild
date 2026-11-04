// The side panel's pull requests tab, app side (server/pullRequestView.ts does the asking): reading
// and acting on pull requests, what a pull request's state means for merging it, and reads that stay
// fresh while they're showing and come back instantly when the tab is shown again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PullDetail, PullList, PullListState, PullMergeMethod, PullPatch } from "../../shared/types";
import { apiUrl } from "./devices";
import { json } from "./git";
import type { TerminalFolder } from "./terminal";

type Folder = Pick<TerminalFolder, "deviceId" | "cwd">;

// A paired device can run an older server than this one.
const answer = <T>(res: Response) => (res.status === 404 ? Promise.reject<T>(new Error("This server is too old for pull requests. Restart it to update.")) : json<T>(res));

const read = <T>(folder: Folder, path: string, query: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams({ cwd: folder.cwd ?? "" });
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  return fetch(apiUrl(folder.deviceId, `/api/workspaces/pulls${path}?${params}`)).then((r) => answer<T>(r));
};

const act = (folder: Folder, path: string, body: Record<string, unknown>) =>
  fetch(apiUrl(folder.deviceId, `/api/workspaces/pulls/${path}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: folder.cwd, ...body }) }).then((r) => answer<{ ok: boolean }>(r));

export const listPulls = (folder: Folder, state: PullListState) => read<PullList>(folder, "", { state });
export const viewPull = (folder: Folder, number: number) => read<PullDetail>(folder, "/view", { number });
export const pullPatch = (folder: Folder, number: number, sha?: string) => read<PullPatch>(folder, "/patch", { number, sha });
export const mergePull = (folder: Folder, number: number, method: PullMergeMethod, headSha: string, deleteBranch: boolean) => act(folder, "merge", { number, method, headSha, deleteBranch });
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

export { mergeReadiness, type Readiness } from "../../shared/pullReadiness";

// The last answer to each read, so showing the tab again doesn't start from nothing.
const CACHE_SIZE = 24;
const cache = new Map<string, unknown>();

function remember(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** A read named by `key`, redone every `every` ms while the page is in view (0: once per key). */
export function usePullRead<T>(key: string, load: () => Promise<T>, every: number) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(() => ({ key, data: cache.get(key) as T | undefined }));
  const [loading, setLoading] = useState(false);
  const loader = useRef(load);
  loader.current = load;
  const latest = useRef(key);
  latest.current = key;
  const reload = useCallback(async (quiet = false) => {
    const asked = latest.current;
    if (!quiet) setLoading(true);
    try {
      const data = await loader.current();
      remember(asked, data);
      if (latest.current === asked) setState({ key: asked, data });
    } catch (err) {
      if (latest.current === asked) setState((s) => ({ key: asked, data: s.key === asked ? s.data : undefined, error: (err as Error).message }));
    } finally {
      if (!quiet && latest.current === asked) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setState({ key, data: cache.get(key) as T | undefined });
    void reload(cache.has(key));
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
  const current = state.key === key ? state : { key };
  return { data: current.data as T | undefined, error: "error" in current ? current.error : undefined, loading, reload };
}
