// The rules behind the folder field's shell-style completion (src/components/PathField.tsx): how a
// typed path splits into the part that stays and the last folder's name being completed, and what
// Tab makes of the folders that match. Kept here, apart from the field, so they can be tested.

export interface PathParts {
  /** What a completed path starts with, exactly as typed (so it ends with "/"). */
  head: string;
  /** The folder to list on the device. "~" and "~/" are the home folder; "/" is the root. */
  dir: string;
  /** The part of the last folder's name being completed ("" after a "/"). */
  fragment: string;
}

/**
 * Split a typed path at its last "/". A path with no folder part yet completes under the home
 * folder, and gains its "~/" head, since a path with no root would mean something else entirely on
 * the device that reads it.
 */
export function pathParts(value: string): PathParts {
  // A bare "~" is home itself, so it completes the way "~/" does.
  if (value === "~") return { head: "~/", dir: "~", fragment: "" };
  const slash = value.lastIndexOf("/");
  const head = slash === -1 ? "" : value.slice(0, slash + 1);
  const fragment = value.slice(slash + 1);
  if (!head) return { head: "~/", dir: "~", fragment };
  return { head, dir: head, fragment };
}

/** The start every name shares ("" when they share none). */
export function commonPrefix(names: string[]): string {
  const [first = "", ...rest] = names;
  let prefix = first;
  for (const name of rest) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) return "";
  }
  return prefix;
}

/**
 * The path Tab produces. `names` are the folders that match the fragment; `active` is the one the
 * arrow keys picked (already chosen, so it completes to that folder and nothing else). With no
 * pick, one match completes to the folder, and several complete to what they share, which usually
 * gets to the next "/" in a step or two.
 */
export function completePath(value: string, names: string[], active?: number): string {
  if (!names.length) return value;
  const { head, fragment } = pathParts(value);
  if (active !== undefined && names[active] !== undefined) return `${head}${names[active]}/`;
  if (names.length === 1) return `${head}${names[0]}/`;
  const prefix = commonPrefix(names);
  // A common prefix no longer than what's typed adds nothing (and mustn't rewrite its case).
  return prefix.length > fragment.length ? `${head}${prefix}` : value;
}

/** The matches for a fragment, in the order the device listed them; never more than a list can show. */
export function matchFolders(names: string[], fragment: string, limit = 100): string[] {
  const q = fragment.toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(q)).slice(0, limit);
}
