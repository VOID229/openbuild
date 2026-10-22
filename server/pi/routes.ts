// HTTP routes for Pi (threads, models, commands, sign-in, install/update, extensions and skills)
// and for projects and workspaces. Mounted by server/index.ts behind its request checks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isStreamRef } from "../../shared/replies";
import type { ModelInfo, PiChatRequest } from "../../shared/types";
import { bad, readJson } from "../handlers";
import * as projects from "../projects";
import { localRun, Run } from "../runs";
import * as auth from "./auth";
import { status } from "./install";
import { currentJob, jobStream, startJob } from "./jobs";
import * as resources from "./resources";
import { problems } from "./rpc";
import { answer, compact, complete, forgetModels, isThreadId, listCommands, listModels, modelEfforts, restartIdle, runTurn, steer } from "./sessions";
import { piBin } from "./install";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const ndjson = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" };
const runHeaders = { ...ndjson, "x-openchat-run": "1" };
const fail = (err: unknown, status = 400) => bad((err as Error).message || String(err), status);
const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** A Pi model as the app's ModelInfo; its id is "<provider>/<model id>". */
function toModelInfo(m: any): ModelInfo {
  return {
    id: `${m.provider}/${m.id}`,
    name: m.name || m.id,
    protocol: "chat",
    reasoning: { efforts: modelEfforts(m), mode: "effort", toggle: false },
    input: Array.isArray(m.input) ? m.input : ["text"],
    contextLimit: m.contextWindow,
    outputLimit: m.maxTokens,
    outputCost: m.cost?.output,
    tools: true,
    provider: m.provider,
  };
}

function isPiChat(b: any): b is PiChatRequest {
  return (
    !!b &&
    isThreadId(b.threadId) &&
    str(b.cwd, 1024) &&
    str(b.model, 512) &&
    b.model.includes("/") &&
    typeof b.message === "string" &&
    b.message.length < 2_000_000 &&
    Number.isInteger(b.prior) &&
    b.prior >= 0 &&
    (b.forkFrom === undefined || isThreadId(b.forkFrom)) &&
    validImages(b.images)
  );
}

const validImages = (images: any) =>
  images === undefined || (Array.isArray(images) && images.length <= 20 && images.every((i: any) => str(i?.data, 30_000_000) && str(i?.mimeType, 100)));

/** A run that produces its events itself (no upstream response to read). */
function startStream(produce: (signal: AbortSignal) => ReadableStream<Uint8Array>): Run {
  const run = new Run();
  void (async () => {
    const { readEvents } = await import("../../shared/replies");
    try {
      for await (const e of readEvents(produce(run.signal))) run.push(e);
    } catch (err) {
      if (!run.signal.aborted) run.push({ t: "error", message: `The reply was interrupted: ${(err as Error).message}` });
    } finally {
      run.end();
    }
  })();
  return run;
}

