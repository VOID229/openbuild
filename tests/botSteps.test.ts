// A bot's status follows Pi's event stream step by step (server/bots/steps.ts): a tool call shows
// from the moment the model starts writing it, with its own status line as soon as that is written,
// and is gone the moment the tool ends. Between steps the line keeps saying what the bot is about
// (its reasoning's heading, its last step, what the turn started on): plain working words only with
// none of those, and never "Thinking".
import { expect, test } from "bun:test";
import openbots from "../server/bots/extension";
import { activityFor, COMPACTING, follow, heading, liveActivity, newLive, partialArgs, RETRYING, startLine, type Live } from "../server/bots/steps";
import type { PiRecord } from "../server/pi/rpc";
import { statusLine, TYPING, WORKING_PHRASES, workingPhrase, WRITING_REPLY } from "../shared/bots";
import { holdingLine, liveLine, workingLine } from "../src/lib/bots/activity";
import type { BotStatus, Conversation } from "../src/lib/bots/types";

const update = (event: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: event });
const start = (toolName: string, toolCallId: string, args: unknown = {}) => ({ type: "tool_execution_start", toolName, toolCallId, args });
const end = (toolName: string, toolCallId: string) => ({ type: "tool_execution_end", toolName, toolCallId, result: {} });
/** Feed records, and say what the status reads after each. */
const lines = (live: Live, records: PiRecord[]) => records.map((record) => (follow(live, record), liveActivity(live)));

test("no status is ever a bare Thinking: every tool has a line of its own, and the gaps are plain work", () => {
  const tools: any[] = [];
  openbots({ on() {}, registerTool(tool: any) { tools.push(tool); } });
  expect(tools.length).toBeGreaterThan(20);
  for (const { name } of tools) {
    expect(activityFor(name, {})).toBeTruthy();
    expect(activityFor(name, {})).not.toMatch(/thinking/i);
  }
  // A tool OpenBots doesn't know (another extension's, an app's) is named, not waved away.
  expect(activityFor("github_search_issues", {})).toBe("Using github search issues");
  expect(activityFor("mcp__notion__find-page", {})).toBe("Using notion find page");
  expect(activityFor("search", {})).toBe("Looking through its memory");
  expect(WORKING_PHRASES.slice(0, 2)).toEqual(["Working on it", "Getting it done"]);
  for (const phrase of WORKING_PHRASES) expect(phrase).not.toMatch(/thinking/i);
  expect(workingPhrase()).toBe("Working on it");
  expect(workingPhrase(WORKING_PHRASES.length + 1)).toBe("Getting it done");
  // A fresh turn, with nothing from Pi yet, already says so.
  expect(liveActivity(newLive())).toBe("Working on it");
});

test("a call shows the moment the model starts writing it, and its own status as soon as that's written", () => {
  const live = newLive();
  expect(lines(live, [
    update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }),
    update({ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "write" }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: '{"status":"Updating your sch' }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: 'ool.md","path":"/home/x/school.md","content":"# A very long' }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: ' file…"}' }),
    update({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { status: "Updating your school.md", path: "/home/x/school.md", content: "# A very long file…" } } }),
    { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "write", arguments: { status: "Updating your school.md" } }] } },
    start("write", "call_1", { status: "Updating your school.md", path: "/home/x/school.md" }),
  ])).toEqual([
    "Working on it",
    // Known the instant the call opens, before a single argument.
    "Writing a file",
    // Half a status isn't shown.
    "Writing a file",
    // Written first, shown while the file's text is still streaming.
    "Updating your school.md",
    "Updating your school.md",
    "Updating your school.md",
    "Updating your school.md",
    "Updating your school.md",
  ]);
  expect(live.steps.map((s) => [s.id, s.state])).toEqual([["call_1", "running"]]);
  // Without a status of its own, what it reads or opens says it, as soon as that argument is in.
  const reading = newLive();
  expect(lines(reading, [
    update({ type: "toolcall_start", contentIndex: 0, id: "r1", toolName: "read" }),
    update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/home/x/notes.md"' }),
  ])).toEqual(["Reading a file", "Reading notes.md"]);
});

