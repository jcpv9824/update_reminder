import { randomUUID } from "node:crypto";
import sql from "mssql";
import type { CurrentUser } from "../types/models";
import {
  encodeRowVersion,
  matchesGuideCreateReplay,
  newGuideSourceId,
  type GuideSessionRecord,
} from "./guideBuilder";
import type { PrivateObjectLocator, StoredPrivateObject } from "./objectStorage";
import { ensureSqlContentFile } from "./contentFileSqlWriter";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";

type SessionRow = {
  guide_session_key: number;
  source_id: string;
  owner_source_id: string;
  title: string | null;
  original_video_name: string;
  declared_mime_type: string;
  declared_byte_count: number;
  upload_storage_provider: "s3" | "azure_blob" | null;
  upload_storage_container: string | null;
  upload_blob_name: string | null;
  upload_storage_bucket: string | null;
  upload_object_key: string | null;
  upload_object_etag: string | null;
  status: GuideSessionRecord["status"];
  current_stage: GuideSessionRecord["currentStage"];
  latest_draft_no: number;
  answered_round_count: number;
  finalized_draft_no: number | null;
  failure_code: string | null;
  failure_summary: string | null;
  created_at: Date;
  updated_at: Date;
  row_version: Buffer;
};

const SESSION_PROJECTION = `
  session.guide_session_key,session.source_id,owner.source_id AS owner_source_id,
  session.title,session.original_video_name,session.declared_mime_type,session.declared_byte_count,
  session.upload_storage_provider,session.upload_storage_container,session.upload_blob_name,
  session.upload_storage_bucket,session.upload_object_key,session.upload_object_etag,
  session.status,session.current_stage,session.latest_draft_no,session.answered_round_count,
  session.finalized_draft_no,session.failure_code,session.failure_summary,
  session.created_at,session.updated_at,session.row_version`;

function mapSession(row: SessionRow): GuideSessionRecord {
  let uploadLocator: PrivateObjectLocator | undefined;
  if (row.upload_storage_provider === "s3" && row.upload_storage_bucket && row.upload_object_key) {
    uploadLocator = {
      storageProvider: "s3",
      storageBucket: row.upload_storage_bucket,
      storageObjectKey: row.upload_object_key,
      storageObjectEtag: row.upload_object_etag ?? undefined,
    };
  } else if (row.upload_storage_provider === "azure_blob" && row.upload_storage_container && row.upload_blob_name) {
    uploadLocator = {
      storageProvider: "azure_blob",
      storageContainer: row.upload_storage_container,
      storageBlobName: row.upload_blob_name,
      storageBlobEtag: row.upload_object_etag ?? undefined,
    };
  }
  return {
    id: row.source_id,
    ownerId: row.owner_source_id,
    title: row.title ?? undefined,
    originalVideoName: row.original_video_name,
    declaredMimeType: row.declared_mime_type,
    declaredByteCount: Number(row.declared_byte_count),
    uploadLocator,
    uploadEtag: row.upload_object_etag ?? undefined,
    status: row.status,
    currentStage: row.current_stage,
    latestDraftNo: row.latest_draft_no,
    answeredRoundCount: row.answered_round_count,
    finalizedDraftNo: row.finalized_draft_no ?? undefined,
    failureCode: row.failure_code ?? undefined,
    failureSummary: row.failure_summary ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    rowVersion: encodeRowVersion(row.row_version),
  };
}

async function appendStatusEvent(
  transaction: sql.Transaction,
  sessionKey: number,
  fromStatus: string | null,
  toStatus: string,
  stage: string,
  actorId: string,
  reasonCode?: string,
): Promise<void> {
  const request = new sql.Request(transaction);
  request.input("sessionKey", sql.BigInt, sessionKey);
  request.input("fromStatus", sql.VarChar(30), fromStatus);
  request.input("toStatus", sql.VarChar(30), toStatus);
  request.input("stage", sql.VarChar(30), stage);
  request.input("reasonCode", sql.NVarChar(80), reasonCode ?? null);
  request.input("actorId", sql.NVarChar(150), actorId);
  await request.query(`
    DECLARE @eventNo INT=ISNULL((SELECT MAX(event_no) FROM content.guide_status_events WITH (UPDLOCK,HOLDLOCK)
      WHERE guide_session_key=@sessionKey),0)+1;
    INSERT content.guide_status_events
      (guide_session_key,event_no,from_status,to_status,stage,reason_code,occurred_by)
    VALUES(@sessionKey,@eventNo,@fromStatus,@toStatus,@stage,@reasonCode,@actorId);
  `);
}

