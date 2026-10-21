// Client side of the Pi and project APIs (server/pi/routes.ts).
import { readEvents } from "../../shared/replies";
import type { GitInfo, ModelInfo, PiCommand, Project, Workspace } from "../../shared/types";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}
const get = <T>(url: string) => fetch(url).then((r) => json<T>(r));
const send = <T>(url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => json<T>(r));

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

export const piStatus = (fresh = false) => get<PiStatus>(`/api/pi/status${fresh ? "?fresh=1" : ""}`);
export const installPi = () => send<{ job: string }>("/api/pi/install", "POST");
export const updatePi = (all = false) => send<{ job: string }>("/api/pi/update", "POST", { all });

/** Follow the current maintenance job's output; resolves with its exit code. */
export async function followJob(onLine: (line: string) => void, signal?: AbortSignal): Promise<{ code?: number; title?: string } | undefined> {
  const res = await fetch("/api/pi/job", { signal });
  if (!res.ok || !res.body || res.status === 204) return undefined;
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
export const piProblems = () => get<{ problems: PiProblem[] }>("/api/pi/problems").then((r) => r.problems);
export const clearPiProblems = () => send("/api/pi/problems", "DELETE");

// ------------------------------------------------------------------ models, commands, threads

export interface PiModels {
  models: ModelInfo[];
  defaultModel?: string;
  checkedAt: number;
}
export const piModels = (fresh = false) => get<PiModels>(`/api/pi/models${fresh ? "?fresh=1" : ""}`);

export const piCommands = (cwd?: string) => get<{ commands: PiCommand[] }>(`/api/pi/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`).then((r) => r.commands);

export const answerAsk = (threadId: string, askId: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
  send(`/api/pi/threads/${encodeURIComponent(threadId)}/answer`, "POST", { askId, ...reply });

export const compactThread = (threadId: string, instructions?: string) =>
  send<{ tokensBefore: number; estimatedTokensAfter?: number }>(`/api/pi/threads/${encodeURIComponent(threadId)}/compact`, "POST", { instructions });

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
export const piProviders = () => get<{ providers: PiProvider[] }>("/api/pi/providers").then((r) => r.providers);
export const logoutProvider = (id: string) => send(`/api/pi/providers/${encodeURIComponent(id)}/logout`, "POST");

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

export const startLogin = (provider: string, type: "api_key" | "oauth") => send<{ id: string }>("/api/pi/login", "POST", { provider, type }).then((r) => r.id);
export async function* followLogin(id: string, signal: AbortSignal): AsyncGenerator<LoginRecord> {
  const res = await fetch(`/api/pi/login/${encodeURIComponent(id)}`, { signal });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Sign-in failed");
  yield* readEvents(res.body) as AsyncGenerator<any>;
}
export const answerLogin = (id: string, promptId: string, value?: string) => send(`/api/pi/login/${encodeURIComponent(id)}/answer`, "POST", { promptId, value });
export const cancelLogin = (id: string) => send(`/api/pi/login/${encodeURIComponent(id)}/cancel`, "POST");

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
export const piResources = () => get<{ resources: PiResource[]; packages: string[] }>("/api/pi/resources");
export const toggleResource = (kind: ResourceKind, id: string, enabled: boolean) => send("/api/pi/resources/toggle", "POST", { kind, id, enabled });
export const readResourceFile = (path: string) => get<{ content: string }>(`/api/pi/resources/file?path=${encodeURIComponent(path)}`).then((r) => r.content);
export const writeResourceFile = (path: string, content: string) => send("/api/pi/resources/file", "PUT", { path, content });
export const removeResource = (id: string) => send<{ trash: string }>("/api/pi/resources/remove", "POST", { id }).then((r) => r.trash);
export const createResource = (kind: ResourceKind, name: string) => send<{ path: string }>("/api/pi/resources/create", "POST", { kind, name }).then((r) => r.path);
export const installPackage = (source: string) => send<{ job: string }>("/api/pi/packages", "POST", { source });
export const removePackage = (source: string) => send<{ job: string }>("/api/pi/packages", "DELETE", { source });

// ------------------------------------------------------------------ projects and workspaces

export const listProjects = () => get<{ projects: Project[] }>("/api/projects").then((r) => r.projects);
export const addProject = (path: string) => send<{ project: Project }>("/api/projects", "POST", { path }).then((r) => r.project);
export const renameProject = (id: string, name: string) => send(`/api/projects/${encodeURIComponent(id)}`, "PATCH", { name });
export const removeProject = (id: string) => send(`/api/projects/${encodeURIComponent(id)}`, "DELETE");
export const discoverProjects = () => get<{ found: { name: string; path: string }[] }>("/api/projects/discover").then((r) => r.found);
export const projectGit = (id: string) => get<GitInfo>(`/api/projects/${encodeURIComponent(id)}/git`);
export const browseFolders = (dir?: string) =>
  get<{ dir: string; parent?: string; entries: { name: string; path: string; git: boolean }[] }>(`/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
export const workspaceGit = (cwd: string) => get<GitInfo>(`/api/workspaces/git?cwd=${encodeURIComponent(cwd)}`);
export const prepareWorkspace = (req: { projectId?: string; mode: "local" | "worktree" | "scratch"; branch?: string; name?: string }) =>
  send<{ workspace: Workspace }>("/api/workspaces", "POST", req).then((r) => r.workspace);
export const removeWorktree = (cwd: string, force = false) => send("/api/workspaces/remove", "POST", { cwd, force });
