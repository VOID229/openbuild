// Client side of the Pi and project APIs (server/pi/routes.ts).
import { readEvents } from "../../shared/replies";
import type { Device, GitInfo, ModelInfo, ModelScope, PiCommand, Project, Workspace } from "../../shared/types";
import { apiUrl, splitProjectId } from "./devices";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}
const get = <T>(url: string) => fetch(url).then((r) => json<T>(r));
const send = <T>(url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => json<T>(r));

/** A paired device's id; undefined means this server. */
type DeviceId = string | undefined;

// ------------------------------------------------------------------ install and status

export interface PiStatus {
  installed: boolean;
  bin?: string;
  version?: string;
  latest?: string;
  updateAvailable: boolean;
  checkError?: string;
  kind: "managed" | "npm" | "other" | "missing";
  agentDir: string;
  node: string;
}

// A trailing `deviceId` means "that paired device's Pi": the request goes through the proxy and
// the device's server installs, updates and lists its own Pi.

export const piStatus = (fresh = false, deviceId?: DeviceId) => get<PiStatus>(apiUrl(deviceId, `/api/pi/status${fresh ? "?fresh=1" : ""}`));
export const installPi = (deviceId?: DeviceId) => send<{ job: string }>(apiUrl(deviceId, "/api/pi/install"), "POST");
export const updatePi = (all = false, deviceId?: DeviceId) => send<{ job: string }>(apiUrl(deviceId, "/api/pi/update"), "POST", { all });

/** Follow the current maintenance job's output; resolves with its exit code. */
export async function followJob(onLine: (line: string) => void, signal?: AbortSignal, onStart?: () => void, deviceId?: DeviceId): Promise<{ code?: number; title?: string } | undefined> {
  const res = await fetch(apiUrl(deviceId, "/api/pi/job"), { signal });
  if (!res.ok || !res.body || res.status === 204) return undefined;
  // Only a real job stream counts as running: an empty answer must not flash a progress panel.
  onStart?.();
  for await (const r of readEvents(res.body) as AsyncGenerator<any>) {
    if (r.line !== undefined) onLine(r.line);
    if (r.done) return { code: r.code, title: r.title };
  }
  return undefined;
}

export interface PiProblem {
  at: number;
  source: string;
  message: string;
}
export const piProblems = (deviceId?: DeviceId) => get<{ problems: PiProblem[] }>(apiUrl(deviceId, "/api/pi/problems")).then((r) => r.problems);
export const clearPiProblems = (deviceId?: DeviceId) => send(apiUrl(deviceId, "/api/pi/problems"), "DELETE");

// ------------------------------------------------------------------ models, commands, threads

export interface PiModels {
  models: ModelInfo[];
  defaultModel?: string;
  /** The models this device's Pi settings (`enabledModels`) scope the picker to; absent = all. */
  scope?: ModelScope;
  checkedAt: number;
}
export const piModels = (fresh = false, deviceId?: DeviceId) => get<PiModels>(apiUrl(deviceId, `/api/pi/models${fresh ? "?fresh=1" : ""}`));

/** Prices for models Pi no longer lists, by "<provider>/<model id>". */
export const piModelPrices = (ids: string[]) =>
  get<{ models: Record<string, Pick<ModelInfo, "billing" | "price" | "priceFrom" | "contextLimit">> }>(`/api/pi/prices?ids=${encodeURIComponent(ids.join(","))}`).then((r) => r.models);