async function enqueueGuideJob(
  transaction: sql.Transaction,
  sessionKey: number,
  sessionId: string,
  jobType: "initial_process" | "reprocess" | "finalize",
  inputVersion: number,
  actorId: string,
): Promise<void> {
  const idempotencyKey = `guide:${sessionId}:${jobType}:${inputVersion}`;
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), newGuideSourceId("guide_job"));
  request.input("sessionKey", sql.BigInt, sessionKey);
  request.input("jobType", sql.VarChar(30), jobType);
  request.input("inputVersion", sql.Int, inputVersion);
  request.input("idempotencyKey", sql.NVarChar(300), idempotencyKey);
  request.input("actorId", sql.NVarChar(150), actorId);
  await request.query(`
    IF NOT EXISTS (SELECT 1 FROM content.guide_jobs WITH (UPDLOCK,HOLDLOCK) WHERE idempotency_key=@idempotencyKey)
      INSERT content.guide_jobs
      (source_id,guide_session_key,job_type,input_version,idempotency_key,job_status,active_slot,
       attempt_count,max_attempts,next_attempt_at,created_at,created_by,updated_at,updated_by)
      VALUES(@sourceId,@sessionKey,@jobType,@inputVersion,@idempotencyKey,'pending',1,0,5,SYSUTCDATETIME(),
        SYSUTCDATETIME(),@actorId,SYSUTCDATETIME(),@actorId);
  `);
}

export async function createSqlGuideSession(input: {
  sessionId: string;
  owner: CurrentUser;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  idempotencyKey: string;
  locator: PrivateObjectLocator;
}): Promise<{ session: GuideSessionRecord; created: boolean }> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("ownerId", sql.NVarChar(150), input.owner.id);
    request.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
    const existing = await request.query<SessionRow>(`
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session WITH (UPDLOCK,HOLDLOCK)
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE owner.source_id=@ownerId AND session.create_idempotency_key=@idempotencyKey;
    `);
    if (existing.recordset[0]) {
      const replay = mapSession(existing.recordset[0]);
      if (!matchesGuideCreateReplay(replay, input)) {
        throw Object.assign(
          new Error("El Idempotency-Key ya fue usado con una carga diferente."),
          { status: 409 },
        );
      }
      return { session: replay, created: false };
    }

    const insert = new sql.Request(transaction);
    insert.input("sourceId", sql.NVarChar(150), input.sessionId);
    insert.input("ownerId", sql.NVarChar(150), input.owner.id);
    insert.input("fileName", sql.NVarChar(260), input.fileName);
    insert.input("mimeType", sql.NVarChar(160), input.mimeType);
    insert.input("sizeBytes", sql.BigInt, input.sizeBytes);
    insert.input("provider", sql.VarChar(30), input.locator.storageProvider);
    insert.input("container", sql.NVarChar(100), input.locator.storageProvider === "azure_blob" ? input.locator.storageContainer : null);
    insert.input("blobName", sql.NVarChar(1024), input.locator.storageProvider === "azure_blob" ? input.locator.storageBlobName : null);
    insert.input("bucket", sql.NVarChar(255), input.locator.storageProvider === "s3" ? input.locator.storageBucket : null);
    insert.input("objectKey", sql.NVarChar(1024), input.locator.storageProvider === "s3" ? input.locator.storageObjectKey : null);
    insert.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
    insert.input("actorId", sql.NVarChar(150), input.owner.id);
    const result = await insert.query<SessionRow>(`
      DECLARE @inserted TABLE(guide_session_key BIGINT NOT NULL);
      INSERT content.guide_sessions
      (source_id,owner_user_key,original_video_name,declared_mime_type,declared_byte_count,
       upload_storage_provider,upload_storage_container,upload_blob_name,upload_storage_bucket,upload_object_key,
       status,current_stage,create_idempotency_key,created_at,created_by,updated_at,updated_by)
      OUTPUT INSERTED.guide_session_key INTO @inserted
      SELECT @sourceId,user_record.user_key,@fileName,@mimeType,@sizeBytes,
        @provider,@container,@blobName,@bucket,@objectKey,
        'upload_pending','ingest',@idempotencyKey,SYSUTCDATETIME(),@actorId,SYSUTCDATETIME(),@actorId
      FROM security.users AS user_record
      WHERE user_record.source_id=@ownerId AND user_record.active=1;
      IF NOT EXISTS(SELECT 1 FROM @inserted) THROW 52620,N'Usuario propietario no encontrado o inactivo.',1;
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      JOIN @inserted AS inserted ON inserted.guide_session_key=session.guide_session_key;
    `);
    const session = mapSession(result.recordset[0]);
    await appendStatusEvent(transaction, result.recordset[0].guide_session_key, null, "upload_pending", "ingest", input.owner.id);
    await writeSqlAuditLog(transaction, {
      entityType: "guideSession",
      entityId: input.sessionId,
      action: "guide_session_created",
      performedBy: input.owner.id,
      performedByEmail: input.owner.email,
      metadata: { mimeType: input.mimeType, byteCount: input.sizeBytes },
    });
    return { session, created: true };
  });
}

