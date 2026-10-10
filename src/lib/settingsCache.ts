// Last-known values for Settings, so a section that remounts (every time you switch to it) paints
// its data at once instead of blanking while the live query or storage read comes back. The live
// value always wins once it arrives; the cache only fills the gap.
import { useQuery } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useReducer } from "react";

const queries = new Map<string, unknown>();

/** Like useQuery, but returns the last value seen for these args while the live one is still loading. */
export function useCachedQuery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
): FunctionReturnType<Q> | undefined {
  const live = useQuery(query, args);
  const key = args === "skip" ? undefined : `${getFunctionName(query)}:${JSON.stringify(args)}`;
  useEffect(() => {
    if (key !== undefined && live !== undefined) queries.set(key, live);
  }, [key, live]);
  if (live !== undefined) return live;
  return key !== undefined ? (queries.get(key) as FunctionReturnType<Q> | undefined) : undefined;
}

const values = new Map<string, unknown>();

/**
 * An async value keyed by a string (e.g. a username), read once per mount. The last result for the
 * key is returned immediately on remount while the fresh read runs.
 */
export function useCachedAsync<T>(key: string | undefined, read: (key: string) => Promise<T>): [T | undefined, () => void] {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const refresh = useCallback(() => {
    if (key === undefined) return;
    void read(key).then((value) => {
      values.set(key, value);
      rerender();
    });
    // `read` is a module-level function in every caller, so it's stable enough to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(refresh, [refresh]);
  return [key === undefined ? undefined : (values.get(key) as T | undefined), refresh];
}