test("between steps the line stays on the last one it named, while the model works out the next", () => {
  const live = newLive();
  expect(lines(live, [
    start("read", "a", { path: "/home/x/notes.md" }),
    end("read", "a"),
    update({ type: "thinking_delta", contentIndex: 0, delta: "so" }),
    update({ type: "thinking_delta", contentIndex: 0, delta: " then" }),
    start("bash", "b", { command: "gh pr checks", status: "Watching CI on #115" }),
    end("bash", "b"),
    { type: "turn_end" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    start("bash", "c", {}),
    end("bash", "c"),
  ])).toEqual([
    "Reading notes.md",
    // The model is working out what's next: still about the notes, not three dots.
    "Reading notes.md",
    "Reading notes.md",
    "Reading notes.md",
    "Watching CI on #115",
    "Watching CI on #115",
    "Watching CI on #115",
    "Watching CI on #115",
    "Running a command",
    "Running a command",
  ]);
  expect(live.steps).toEqual([]);
  // Words for the chat and a tool being loaded aren't what it's about: the line goes back past them.
  expect(lines(live, [
    start("send_message", "m", { text: "on it" }),
    end("send_message", "m"),
    start("load_tools", "l", { names: ["browser"] }),
    end("load_tools", "l"),
    start("react", "r", { emoji: "👍" }),
    end("react", "r"),
  ])).toEqual(["Writing a reply", "Running a command", "Getting tools ready", "Running a command", "Reacting", "Running a command"]);
});

test("a turn says what it started on until it names a step, and plain words only with nothing at all", () => {
  const live = newLive("Reading your message");
  expect(lines(live, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_delta", contentIndex: 0, delta: "They want the notes file changed." }),
    start("load_tools", "l", { names: ["write"] }),
    end("load_tools", "l"),
    start("write", "w", { status: "Updating your notes" }),
    end("write", "w"),
  ])).toEqual(["Reading your message", "Reading your message", "Getting tools ready", "Reading your message", "Updating your notes", "Updating your notes"]);
  // A turn with nothing to say it started on (an older caller) falls back to plain words.
  expect(liveActivity(newLive())).toBe("Working on it");
  // What woke it is what it starts on: a message someone's waiting on before anything else.
  expect(startLine(["messages"], true)).toBe("Reading your message");
  expect(startLine(["heartbeat", "messages"], false)).toBe("Reading the new messages");
  expect(startLine(["routine"], false)).toBe("Getting started on a routine");
  expect(startLine(["note", "heartbeat"], true)).toBe("Reading a note");
  expect(startLine(["heartbeat"], true)).toBe("Checking in on things");
  expect(startLine(["reaction"], true)).toBe("Looking at a reaction");
  for (const kinds of [["messages"], ["routine"], ["note"], ["heartbeat"], ["reaction"]]) expect(WORKING_PHRASES as readonly string[]).not.toContain(startLine(kinds, true));
});

test("the heading of the model's reasoning is the line while it thinks, once it's written in full", () => {
  const live = newLive("Reading your message");
  expect(lines(live, [
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "**Inspecting the" }),
    update({ type: "thinking_delta", contentIndex: 0, delta: " CI logs**\n\nThe failing job is" }),
    update({ type: "thinking_delta", contentIndex: 0, delta: " lint. **not a heading** here.\n\n**Planning the fix**" }),
    update({ type: "toolcall_start", contentIndex: 1, id: "e", toolName: "edit" }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: '{"status":"Fixing the lint error","path":"a.ts"' }),
    start("edit", "e", { status: "Fixing the lint error", path: "a.ts" }),
    end("edit", "e"),
    { type: "turn_end" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "Plain reasoning with no heading." }),
  ])).toEqual([
    "Reading your message",
    "Reading your message",
    // Half a heading isn't shown.
    "Reading your message",
    "Inspecting the CI logs",
    // Bold words inside a sentence aren't a heading; a new heading of its own line is.
    "Planning the fix",
    "Editing a file",
    "Fixing the lint error",
    "Fixing the lint error",
    "Fixing the lint error",
    // A later response with no heading keeps what it was last on.
    "Fixing the lint error",
    "Fixing the lint error",
    "Fixing the lint error",
    "Fixing the lint error",
  ]);
  expect(heading("**Checking**")).toBe("Checking");
  expect(heading("  **reviewing #101**  \nmore")).toBe("Reviewing #101");
  expect(heading("**" + "x".repeat(70) + "**")!.length).toBe(50);
  expect(heading("**12**")).toBeUndefined();
  expect(heading("so **this** is it")).toBeUndefined();
});

