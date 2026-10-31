/** Model-only prefixes must never become user-visible transcript content.
 * Only consume reserved blocks at the beginning, preserving quoted examples in messages.
 * Incomplete reserved blocks fail closed (e.g. a partially recovered transcript).
 */
export function userVisiblePrompt(text: string): string {
  for (;;) {
    const start = text.trimStart();
    let end: number;
    if (start.startsWith("[OpenBuild user profile context (current)]")) {
      const marker = "[End OpenBuild user profile context]";
      const at = start.indexOf(marker);
      if (at < 0) return "";
      end = at + marker.length;
    } else if (start.startsWith("[OpenBuild display instructions:") || start.startsWith("[OpenBuild plugin instructions:")) {
      const at = start.indexOf("]");
      if (at < 0) return "";
      end = at + 1;
    } else return text;
    text = start.slice(end).replace(/^\s*\r?\n(?:[ \t]*\r?\n)*/, "");
  }
}