export async function readSqlGuideSession(sessionId: string): Promise<GuideSessionRecord | null> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), sessionId);
  const result = await request.query<SessionRow>(`
    SELECT ${SESSION_PROJECTION}
    FROM content.guide_sessions AS session
    JOIN security.users AS owner ON owner.user_key=session.owner_user_key
    WHERE session.source_id=@sourceId AND session.status<>'deleted';
  `);
  return result.recordset[0] ? mapSession(result.recordset[0]) : null;
}

export async function readSqlGuideSessions(input: {
  ownerId: string;
  viewAll: boolean;
  page: number;
  pageSize: number;
  status?: string;
}): Promise<{ items: GuideSessionRecord[]; total: number }> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("ownerId", sql.NVarChar(150), input.ownerId);
  request.input("viewAll", sql.Bit, input.viewAll);
  request.input("status", sql.VarChar(30), input.status ?? null);
  request.input("offset", sql.Int, (input.page - 1) * input.pageSize);
  request.input("pageSize", sql.Int, input.pageSize);
  const result = await request.query<SessionRow & { total_count: number }>(`
    SELECT ${SESSION_PROJECTION},COUNT_BIG(*) OVER() AS total_count
    FROM content.guide_sessions AS session
    JOIN security.users AS owner ON owner.user_key=session.owner_user_key
    WHERE session.status<>'deleted'
      AND (@viewAll=1 OR owner.source_id=@ownerId)
      AND (@status IS NULL OR session.status=@status)
    ORDER BY session.updated_at DESC,session.guide_session_key DESC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
  `);
  return {
    items: result.recordset.map(mapSession),
    total: Number(result.recordset[0]?.total_count ?? 0),
  };
}