test("tools running side by side are told apart by call id, so one ending never hides another", () => {
  const live = newLive();
  expect(lines(live, [
    start("bash", "a", { status: "Building the app" }),
    start("bash", "b", { status: "Running the tests" }),
    // The same tool twice: by name alone, this would have cleared the one still running.
    end("bash", "b"),
    end("bash", "a"),
  ])).toEqual(["Building the app", "Running the tests", "Building the app", "Building the app"]);
  // Calls written in one response show the newest while they're written, then whichever is running.
  expect(lines(live, [
    update({ type: "toolcall_start", contentIndex: 0, id: "x", toolName: "read" }),
    update({ type: "toolcall_end", contentIndex: 0, toolCall: { id: "x", name: "read", arguments: { path: "a.md" } } }),
    update({ type: "toolcall_start", contentIndex: 1, id: "y", toolName: "browser" }),
    update({ type: "toolcall_end", contentIndex: 1, toolCall: { id: "y", name: "browser", arguments: { action: "open", url: "https://www.example.com/x" } } }),
    start("read", "x", { path: "a.md" }),
    start("browser", "y", { action: "open", url: "https://www.example.com/x" }),
    end("browser", "y"),
    end("read", "x"),
  ])).toEqual(["Reading a file", "Reading a.md", "Browsing", "Opening example.com", "Reading a.md", "Opening example.com", "Reading a.md", "Reading a.md"]);
  // An end with no id (an older Pi) still ends the tool of that name, and one never seen is harmless.
  follow(live, { type: "tool_execution_start", toolName: "edit", args: { path: "x.ts" } });
  expect(follow(live, { type: "tool_execution_end", toolName: "edit" }).ended?.tool).toBe("edit");
  expect(follow(live, { type: "tool_execution_end", toolName: "send_message" }).ended?.tool).toBe("send_message");
  expect(live.steps).toEqual([]);
});

test("nothing of a response is left showing once it's over, failed or was stopped", () => {
  const live = newLive();
  const writes = [update({ type: "toolcall_start", contentIndex: 0, id: "w", toolName: "bash" }), update({ type: "toolcall_delta", contentIndex: 0, delta: '{"status":"Deploying"' })];
  // The model's call failed mid-write: that call never runs, though it's still what the bot is about.
  expect(lines(live, [...writes, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529" } }])).toEqual(["Running a command", "Deploying", "Deploying"]);
  expect(live.steps).toEqual([]);
  // Stopped by the user.
  lines(live, [...writes, { type: "message_end", message: { role: "assistant", stopReason: "aborted" } }]);
  expect(live.steps).toEqual([]);
  // A tool whose end never came (blocked, or lost) goes with its turn, and with the next response.
  for (const over of [{ type: "turn_end" }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "agent_settled" }]) {
    lines(live, [start("bash", "lost", { status: "Deploying" }), over]);
    expect(live.steps).toEqual([]);
  }
  // A user message arriving (a steer) ends nothing.
  expect(lines(live, [start("bash", "kept", { status: "Deploying" }), { type: "message_start", message: { role: "user", content: "and the docs?" } }])).toEqual(["Deploying", "Deploying"]);
  // A call that never streamed (a provider that sends whole messages) is taken from the finished message.
  const whole = newLive();
  expect(lines(whole, [{ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "m", name: "bot_web_search", arguments: { status: "Looking up the release date" } }] } }])).toEqual(["Looking up the release date"]);
  expect(follow(whole, start("bot_web_search", "m", { status: "Looking up the release date" })).started?.id).toBe("m");
  expect(whole.steps.length).toBe(1);
});

test("text on its way to the chat reads Writing a reply, and Pi's own waits say what they are", () => {
  const live = newLive();
  follow(live, update({ type: "text_delta", contentIndex: 0, delta: "Here's" }));
  expect(live.streaming).toBe(true);
  expect(liveActivity(live, { writing: true })).toBe(WRITING_REPLY);
  // A step outranks it: the call it goes on to write is what it's doing now.
  follow(live, update({ type: "toolcall_start", contentIndex: 1, id: "t", toolName: "todo" }));
  expect(live.streaming).toBe(false);
  expect(liveActivity(live, { writing: true })).toBe("Updating the to-do list");
  // Steps the chat shows another way are left out of the line.
  const other = newLive();
  follow(other, update({ type: "toolcall_start", contentIndex: 0, id: "t", toolName: "todo" }));
  expect(liveActivity(other, { counts: (step) => step.tool !== "todo" })).toBe("Working on it");
  follow(live, { type: "turn_end" });
  follow(live, { type: "compaction_start", reason: "threshold" });
  expect(liveActivity(live)).toBe(COMPACTING);
  follow(live, { type: "compaction_end", reason: "threshold" });
  expect(liveActivity(live)).toBe("Updating the to-do list");
  follow(live, { type: "auto_retry_start", attempt: 1, delayMs: 2000 });
  expect(liveActivity(live)).toBe(RETRYING);
  follow(live, { type: "auto_retry_end", success: true });
  expect(liveActivity(live)).toBe("Updating the to-do list");
  for (const line of [COMPACTING, RETRYING, WRITING_REPLY]) expect(line).not.toMatch(/thinking/i);
});

