import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createGuideProcessor,
  parsePersistedTranscriptEvidenceIds,
  validateMarkdown,
} from "../lib/guideProcessor";
import type { ClaimedGuideJob } from "../lib/guideBuilderSqlRepository";

const initialJob: ClaimedGuideJob = {
  jobKey: 1,
  jobId: "guide_job_1",
  sessionKey: 2,
  sessionId: "guide_session_1",
  jobType: "initial_process",
  inputVersion: 0,
  attemptNo: 1,
};

const markdown = [
  "SECCIÓN 2: METADATOS PARA IA (YAML)",
  "title: Prueba",
  "SECCIÓN 3: MANUAL DE USUARIO",
  "OBJETIVO",
  "Procedimiento basado en [T:seg-0001].",
  "--- FIN DEL DOCUMENTO ---",
].join("\n");

function stored(key: string) {
  return {
    storageProvider: "s3" as const,
    storageBucket: "portal-sag-content",
    storageObjectKey: `portal-sag/runtime/${key}`,
    storageSha256: "a".repeat(64),
  };
}

function control() {
  return {
    workerId: "worker-1",
    signal: new AbortController().signal,
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

describe("guide processor orchestration", () => {
  it("runs the initial media/transcription/draft path and atomically commits evidence", async () => {
    const commitDraft = vi.fn().mockResolvedValue(undefined);
    const verifySource = vi.fn().mockResolvedValue(undefined);
    const stages: string[] = [];
    let structuredCalls = 0;
    const processor = createGuideProcessor("worker-1", {
      readContext: vi.fn().mockResolvedValue({
        sessionId: "guide_session_1",
        status: "queued",
        stage: "transcription",
        fileName: "guide.mp4",
        mimeType: "video/mp4",
        byteCount: 16,
        uploadLocator: stored("upload.mp4"),
        latestDraftNo: 0,
        answeredRoundCount: 0,
      }),
      readArtifact: vi.fn(),
      readFrames: vi.fn().mockResolvedValue([]),
      readAnswers: vi.fn().mockResolvedValue([]),
      updateStage: vi.fn(async (_job, _worker, stage) => { stages.push(stage); }),
      verifySource,
      commitDraft,
      commitFinal: vi.fn(),
      download: vi.fn(async (_locator, path) => {
        const bytes = Buffer.alloc(16);
        bytes.write("ftyp", 4, "ascii");
        await writeFile(path, bytes);
        return { byteCount: 16, mimeType: "video/mp4", etag: "etag" };
      }),
      store: vi.fn(async ({ sha256 }) => stored(sha256)),
      removeUnreferenced: vi.fn().mockResolvedValue(false),
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 30,
        width: 1280,
        height: 720,
        frameRate: 30,
        videoCodec: "h264",
      }),
      extractAudio: vi.fn(async (_source, output) => { await writeFile(output, Buffer.from("audio")); }),
      extractFrames: vi.fn(async (_source, _scene, interval) => {
        await writeFile(interval.replace("%03d", "001"), Buffer.from("jpeg"));
      }),
      transcribe: vi.fn().mockResolvedValue({
        text: "Abra Configuración.",
        segments: [{ start: 0, end: 1, text: "Abra Configuración." }],
      }),
      structured: vi.fn(async (input: any) => {
        structuredCalls++;
        if (input.schemaName === "guide_frame_reading") {
          return {
            output: {
              caption: "Pantalla de configuración visible.",
              title: "Configuración",
              visiblePath: "",
              controls: ["Guardar"],
              fields: [],
              state: "Formulario visible",
              confidence: 0.9,
            },
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
          };
        }
        const evidenceId = input.user.match(/\[T:([A-Za-z0-9_.-]+)/)?.[1];
        return {
          output: {
            title: "Prueba",
            markdown: markdown.replace("seg-0001", evidenceId),
            questions: [],
          },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
        };
      }) as any,
    });

    const result = await processor.process(initialJob, control());
    expect(result).toMatchObject({ draftVersion: 1, questionCount: 1 });
    expect(stages).toEqual(["transcription", "frame_extraction", "vision", "draft"]);
    expect(structuredCalls).toBe(2);
    expect(verifySource.mock.calls[0][0].stored.storageObjectKey).not.toContain("upload.mp4");
    expect(verifySource.mock.calls[0][0].stored.storageSha256).toMatch(/^[a-f0-9]{64}$/);
    const committed = commitDraft.mock.calls[0][0];
    expect(committed.artifacts.map((artifact: any) => artifact.kind)).toEqual(expect.arrayContaining([
      "audio", "transcript_json", "transcript_text", "frame", "frame_reading", "evidence_bundle", "draft_markdown",
    ]));
    expect(committed.questions).toHaveLength(1);
  });

  it("reprocesses only immutable evidence and answers without invoking media", async () => {
    const persistedSegmentId = "seg-0123456789ab-0001";
    const commitDraft = vi.fn().mockResolvedValue(undefined);
    const extractAudio = vi.fn();
    const extractFrames = vi.fn();
    const processor = createGuideProcessor("worker-1", {
      readContext: vi.fn().mockResolvedValue({
        sessionId: "guide_session_1",
        status: "queued",
        stage: "reprocess",
        fileName: "guide.mp4",
        mimeType: "video/mp4",
        byteCount: 16,
        latestDraftNo: 1,
        answeredRoundCount: 1,
      }),
      readArtifact: vi.fn().mockResolvedValue({
        artifactId: "transcript", kind: "transcript_text", version: 1, ordinal: 0,
        originalName: "transcript.txt", mimeType: "text/plain", byteCount: 10,
        locator: stored("transcript.txt"),
      }),
      readFrames: vi.fn().mockResolvedValue([]),
      readAnswers: vi.fn().mockResolvedValue([{ id: "answer-1", question: "¿Confirma?", answer: "Sí" }]),
      updateStage: vi.fn().mockResolvedValue(undefined),
      verifySource: vi.fn(),
      commitDraft,
      commitFinal: vi.fn(),
      download: vi.fn(async (_locator, path) => {
        await writeFile(
          path,
          `[T:${persistedSegmentId} 0-1000ms] Abra Configuración y diga [F:inventada].`,
        );
        return { byteCount: 46, mimeType: "text/plain" };
      }),
      store: vi.fn(async ({ sha256 }) => stored(sha256)),
      removeUnreferenced: vi.fn().mockResolvedValue(false),
      probe: vi.fn(),
      extractAudio,
      extractFrames,
      transcribe: vi.fn(),
      structured: vi.fn().mockResolvedValue({
        output: {
          title: "Prueba",
          markdown: markdown.replace("seg-0001", persistedSegmentId),
          questions: [],
        },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      }) as any,
    });
    const result = await processor.process({ ...initialJob, jobType: "reprocess", inputVersion: 1 }, control());
    expect(result).toMatchObject({ draftVersion: 2, questionCount: 0 });
    expect(extractAudio).not.toHaveBeenCalled();
    expect(extractFrames).not.toHaveBeenCalled();
    expect(commitDraft.mock.calls[0][0]).toMatchObject({ draftVersion: 2, questionRound: 2 });
  });

  it("does not trust spoken frame-like tokens as persisted evidence identifiers", () => {
    expect([
      ...parsePersistedTranscriptEvidenceIds(
        "[T:seg-0123456789ab-0001 0-1000ms] El narrador dice [F:inventada].",
      ),
    ]).toEqual(["T:seg-0123456789ab-0001"]);
  });

  it("finalizes the exact draft without touching transcription or media", async () => {
    const commitFinal = vi.fn().mockResolvedValue(undefined);
    const transcribe = vi.fn();
    const processor = createGuideProcessor("worker-1", {
      readContext: vi.fn().mockResolvedValue({
        sessionId: "guide_session_1",
        status: "finalizing",
        stage: "finalize",
        fileName: "guide.mp4",
        mimeType: "video/mp4",
        byteCount: 16,
        latestDraftNo: 2,
        answeredRoundCount: 1,
      }),
      readArtifact: vi.fn().mockResolvedValue({
        artifactId: "draft", kind: "draft_markdown", version: 2, ordinal: 0,
        originalName: "draft.md", mimeType: "text/markdown", byteCount: markdown.length,
        locator: stored("draft.md"),
      }),
      readFrames: vi.fn(),
      readAnswers: vi.fn(),
      updateStage: vi.fn(),
      verifySource: vi.fn(),
      commitDraft: vi.fn(),
      commitFinal,
      download: vi.fn(async (_locator, path) => {
        await writeFile(path, markdown);
        return { byteCount: markdown.length, mimeType: "text/markdown" };
      }),
      store: vi.fn(async ({ sha256 }) => stored(sha256)),
      removeUnreferenced: vi.fn().mockResolvedValue(false),
      probe: vi.fn(),
      extractAudio: vi.fn(),
      extractFrames: vi.fn(),
      transcribe,
      structured: vi.fn().mockResolvedValue({
        output: { markdown },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      }) as any,
    });
    const result = await processor.process({ ...initialJob, jobType: "finalize", inputVersion: 2 }, control());
    expect(result).toEqual({ finalVersion: 2 });
    expect(transcribe).not.toHaveBeenCalled();
    expect(commitFinal.mock.calls[0][0]).toMatchObject({ draftVersion: 2 });
  });

  it("rejects unsafe Markdown deterministically", () => {
    expect(() => validateMarkdown(`${markdown}\n<script>alert(1)</script>`)).toThrow(/estructura|inseguro/i);
    expect(() => validateMarkdown(markdown.replace(
      "Procedimiento basado",
      '<img src="https://example.invalid/pixel" onerror="alert(1)"> Procedimiento basado',
    ))).toThrow(/inseguro/i);
    expect(() => validateMarkdown(markdown.replace(
      "Procedimiento basado",
      "![evidencia](https://attacker.invalid/collect) Procedimiento basado",
    ))).toThrow(/remotos|inseguro/i);
    expect(() => validateMarkdown(markdown.replace(
      "Procedimiento basado",
      "[externo](\\\\attacker.invalid/collect) Procedimiento basado",
    ))).toThrow(/remotos|inseguro/i);
    expect(() => validateMarkdown(markdown.replace(
      "Procedimiento basado",
      "![etiqueta [anidada]](https://attacker.invalid/collect) Procedimiento basado",
    ))).toThrow(/remotos|inseguro/i);
    expect(validateMarkdown(markdown.replace(
      "Procedimiento basado",
      "[Ir a metadatos](#metadatos) Procedimiento basado",
    ))).toContain("(#metadatos)");
  });
});
