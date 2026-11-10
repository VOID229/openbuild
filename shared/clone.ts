// Where a clone lands, shared by the Clone repository dialog and the server: a folder that's already
// there gets the clone in a subfolder named after the repository, any other path is the clone itself.

/** The folder a clone of `url` gets by default: the repository's name ("" when the URL has none). */
export const repoName = (url: string) =>
  url
    .trim()
    .replace(/[/\s]+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop() ?? "";

/** Where cloning `url` to `path` lands: inside `path` when that's an existing folder, else `path` itself. */
export function cloneTarget(url: string, path: string, isFolder: boolean): string {
  const name = repoName(url);
  if (!isFolder || !name || name === "." || name === "..") return path;
  return `${path.replace(/\/+$/, "")}/${name}`;
}
