import type { Attachment } from "../../shared/types";
import { uid } from "./chat";

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|dart|scala|vue|svelte|tex|log|conf|cfg|gitignore|dockerfile)$/i;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_EDGE = 2048;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

export const ACCEPT = [...IMAGE_TYPES, "application/pdf", "text/*", ".md", ".json", ".csv", ".ts", ".tsx", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".sql", ".yaml", ".yml", ".toml", ".sh"].join(",");

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3.5 * 1024 * 1024 && file.type !== "image/gif") {
    bitmap.close();
    return readAsDataUrl(file);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(type, 0.9);
}

export class AttachmentError extends Error {}

export async function readAttachment(file: File): Promise<Attachment> {
  const base = { id: uid(), name: file.name || "pasted-image.png", size: file.size };
  if (IMAGE_TYPES.includes(file.type)) {
    const dataUrl = await downscale(file);
    return { ...base, mime: dataUrl.slice(5, dataUrl.indexOf(";")), dataUrl };
  }
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new AttachmentError(`${file.name} is larger than 20 MB.`);
    return { ...base, mime: file.type, dataUrl: await readAsDataUrl(file) };
  }
  if (file.type.startsWith("text/") || TEXT_EXT.test(file.name) || file.type === "application/json") {
    if (file.size > MAX_TEXT_BYTES) throw new AttachmentError(`${file.name} is larger than 1 MB.`);
    const text = await file.text();
    if (text.includes("\u0000")) throw new AttachmentError(`${file.name} doesn't look like a text file.`);
    return { ...base, mime: file.type || "text/plain", dataUrl: "", text };
  }
  throw new AttachmentError(`${file.name}: only images, PDFs and text files can be attached.`);
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
