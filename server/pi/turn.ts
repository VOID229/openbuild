// Admitting a turn: the one path from "here's a request" to a running agent, whether the request
// came from the app (/api/pi/chat) or from a bot (server/bots/threads.ts).
import { existsSync } from "node:fs";
import { isStreamRef } from "../../shared/replies";
import { EFFORTS, isPermissionId, isSpeedId, type PiChatRequest } from "../../shared/types";
import * as durable from "../durable";
import { beforeChat, hasChatHooks } from "../plugins";
import * as projects from "../projects";
import { runStopRequested } from "../runStops";
import { localRun, Run } from "../runs";
import { claimRuntime, validRuntime } from "../threadRuntime";
import { startRun } from "./remote";
import { isThreadId } from "./sessions";

const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export const validImages = (images: any) =>
  images === undefined || (Array.isArray(images) && images.length <= 20 && images.every((i: any) => str(i?.data, 30_000_000) && str(i?.mimeType, 100)));

export function isPiChat(b: any): b is PiChatRequest {
  return (
    !!b &&
    isThreadId(b.threadId) &&
    (b.runtime === undefined || validRuntime(b.runtime)) &&
    (b.cursorAllowAllTools === undefined || (b.runtime === "cursor" && typeof b.cursorAllowAllTools === "boolean")) &&
    (b.remoteControl === undefined || (b.runtime === "claude" && typeof b.remoteControl === "boolean")) &&
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

const refused = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Start `input`'s turn, or pick it back up if its stream id is already running. Errors carry a `status`. */
export async function admitTurn(input: PiChatRequest): Promise<Run> {
  let body = input;
  if (hasChatHooks()) {
    // A plugin may adjust the model, prompt or effort for this turn; it may not change the
    // stream or leave an invalid request behind.
    const next = await beforeChat(body);
    if (!isPiChat(next) || !isStreamRef(next.stream)) throw refused("A plugin produced an invalid chat request", 400);
    body = next;
  }
  if (!existsSync(body.cwd)) throw refused("This thread's folder doesn't exist anymore (was its worktree removed?). Start a new thread to keep going.", 410);
  if (!projects.allowedCwd(body.cwd)) throw refused("That folder isn't a project in OpenBuild", 403);
  claimRuntime(body.threadId, body.runtime ?? "pi");
  if (body.stream && runStopRequested(body.stream.id)) return localRun(body.stream.id, () => new Run());
  return body.runtime === "durable" ? durable.startRun(body) : startRun(body);
}
