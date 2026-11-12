import { expect, test } from "bun:test";
import { attachedFileNote, fileKind, formatBytes, isPicture } from "../shared/attachments";
import { capAttached, fileRef, parseFileRef } from "../shared/bots";

test("a file's kind comes from its type, or from its name when the browser gave none", () => {
  expect(fileKind("video/x-matroska", "film.mkv")).toBe("video");
  expect(fileKind("audio/mpeg")).toBe("audio");
  expect(fileKind("application/octet-stream", "backup.tar.gz")).toBe("archive");
  expect(fileKind("application/zip")).toBe("archive");
  expect(fileKind("", "NOTES.md")).toBe("text");
  expect(fileKind("application/octet-stream", "thing.bin")).toBe("file");
});

test("only a picture carried in the message is shown and sent as one", () => {
  expect(isPicture({ mime: "image/png", dataUrl: "data:image/png;base64,AAAA" })).toBe(true);
  // An SVG or HEIC kept on disk is a file the agent opens, not pixels for the model.
  expect(isPicture({ mime: "image/svg+xml", dataUrl: "" })).toBe(false);
  expect(isPicture({ mime: "video/mp4", dataUrl: "" })).toBe(false);
});

test("the prompt names where the file is and how large", () => {
  expect(attachedFileNote({ name: "film.mkv", mime: "video/x-matroska", size: 3 * 1024 ** 3 }, "/data/attachments/a/film.mkv")).toBe(
    '[Attached file "film.mkv" (video/x-matroska, 3.00 GB) is saved at /data/attachments/a/film.mkv. Open it with your tools when you need it.]',
  );
  expect(formatBytes(1536)).toBe("2 KB");
});

test("a bot composer's list holds pictures and file references, each up to its own limit", () => {
  const file = (n: number) => fileRef({ id: `id-${n}`, name: `f${n}.zip`, mime: "application/zip", size: n });
  expect(parseFileRef(file(3))).toEqual({ id: "id-3", name: "f3.zip", mime: "application/zip", size: 3 });
  expect(parseFileRef("data:image/png;base64,AAAA")).toBeUndefined();
  expect(parseFileRef("obfile:{broken")).toBeUndefined();
  const pictures = [1, 2, 3, 4, 5].map((n) => `data:image/png;base64,${n}`);
  const files = Array.from({ length: 12 }, (_, n) => file(n));
  const kept = capAttached([...pictures, ...files, files[0]!]);
  expect(kept.filter((x) => !parseFileRef(x))).toEqual(pictures.slice(0, 4));
  expect(kept.filter((x) => parseFileRef(x))).toEqual(files.slice(0, 10));
});
