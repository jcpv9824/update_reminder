import { createHash } from "node:crypto";
import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import {
  AnswerRoundSchema,
  canAccessGuideOwnerScope,
  canFinalizeGuide,
  decodeIfMatch,
  FinalizeGuideSchema,
  GuideSessionCreateSchema,
  inspectGuideVideoDeclaration,
  newGuideSourceId,
  requireGuideFeature,
  requireIdempotencyKey,
  type GuideSessionRecord,
} from "../lib/guideBuilder";
import {
  appendSqlGuideAnswerRound,
  cancelSqlGuideSession,
  completeSqlGuideUpload,
  createSqlGuideSession,
  queueSqlGuideFinalization,
  readSqlGuideArtifact,
  readSqlGuideArtifactSummary,
  readSqlGuideQuestions,
  readSqlGuideFrames,
  readSqlGuideSession,
  readSqlGuideSessions,
} from "../lib/guideBuilderSqlRepository";
import { badRequest, forbidden, notFound } from "../lib/http";
import { canUseGuideBuilder } from "../lib/managementAccess";
import {
  createPrivateObjectUpload,
  createPrivateObjectUrl,
  statPrivateObject,
} from "../lib/objectStorage";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";

async function currentUser(req: HttpRequest) {
  const authenticated = await requireUser(req);
  const profile = await loadUserProfile(authenticated);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function sessionDto(
  session: GuideSessionRecord,
  options: {
    transcriptAvailable?: boolean;
    transcriptSegmentCount?: number;
    frames?: Awaited<ReturnType<typeof readSqlGuideFrames>>;
    draftAvailable?: boolean;
    draftVersion?: number;
    finalAvailable?: boolean;
    questions?: Awaited<ReturnType<typeof readSqlGuideQuestions>>;
  } = {},
) {
  const questions = options.questions ?? [];
  const pendingVerificationCount = questions.filter((question) => question.status === "open").length;
  const draftVersion = options.draftVersion || session.latestDraftNo;
  const draftAvailable = options.draftAvailable ?? false;
  const transcriptAvailable = options.transcriptAvailable ?? false;
  const processingStages: Record<string, { progressPercent: number; message: string }> = {
    ingest: { progressPercent: 5, message: "Esperando confirmación de carga." },
    transcription: { progressPercent: 20, message: "Preparando y transcribiendo el audio." },
    frame_extraction: { progressPercent: 40, message: "Extrayendo capturas relevantes." },
    vision: { progressPercent: 60, message: "Leyendo la evidencia visual." },
    draft: { progressPercent: 80, message: "Construyendo el borrador." },
    questions: { progressPercent: 90, message: "Preparando preguntas de verificación." },
    reprocess: { progressPercent: 75, message: "Regenerando con las respuestas." },
    finalize: { progressPercent: 95, message: "Validando el manual final." },
    completed: { progressPercent: 100, message: "Manual completado." },
  };
  const isProcessing = ["upload_pending", "queued", "processing", "finalizing"].includes(session.status);
  return {
    id: session.id,
    ownerId: session.ownerId,
    title: session.title,
    status: session.status,
    stage: session.currentStage,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    etag: session.rowVersion,
    sourceFile: {
      name: session.originalVideoName,
      mimeType: session.declaredMimeType,
      sizeBytes: session.declaredByteCount,
    },
    processing: isProcessing
      ? { stage: session.currentStage, ...(processingStages[session.currentStage] ?? { progressPercent: 0, message: "Procesando." }) }
      : null,
    transcript: {
      available: transcriptAvailable,
      segmentCount: options.transcriptSegmentCount ?? 0,
    },
    frames: options.frames ?? [],
    draft: {
      available: draftAvailable,
      version: draftVersion,
      pendingVerificationCount,
    },
    questions: questions.map((question) => ({
      id: question.id,
      text: question.text,
      required: true,
      answered: question.status === "answered",
    })),
    answerRoundCount: session.answeredRoundCount,
    canFinalize: canFinalizeGuide({
      status: session.status,
      answeredRoundCount: session.answeredRoundCount,
      draftAvailable,
      unresolvedQuestionCount: pendingVerificationCount,
    }),
    validation: session.status === "completed"
      ? {
          complete: (options.finalAvailable ?? false) && session.answeredRoundCount >= 1,
          checks: [
            { id: "final_artifact", label: "Manual final disponible", passed: options.finalAvailable ?? false },
            { id: "answer_round", label: "Ronda de respuestas completada", passed: session.answeredRoundCount >= 1 },
          ],
        }
      : null,
    failure: session.failureCode || session.failureSummary
      ? { code: session.failureCode, message: session.failureSummary, retryable: session.status === "failed" }
      : null,
  };
}

async function detailedSessionDto(session: GuideSessionRecord) {
  const [artifacts, questions, frames] = await Promise.all([
    readSqlGuideArtifactSummary(session.id),
    readSqlGuideQuestions(session.id),
    readSqlGuideFrames(session.id),
  ]);
  return sessionDto(session, { ...artifacts, questions, frames });
}

async function withEtag(status: number, session: GuideSessionRecord, body?: unknown): Promise<HttpResponseInit> {
  return {
    status,
    headers: { ETag: session.rowVersion, "Cache-Control": "private, no-store" },
    jsonBody: body ?? await detailedSessionDto(session),
  };
}

function sqlNumber(error: unknown): number | undefined {
  const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
  return candidate.number ?? candidate.originalError?.info?.number;
}

function guideError(error: unknown): HttpResponseInit {
  const number = sqlNumber(error);
  if (number === 52628 || number === 52621) {
    return { status: number === 52628 ? 412 : 404, jsonBody: { error: (error as Error).message } };
  }
  if ([52622, 52623, 52624, 52625, 52626].includes(number ?? 0)) {
    return { status: 409, jsonBody: { error: (error as Error).message } };
  }
  const status = Number((error as { status?: unknown })?.status);
  const safeMessages: Record<number, string> = {
    400: "La solicitud no es válida.",
    403: "No tiene permisos.",
    404: "Sesión de guía no encontrada.",
    409: "La operación entra en conflicto con el estado actual.",
    412: "La sesión cambió; actualice la página.",
    413: "El archivo supera el límite permitido.",
    429: "Se alcanzó temporalmente el límite de procesamiento.",
    503: "El Constructor de guías no está disponible temporalmente.",
  };
  const safeStatus = safeMessages[status] ? status : 500;
  return {
    status: safeStatus,
    jsonBody: { error: safeMessages[safeStatus] ?? "Error interno del servidor." },
  };
}

async function authorizeSession(
  req: HttpRequest,
  action: Parameters<typeof canUseGuideBuilder>[1],
): Promise<{ user: Awaited<ReturnType<typeof currentUser>>; session: GuideSessionRecord }> {
  const user = await currentUser(req);
  const roles = await loadRoleDefinitions();
  if (!canUseGuideBuilder(user, action, roles)) throw Object.assign(new Error("No tiene permisos."), { status: 403 });
  const session = await readSqlGuideSession(req.params.id);
  if (!session) throw Object.assign(new Error("Sesión de guía no encontrada."), { status: 404 });
  const canViewAll = canUseGuideBuilder(user, "view_all", roles);
  if (!canAccessGuideOwnerScope(user.id, session.ownerId, canViewAll)) {
    throw Object.assign(new Error("Sesión de guía no encontrada."), { status: 404 });
  }
  return { user, session };
}

app.http("guideSessionsCollection", {
  route: "guide-sessions",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const user = await currentUser(req);
      const roles = await loadRoleDefinitions();
      if (req.method === "GET") {
        if (!canUseGuideBuilder(user, "view", roles)) return forbidden();
        const page = Math.max(1, Number(req.query.get("page") || "1") || 1);
        const pageSize = Math.max(1, Math.min(50, Number(req.query.get("pageSize") || "20") || 20));
        const status = req.query.get("status")?.trim() || undefined;
        const result = await readSqlGuideSessions({
          ownerId: user.id,
          viewAll: canUseGuideBuilder(user, "view_all", roles),
          page,
          pageSize,
          status,
        });
        return {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
          jsonBody: { items: result.items.map((session) => sessionDto(session)), total: result.total, page, pageSize },
        };
      }

      if (!canUseGuideBuilder(user, "create", roles)) return forbidden();
      const idempotencyKey = requireIdempotencyKey(req.headers.get("idempotency-key"));
      const parsed = GuideSessionCreateSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const video = inspectGuideVideoDeclaration(parsed.data);
      const uploadObjectId = createHash("sha256")
        .update(`${user.id}\0${idempotencyKey}`, "utf8")
        .digest("hex");
      const upload = await createPrivateObjectUpload({
        objectId: uploadObjectId,
        extension: video.extension,
        mimeType: video.mimeType,
        sizeBytes: video.sizeBytes,
      });
      const result = await createSqlGuideSession({
        sessionId: newGuideSourceId("guide_session"),
        owner: user,
        fileName: video.fileName,
        mimeType: video.mimeType,
        sizeBytes: video.sizeBytes,
        idempotencyKey,
        locator: upload.locator,
      });
      if (!result.created) {
        return {
          status: 409,
          headers: {
            ETag: result.session.rowVersion,
            "Cache-Control": "private, no-store",
          },
          jsonBody: {
            error: "La autorización de carga ya fue emitida y no puede volver a generarse.",
            session: sessionDto(result.session),
          },
        };
      }
      return withEtag(result.created ? 201 : 200, result.session, {
        session: sessionDto(result.session),
        upload: {
          url: upload.url,
          method: upload.method,
          headers: upload.headers,
          expiresAt: upload.expiresAt,
        },
      });
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionDetail", {
  route: "guide-sessions/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const { session } = await authorizeSession(req, "view");
      return await withEtag(200, session);
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionUploadComplete", {
  route: "guide-sessions/{id}/upload-complete",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const idempotencyKey = requireIdempotencyKey(req.headers.get("idempotency-key"));
      const { user, session } = await authorizeSession(req, "create");
      if (!session.uploadLocator) {
        if (session.status !== "upload_pending") return await withEtag(200, session);
        return { status: 409, jsonBody: { error: "La sesión no tiene una carga pendiente." } };
      }
      const expected = decodeIfMatch(req.headers.get("if-match"));
      const properties = await statPrivateObject(session.uploadLocator);
      const updated = await completeSqlGuideUpload({
        sessionId: session.id,
        expectedRowVersion: expected,
        idempotencyKey,
        byteCount: properties.byteCount,
        mimeType: properties.mimeType,
        etag: properties.etag,
        actor: user,
      });
      return await withEtag(202, updated);
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionQuestions", {
  route: "guide-sessions/{id}/questions",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      await authorizeSession(req, "view");
      return {
        status: 200,
        headers: { "Cache-Control": "private, no-store" },
        jsonBody: { items: await readSqlGuideQuestions(req.params.id) },
      };
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionRegenerate", {
  route: "guide-sessions/{id}/regenerate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const { user } = await authorizeSession(req, "regenerate");
      const expected = decodeIfMatch(req.headers.get("if-match"));
      const parsed = AnswerRoundSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const deterministicKey = createHash("sha256")
        .update(JSON.stringify(parsed.data.answers), "utf8")
        .digest("hex");
      const updated = await appendSqlGuideAnswerRound({
        sessionId: req.params.id,
        expectedRowVersion: expected,
        idempotencyKey: deterministicKey,
        answers: parsed.data.answers,
        actor: user,
      });
      return await withEtag(202, updated);
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionFinalize", {
  route: "guide-sessions/{id}/finalize",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const { user } = await authorizeSession(req, "finalize");
      const expected = decodeIfMatch(req.headers.get("if-match"));
      const parsed = FinalizeGuideSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const updated = await queueSqlGuideFinalization({
        sessionId: req.params.id,
        expectedRowVersion: expected,
        draftVersion: parsed.data.draftVersion,
        actor: user,
      });
      return await withEtag(202, updated);
    } catch (error) {
      return guideError(error);
    }
  },
});

