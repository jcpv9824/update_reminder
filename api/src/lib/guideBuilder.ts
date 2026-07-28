import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrivateObjectLocator } from "./objectStorage";

export const GUIDE_MAX_VIDEO_BYTES = 100_000_000;
export const GUIDE_MAX_DURATION_SECONDS = 15 * 60;

export type GuideSessionStatus =
  | "upload_pending"
  | "queued"
  | "processing"
  | "review"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted";

export type GuideStage =
  | "ingest"
  | "transcription"
  | "frame_extraction"
  | "vision"
  | "draft"
  | "questions"
  | "reprocess"
  | "finalize"
  | "completed";

export type GuideSessionRecord = {
  id: string;
  ownerId: string;
  title?: string;
  originalVideoName: string;
  declaredMimeType: string;
  declaredByteCount: number;
  uploadLocator?: PrivateObjectLocator;
  uploadEtag?: string;
  status: GuideSessionStatus;
  currentStage: GuideStage;
  latestDraftNo: number;
  answeredRoundCount: number;
  finalizedDraftNo?: number;
  failureCode?: string;
  failureSummary?: string;
  createdAt: string;
  updatedAt: string;
  rowVersion: string;
};

export const GuideSessionCreateSchema = z.object({
  fileName: z.string().trim().min(1).max(260),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(GUIDE_MAX_VIDEO_BYTES),
});

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export function inspectGuideVideoDeclaration(input: z.infer<typeof GuideSessionCreateSchema>): {
  fileName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
} {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > GUIDE_MAX_VIDEO_BYTES) {
    throw Object.assign(new Error("El video supera el tamaño máximo permitido de 100 MB."), { status: 413 });
  }
  const fileName = input.fileName.replace(/[\\/:*?"<>|]+/g, "-");
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  const expected = VIDEO_TYPES[extension];
  if (!expected) {
    throw Object.assign(new Error("Solo se admiten videos MP4, M4V, MOV o WebM."), { status: 415 });
  }
  if (input.mimeType.toLowerCase() !== expected) {
    throw Object.assign(new Error("El tipo MIME no coincide con la extensión del video."), { status: 415 });
  }
  return { fileName, extension, mimeType: expected, sizeBytes: input.sizeBytes };
}

export function guideFeatureEnabled(): boolean {
  return process.env.GUIDE_BUILDER_ENABLED === "true";
}

export function guideWorkerEnabled(): boolean {
  return process.env.GUIDE_WORKER_ENABLED === "true"
    && process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED === "true";
}

export function canAccessGuideOwnerScope(
  currentUserId: string,
  sessionOwnerId: string,
  canViewAll: boolean,
): boolean {
  return currentUserId === sessionOwnerId || canViewAll;
}

export function canFinalizeGuide(input: {
  status: GuideSessionStatus;
  answeredRoundCount: number;
  draftAvailable: boolean;
  unresolvedQuestionCount: number;
}): boolean {
  return input.status === "review"
    && input.answeredRoundCount >= 1
    && input.draftAvailable;
}

export function matchesGuideCreateReplay(
  session: GuideSessionRecord,
  input: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    locator: PrivateObjectLocator;
  },
): boolean {
  const existing = session.uploadLocator;
  let sameLocator = false;
  if (existing?.storageProvider === "s3" && input.locator.storageProvider === "s3") {
    sameLocator = existing.storageBucket === input.locator.storageBucket
      && existing.storageObjectKey === input.locator.storageObjectKey;
  } else if (existing?.storageProvider === "azure_blob" && input.locator.storageProvider === "azure_blob") {
    sameLocator = existing.storageContainer === input.locator.storageContainer
      && existing.storageBlobName === input.locator.storageBlobName;
  }
  return session.originalVideoName === input.fileName
    && session.declaredMimeType === input.mimeType
    && session.declaredByteCount === input.sizeBytes
    && sameLocator;
}

export function requireGuideFeature(): void {
  if (!guideFeatureEnabled()) {
    throw Object.assign(new Error("El Constructor de guías no está habilitado."), { status: 503 });
  }
}

export function newGuideSourceId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function encodeRowVersion(value: Buffer): string {
  return `"${value.toString("base64")}"`;
}

export function decodeIfMatch(value: string | null): Buffer {
  const normalized = value?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!normalized) throw Object.assign(new Error("Debe enviar If-Match con la versión vigente."), { status: 428 });
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length !== 8 || bytes.toString("base64") !== normalized) {
    throw Object.assign(new Error("If-Match no contiene una versión válida."), { status: 400 });
  }
  return bytes;
}

export function requireIdempotencyKey(value: string | null): string {
  const key = value?.trim();
  if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    throw Object.assign(new Error("Debe enviar un Idempotency-Key ASCII válido."), { status: 400 });
  }
  return key;
}

export const AnswerRoundSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().min(1).max(150),
    answer: z.string().trim().min(1).max(4000),
  })).min(1).max(20),
});

export const FinalizeGuideSchema = z.object({
  draftVersion: z.number().int().positive(),
});