export async function completeSqlGuideUpload(input: {
  sessionId: string;
  expectedRowVersion: Buffer;
  idempotencyKey: string;
  byteCount: number;
  mimeType: string | null;
  etag?: string;
  actor: CurrentUser;
}): Promise<GuideSessionRecord> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), input.sessionId);
    request.input("rowVersion", sql.VarBinary(8), input.expectedRowVersion);
    request.input("byteCount", sql.BigInt, input.byteCount);
    request.input("mimeType", sql.NVarChar(160), input.mimeType);
    request.input("etag", sql.NVarChar(200), input.etag ?? null);
    request.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
    request.input("actorId", sql.NVarChar(150), input.actor.id);
    const result = await request.query<SessionRow>(`
      DECLARE @sessionKey BIGINT,@declaredBytes BIGINT,@declaredMime NVARCHAR(160),@currentStatus VARCHAR(30),
        @completedKey NVARCHAR(200);
      SELECT @sessionKey=guide_session_key,@declaredBytes=declared_byte_count,
        @declaredMime=declared_mime_type,@currentStatus=status,@completedKey=upload_complete_idempotency_key
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId;
      IF @sessionKey IS NULL THROW 52621,N'La sesión no existe.',1;
      IF @completedKey=@idempotencyKey
      BEGIN
        SELECT ${SESSION_PROJECTION}
        FROM content.guide_sessions AS session
        JOIN security.users AS owner ON owner.user_key=session.owner_user_key
        WHERE session.guide_session_key=@sessionKey;
        RETURN;
      END;
      IF NOT EXISTS(SELECT 1 FROM content.guide_sessions WHERE guide_session_key=@sessionKey AND row_version=@rowVersion)
        THROW 52628,N'La sesión cambió; actualice la página.',1;
      IF @currentStatus<>'upload_pending' THROW 52622,N'La sesión no acepta otra confirmación de carga.',1;
      IF @declaredBytes<>@byteCount OR LOWER(@declaredMime)<>LOWER(ISNULL(@mimeType,N''))
        THROW 52623,N'El objeto cargado no coincide con el tamaño o tipo declarado.',1;
      UPDATE content.guide_sessions
      SET upload_object_etag=@etag,upload_complete_idempotency_key=@idempotencyKey,
        status='queued',current_stage='transcription',
        updated_at=SYSUTCDATETIME(),updated_by=@actorId,failure_code=NULL,failure_summary=NULL
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    await enqueueGuideJob(transaction, row.guide_session_key, input.sessionId, "initial_process", 0, input.actor.id);
    await appendStatusEvent(transaction, row.guide_session_key, "upload_pending", "queued", "transcription", input.actor.id);
    await writeSqlAuditLog(transaction, {
      entityType: "guideSession",
      entityId: input.sessionId,
      action: "guide_upload_completed",
      performedBy: input.actor.id,
      performedByEmail: input.actor.email,
      metadata: { byteCount: input.byteCount, mimeType: input.mimeType },
    });
    return mapSession(row);
  });
}

export type GuideQuestion = {
  id: string;
  roundNo: number;
  questionNo: number;
  targetField: string;
  text: string;
  status: "open" | "answered" | "superseded";
};

export async function readSqlGuideQuestions(sessionId: string): Promise<GuideQuestion[]> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), sessionId);
  const result = await request.query<{
    source_id: string; round_no: number; question_no: number;
    target_field: string; question_text: string; question_status: GuideQuestion["status"];
  }>(`
    DECLARE @sessionKey BIGINT=(SELECT guide_session_key FROM content.guide_sessions WHERE source_id=@sourceId);
    DECLARE @round INT=(SELECT MAX(round_no) FROM content.guide_questions WHERE guide_session_key=@sessionKey);
    SELECT source_id,round_no,question_no,target_field,question_text,question_status
    FROM content.guide_questions
    WHERE guide_session_key=@sessionKey AND round_no=@round
    ORDER BY question_no;
  `);
  return result.recordset.map((row) => ({
    id: row.source_id,
    roundNo: row.round_no,
    questionNo: row.question_no,
    targetField: row.target_field,
    text: row.question_text,
    status: row.question_status,
  }));
}

export type GuideArtifactSummary = {
  transcriptAvailable: boolean;
  transcriptSegmentCount: number;
  frameCount: number;
  draftAvailable: boolean;
  draftVersion: number;
  finalAvailable: boolean;
};

export async function readSqlGuideArtifactSummary(sessionId: string): Promise<GuideArtifactSummary> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), sessionId);
  const result = await request.query<{
    transcript_count: number; frame_count: number; draft_count: number;
    transcript_segment_count: number | null; draft_version: number | null; final_count: number;
  }>(`
    DECLARE @sessionKey BIGINT=(SELECT guide_session_key FROM content.guide_sessions WHERE source_id=@sourceId);
    SELECT
      SUM(CASE WHEN artifact_kind='transcript_text' AND is_current=1 THEN 1 ELSE 0 END) AS transcript_count,
      MAX(CASE WHEN artifact_kind='transcript_json' AND is_current=1
        THEN TRY_CONVERT(INT,JSON_VALUE(technical_metadata_json,'$.segmentCount')) END) AS transcript_segment_count,
      SUM(CASE WHEN artifact_kind='frame' AND is_current=1 THEN 1 ELSE 0 END) AS frame_count,
      SUM(CASE WHEN artifact_kind='draft_markdown' AND is_current=1 THEN 1 ELSE 0 END) AS draft_count,
      MAX(CASE WHEN artifact_kind='draft_markdown' AND is_current=1 THEN artifact_version END) AS draft_version,
      SUM(CASE WHEN artifact_kind='final_markdown' AND is_current=1 THEN 1 ELSE 0 END) AS final_count
    FROM content.guide_artifacts WHERE guide_session_key=@sessionKey;
  `);
  const row = result.recordset[0];
  return {
    transcriptAvailable: Number(row?.transcript_count ?? 0) > 0,
    transcriptSegmentCount: Number(row?.transcript_segment_count ?? 0),
    frameCount: Number(row?.frame_count ?? 0),
    draftAvailable: Number(row?.draft_count ?? 0) > 0,
    draftVersion: Number(row?.draft_version ?? 0),
    finalAvailable: Number(row?.final_count ?? 0) > 0,
  };
}

export type GuideFrameMetadata = { id: string; timestampMs: number; caption: string };

export async function readSqlGuideFrames(sessionId: string): Promise<GuideFrameMetadata[]> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sourceId", sql.NVarChar(150), sessionId);
  const result = await request.query<{ source_id: string; timestamp_ms: number | null; caption: string | null }>(`
    SELECT TOP (100) artifact.source_id,
      TRY_CONVERT(INT,JSON_VALUE(artifact.technical_metadata_json,'$.timestampMs')) AS timestamp_ms,
      CONVERT(NVARCHAR(300),JSON_VALUE(artifact.technical_metadata_json,'$.caption')) AS caption
    FROM content.guide_artifacts AS artifact
    JOIN content.guide_sessions AS session ON session.guide_session_key=artifact.guide_session_key
    WHERE session.source_id=@sourceId AND artifact.artifact_kind='frame' AND artifact.is_current=1
    ORDER BY artifact.ordinal_no;
  `);
  return result.recordset.map((row) => ({
    id: row.source_id,
    timestampMs: Number(row.timestamp_ms ?? 0),
    caption: row.caption ?? "",
  }));
}

export async function appendSqlGuideAnswerRound(input: {
  sessionId: string;
  expectedRowVersion: Buffer;
  idempotencyKey: string;
  answers: Array<{ questionId: string; answer: string }>;
  actor: CurrentUser;
}): Promise<GuideSessionRecord> {
  return runSqlTransaction(async (transaction) => {
    const lock = new sql.Request(transaction);
    lock.input("sourceId", sql.NVarChar(150), input.sessionId);
    lock.input("rowVersion", sql.VarBinary(8), input.expectedRowVersion);
    const state = await lock.query<{ guide_session_key: number; status: string; answered_round_count: number }>(`
      SELECT guide_session_key,status,answered_round_count
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND row_version=@rowVersion;
    `);
    const current = state.recordset[0];
    if (!current) throw Object.assign(new Error("La sesión cambió; actualice la página."), { status: 412 });
    if (current.status !== "review") throw Object.assign(new Error("La sesión no está esperando respuestas."), { status: 409 });
    const roundNo = current.answered_round_count + 1;
    for (const answer of input.answers) {
      const request = new sql.Request(transaction);
      request.input("answerId", sql.NVarChar(150), newGuideSourceId("guide_answer"));
      request.input("sessionKey", sql.BigInt, current.guide_session_key);
      request.input("questionId", sql.NVarChar(150), answer.questionId);
      request.input("roundNo", sql.Int, roundNo);
      request.input("answer", sql.NVarChar(4000), answer.answer.trim());
      request.input("actorId", sql.NVarChar(150), input.actor.id);
      request.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
      await request.query(`
        DECLARE @questionKey BIGINT=(
          SELECT guide_question_key FROM content.guide_questions WITH (UPDLOCK,HOLDLOCK)
          WHERE guide_session_key=@sessionKey AND source_id=@questionId AND question_status='open'
        );
        IF @questionKey IS NULL THROW 52624,N'Una pregunta no existe o ya fue respondida.',1;
        INSERT content.guide_answers
          (source_id,guide_session_key,guide_question_key,answer_round_no,answer_text,answered_by_user_key)
        SELECT @answerId,@sessionKey,@questionKey,@roundNo,@answer,user_key
        FROM security.users WHERE source_id=@actorId AND active=1;
        UPDATE content.guide_questions SET question_status='answered' WHERE guide_question_key=@questionKey;
      `);
    }
    const update = new sql.Request(transaction);
    update.input("sessionKey", sql.BigInt, current.guide_session_key);
    update.input("roundNo", sql.Int, roundNo);
    update.input("actorId", sql.NVarChar(150), input.actor.id);
    const result = await update.query<SessionRow>(`
      UPDATE content.guide_sessions
      SET answered_round_count=@roundNo,status='queued',current_stage='reprocess',
        updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    await enqueueGuideJob(transaction, current.guide_session_key, input.sessionId, "reprocess", roundNo, input.actor.id);
    await appendStatusEvent(transaction, current.guide_session_key, "review", "queued", "reprocess", input.actor.id);
    await writeSqlAuditLog(transaction, {
      entityType: "guideSession", entityId: input.sessionId, action: "guide_answer_round_submitted",
      performedBy: input.actor.id, performedByEmail: input.actor.email,
      metadata: { roundNo, answerCount: input.answers.length },
    });
    return mapSession(result.recordset[0]);
  });
}

