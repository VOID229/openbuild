// Commands the user runs from the composer: "!cmd" (the agent reads it and its output with the next
// message) and "!!cmd" (it doesn't). See server/pi/shell.ts and src/lib/shell.ts.

/** "!cmd" or "!!cmd": the command, and whether it's kept from the agent. */
export function shellCommand(text: string): { command: string; hidden: boolean } | undefined {
  const m = /^(!!?)([\s\S]*)$/.exec(text.trim());
  const command = m?.[2]!.trim();
  return m && command ? { command, hidden: m[1] === "!!" } : undefined;
}

const CUT = "… earlier output not shown …\n";

/** A command's latest output, at most `max` characters: a long-running one (a dev server) keeps its tail. */
export function outputTail(output: string, max: number): string {
  if (output.length <= max) return output;
  let tail = output.slice(-max);
  // Start on a whole line when there's one close by.
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < 4096) tail = tail.slice(nl + 1);
  return CUT + tail;
}
