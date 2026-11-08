/** A single-line data value, never transcript syntax. JSON preserves formatting as escapes.
 * Also escape Unicode line separators and invisible formatting controls (including bidi).
 */
export function untrustedData(text: string): string {
  return `untrusted data ${JSON.stringify(text).replace(/[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
}