test("a half-written call gives up only the arguments that are complete, and only its own", () => {
  expect(partialArgs("")).toEqual({});
  expect(partialArgs('{"sta')).toEqual({});
  expect(partialArgs('{"status":"Watching')).toEqual({});
  expect(partialArgs('{"status":"Watching CI"')).toEqual({ status: "Watching CI" });
  expect(partialArgs('{ "status" : "Say \\"hi\\" to them", "command": "echo')).toEqual({ status: 'Say "hi" to them' });
  // A status inside another argument's object or text isn't the call's.
  expect(partialArgs('{"app":"github","args":{"status":"open","labels":["a","b"]},"limit":5,"status":"Listing open issues"')).toEqual({ app: "github", status: "Listing open issues" });
  expect(partialArgs('{"content":"{\\"status\\":\\"fake\\"}","path":"a.json"}')).toEqual({ content: '{"status":"fake"}', path: "a.json" });
  expect(partialArgs('{"args":{"status":"open"')).toEqual({});
  expect(partialArgs('{"n":12,"ok":true,"path":"x"}  trailing')).toEqual({ path: "x" });
  // The bot's own line is kept short and tidy.
  expect(activityFor("bash", { status: "  checking why the build broke...\nsecond line" })).toBe("Checking why the build broke");
  expect(activityFor("bash", { status: "x".repeat(80) }).length).toBe(50);
});

test("the app shows one line everywhere: the live step, Typing…, or plain work, never Thinking", () => {
  const solo = { id: "solo", kind: "direct", botIds: ["egg"] } as Conversation;
  const working = (activity?: string, more: Partial<BotStatus> = {}): Record<string, BotStatus> => ({ egg: { state: "working", conversationId: "solo", activity, ...more } });
  // The chat's working row.
  expect(workingLine("solo", "egg", working("Reading notes.md").egg)).toBe("Reading notes.md");
  expect(workingLine("solo", "egg", working().egg)).toBe("Working on it");
  // A paired device on an older server still says Thinking: it reads as plain work here.
  expect(workingLine("solo", "egg", working("Thinking").egg)).toBe("Working on it");
  expect(statusLine({ activity: "Thinking…" })).toBe("Working on it");
  expect(statusLine({ activity: "Thinking back on the trip" })).toBe("Thinking back on the trip");
  expect(statusLine(undefined)).toBe("Working on it");
  // The header's line under the name.
  expect(liveLine(solo, working("Watching CI on #115"), [])).toBe("Watching CI on #115");
  expect(liveLine(solo, working("Thinking"), undefined)).toBe("Working on it");
  expect(liveLine(solo, working("Watching CI on #115"), ["egg"])).toBe("Typing…");
  expect(liveLine(solo, {}, ["egg"])).toBe(TYPING);
  // Quiet work and work a group bot hasn't decided on say nothing; nor does an idle bot.
  expect(liveLine(solo, working("Making a note", { quiet: true }), [])).toBeUndefined();
  expect(liveLine(solo, working("Reading notes.md", { deciding: true }), [])).toBeUndefined();
  expect(liveLine(solo, {}, [])).toBeUndefined();
  // Busy elsewhere with this chat's message next: it's holding on, in the same words as the chat's row.
  const held: Record<string, BotStatus> = { egg: { state: "working", conversationId: "group", activity: "Running the tests", waiting: ["solo"] } };
  expect(liveLine(solo, held, [])).toBe(holdingLine("solo", "egg"));
  expect(workingLine("solo", "egg", held.egg)).toBe(holdingLine("solo", "egg"));
});