export function piRoutes(api: Api) {
  return {
    // ---------------------------------------------------------------- install, version, updates
    "/api/pi/status": {
      GET: api(async (req) => Response.json(await status(new URL(req.url).searchParams.has("fresh")))),
    },
    "/api/pi/install": {
      POST: api(() => {
        if (piBin()) return bad("Pi is already installed");
        const job = startJob("Installing Pi", ["sh", "-c", "curl -fsSL https://pi.dev/install.sh | sh"], () => forgetModels());
        return Response.json({ job: job.id });
      }),
    },
    "/api/pi/update": {
      POST: api(async (req) => {
        const bin = piBin();
        if (!bin) return bad("Pi isn't installed");
        const body = await readJson(req);
        const job = startJob(body?.all ? "Updating Pi and its packages" : "Updating Pi", [bin, "update", body?.all ? "--all" : "--self"], () => restartIdle());
        return Response.json({ job: job.id });
      }),
    },
    "/api/pi/job": {
      GET: api(() => {
        const job = currentJob();
        return job ? new Response(jobStream(job), { headers: ndjson }) : new Response(null, { status: 204 });
      }),
    },
    "/api/pi/problems": {
      GET: api(() => Response.json({ problems })),
      DELETE: api(() => {
        problems.splice(0, problems.length);
        return Response.json({ ok: true });
      }),
    },

    // ---------------------------------------------------------------- models, commands, threads
    "/api/pi/models": {
      GET: api(async (req) => {
        try {
          const r = await listModels(new URL(req.url).searchParams.has("fresh"));
          return Response.json({ models: r.models.map(toModelInfo), defaultModel: r.defaultModel, checkedAt: r.checkedAt });
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/pi/commands": {
      GET: api(async (req) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return Response.json({ commands: await listCommands(cwd || homedir()) });
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // A turn runs on its own (runs.ts), so a dropped connection doesn't stop Pi; the app picks it
    // back up from /api/chat/runs/:id like any reply.
    "/api/pi/chat": {
      POST: api(async (req, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const body = await readJson(req);
        if (!isPiChat(body) || !isStreamRef(body.stream)) return bad("Malformed request");
        if (!existsSync(body.cwd)) return bad("This thread's folder doesn't exist anymore (was its worktree removed?). Start a new thread to keep going.", 410);
        if (!projects.allowedCwd(body.cwd)) return bad("That folder isn't a project in OpenBuild", 403);
        const run = localRun(body.stream.id, () => startStream((signal) => runTurn(body, signal)));
        return new Response(run.stream(), { headers: runHeaders });
      }),
    },
    "/api/pi/threads/:id/answer": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/answer">) => {
        const body = await readJson(req);
        if (!isThreadId(req.params.id) || !str(body?.askId, 128)) return bad("Expected { askId, value | confirmed | cancelled }");
        const ok = answer(req.params.id, body.askId, { value: typeof body.value === "string" ? body.value : undefined, confirmed: typeof body.confirmed === "boolean" ? body.confirmed : undefined, cancelled: body.cancelled === true });
        return ok ? Response.json({ ok }) : bad("That question isn't waiting anymore", 410);
      }),
    },
    "/api/pi/threads/:id/steer": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/steer">) => {
        const body = await readJson(req);
        if (!isThreadId(req.params.id) || !str(body?.steerId, 128) || typeof body?.message !== "string" || body.message.length >= 2_000_000 || !validImages(body.images)) {
          return bad("Expected { steerId, message, images? }");
        }
        try {
          return Response.json(await steer(req.params.id, body.steerId, body.message, body.images));
        } catch (err) {
          return fail(err, 409);
        }
      }),
    },
    "/api/pi/threads/:id/compact": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/compact">) => {
        if (!isThreadId(req.params.id)) return bad("Bad thread id");
        const body = await readJson(req);
        try {
          return Response.json(await compact(req.params.id, typeof body?.instructions === "string" ? body.instructions : undefined));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // One-off completion with no tools (thread titles).
    "/api/pi/complete": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.model, 512) || !str(body?.system, 8000) || !str(body?.prompt, 20_000)) return bad("Expected { model, system, prompt }");
        try {
          return Response.json({ text: await complete(body.model, body.system, body.prompt, req.signal) });
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },

    // ---------------------------------------------------------------- providers and sign-in
    "/api/pi/providers": {
      GET: api(async () => {
        try {
          return Response.json({ providers: await auth.providers() });
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/pi/providers/:id/logout": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/providers/:id/logout">) => {
        try {
          await auth.logout(req.params.id);
          forgetModels();
          return Response.json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/pi/login": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.provider, 128) || (body.type !== "api_key" && body.type !== "oauth")) return bad("Expected { provider, type }");
        try {
          const login = auth.startLogin(body.provider, body.type);
          return Response.json({ id: login.id });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/pi/login/:id": {
      GET: api((req: Bun.BunRequest<"/api/pi/login/:id">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const login = auth.findLogin(req.params.id);
        return login ? new Response(auth.loginStream(login), { headers: ndjson }) : bad("No such sign-in", 404);
      }),
    },
    "/api/pi/login/:id/answer": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/login/:id/answer">) => {
        const body = await readJson(req);
        if (!str(body?.promptId, 64)) return bad("Expected { promptId, value }");
        const ok = auth.answerLogin(req.params.id, body.promptId, typeof body.value === "string" ? body.value : undefined);
        if (ok) forgetModels();
        return ok ? Response.json({ ok }) : bad("This sign-in is over", 410);
      }),
    },
    "/api/pi/login/:id/cancel": {
      POST: api((req: Bun.BunRequest<"/api/pi/login/:id/cancel">) => {
        auth.cancelLogin(req.params.id);
        return Response.json({ ok: true });
      }),
    },

    // ---------------------------------------------------------------- extensions, skills, prompts, packages
    "/api/pi/resources": {
      GET: api(() => {
        try {
          return Response.json({ resources: resources.list(), packages: resources.packages() });
        } catch (err) {
          return fail(err, 500);
        }
      }),
    },
    "/api/pi/resources/toggle": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!["extension", "skill", "prompt"].includes(body?.kind) || !str(body?.id, 512) || typeof body?.enabled !== "boolean") return bad("Expected { kind, id, enabled }");
        resources.setEnabled(body.kind, body.id, body.enabled);
        return Response.json({ ok: true });
      }),
    },
    "/api/pi/resources/file": {
      GET: api((req) => {
        const path = new URL(req.url).searchParams.get("path");
        if (!str(path, 1024)) return bad("Expected ?path=");
        try {
          return Response.json({ path, content: resources.readResourceFile(path) });
        } catch (err) {
          return fail(err);
        }
      }),
      PUT: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.path, 1024) || typeof body?.content !== "string" || body.content.length > 1024 * 1024) return bad("Expected { path, content }");
        try {
          resources.writeResourceFile(body.path, body.content);
          return Response.json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/pi/resources/remove": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.id, 1024)) return bad("Expected { id }");
        try {
          return Response.json({ trash: resources.remove(body.id) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/pi/resources/create": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!["extension", "skill", "prompt"].includes(body?.kind) || !str(body?.name, 64)) return bad("Expected { kind, name }");
        try {
          return Response.json({ path: resources.create(body.kind, body.name) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/pi/packages": {
      POST: api(async (req) => {
        const bin = piBin();
        const body = await readJson(req);
        if (!bin) return bad("Pi isn't installed");
        if (!str(body?.source, 512) || /^\s*-/.test(body.source)) return bad("Expected { source }");
        const job = startJob(`Installing ${body.source}`, [bin, "install", body.source.trim()], () => restartIdle());
        return Response.json({ job: job.id });
      }),
      DELETE: api(async (req) => {
        const bin = piBin();
        const body = await readJson(req);
        if (!bin) return bad("Pi isn't installed");
        if (!str(body?.source, 512) || /^\s*-/.test(body.source)) return bad("Expected { source }");
        const job = startJob(`Removing ${body.source}`, [bin, "remove", body.source.trim()], () => restartIdle());
        return Response.json({ job: job.id });
      }),
    },

    // ---------------------------------------------------------------- projects and workspaces
    "/api/projects": {
      GET: api(() => Response.json({ projects: projects.listProjects() })),
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.path, 1024)) return bad("Expected { path }");
        try {
          return Response.json({ project: await projects.addProject(body.path) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/projects/discover": {
      GET: api(() => Response.json({ found: projects.discover() })),
    },
    "/api/projects/:id": {
      PATCH: api(async (req: Bun.BunRequest<"/api/projects/:id">) => {
        const body = await readJson(req);
        if (!str(body?.name, 80)) return bad("Expected { name }");
        projects.renameProject(req.params.id, body.name);
        return Response.json({ ok: true });
      }),
      DELETE: api((req: Bun.BunRequest<"/api/projects/:id">) => {
        projects.removeProject(req.params.id);
        return Response.json({ ok: true });
      }),
    },
    "/api/projects/:id/git": {
      GET: api(async (req: Bun.BunRequest<"/api/projects/:id/git">) => {
        const p = projects.findProject(req.params.id);
        if (!p) return bad("No such project", 404);
        if (!p.git || p.missing) return Response.json({ branches: [], dirty: 0 });
        return Response.json(await projects.gitInfo(p.path));
      }),
    },
    "/api/fs": {
      GET: api((req) => {
        try {
          return Response.json(projects.browse(new URL(req.url).searchParams.get("dir") ?? undefined));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/workspaces": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (body?.mode === "scratch") return Response.json({ workspace: projects.scratchWorkspace() });
        if (!str(body?.projectId, 64) || (body.mode !== "local" && body.mode !== "worktree")) return bad("Expected { projectId, mode, branch? }");
        try {
          return Response.json({ workspace: await projects.prepareWorkspace(body.projectId, body.mode, typeof body.branch === "string" ? body.branch : undefined, typeof body.name === "string" ? body.name : undefined) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/workspaces/git": {
      GET: api(async (req) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (!cwd || !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        return Response.json(await projects.gitInfo(cwd));
      }),
    },
    "/api/workspaces/remove": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!str(body?.cwd, 1024)) return bad("Expected { cwd }");
        try {
          await projects.removeWorktree(body.cwd, body.force === true);
          return Response.json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
  };
}

