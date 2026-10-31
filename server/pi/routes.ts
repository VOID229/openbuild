// HTTP routes for Pi (threads, models, commands, sign-in, install/update, extensions and skills)
// and for projects and workspaces. Mounted by server/index.ts behind its request checks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isStreamId, isStreamRef } from "../../shared/replies";
import { EFFORTS, isPermissionId, isSpeedId, type ModelInfo, type PiChatRequest, type Speed, type ThreadRuntime } from "../../shared/types";
import { bad, readJson } from "../handlers";
import * as projects from "../projects";
import * as workspaceFiles from "../workspaceFiles";
import * as workspaceGit from "../workspaceGit";
import { beforeChat, hasChatHooks } from "../plugins";
import * as auth from "./auth";
import { status } from "./install";
import { currentJob, jobStream, startJob } from "./jobs";
import * as resources from "./resources";
import { forgetPrices, lookup, priceBook, pricing, type PriceBook } from "./pricing";
import { problems } from "./rpc";
import { TEXT_RUNTIMES } from "../../shared/types";
import { complete } from "../textGeneration";
import { forgetModels, isThreadId, listCommands, listModels, modelEfforts } from "./sessions";
import { answer, compact, findShell, startShell, stopShell, restartIdle, steer, startRun } from "./remote";
import { piBin } from "./install";
import { claimRuntime, threadRuntime, validRuntime } from "../threadRuntime";
import * as durable from "../durable";
import * as fxInstall from "../fx/install";
import * as codexInstall from "../codex/install";
import * as cursorInstall from "../cursor/install";
import * as claudeInstall from "../claude/install";
import * as opencodeInstall from "../opencode-agent/install";
import { assertRuntimeUpdated, forgetRuntimeStatus, runtimeStatus, runtimes, runtimeUpdateCommand } from "../runtimes";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const ndjson = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" };
const runHeaders = { ...ndjson, "x-openchat-run": "1" };
/** An error response. An explicit status wins; otherwise the error's own (409 for Durable), then 400. */
const fail = (err: unknown, status?: number) => {
  const code = (err as { code?: unknown })?.code;
  const own = (err as { status?: unknown })?.status;
  return Response.json(
    { error: (err as Error).message || String(err), ...(typeof code === "string" ? { code } : {}) },
    { status: status ?? (typeof own === "number" ? own : 400) },
  );
};
const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** A Pi model as the app's ModelInfo; its id is "<provider>/<model id>". */
function toModelInfo(m: any, builtins?: Set<string>, book?: PriceBook, speeds?: Record<string, Speed[]>): ModelInfo {
  const own = speeds?.[`${m.provider}/${m.id}`];
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
    custom: builtins && !builtins.has(m.provider) ? true : undefined,
    ...pricing(m, book),
    ...(own?.length ? { speeds: own } : {}),
  };
}

