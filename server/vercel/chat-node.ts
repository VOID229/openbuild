// Entry point of the hosted /api/chat function (see scripts/build-vercel.ts).
import chat from "./chat";
import { toNode } from "./node";

export default toNode(chat);
