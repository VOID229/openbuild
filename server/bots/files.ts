// Files the user attaches to a message for bots: anything that isn't a picture the model looks at.
//
// They're uploaded in pieces to this server's file store (server/attachments.ts), by conversation.
// A bot can't see that store from its computer, so once a file is whole it's copied into the home
// folder of every bot in the conversation, at ~/Attachments/<id>/<name>: the same place on a
// container and on a plain folder, and the path the bot's transcript names. The copy is each bot's
// own, so one bot editing it doesn't change what another has, or what the user downloads again.
import { constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { attachedFileNote } from "../../shared/attachments";
import type { BotFile } from "../../shared/bots";
import { receive, receiveBytes, stored } from "../attachments";
import { dataDir } from "../paths";
import * as db from "./db";
import { isolationOf } from "./machines";

/** As in server/computers: a container's home is this folder, mounted at CONTAINER_HOME. */
const CONTAINER_HOME = "/home/bot";
const hostHome = (botId: string) => join(dataDir(), "computers", botId, "home");
const folder = (file: Pick<BotFile, "id">) => join("Attachments", file.id.slice(0, 8));

/** Where a bot finds an attached file on its computer on this server, or undefined if it isn't there. */
export function botFilePath(botId: string, file: BotFile): string | undefined {
  if (!existsSync(join(hostHome(botId), folder(file), file.name))) return undefined;
  return join(isolationOf("local") === "container" ? CONTAINER_HOME : hostHome(botId), folder(file), file.name);
}

/** How a bot's transcript mentions a message's files. */
export function filesNote(botId: string, files: BotFile[] | undefined): string {
  return (files ?? [])
    .map((f) => {
      const path = botFilePath(botId, f);
      return path ? attachedFileNote(f, path) : `[Attached file "${f.name}" (${f.mime}) isn't on your computer: it was sent before you joined.]`;
    })
    .join(" ");
}

async function give(botId: string, file: BotFile, source: string) {
  const home = hostHome(botId);
  const dir = join(home, folder(file));
  mkdirSync(dir, { recursive: true });
  // The home folder is the bot's to arrange, and a container's links must never be followed out of
  // it from this side: the folder has to really be where it was just made.
  if (realpathSync(dir) !== join(realpathSync(home), folder(file))) throw new Error("That bot's Attachments folder isn't a plain folder.");
  // Never over something already there, and without following a link left under that name.
  await copyFile(source, join(dir, file.name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
}

/** Put a finished upload into the home folder of each bot in the conversation. */
export async function deliver(conversationId: string, id: string) {
  const file = stored(id);
  const c = db.getConversation(conversationId);
  if (!file?.done || !c) return;
  await Promise.all(c.botIds.map((botId) => give(botId, file, file.path).catch((err) => console.error(`Couldn't give ${file.name} to bot ${botId}:`, err))));
}

/** One piece of a file for a conversation. The answer to the last piece comes once its bots have the file. */
export async function receiveFile(req: Request, conversationId: string, id: string, bytes?: Uint8Array): Promise<Response> {
  if (!db.getConversation(conversationId)) return Response.json({ error: "Conversation not found" }, { status: 404 });
  // Bytes a workspace route already read are written at once: its grant was checked just before.
  const res = bytes ? receiveBytes(req.url, id, bytes) : await receive(req, id);
  if (res.ok && ((await res.clone().json()) as { done?: boolean }).done) await deliver(conversationId, id);
  return res;
}

/** A message's files as the store has them, whatever the tab said about them. */
export function checkedFiles(files: unknown): BotFile[] | undefined {
  if (files === undefined) return undefined;
  if (!Array.isArray(files) || files.length > 10) throw new Error("Up to 10 files.");
  return files.map((f) => {
    const file = stored((f as BotFile)?.id);
    if (!file?.done) throw new Error("A file hasn't finished uploading.");
    return { id: file.id, name: file.name, mime: file.mime, size: file.size };
  });
}
