import { createHash } from "node:crypto";

export type PublicDownloadAssetKind = "document" | "video";
export type PublicInlineAssetKind = "image" | "video" | "pdf";

export const MAX_PUBLIC_DOCUMENT_BYTES = 8_000_000;
export const MAX_PUBLIC_VIDEO_BYTES = 100_000_000;
export const MAX_PUBLIC_IMAGE_BYTES = 12_000_000;
type FileContract = {
  assetKind: PublicDownloadAssetKind | PublicInlineAssetKind;
  mimeType: string;
  maxBytes: number;
  hasExpectedSignature?: (bytes: Buffer) => boolean;
};

const startsWith = (signature: number[]) => (bytes: Buffer) =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const isIsoBaseMedia = (bytes: Buffer) =>
  bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";

const isGif = (bytes: Buffer) =>
  bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));

const isWebp = (bytes: Buffer) =>
  bytes.length >= 12 &&
  bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
  bytes.subarray(8, 12).toString("ascii") === "WEBP";

const DOWNLOAD_CONTRACTS: Record<string, FileContract> = {
  ".pdf": { assetKind: "document", mimeType: "application/pdf", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES, hasExpectedSignature: startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]) },
  ".doc": { assetKind: "document", mimeType: "application/msword", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".docx": { assetKind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".xls": { assetKind: "document", mimeType: "application/vnd.ms-excel", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".xlsx": { assetKind: "document", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".ppt": { assetKind: "document", mimeType: "application/vnd.ms-powerpoint", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".pptx": { assetKind: "document", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".vsd": { assetKind: "document", mimeType: "application/vnd.visio", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".vsdx": { assetKind: "document", mimeType: "application/vnd.ms-visio.drawing", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".html": { assetKind: "document", mimeType: "text/html; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".htm": { assetKind: "document", mimeType: "text/html; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".md": { assetKind: "document", mimeType: "text/markdown; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".txt": { assetKind: "document", mimeType: "text/plain; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".csv": { assetKind: "document", mimeType: "text/csv; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".url": { assetKind: "document", mimeType: "text/plain; charset=utf-8", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES },
  ".mp4": { assetKind: "video", mimeType: "video/mp4", maxBytes: MAX_PUBLIC_VIDEO_BYTES, hasExpectedSignature: isIsoBaseMedia },
  ".m4v": { assetKind: "video", mimeType: "video/x-m4v", maxBytes: MAX_PUBLIC_VIDEO_BYTES, hasExpectedSignature: isIsoBaseMedia },
  ".mov": { assetKind: "video", mimeType: "video/quicktime", maxBytes: MAX_PUBLIC_VIDEO_BYTES, hasExpectedSignature: isIsoBaseMedia },
  ".webm": { assetKind: "video", mimeType: "video/webm", maxBytes: MAX_PUBLIC_VIDEO_BYTES, hasExpectedSignature: startsWith([0x1a, 0x45, 0xdf, 0xa3]) },
};

const INLINE_CONTRACTS: Record<string, FileContract> = {
  ".pdf": { assetKind: "pdf", mimeType: "application/pdf", maxBytes: MAX_PUBLIC_DOCUMENT_BYTES, hasExpectedSignature: startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]) },
  ".jpg": { assetKind: "image", mimeType: "image/jpeg", maxBytes: MAX_PUBLIC_IMAGE_BYTES, hasExpectedSignature: startsWith([0xff, 0xd8, 0xff]) },
  ".jpeg": { assetKind: "image", mimeType: "image/jpeg", maxBytes: MAX_PUBLIC_IMAGE_BYTES, hasExpectedSignature: startsWith([0xff, 0xd8, 0xff]) },
  ".png": { assetKind: "image", mimeType: "image/png", maxBytes: MAX_PUBLIC_IMAGE_BYTES, hasExpectedSignature: startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ".gif": { assetKind: "image", mimeType: "image/gif", maxBytes: MAX_PUBLIC_IMAGE_BYTES, hasExpectedSignature: isGif },
  ".webp": { assetKind: "image", mimeType: "image/webp", maxBytes: MAX_PUBLIC_IMAGE_BYTES, hasExpectedSignature: isWebp },
  ".mp4": DOWNLOAD_CONTRACTS[".mp4"],
  ".m4v": DOWNLOAD_CONTRACTS[".m4v"],
  ".mov": DOWNLOAD_CONTRACTS[".mov"],
  ".webm": DOWNLOAD_CONTRACTS[".webm"],
};

function acceptList(contracts: Record<string, FileContract>): string {
  return Object.entries(contracts)
  .flatMap(([extension, contract]) => [extension, contract.mimeType.split(";")[0]])
  .filter((value, index, values) => values.indexOf(value) === index)
  .join(",");
}

export const PUBLIC_DOWNLOAD_ACCEPT = acceptList(DOWNLOAD_CONTRACTS);
export const PUBLIC_INLINE_ACCEPT = acceptList(INLINE_CONTRACTS);

export function sanitizePublicFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-");
}

export function fileExtension(filename: string): string {
  const clean = filename.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index) : "";
}

function inspectFile(
  contracts: Record<string, FileContract>,
  rejectionMessage: string,
  filename: string,
  bytes: Buffer,
) {
  const sanitizedFilename = sanitizePublicFileName(filename);
  const extension = fileExtension(sanitizedFilename);
  const contract = contracts[extension];
  if (!contract) throw new Error(rejectionMessage);
  if (bytes.length === 0) throw new Error("El archivo es obligatorio.");
  if (bytes.length > contract.maxBytes) {
    const limitMb = Math.floor(contract.maxBytes / 1_000_000);
    throw new Error(`El archivo supera el tamaño máximo permitido de ${limitMb} MB.`);
  }
  if (contract.hasExpectedSignature && !contract.hasExpectedSignature(bytes)) {
    throw new Error("El contenido no corresponde al tipo de archivo seleccionado.");
  }
  return {
    assetKind: contract.assetKind,
    filename: sanitizedFilename,
    extension,
    mimeType: contract.mimeType,
    byteCount: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function inspectPublicDownloadFile(filename: string, bytes: Buffer, _reportedMimeType?: string) {
  const result = inspectFile(
    DOWNLOAD_CONTRACTS,
    "Tipo de archivo no permitido para descargas públicas.",
    filename,
    bytes,
  );
  return { ...result, assetKind: result.assetKind as PublicDownloadAssetKind };
}

export function inspectPublicInlineFile(filename: string, bytes: Buffer, _reportedMimeType?: string) {
  const result = inspectFile(
    INLINE_CONTRACTS,
    "Tipo de archivo no permitido para visualización pública.",
    filename,
    bytes,
  );
  return { ...result, assetKind: result.assetKind as PublicInlineAssetKind };
}

export function decodePublicDownloadFile(input: {
  archivoBase64: string;
  archivoNombreOriginal: string;
  archivoMimeType?: string;
}) {
  const base64 = input.archivoBase64.trim();
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("El archivo no tiene un contenido Base64 válido.");
  }
  const bytes = Buffer.from(base64, "base64");
  return { bytes, ...inspectPublicDownloadFile(input.archivoNombreOriginal, bytes, input.archivoMimeType) };
}

export function decodePublicInlineFile(input: {
  archivoBase64: string;
  archivoNombreOriginal: string;
  archivoMimeType?: string;
}) {
  const base64 = input.archivoBase64.trim();
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("El archivo no tiene un contenido Base64 válido.");
  }
  const bytes = Buffer.from(base64, "base64");
  return { bytes, ...inspectPublicInlineFile(input.archivoNombreOriginal, bytes, input.archivoMimeType) };
}