app.http("guideSessionCancel", {
  route: "guide-sessions/{id}/cancel",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      requireGuideFeature();
      const { user } = await authorizeSession(req, "cancel");
      const updated = await cancelSqlGuideSession({
        sessionId: req.params.id,
        expectedRowVersion: decodeIfMatch(req.headers.get("if-match")),
        actor: user,
      });
      return await withEtag(200, updated);
    } catch (error) {
      return guideError(error);
    }
  },
});

async function artifactRedirect(
  req: HttpRequest,
  permission: Parameters<typeof canUseGuideBuilder>[1],
  kind: "transcript_text" | "draft_markdown" | "final_markdown" | "frame",
  disposition: "inline" | "attachment",
): Promise<HttpResponseInit> {
  await authorizeSession(req, permission);
  const versionValue = req.params.version;
  const artifact = await readSqlGuideArtifact({
    sessionId: req.params.id,
    kind,
    version: versionValue && versionValue !== "current" ? Number(versionValue) : undefined,
    artifactId: req.params.artifactId,
  });
  if (!artifact) return notFound("Artefacto de guía no encontrado.");
  return {
    status: 302,
    headers: {
      Location: await createPrivateObjectUrl({
        ...artifact.locator,
        mimeType: artifact.mimeType,
        filename: artifact.originalName,
        disposition,
      }),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  };
}

app.http("guideSessionTranscript", {
  route: "guide-sessions/{id}/transcript",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    try { requireGuideFeature(); return await artifactRedirect(req, "download_transcript", "transcript_text", "attachment"); }
    catch (error) { return guideError(error); }
  },
});

app.http("guideSessionDraft", {
  route: "guide-sessions/{id}/drafts/{version}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    try { requireGuideFeature(); return await artifactRedirect(req, "view", "draft_markdown", "inline"); }
    catch (error) { return guideError(error); }
  },
});

app.http("guideSessionFrame", {
  route: "guide-sessions/{id}/frames/{artifactId}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    try { requireGuideFeature(); return await artifactRedirect(req, "view", "frame", "inline"); }
    catch (error) { return guideError(error); }
  },
});

app.http("guideSessionManual", {
  route: "guide-sessions/{id}/manual",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    try { requireGuideFeature(); return await artifactRedirect(req, "download_manual", "final_markdown", "attachment"); }
    catch (error) { return guideError(error); }
  },
});