export async function queueSqlGuideFinalization(input: {
  sessionId: string;
  expectedRowVersion: Buffer;
  draftVersion: number;
  actor: CurrentUser;
}): Promise<GuideSessionRecord> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), input.sessionId);
    request.input("rowVersion", sql.VarBinary(8), input.expectedRowVersion);
    request.input("draftVersion", sql.Int, input.draftVersion);
    request.input("actorId", sql.NVarChar(150), input.actor.id);
    const result = await request.query<SessionRow>(`
      DECLARE @sessionKey BIGINT,@status VARCHAR(30),@rounds INT,@latestDraft INT,@openQuestions INT;
      SELECT @sessionKey=guide_session_key,@status=status,@rounds=answered_round_count,@latestDraft=latest_draft_no
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND row_version=@rowVersion;
      IF @sessionKey IS NULL THROW 52621,N'La sesión cambió; actualice la página.',1;
      SELECT @openQuestions=COUNT(*) FROM content.guide_questions
      WHERE guide_session_key=@sessionKey AND question_status='open';
      IF @status<>'review' OR @rounds<1 OR @latestDraft<>@draftVersion OR @openQuestions>0
        THROW 52625,N'La sesión aún no puede finalizarse.',1;
      UPDATE content.guide_sessions
      SET status='finalizing',current_stage='finalize',updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    await enqueueGuideJob(transaction, row.guide_session_key, input.sessionId, "finalize", input.draftVersion, input.actor.id);
    await appendStatusEvent(transaction, row.guide_session_key, "review", "finalizing", "finalize", input.actor.id);
    return mapSession(row);
  });
}

export async function cancelSqlGuideSession(input: {
  sessionId: string;
  expectedRowVersion: Buffer;
  actor: CurrentUser;
}): Promise<GuideSessionRecord> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), input.sessionId);
    request.input("rowVersion", sql.VarBinary(8), input.expectedRowVersion);
    request.input("actorId", sql.NVarChar(150), input.actor.id);
    const result = await request.query<SessionRow>(`
      DECLARE @sessionKey BIGINT,@fromStatus VARCHAR(30);
      SELECT @sessionKey=guide_session_key,@fromStatus=status
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND row_version=@rowVersion;
      IF @sessionKey IS NULL THROW 52621,N'La sesión cambió; actualice la página.',1;
      IF @fromStatus IN ('completed','cancelled','deleted') THROW 52626,N'La sesión ya es terminal.',1;
      UPDATE content.guide_jobs SET job_status='cancelled',active_slot=NULL,claimed_by=NULL,claim_expires_at=NULL,
        completed_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey AND job_status IN ('pending','processing');
      UPDATE content.guide_sessions
      SET status='cancelled',cancelled_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION}
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    await appendStatusEvent(transaction, row.guide_session_key, null, "cancelled", row.current_stage, input.actor.id);
    return mapSession(row);
  });
}