export const piCommands = (cwd?: string, deviceId?: string) =>
  get<{ commands: PiCommand[] }>(apiUrl(deviceId, `/api/pi/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)).then((r) => r.commands);

export const answerAsk = (threadId: string, askId: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }, deviceId?: string) =>
  send(apiUrl(deviceId, `/api/pi/threads/${encodeURIComponent(threadId)}/answer`), "POST", { askId, ...reply });

export const steerThread = (threadId: string, steerId: string, message: string, images?: { data: string; mimeType: string }[], deviceId?: string) =>
  send<{ handled: boolean }>(apiUrl(deviceId, `/api/pi/threads/${encodeURIComponent(threadId)}/steer`), "POST", { steerId, message, images });

export const compactThread = (threadId: string, instructions?: string, deviceId?: string) =>
  send<{ tokensBefore: number; estimatedTokensAfter?: number }>(apiUrl(deviceId, `/api/pi/threads/${encodeURIComponent(threadId)}/compact`), "POST", { instructions });

export const completeOnce = (model: string, system: string, prompt: string, signal?: AbortSignal) =>
  fetch("/api/pi/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, system, prompt }), signal })
    .then((r) => json<{ text: string }>(r))
    .then((r) => r.text);

// ------------------------------------------------------------------ providers and sign-in

export interface PiProvider {
  id: string;
  name: string;
  apiKey?: { name: string; canLogin: boolean };
  oauth?: { name: string; label?: string; subscription: boolean };
  status: { configured: boolean; source?: string; label?: string };
  stored?: "api_key" | "oauth";
  models: number;
}
export const piProviders = (deviceId?: DeviceId) => get<{ providers: PiProvider[] }>(apiUrl(deviceId, "/api/pi/providers")).then((r) => r.providers);
export const logoutProvider = (id: string, deviceId?: DeviceId) => send(apiUrl(deviceId, `/api/pi/providers/${encodeURIComponent(id)}/logout`), "POST");

export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };
export type AuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };
export type LoginRecord =
  | { type: "prompt"; id: string; prompt: AuthPrompt }
  | { type: "prompt_closed"; id: string }
  | { type: "event"; event: AuthEvent }
  | { type: "done" }
  | { type: "error"; message: string };

export const startLogin = (provider: string, type: "api_key" | "oauth", deviceId?: DeviceId) =>
  send<{ id: string }>(apiUrl(deviceId, "/api/pi/login"), "POST", { provider, type }).then((r) => r.id);
export async function* followLogin(id: string, signal: AbortSignal, deviceId?: DeviceId): AsyncGenerator<LoginRecord> {
  const res = await fetch(apiUrl(deviceId, `/api/pi/login/${encodeURIComponent(id)}`), { signal });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Sign-in failed");
  yield* readEvents(res.body) as AsyncGenerator<any>;
}
export const answerLogin = (id: string, promptId: string, value?: string, deviceId?: DeviceId) =>
  send(apiUrl(deviceId, `/api/pi/login/${encodeURIComponent(id)}/answer`), "POST", { promptId, value });
export const cancelLogin = (id: string, deviceId?: DeviceId) => send(apiUrl(deviceId, `/api/pi/login/${encodeURIComponent(id)}/cancel`), "POST");

// ------------------------------------------------------------------ extensions, skills, prompts

export type ResourceKind = "extension" | "skill" | "prompt";
export interface PiResource {
  kind: ResourceKind;
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  builtin?: boolean;
  files: string[];
}
export const piResources = (deviceId?: DeviceId) => get<{ resources: PiResource[]; packages: string[] }>(apiUrl(deviceId, "/api/pi/resources"));
export const toggleResource = (kind: ResourceKind, id: string, enabled: boolean, deviceId?: DeviceId) =>
  send(apiUrl(deviceId, "/api/pi/resources/toggle"), "POST", { kind, id, enabled });
export const readResourceFile = (path: string, deviceId?: DeviceId) =>
  get<{ content: string }>(apiUrl(deviceId, `/api/pi/resources/file?path=${encodeURIComponent(path)}`)).then((r) => r.content);
export const writeResourceFile = (path: string, content: string, deviceId?: DeviceId) => send(apiUrl(deviceId, "/api/pi/resources/file"), "PUT", { path, content });
export const removeResource = (id: string, deviceId?: DeviceId) =>
  send<{ trash: string }>(apiUrl(deviceId, "/api/pi/resources/remove"), "POST", { id }).then((r) => r.trash);
export const createResource = (kind: ResourceKind, name: string, deviceId?: DeviceId) =>
  send<{ path: string }>(apiUrl(deviceId, "/api/pi/resources/create"), "POST", { kind, name }).then((r) => r.path);
export const installPackage = (source: string, deviceId?: DeviceId) => send<{ job: string }>(apiUrl(deviceId, "/api/pi/packages"), "POST", { source });
export const removePackage = (source: string, deviceId?: DeviceId) => send<{ job: string }>(apiUrl(deviceId, "/api/pi/packages"), "DELETE", { source });

// ------------------------------------------------------------------ devices

/** Paired devices (online and offline) this OpenBuild can use. */
export const listDevices = () => get<{ devices: Device[] }>("/api/devices").then((r) => r.devices);
export const removeDevice = (id: string) => send(`/api/devices/${encodeURIComponent(id)}`, "DELETE");

// ------------------------------------------------------------------ projects and workspaces

/** Projects on this server, or on a paired device. Remote ids are namespaced by the caller. */
export const listProjects = (deviceId?: DeviceId) => get<{ projects: Project[] }>(apiUrl(deviceId, "/api/projects")).then((r) => r.projects);
/** `create` makes the folder when it doesn't exist yet; `name` defaults to the folder's. */
export const addProject = (path: string, deviceId?: DeviceId, opts: { name?: string; create?: boolean } = {}) =>
  send<{ project: Project }>(apiUrl(deviceId, "/api/projects"), "POST", { path, ...opts }).then((r) => r.project);
/** Clone a repository into `path` (which mustn't exist yet) and add it as a project. */
export const cloneProject = (url: string, path: string, deviceId?: DeviceId) =>
  send<{ project: Project }>(apiUrl(deviceId, "/api/projects/clone"), "POST", { url, path }).then((r) => r.project);
export const renameProject = (id: string, name: string, deviceId?: DeviceId) => send(apiUrl(deviceId, `/api/projects/${encodeURIComponent(id)}`), "PATCH", { name });
export const removeProject = (id: string, deviceId?: DeviceId) => send(apiUrl(deviceId, `/api/projects/${encodeURIComponent(id)}`), "DELETE");
export const projectGit = (id: string, deviceId?: DeviceId) => get<GitInfo>(apiUrl(deviceId, `/api/projects/${encodeURIComponent(id)}/git`));
/** A folder's subfolders on `deviceId` (this server without one). `hidden` also lists dotfolders. */
export const browseFolders = (dir?: string, deviceId?: DeviceId, hidden = false) =>
  get<{ dir: string; parent?: string; entries: { name: string; path: string; git: boolean }[] }>(
    apiUrl(deviceId, `/api/fs?${new URLSearchParams({ ...(dir ? { dir } : {}), ...(hidden ? { hidden: "1" } : {}) })}`),
  );
/** Whether this browser can use the server's native folder picker (only when both are on one machine). */
export const folderPickerAvailable = () => get<{ available: boolean }>("/api/native/folder").then((r) => r.available, () => false);
/** Open the native folder picker; null when it was cancelled. */
export const pickFolder = (dir?: string) => send<{ path: string | null }>("/api/native/folder", "POST", { dir }).then((r) => r.path);
export const workspaceGit = (cwd: string, deviceId?: DeviceId) => get<GitInfo>(apiUrl(deviceId, `/api/workspaces/git?cwd=${encodeURIComponent(cwd)}`));
/** `deviceId` is only for a scratch folder: a project's own id says which device it's on. */
export const prepareWorkspace = ({ deviceId: scratchDevice, ...req }: { projectId?: string; mode: "local" | "worktree" | "scratch"; branch?: string; name?: string; deviceId?: DeviceId }) => {
  const ref = req.projectId ? splitProjectId(req.projectId) : undefined;
  const deviceId = ref ? ref.deviceId : scratchDevice;
  return send<{ workspace: Workspace }>(apiUrl(deviceId, "/api/workspaces"), "POST", { ...req, projectId: ref?.id })
    .then((r) => (deviceId ? { ...r.workspace, deviceId } : r.workspace));
};
export const removeWorktree = (cwd: string, force = false, deviceId?: DeviceId) => send(apiUrl(deviceId, "/api/workspaces/remove"), "POST", { cwd, force });
