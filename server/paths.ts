// Where OpenBuild keeps its data: OPENCHAT_DATA_DIR, or the platform's per-user data directory.
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.OPENCHAT_DATA_DIR) return process.env.OPENCHAT_DATA_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "OpenBuild");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "OpenBuild");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "openbuild");
}
