import { createHash } from "node:crypto";

export type PublicDownloadAssetKind = "document" | "video";

export const MAX_PUBLIC_DOCUMENT_BYTES = 8_000_000;
export const MAX_PUBLIC_VIDEO_BYTES = 100_000_000;
export const MAX_LEGACY_COSMOS_FILE_BYTES = 1_000_000;

type FileContract = {
  assetKind: PublicDownloadAssetKind;
  mimeType: string;
  maxBytes: number;
  hasExpectedSignature?: (bytes: Buffer) => boolean;
};

const startsWith = (signature: number[]) => (bytes: Buffer) =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const isIsoBaseMedia = (bytes: Buffer) =>
  bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";

const CONTRACTS: Record<string, FileContract> = {
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

export const PUBLIC_DOWNLOAD_ACCEPT = Object.entries(CONTRACTS)
  .flatMap(([extension, contract]) => [extension, contract.mimeType.split(";")[0]])
  .filter((value, index, values) => values.indexOf(value) === index)
  .join(",");

export function sanitizePublicFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-");
}

export function fileExtension(filename: string): string {
  const clean = filename.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index) : "";
}

export function inspectPublicDownloadFile(filename: string, bytes: Buffer, _reportedMimeType?: string) {
  const sanitizedFilename = sanitizePublicFileName(filename);
  const extension = fileExtension(sanitizedFilename);
  const contract = CONTRACTS[extension];
  if (!contract) throw new Error("Tipo de archivo no permitido para descargas públicas.");
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
