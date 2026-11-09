// Which pages (html_render) start collapsed: a page from a while back is shown as a one-line chip
// rather than rendered, so a long thread or chat doesn't keep every old page's scripts running.
// The reader's own choice (see HtmlRender) always wins over this default.
import type { BotMessage } from "../../shared/bots";

/** How many turns back a page starts collapsed. */
export const PAGE_COLLAPSE_TURNS = 5;

/**
 * OpenBuild: a turn is a message the user sent. For each message, whether the user has sent
 * PAGE_COLLAPSE_TURNS or more since it (commands they ran in the shell don't count).
 */
export function threadPagesOld(messages: readonly { role: string }[]): boolean[] {
  const old = new Array<boolean>(messages.length);
  let users = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    old[i] = users >= PAGE_COLLAPSE_TURNS;
    if (messages[i]!.role === "user") users++;
  }
  return old;
}

/**
 * OpenBots: a turn is someone other than the page's author speaking: the user, a friend, or another
 * bot. Consecutive messages from one author count once (a bot often answers in a few bubbles), and
 * the page's own author carrying on doesn't count, so a chat that's mostly bots talking ages a page
 * by the exchanges that follow it, as the user's messages do in a direct chat. Activity lines
 * ("Created routine …") are not turns. The ids of the pages that are that old.
 */
export function botPagesOld(messages: readonly BotMessage[]): Set<string> {
  const old = new Set<string>();
  messages.forEach((m, i) => {
    if (!m.html) return;
    let turns = 0;
    let last: string | undefined = m.author;
    for (let j = i + 1; j < messages.length && turns < PAGE_COLLAPSE_TURNS; j++) {
      const n = messages[j]!;
      if (n.event) continue;
      if (n.author !== last && n.author !== m.author) turns++;
      last = n.author;
    }
    if (turns >= PAGE_COLLAPSE_TURNS) old.add(m.id);
  });
  return old;
}
