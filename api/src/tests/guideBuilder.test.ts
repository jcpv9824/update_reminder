import { afterEach, describe, expect, it } from "vitest";
import {
  canFinalizeGuide,
  decodeIfMatch,
  encodeRowVersion,
  guideFeatureEnabled,
  guideWorkerEnabled,
  inspectGuideVideoDeclaration,
  matchesGuideCreateReplay,
  requireIdempotencyKey,
} from "../lib/guideBuilder";

const originalFeature = process.env.GUIDE_BUILDER_ENABLED;
const originalWorker = process.env.GUIDE_WORKER_ENABLED;
const originalCertified = process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED;

afterEach(() => {
  if (originalFeature === undefined) delete process.env.GUIDE_BUILDER_ENABLED;
  else process.env.GUIDE_BUILDER_ENABLED = originalFeature;
  if (originalWorker === undefined) delete process.env.GUIDE_WORKER_ENABLED;
  else process.env.GUIDE_WORKER_ENABLED = originalWorker;
  if (originalCertified === undefined) delete process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED;
  else process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED = originalCertified;
});

describe("guide builder transport contract", () => {
  it("is disabled by default", () => {
    delete process.env.GUIDE_BUILDER_ENABLED;
    expect(guideFeatureEnabled()).toBe(false);
  });

  it("does not enable job claims without the deployment certification gate", () => {
    process.env.GUIDE_WORKER_ENABLED = "true";
    delete process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED;
    expect(guideWorkerEnabled()).toBe(false);
    process.env.GUIDE_WORKER_PROCESSOR_CERTIFIED = "true";
    expect(guideWorkerEnabled()).toBe(true);
  });

  it("accepts only a matching allowlisted video extension and MIME type", () => {
    expect(inspectGuideVideoDeclaration({
      fileName: "Demostración SAG.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_024,
    })).toMatchObject({ extension: ".mp4", mimeType: "video/mp4" });
    expect(() => inspectGuideVideoDeclaration({
      fileName: "payload.html",
      mimeType: "video/mp4",
      sizeBytes: 1_024,
    })).toThrow(/Solo se admiten/);
    expect(() => inspectGuideVideoDeclaration({
      fileName: "video.mp4",
      mimeType: "text/html",
      sizeBytes: 1_024,
    })).toThrow(/MIME/);
  });

  it("enforces the 100 MB non-production upload ceiling", () => {
    expect(() => inspectGuideVideoDeclaration({
      fileName: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100_000_001,
    })).toThrow();
  });

  it("round-trips SQL rowversion through the ETag contract", () => {
    const value = Buffer.from("0102030405060708", "hex");
    const etag = encodeRowVersion(value);
    expect(etag).toMatch(/^".+"$/);
    expect(decodeIfMatch(etag)).toEqual(value);
    expect(() => decodeIfMatch(null)).toThrow(/If-Match/);
  });

  it("requires bounded printable ASCII idempotency keys", () => {
    expect(requireIdempotencyKey("guide-upload-1")).toBe("guide-upload-1");
    expect(() => requireIdempotencyKey(null)).toThrow(/Idempotency-Key/);
    expect(() => requireIdempotencyKey("línea")).toThrow(/ASCII/);
  });

  it("requires an answered round, a draft, and no unresolved question before finalization", () => {
    expect(canFinalizeGuide({
      status: "review",
      answeredRoundCount: 1,
      draftAvailable: true,
      unresolvedQuestionCount: 0,
    })).toBe(true);
    expect(canFinalizeGuide({
      status: "review",
      answeredRoundCount: 1,
      draftAvailable: true,
      unresolvedQuestionCount: 1,
    })).toBe(false);
    expect(canFinalizeGuide({
      status: "review",
      answeredRoundCount: 0,
      draftAvailable: true,
      unresolvedQuestionCount: 0,
    })).toBe(false);
  });

  it("rejects an idempotency replay whose upload contract changed", () => {
    const session = {
      id: "guide_session_1",
      ownerId: "user_1",
      originalVideoName: "guide.mp4",
      declaredMimeType: "video/mp4",
      declaredByteCount: 1_024,
      uploadLocator: {
        storageProvider: "s3" as const,
        storageBucket: "portal-sag",
        storageObjectKey: "guides/upload.mp4",
      },
      status: "upload_pending" as const,
      currentStage: "ingest" as const,
      latestDraftNo: 0,
      answeredRoundCount: 0,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      rowVersion: "\"AQIDBAUGBwg=\"",
    };
    expect(matchesGuideCreateReplay(session, {
      fileName: "guide.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_024,
      locator: session.uploadLocator,
    })).toBe(true);
    expect(matchesGuideCreateReplay(session, {
      fileName: "other.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2_048,
      locator: session.uploadLocator,
    })).toBe(false);
  });
});