export type GuideArtifactLocator = {
  artifactId: string;
  kind: string;
  version: number;
  ordinal: number;
  originalName: string;
  mimeType: string;
  byteCount: number;
  locator: PrivateObjectLocator;
};

export async function readSqlGuideArtifact(input: {
  sessionId: string;
  kind: "transcript_text" | "draft_markdown" | "final_markdown" | "frame";
  version?: number;
  artifactId?: string;
}): Promise<GuideArtifactLocator | null> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sessionId", sql.NVarChar(150), input.sessionId);
  request.input("kind", sql.VarChar(40), input.kind);
  request.input("version", sql.Int, input.version ?? null);
  request.input("artifactId", sql.NVarChar(150), input.artifactId ?? null);
  const result = await request.query<{
    source_id: string; artifact_kind: string; artifact_version: number; ordinal_no: number;
    storage_provider: "s3" | "azure_blob"; storage_container: string | null; blob_name: string | null;
    storage_bucket: string | null; object_key: string | null; object_etag: string | null;
    original_name: string; mime_type: string; byte_count: number;
  }>(`
    SELECT TOP (1) artifact.source_id,artifact.artifact_kind,artifact.artifact_version,artifact.ordinal_no,
      file_record.storage_provider,file_record.storage_container,file_record.blob_name,
      file_record.storage_bucket,file_record.object_key,file_record.object_etag,
      file_record.original_name,file_record.mime_type,file_record.byte_count
    FROM content.guide_artifacts AS artifact
    JOIN content.guide_sessions AS session ON session.guide_session_key=artifact.guide_session_key
    JOIN content.files AS file_record ON file_record.file_key=artifact.file_key
    WHERE session.source_id=@sessionId AND artifact.artifact_kind=@kind
      AND (@version IS NULL OR artifact.artifact_version=@version)
      AND (@artifactId IS NULL OR artifact.source_id=@artifactId)
      AND (@version IS NOT NULL OR @artifactId IS NOT NULL OR artifact.is_current=1)
    ORDER BY artifact.artifact_version DESC,artifact.ordinal_no;
  `);
  const row = result.recordset[0];
  if (!row) return null;
  const locator: PrivateObjectLocator = row.storage_provider === "s3"
    ? { storageProvider: "s3", storageBucket: row.storage_bucket!, storageObjectKey: row.object_key!, storageObjectEtag: row.object_etag ?? undefined }
    : { storageProvider: "azure_blob", storageContainer: row.storage_container!, storageBlobName: row.blob_name!, storageBlobEtag: row.object_etag ?? undefined };
  return {
    artifactId: row.source_id, kind: row.artifact_kind, version: row.artifact_version,
    ordinal: row.ordinal_no, originalName: row.original_name, mimeType: row.mime_type,
    byteCount: Number(row.byte_count), locator,
  };
}

