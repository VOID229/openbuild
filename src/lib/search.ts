// Fuzzy chat search: every query word must match the title or some message, either exactly
// (substring) or with a small typo (edit distance) on a whole word.
import type { Chat } from "./types";

export interface Range {
  start: number;
  end: number;
}

export interface Snippet {
  messageId: string;
  text: string;
  ranges: Range[];
}

export interface SearchHit {
  chat: Chat;
  score: number;
  titleRanges: Range[];
  snippet?: Snippet;
  /** The words actually matched in message text, used to highlight them inside the chat. */
  words: string[];
}

interface Match extends Range {
  quality: number;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Lower-case and strip accents ("Pastéis" → "pasteis"); keeps offsets for precomposed text. */
export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** Allowed typos for a query word of this length. */
const tolerance = (len: number) => (len >= 9 ? 2 : len >= 5 ? 1 : 0);

/** Optimal string alignment distance (Levenshtein + transpositions), bailing out above `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length]!;
}

const isWordStart = (text: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]!);

/** Find a query word in lower-cased text: exact substring first, then a close-enough word. */
function findTerm(text: string, term: string): Match | undefined {
  const i = text.indexOf(term);
  if (i >= 0) return { start: i, end: i + term.length, quality: isWordStart(text, i) ? 1 : 0.8 };
  // 4-letter words may have one typo, but only against a whole word of similar length
  // ("flsh" → "flash", while "this" must not match "thirty").
  const short = term.length === 4;
  const tol = short ? 1 : tolerance(term.length);
  if (!tol) return undefined;
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    if (word[0] !== term[0] && word[1] !== term[1]) continue;
    // Compare against the whole word and (for longer terms) its prefix, for partially typed words.
    const prefix = !short && word.length > term.length ? distance(term, word.slice(0, term.length), tol) : tol + 1;
    const d = Math.min(distance(term, word, tol), prefix);
    if (d <= tol) return { start: m.index!, end: m.index! + word.length, quality: 0.6 - d * 0.1 };
  }
  return undefined;
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Plain one-line excerpt around a match, with every matched word highlighted. */
function makeSnippet(content: string, at: Range, words: string[], messageId: string): Snippet {
  const from = Math.max(0, at.start - 36);
  const to = Math.min(content.length, at.end + 90);
  // Same-length replacements keep match offsets valid.
  let text = content.slice(from, to).replace(/[\n\r\t#*_`>|~[\]]/g, " ");
  // Don't start mid-word.
  if (from > 0) {
    const cut = text.search(/\s/);
    if (cut >= 0 && cut < at.start - from) text = text.slice(cut + 1);
  }
  text = text.replace(/\s+/g, " ").trim();
  const lower = fold(text);
  const ranges: Range[] = [];
  for (const w of words) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) ranges.push({ start: i, end: i + w.length });
  }
  const prefix = from > 0 ? "…" : "";
  return {
    messageId,
    text: prefix + text + (to < content.length ? "…" : ""),
    ranges: mergeRanges(ranges).map((r) => ({ start: r.start + prefix.length, end: r.end + prefix.length })),
  };
}

export function searchChats(chats: Chat[], query: string): SearchHit[] {
  const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (!terms.length) return [];
  const hits: SearchHit[] = [];

  for (const chat of chats) {
    const title = fold(chat.title);
    const lowered = chat.messages.map((m) => fold(m.content));
    const titleRanges: Range[] = [];
    const words: string[] = [];
    let first: { index: number; at: Range } | undefined;
    let score = 0;
    let ok = true;

    for (const term of terms) {
      const inTitle = findTerm(title, term);
      if (inTitle) {
        titleRanges.push(inTitle);
        score += 3 * inTitle.quality;
      }
      // Look in messages too, both to match and to build a snippet.
      let inBody: { index: number; m: Match } | undefined;
      for (let i = 0; i < lowered.length && !inBody; i++) {
        const m = findTerm(lowered[i]!, term);
        if (m) inBody = { index: i, m };
      }
      if (inBody) {
        words.push(lowered[inBody.index]!.slice(inBody.m.start, inBody.m.end));
        first ??= { index: inBody.index, at: inBody.m };
        if (!inTitle) score += inBody.m.quality;
      } else if (!inTitle) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const msg = first && chat.messages[first.index];
    hits.push({
      chat,
      score,
      titleRanges: mergeRanges(titleRanges),
      words,
      snippet: msg && first ? makeSnippet(msg.content, first.at, [...new Set(words)], msg.id) : undefined,
    });
  }
  return hits.sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt);
}

/**
 * Fuzzy-match a short label (e.g. a model name) against a query. Every query word must appear
 * as a substring (ignoring separators, so "glm53" finds "GLM-5.3"), or as a word with a small
 * typo. Scattered letters don't count ("auto" must not match "spark … contributor").
 * Returns a score, higher is better.
 */
export function fuzzyScore(label: string, query: string): number | undefined {
  const text = fold(label);
  let score = 0;
  for (const term of fold(query).split(/\s+/).filter(Boolean)) {
    const m = findTerm(text, term);
    if (m) {
      score += m.quality + (m.start === 0 ? 0.2 : 0);
      continue;
    }
    const compact = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
    const needle = compact(term);
    if (!needle || !compact(text).includes(needle)) return undefined;
    score += 0.5;
  }
  return score;
}
