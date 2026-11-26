import { createHash } from "node:crypto";
import { z } from "zod";
import { ChecklistError } from "./checklistDomain";
import { fileExtension, inspectPublicInlineFile } from "./publicDownloadFiles";
export type ChecklistEvidenceBinaryKind = "image" | "video" | "file";
export type ChecklistEvidenceKind = ChecklistEvidenceBinaryKind | "link" | "text";
/** RN-40 defaults and hard ceilings. Optional environment values may lower a
 * limit, never raise memory/transport promises without another reviewed change. */
export const checklistEvidenceLimits = { image: 10_000_000, video: 100_000_000, file: 25_000_000 } as const;
const textCeiling = 2000;
function configuredLimit(value: string | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > ceiling) {
    throw new ChecklistError(503, "evidence_configuration", "La configuración de límites de evidencias no es válida.");
  }
  return number;
}
export function readChecklistEvidenceLimits(env: NodeJS.ProcessEnv = process.env): Record<ChecklistEvidenceBinaryKind, number> {
  const result = { ...checklistEvidenceLimits } as Record<ChecklistEvidenceBinaryKind, number>;
  for (const kind of ["image", "video", "file"] as const) {
    result[kind] = configuredLimit(env[`CHECKLIST_EVIDENCE_${kind.toUpperCase()}_MAX_BYTES`], checklistEvidenceLimits[kind]);
  }
  return result;
}
const invalid = () => new ChecklistError(400, "invalid_evidence", "El contenido no corresponde a un tipo de evidencia permitido.");
export function assertChecklistEvidenceSize(kind: ChecklistEvidenceBinaryKind, bytes: number, limits = readChecklistEvidenceLimits()): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw invalid();
  if (bytes > limits[kind]) throw new ChecklistError(413, "too_large", `El archivo supera el límite de ${limits[kind] / 1_000_000} MB.`);
}
export const ChecklistEvidenceJsonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(textCeiling) }).strict(),
  z.object({ kind: z.literal("link"), url: z.string().max(textCeiling).refine((value) => {
    if (/[\u0000-\u0020\u007f]/.test(value)) return false;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
  }, "Use un enlace http o https válido, sin credenciales.") }).strict(),
]);
export function validateChecklistEvidenceJson(input: unknown, env: NodeJS.ProcessEnv = process.env) {
  const result = ChecklistEvidenceJsonSchema.parse(input);
  const limit = configuredLimit(env[`CHECKLIST_EVIDENCE_${result.kind.toUpperCase()}_MAX_CHARS`], textCeiling);
  const value = result.kind === "text" ? result.text : result.url;
  if (value.length > limit) throw new ChecklistError(413, "too_large",
    `${result.kind === "text" ? "El texto" : "El enlace"} supera el límite de ${limit} caracteres.`);
  return result;
}

// Validate container structure as well as signature. No decompression, codec
// execution, fetching external URLs or parsing office documents is performed.
function pngStructure(b: Buffer): boolean {
  if (b.length < 45 || b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR" || !b.readUInt32BE(16) || !b.readUInt32BE(20)) return false;
  let p = 8, data = false;
  while (p + 12 <= b.length) {
    const size = b.readUInt32BE(p), type = b.toString("ascii", p + 4, p + 8);
    if (p + 12 + size > b.length) return false;
    if (type === "IDAT" && size) data = true;
    p += size + 12;
    if (type === "IEND") return size === 0 && data && p === b.length;
  }
  return false;
}
function jpegStructure(b: Buffer): boolean {
  if (b.length < 12 || b.readUInt16BE(0) !== 0xffd8 || b.readUInt16BE(b.length - 2) !== 0xffd9) return false;
  let p = 2, frame = false;
  while (p + 4 < b.length) {
    if (b[p++] !== 0xff) return false;
    while (b[p] === 0xff) p++;
    const marker = b[p++];
    if (marker === 0xda) return frame && p + 2 < b.length;
    const length = b.readUInt16BE(p);
    if (length < 2 || p + length > b.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !b.readUInt16BE(p + 3) || !b.readUInt16BE(p + 5)) return false;
      frame = true;
    }
    p += length;
  }
  return false;
}
function rasterStructure(mime: string, b: Buffer): boolean {
  if (mime === "image/png") return pngStructure(b);
  if (mime === "image/jpeg") return jpegStructure(b);
  if (mime === "image/gif") return b.length >= 14 && b.readUInt16LE(6) > 0 && b.readUInt16LE(8) > 0 && b[b.length - 1] === 0x3b && b.includes(0x2c, 10);
  if (mime === "image/webp") return b.length >= 20 && b.readUInt32LE(4) + 8 === b.length && ["VP8 ", "VP8L", "VP8X"].includes(b.toString("ascii", 12, 16)) && b.readUInt32LE(16) + 20 <= b.length;
  return false;
}
function videoStructure(extension: string, bytes: Buffer): boolean {
  if (extension === ".webm") return bytes.length > 16 && bytes.readUInt32BE(0) === 0x1a45dfa3 && bytes.subarray(0, 4096).includes(Buffer.from("webm")) && bytes.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  let p = 0; const types = new Set<string>();
  while (p + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(p); const type = bytes.toString("ascii", p + 4, p + 8);
    if (size === 1) { if (p + 16 > bytes.length) return false; const extended = bytes.readBigUInt64BE(p + 8); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false; size = Number(extended); }
    if (size === 0) size = bytes.length - p;
    if (size < 8 || p + size > bytes.length) return false;
    types.add(type); p += size;
  }
  return p === bytes.length && types.has("moov") && types.has("mdat") && (extension === ".mov" || types.has("ftyp"));
}
export function inspectChecklistEvidence(kind: unknown, name: unknown, bytes: Buffer, _reportedMime?: string, limits = readChecklistEvidenceLimits()) {
  if (kind !== "image" && kind !== "video" && kind !== "file") throw invalid();
  assertChecklistEvidenceSize(kind, bytes.length, limits);
  if (typeof name !== "string") throw invalid();
  const fileName = name.normalize("NFC").replace(/[\p{C}\\/:*?"<>|]/gu, "-").trim();
  if (!fileName || fileName.length > 255) throw invalid();
  const ext = fileExtension(fileName);
  let contentType = "application/octet-stream", extension = ".bin";
  if (kind === "image") {
    try {
      const inspected = inspectPublicInlineFile(fileName, bytes);
      if (!rasterStructure(inspected.mimeType, bytes)) throw invalid();
      contentType = inspected.mimeType; extension = ext === ".jpeg" ? ".jpg" : ext;
    } catch { throw invalid(); }
  } else if (kind === "video") {
    if (![".mp4", ".mov", ".webm"].includes(ext) || !videoStructure(ext, bytes)) throw invalid();
    contentType = ext === ".mp4" ? "video/mp4" : ext === ".mov" ? "video/quicktime" : "video/webm"; extension = ext;
  }
  return { kind: kind as ChecklistEvidenceBinaryKind, fileName, contentType, extension, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}
export type InspectedChecklistEvidence = ReturnType<typeof inspectChecklistEvidence>;