function isPiChat(b: any): b is PiChatRequest {
  return (
    !!b &&
    isThreadId(b.threadId) &&
    (b.runtime === undefined || validRuntime(b.runtime)) &&
    (b.cursorAllowAllTools === undefined || (b.runtime === "cursor" && typeof b.cursorAllowAllTools === "boolean")) &&
    (b.permission === undefined || ((b.runtime === "codex" || b.runtime === "cursor" || b.runtime === "claude") && isPermissionId(b.permission))) &&
    str(b.cwd, 1024) &&
    str(b.model, 512) &&
    b.model.includes("/") &&
    EFFORTS.includes(b.effort) &&
    (b.speed === undefined || isSpeedId(b.speed)) &&
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

export function piRoutes(api: Api) {
  // Pi and Durable deliberately use the exact same maintenance path as /api/pi/update.
  const updateRuntime = (runtime: ThreadRuntime, all = false): Response => {
    try {
      const command = runtimeUpdateCommand(runtime, all);
      const running = currentJob();
      if (running && !running.done) return Response.json({ error: "A maintenance job is already running", job: running.id }, { status: 409 });
      const isPi = runtime === "pi" || runtime === "durable";
      const job = startJob(isPi ? (all ? "Updating Pi and its packages" : "Updating Pi") : `Updating ${runtime}`, command, async (finished) => {
        // Invalidate on failures too: installers can change files before failing.
        forgetRuntimeStatus();
        if (isPi) {
          forgetModels();
          if (finished.code === 0) void restartIdle().catch(err => console.warn("[pi] restart after update:", err));
        } else {
          ({ claude: claudeInstall, codex: codexInstall, cursor: cursorInstall, fx: fxInstall, opencode: opencodeInstall }[runtime as "claude" | "codex" | "cursor" | "fx" | "opencode"]).forgetModels();
        }
        if (finished.code === 0) {
          finished.lines.push("Verifying the installed runtime version…");
          const status = (await runtimeStatus(true))[runtime];
          assertRuntimeUpdated(status);
          finished.lines.push(`Verified ${runtime} ${status.version} at ${status.bin ?? "its configured path"}.`);
        }
      });
      forgetRuntimeStatus();
      return Response.json({ job: job.id });
    } catch (err) {
      return fail(err);
    }
  };
  /** A git action on a workspace the server knows: `{ cwd, … }` in, its result (or why it failed) out. */
  const gitAction = (action: (body: any) => Promise<unknown>) =>
    api(async (req: Request) => {
      const body = await readJson(req);
      if (!str(body?.cwd, 1024) || !projects.allowedCwd(body.cwd)) return bad("Unknown folder", 403);
      try {
        return Response.json(await action(body));
      } catch (err) {
        return fail(err);
      }
    });
  return {
    // ---------------------------------------------------------------- install, version, updates
    "/api/pi/status": {
      GET: api(async (req) => Response.json(await status(new URL(req.url).searchParams.has("fresh")))),
    },
    "/api/pi/install": {
      POST: api(() => {
        if (piBin()) return bad("Pi is already installed");
        const job = startJob("Installing Pi", ["sh", "-c", "curl -fsSL https://pi.dev/install.sh | sh"], () => { forgetModels(); forgetRuntimeStatus(); });
        return Response.json({ job: job.id });
      }),
    },
    "/api/pi/update": {
      POST: api(async (req) => {
        const body = await readJson(req);
        return updateRuntime("pi", !!body?.all);
      }),
    },
    "/api/releases/update": {
      POST: api(() => {
        const running = currentJob();
        if (running && !running.done) return Response.json({ error: "A maintenance job is already running" }, { status: 409 });
        const job = startJob("Updating OpenBuild", [process.execPath, new URL("../../bin/openbuild.ts", import.meta.url).pathname, "update"]);
        return Response.json({ job: job.id });
      }),
    },
    "/api/pi/job": {
      GET: api((req) => {
        const job = currentJob();
        const expected = new URL(req.url).searchParams.get("id");
        if (expected && job?.id !== expected) return Response.json({ error: "This maintenance job is no longer available. Check runtime status before retrying." }, { status: 409 });
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
          const fresh = new URL(req.url).searchParams.has("fresh");
          if (fresh) forgetPrices();
          // Without the built-in list, every provider keeps its own group; without prices, spend
          // shows only what Pi priced itself.
          const [r, builtins, book, speeds] = await Promise.all([
            listModels(fresh),
            auth.builtinProviders().catch(() => undefined),
            priceBook().catch((err) => void console.warn("[pi] model prices unavailable:", (err as Error).message)),
            auth.speedsFromPi(fresh).catch((err) => void console.warn("[pi] model speeds unavailable:", (err as Error).message)),
          ]);
          // `models` stays the full list (routing, priorities and digests use it); `scope` says which
          // of them this device's Pi settings put in the picker.
          return Response.json({ models: r.models.map((m) => toModelInfo(m, builtins, book ?? undefined, speeds ?? undefined)), defaultModel: r.defaultModel, scope: r.scope, checkedAt: r.checkedAt });
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // Prices for models a thread used that Pi no longer lists: ?ids=<provider>/<model id>,…
    "/api/pi/prices": {
      GET: api(async (req) => {
        const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((id) => id.includes("/") && id.length <= 512).slice(0, 50);
        try {
          const book = await priceBook();
          return Response.json({ models: Object.fromEntries(ids.map((id) => [id, lookup(id, book)])) });
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
        let body = await readJson(req);
        if (!isPiChat(body) || !isStreamRef(body.stream)) return bad("Malformed request");
        if (hasChatHooks()) {
          // A plugin may adjust the model, prompt or effort for this turn; it may not change the
          // stream or leave an invalid request behind.
          const next = await beforeChat(body);
          if (!isPiChat(next) || !isStreamRef(next.stream)) return bad("A plugin produced an invalid chat request");
          body = next;
        }
        if (!existsSync(body.cwd)) return bad("This thread's folder doesn't exist anymore (was its worktree removed?). Start a new thread to keep going.", 410);
        if (!projects.allowedCwd(body.cwd)) return bad("That folder isn't a project in OpenBuild", 403);
        try {
          claimRuntime(body.threadId, body.runtime ?? "pi");
        } catch (err) {
          return fail(err);
        }
        try {
          const run = body.runtime === "durable"
            ? await durable.startRun(body)
            : await startRun(body);
          return new Response(run.stream(), { headers: runHeaders });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // Which thread runtimes are installed on this device, for the new-thread runtime picker.
    "/api/runtimes": {
      GET: api(() => Response.json({ runtimes: runtimes() })),
    },
    // Version, updates, sign-in and errors for every runtime, for Settings → Runtimes.
    "/api/runtimes/status": {
      GET: api(async (req) => Response.json({ runtimes: await runtimeStatus(new URL(req.url).searchParams.has("fresh")) })),
    },
    "/api/runtimes/update": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (!validRuntime(body?.runtime)) return bad("Unknown runtime");
        return updateRuntime(body.runtime);
      }),
    },
    // ---------------------------------------------------------------- fx (Vercel's coding agent), installed on this device
    "/api/fx/status": {
      GET: api(async () => Response.json(await fxInstall.status())),
    },
    "/api/fx/models": {
      GET: api(async (req) => {
        try {
          return Response.json(await fxInstall.listModels(new URL(req.url).searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // Native Codex CLI (independent of Pi's openai-codex provider).
    "/api/codex/status": {
      GET: api(async () => Response.json(await codexInstall.status())),
    },
    "/api/codex/models": {
      GET: api(async (req) => {
        try {
          return Response.json(await codexInstall.listModels(new URL(req.url).searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // Permission modes as each runtime reports them on this device (Codex: for a folder's config layers).
    "/api/codex/permissions": {
      GET: api(async (req) => {
        const url = new URL(req.url), cwd = url.searchParams.get("cwd") ?? undefined;
        try {
          return Response.json(await codexInstall.listPermissions(cwd && str(cwd, 1024) && projects.allowedCwd(cwd) ? cwd : undefined, url.searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/cursor/permissions": {
      GET: api(async (req) => {
        try {
          return Response.json(await cursorInstall.listPermissions(new URL(req.url).searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // OpenCode 2's native server protocol, independent of the OpenCode API-key plans.
    "/api/opencode/status": {
      GET: api(async () => Response.json(await opencodeInstall.status())),
    },
    "/api/opencode/models": {
      GET: api(async (req) => {
        try {
          return Response.json(await opencodeInstall.listModels(new URL(req.url).searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    // Native Claude Code (the installed CLI through the Agent SDK; independent of Pi's Anthropic provider).
    "/api/claude/status": {
      GET: api(async () => Response.json(await claudeInstall.status())),
    },
    "/api/claude/models": {
      GET: api(async (req) => {
        try {
          const url = new URL(req.url), accounts = url.searchParams.get("accounts");
          return Response.json(await claudeInstall.listAccountModels(url.searchParams.has("fresh"), accounts ? JSON.parse(accounts) : undefined));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/claude/permissions": {
      GET: api(async (req) => {
        const url = new URL(req.url), cwd = url.searchParams.get("cwd") ?? undefined;
        try {
          return Response.json(await claudeInstall.listPermissions(cwd && str(cwd, 1024) && projects.allowedCwd(cwd) ? cwd : undefined, url.searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/cursor/status": {
      GET: api(async () => Response.json(await cursorInstall.status())),
    },
    "/api/cursor/models": {
      GET: api(async (req) => {
        try {
          return Response.json(await cursorInstall.listModels(new URL(req.url).searchParams.has("fresh")));
        } catch (err) {
          return fail(err, 502);
        }
      }),
    },
    "/api/pi/threads/:id/answer": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/answer">) => {
        const body = await readJson(req);
        if (!isThreadId(req.params.id) || !str(body?.askId, 128)) return bad("Expected { askId, value | confirmed | cancelled }");
        const reply = { value: typeof body.value === "string" ? body.value : undefined, confirmed: typeof body.confirmed === "boolean" ? body.confirmed : undefined, cancelled: body.cancelled === true };
        const ok = threadRuntime(req.params.id) === "durable"
          ? await durable.answerQuestion(req.params.id, body.askId, reply)
          : await answer(req.params.id, body.askId, reply);
        return ok ? Response.json({ ok }) : bad("That question isn't waiting anymore", 410);
      }),
    },
    "/api/pi/threads/:id/steer": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/steer">) => {
        const body = await readJson(req);
        if (!isThreadId(req.params.id) || !str(body?.steerId, 128) || typeof body?.message !== "string" || body.message.length >= 2_000_000 || !validImages(body.images) || (body.display !== undefined && typeof body.display !== "string")) {
          return bad("Expected { steerId, message, images?, display? }");
        }
        try {
          if (threadRuntime(req.params.id) === "durable") return Response.json(await durable.steer(req.params.id, body.steerId, body.message, body.images, body.display));
          return Response.json(await steer(req.params.id, body.steerId, body.message, body.images, body.display));
        } catch (err) {
          return fail(err, 409);
        }
      }),
    },
    // A command the user runs in the thread's folder: "!" (the agent reads it with the next message)
    // or "!!" (it doesn't). It runs on its own, apart from any turn; the app follows it at
    // /api/pi/shells/:id, and sending the same id again just watches it.
    "/api/pi/threads/:id/shell": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/shell">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const body = await readJson(req);
        const threadId = req.params.id;
        if (!isThreadId(threadId) || !isStreamId(body?.id) || !str(body?.cwd, 1024) || !str(body?.command, 100_000) || (body.hidden !== undefined && typeof body.hidden !== "boolean")) {
          return bad("Expected { id, cwd, command, hidden? }");
        }
        if (!existsSync(body.cwd)) return bad("This thread's folder doesn't exist anymore (was its worktree removed?).", 410);
        if (!projects.allowedCwd(body.cwd)) return bad("That folder isn't a project in OpenBuild", 403);
        if (threadRuntime(threadId) === "durable") return bad("Shell commands aren't available in Durable threads yet.");
        if (threadRuntime(threadId) === "fx") return bad("Shell commands aren't available in fx threads yet.");
        if (threadRuntime(threadId) === "codex") return bad("Shell commands aren't available in Codex threads yet.");
        if (threadRuntime(threadId) === "cursor") return bad("Shell commands aren't available in Cursor threads yet.");
        if (threadRuntime(threadId) === "claude") return bad("Shell commands aren't available in Claude Code threads yet.");
        if (threadRuntime(threadId) === "opencode") return bad("Shell commands aren't available in OpenCode threads yet.");
        try {
          claimRuntime(threadId, "pi");
        } catch (err) {
          return fail(err);
        }
        const shell = await startShell({ id: body.id, threadId, cwd: body.cwd, command: body.command, hidden: body.hidden === true });
        return new Response(shell.stream(), { headers: ndjson });
      }),
    },
    "/api/pi/shells/:id": {
      GET: api(async (req: Bun.BunRequest<"/api/pi/shells/:id">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const shell = isStreamId(req.params.id) ? await findShell(req.params.id) : undefined;
        return shell ? new Response(shell.stream(), { headers: ndjson }) : bad("No such command", 404);
      }),
    },
    "/api/pi/shells/:id/stop": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/shells/:id/stop">) => {
        if (isStreamId(req.params.id)) await stopShell(req.params.id);
        return Response.json({ ok: true });
      }),
    },
    "/api/pi/threads/:id/compact": {
      POST: api(async (req: Bun.BunRequest<"/api/pi/threads/:id/compact">) => {
        if (!isThreadId(req.params.id)) return bad("Bad thread id");
        const body = await readJson(req);
        try {
          if (threadRuntime(req.params.id) === "durable") return bad("Manual compaction isn't available in Durable threads yet.");
          if (threadRuntime(req.params.id) === "fx") return bad("Manual compaction isn't available in fx threads yet.");
          if (threadRuntime(req.params.id) === "codex") return bad("Manual compaction isn't available in Codex threads yet.");
          if (threadRuntime(req.params.id) === "cursor") return bad("Manual compaction isn't available in Cursor threads yet.");
          if (threadRuntime(req.params.id) === "claude") return bad("Manual compaction isn't available in Claude Code threads yet.");
          if (threadRuntime(req.params.id) === "opencode") return bad("Manual compaction isn't available in OpenCode threads yet.");
          return Response.json(await compact(req.params.id, typeof body?.instructions === "string" ? body.instructions : undefined));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // One-off completion with no tools, on any runtime (thread titles, commit messages).
    "/api/pi/complete": {
      POST: api(async (req) => {
        const body = await readJson(req);
        const images = body?.images ?? [];
        const imagesOk = Array.isArray(images) && images.length <= 4 && images.every((image) => str(image?.data, 16_000_000) && str(image?.mimeType, 64));
        const runtime = body?.runtime ?? "pi";
        const effort = EFFORTS.includes(body?.effort) ? body.effort : undefined;
        if (!TEXT_RUNTIMES.includes(runtime) || !str(body?.model, 512) || !str(body?.system, 8000) || !str(body?.prompt, 20_000) || !imagesOk) return bad("Expected { model, system, prompt, runtime?, effort?, images? }");
        try {
          return Response.json({ text: await complete({ runtime, model: body.model, effort, system: body.system, prompt: body.prompt, images }, req.signal) });
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
          const name = typeof body.name === "string" ? body.name.slice(0, 200) : undefined;
          return Response.json({ project: await projects.addProject(body.path, { name, create: body.create === true }) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/projects/clone": {
      POST: api(async (req, server: Bun.Server<unknown>) => {
        // A big repository takes a while.
        server.timeout(req, 0);
        const body = await readJson(req);
        if (!str(body?.url, 2048) || !str(body?.path, 1024)) return bad("Expected { url, path }");
        try {
          return Response.json({ project: await projects.cloneProject(body.url, body.path, typeof body.name === "string" ? body.name.slice(0, 200) : undefined) });
        } catch (err) {
          return fail(err);
        }
      }),
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
          const params = new URL(req.url).searchParams;
          return Response.json(projects.browse(params.get("dir") ?? undefined, { hidden: params.get("hidden") === "1" }));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // Files and folders for the composer's "@" menu. `cwd` is a thread's workspace; without it, the scratch area.
    "/api/workspaces/files": {
      GET: api(async (req) => {
        const params = new URL(req.url).searchParams;
        const cwd = params.get("cwd") || undefined;
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return Response.json({ entries: await workspaceFiles.listEntries(cwd, params.has("refresh")) });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // One workspace file's text, for an "@" mention or the editor; and saving it from the editor.
    "/api/workspaces/file": {
      GET: api((req) => {
        const params = new URL(req.url).searchParams;
        const cwd = params.get("cwd") || undefined;
        const path = params.get("path");
        if (!path) return bad("Expected ?path=");
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          // An open editor checking whether the file changed under it: no need to send it again.
          const since = Number(params.get("since"));
          if (params.has("since") && workspaceFiles.fileMtime(cwd, path) === since) return Response.json({ unchanged: true });
          return Response.json(workspaceFiles.readFile(cwd, path));
        } catch (err) {
          return fail(err);
        }
      }),
      PUT: api(async (req) => {
        const body = await readJson(req);
        const cwd = typeof body?.cwd === "string" && body.cwd ? body.cwd : undefined;
        if (!str(body?.path, 1024) || typeof body.text !== "string" || body.text.length > 5_000_000 || (body.mtime !== undefined && typeof body.mtime !== "number"))
          return bad("Expected { cwd?, path, text, mtime? }");
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return Response.json(workspaceFiles.writeFile(cwd, body.path, body.text, body.mtime));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // An image as it is, for the file viewer.
    "/api/workspaces/raw": {
      GET: api((req) => {
        const params = new URL(req.url).searchParams;
        const cwd = params.get("cwd") || undefined;
        const path = params.get("path");
        if (!path) return bad("Expected ?path=");
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return workspaceFiles.rawFile(cwd, path);
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // One folder of the file tree.
    "/api/workspaces/tree": {
      GET: api(async (req) => {
        const params = new URL(req.url).searchParams;
        const cwd = params.get("cwd") || undefined;
        if (cwd && !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return Response.json({ entries: await workspaceFiles.listDir(cwd, params.get("dir") ?? "") });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    // The Commit menu: what changed, what a commit would contain, and committing, pushing, opening a PR.
    "/api/workspaces/changes": {
      GET: api(async (req) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (!cwd || !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        return Response.json(await workspaceGit.changes(cwd));
      }),
    },
    // The side panel's diff viewer: every change in the checkout, as one patch.
    "/api/workspaces/patch": {
      GET: api(async (req) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (!cwd || !projects.allowedCwd(cwd)) return bad("Unknown folder", 403);
        try {
          return Response.json(await workspaceGit.patch(cwd));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/workspaces/diff": {
      POST: gitAction((body) => workspaceGit.diff(body.cwd, body.paths)),
    },
    "/api/workspaces/commit": {
      POST: gitAction((body) => workspaceGit.commit(body.cwd, body.message, body.paths)),
    },
    "/api/workspaces/push": {
      POST: gitAction((body) => workspaceGit.push(body.cwd)),
    },
    "/api/workspaces/pr": {
      POST: gitAction((body) => workspaceGit.pullRequest(body.cwd)),
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