export type ClaimedGuideJob = {
  jobKey: number;
  jobId: string;
  sessionKey: number;
  sessionId: string;
  jobType: "initial_process" | "reprocess" | "finalize";
  inputVersion: number;
  attemptNo: number;
};

export async function claimSqlGuideJobs(workerId: string, batchSize = 1, leaseSeconds = 600): Promise<ClaimedGuideJob[]> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("batchSize", sql.Int, Math.max(1, Math.min(5, batchSize)));
    request.input("leaseSeconds", sql.Int, Math.max(60, Math.min(1800, leaseSeconds)));
    const result = await request.query<{
      guide_job_key: number; source_id: string; guide_session_key: number; session_id: string;
      job_type: ClaimedGuideJob["jobType"]; input_version: number; attempt_count: number;
    }>(`
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
      UPDATE attempt SET completed_at=@now,attempt_status='failed',error_code=N'lease_expired',
        error_summary=N'La concesión del trabajador expiró.'
      FROM content.guide_job_attempts AS attempt
      JOIN content.guide_jobs AS job ON job.guide_job_key=attempt.guide_job_key AND job.attempt_count=attempt.attempt_no
      WHERE job.job_status='processing' AND job.claim_expires_at<=@now AND attempt.completed_at IS NULL;
      ;WITH candidates AS
      (
        SELECT TOP (@batchSize) guide_job_key
        FROM content.guide_jobs WITH (UPDLOCK,READPAST,ROWLOCK)
        WHERE active_slot=1 AND attempt_count<max_attempts
          AND ((job_status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=@now))
            OR (job_status='processing' AND claim_expires_at<=@now))
        ORDER BY priority,created_at,guide_job_key
      )
      UPDATE job SET job_status='processing',claimed_by=@workerId,claim_expires_at=DATEADD(second,@leaseSeconds,@now),
        heartbeat_at=@now,attempt_count=attempt_count+1,updated_at=@now,updated_by=@workerId
      OUTPUT INSERTED.guide_job_key,INSERTED.source_id,INSERTED.guide_session_key,
        session.source_id,INSERTED.job_type,INSERTED.input_version,INSERTED.attempt_count
      FROM content.guide_jobs AS job
      JOIN candidates ON candidates.guide_job_key=job.guide_job_key
      JOIN content.guide_sessions AS session ON session.guide_session_key=job.guide_session_key;
    `);
    for (const row of result.recordset) {
      const attempt = new sql.Request(transaction);
      attempt.input("jobKey", sql.BigInt, row.guide_job_key);
      attempt.input("attemptNo", sql.Int, row.attempt_count);
      attempt.input("workerId", sql.NVarChar(150), workerId);
      await attempt.query(`
        INSERT content.guide_job_attempts(guide_job_key,attempt_no,worker_id,started_at,attempt_status)
        VALUES(@jobKey,@attemptNo,@workerId,SYSUTCDATETIME(),'processing');
      `);
    }
    return result.recordset.map((row) => ({
      jobKey: row.guide_job_key, jobId: row.source_id, sessionKey: row.guide_session_key,
      sessionId: row.session_id, jobType: row.job_type, inputVersion: row.input_version,
      attemptNo: row.attempt_count,
    }));
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function completeSqlGuideJobAttempt(
  claimed: ClaimedGuideJob,
  workerId: string,
  result: { ok: boolean; errorCode?: string; errorSummary?: string; metrics?: Record<string, unknown> },
): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("jobKey", sql.BigInt, claimed.jobKey);
    request.input("attemptNo", sql.Int, claimed.attemptNo);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("ok", sql.Bit, result.ok);
    request.input("errorCode", sql.NVarChar(80), result.errorCode?.slice(0, 80) ?? null);
    request.input("errorSummary", sql.NVarChar(1000), result.errorSummary?.slice(0, 1000) ?? null);
    request.input("metrics", sql.NVarChar(sql.MAX), result.metrics ? JSON.stringify(result.metrics) : null);
    await request.query(`
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME(),@attemptCount INT,@maxAttempts INT;
      SELECT @attemptCount=attempt_count,@maxAttempts=max_attempts
      FROM content.guide_jobs WITH (UPDLOCK,HOLDLOCK)
      WHERE guide_job_key=@jobKey AND claimed_by=@workerId AND job_status='processing';
      IF @attemptCount IS NULL THROW 52627,N'La concesión del trabajo expiró.',1;
      DECLARE @terminal BIT=CASE WHEN @ok=0 AND @attemptCount>=@maxAttempts THEN 1 ELSE 0 END;
      UPDATE content.guide_jobs
      SET job_status=CASE WHEN @ok=1 THEN 'succeeded' WHEN @terminal=1 THEN 'failed' ELSE 'pending' END,
        active_slot=CASE WHEN @ok=1 OR @terminal=1 THEN NULL ELSE 1 END,
        claimed_by=NULL,claim_expires_at=NULL,heartbeat_at=NULL,
        next_attempt_at=CASE WHEN @ok=0 AND @terminal=0 THEN DATEADD(second,POWER(2,@attemptCount)*30,@now) ELSE NULL END,
        failure_code=@errorCode,failure_summary=@errorSummary,
        completed_at=CASE WHEN @ok=1 OR @terminal=1 THEN @now ELSE NULL END,
        updated_at=@now,updated_by=@workerId
      WHERE guide_job_key=@jobKey;
      UPDATE content.guide_job_attempts
      SET completed_at=@now,attempt_status=CASE WHEN @ok=1 THEN 'succeeded' ELSE 'failed' END,
        error_code=@errorCode,error_summary=@errorSummary,metrics_json=@metrics
      WHERE guide_job_key=@jobKey AND attempt_no=@attemptNo;
      IF @terminal=1
        UPDATE content.guide_sessions SET status='failed',failure_code=@errorCode,failure_summary=@errorSummary,
          updated_at=@now,updated_by=@workerId
        WHERE guide_session_key=(SELECT guide_session_key FROM content.guide_jobs WHERE guide_job_key=@jobKey);
    `);
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function verifySqlGuideSourceArtifact(input: {
  claimed: ClaimedGuideJob;
  workerId: string;
  stored: StoredPrivateObject;
  fileName: string;
  mimeType: string;
  byteCount: number;
  sha256: string;
  durationSeconds: number;
}): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const fileKey = await ensureSqlContentFile(transaction, {
      storageProvider: input.stored.storageProvider,
      storageBucket: input.stored.storageProvider === "s3" ? input.stored.storageBucket : undefined,
      storageObjectKey: input.stored.storageProvider === "s3" ? input.stored.storageObjectKey : undefined,
      storageObjectEtag: input.stored.storageProvider === "s3" ? input.stored.storageObjectEtag : undefined,
      storageContainer: input.stored.storageProvider === "azure_blob" ? input.stored.storageContainer : undefined,
      storageBlobName: input.stored.storageProvider === "azure_blob" ? input.stored.storageBlobName : undefined,
      storageBlobEtag: input.stored.storageProvider === "azure_blob" ? input.stored.storageBlobEtag : undefined,
      originalName: input.fileName,
      mimeType: input.mimeType,
      byteCount: input.byteCount,
      sha256: input.sha256,
    }, input.workerId);
    const request = new sql.Request(transaction);
    request.input("sessionKey", sql.BigInt, input.claimed.sessionKey);
    request.input("artifactId", sql.NVarChar(150), newGuideSourceId("guide_artifact"));
    request.input("fileKey", sql.BigInt, fileKey);
    request.input("metadata", sql.NVarChar(sql.MAX), JSON.stringify({ durationSeconds: input.durationSeconds }));
    request.input("workerId", sql.NVarChar(150), input.workerId);
    await request.query(`
      IF NOT EXISTS
      (
        SELECT 1 FROM content.guide_artifacts
        WHERE guide_session_key=@sessionKey AND artifact_kind='source_video' AND artifact_version=1 AND ordinal_no=0
      )
        INSERT content.guide_artifacts
          (source_id,guide_session_key,artifact_kind,artifact_version,ordinal_no,file_key,is_current,technical_metadata_json,created_by)
        VALUES(@artifactId,@sessionKey,'source_video',1,0,@fileKey,1,@metadata,@workerId);
      UPDATE content.guide_sessions
      SET source_file_key=@fileKey,upload_storage_provider=NULL,upload_storage_container=NULL,upload_blob_name=NULL,
        upload_storage_bucket=NULL,upload_object_key=NULL,upload_object_etag=NULL,
        status='processing',current_stage='transcription',updated_at=SYSUTCDATETIME(),updated_by=@workerId
      WHERE guide_session_key=@sessionKey;
    `);
  });
}
