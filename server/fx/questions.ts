import type { StreamEvent } from "../../shared/types";

type Ask = Omit<Extract<StreamEvent, { t: "ask" }>, "t" | "id">;
export type QuestionReply = { value?: string; confirmed?: boolean; cancelled?: boolean };
export const elicitationMethods = new Set(["elicitation/create", "session/elicitation", "_session/elicitation"]);
export const QUESTION_NOTE = "When you need a decision or clarification from the user, use request_user_input to ask through the app's question tool instead of asking in prose. Wait for the real answer; never invent it.";

/** ACP form elicitation (also used by t3code). Never accept a URL or an unsupported schema. */
export async function elicit(params: any, ask: (a: Ask) => Promise<QuestionReply>): Promise<{ action: "accept" | "cancel" | "decline"; content?: Record<string, unknown> }> {
  const schema = params?.requestedSchema;
  if (params?.mode !== "form" || schema?.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return { action: "decline" };
  const fields = Object.entries(schema.properties) as [string, any][];
  if (!fields.length || fields.some(([, f]) => !f || !["string", "number", "integer", "boolean"].includes(f.type) || Object.keys(f).some(k => !["type", "title", "description", "enum", "enumNames", "default", "minimum", "maximum", "minLength", "maxLength"].includes(k)) || (f.enum && (!Array.isArray(f.enum) || !f.enum.length || f.enum.some((v: unknown) => !["string", "number", "boolean"].includes(typeof v)))))) return { action: "decline" };
  const content: Record<string, unknown> = {};
  for (const [key, f] of fields) {
    const values: unknown[] | undefined = f.enum ?? (f.type === "boolean" ? [true, false] : undefined);
    const labels: string[] | undefined = values?.map((v, i) => f.enumNames?.[i] ?? String(v));
    const reply = await ask({ method: labels?.length ? "select" : "input", title: f.title || f.description || params.message || key, message: [f.title && f.description, params.message].filter(Boolean).join("\n") || undefined, options: labels, other: !values, prefill: f.default === undefined ? undefined : String(f.default) });
    if (reply.cancelled) return { action: "cancel" };
    let value: unknown = reply.value ?? "";
    if (values) {
      const index = labels!.indexOf(String(value));
      if (index < 0) return { action: "decline" };
      value = values[index];
    } else if (f.type === "number" || f.type === "integer") {
      if (!String(value).trim()) return { action: "decline" };
      value = Number(value);
    }
    if ((f.type === "string" && typeof value !== "string") || (f.type === "boolean" && typeof value !== "boolean") || (["number", "integer"].includes(f.type) && (typeof value !== "number" || !Number.isFinite(value) || (f.type === "integer" && !Number.isInteger(value))))) return { action: "decline" };
    if (typeof value === "number" && ((f.minimum !== undefined && value < f.minimum) || (f.maximum !== undefined && value > f.maximum))) return { action: "decline" };
    if (typeof value === "string" && ((f.minLength !== undefined && value.length < f.minLength) || (f.maxLength !== undefined && value.length > f.maxLength))) return { action: "decline" };
    content[key] = value;
  }
  return { action: "accept", content };
}
