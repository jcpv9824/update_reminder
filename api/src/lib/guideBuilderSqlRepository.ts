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

function boundedGuideLimit(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

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
    IF EXISTS
    (
      SELECT 1 FROM content.guide_jobs WITH (UPDLOCK,HOLDLOCK)
      WHERE guide_session_key=@sessionKey AND active_slot=1
        AND idempotency_key<>@idempotencyKey
    )
      THROW 52622,N'La sesión ya tiene un trabajo activo.',1;
    IF NOT EXISTS (SELECT 1 FROM content.guide_jobs WITH (UPDLOCK,HOLDLOCK) WHERE idempotency_key=@idempotencyKey)
      INSERT content.guide_jobs
      (source_id,guide_session_key,job_type,input_version,idempotency_key,job_status,active_slot,
       attempt_count,max_attempts,next_attempt_at,created_at,created_by,updated_at,updated_by)
      VALUES(@sourceId,@sessionKey,@jobType,@inputVersion,@idempotencyKey,'pending',1,0,5,SYSUTCDATETIME(),
        SYSUTCDATETIME(),@actorId,SYSUTCDATETIME(),@actorId);
  `);
}

async function assertGuideJobLease(
  transaction: sql.Transaction,
  claimed: ClaimedGuideJob,
  workerId: string,
): Promise<{
  sessionKey: number;
  status: GuideSessionRecord["status"];
  stage: GuideSessionRecord["currentStage"];
  latestDraftNo: number;
  answeredRoundCount: number;
}> {
  const request = new sql.Request(transaction);
  request.input("jobKey", sql.BigInt, claimed.jobKey);
  request.input("attemptNo", sql.Int, claimed.attemptNo);
  request.input("workerId", sql.NVarChar(150), workerId);
  const result = await request.query<{
    guide_session_key: number;
    status: GuideSessionRecord["status"];
    current_stage: GuideSessionRecord["currentStage"];
    latest_draft_no: number;
    answered_round_count: number;
  }>(`
    SELECT session.guide_session_key,session.status,session.current_stage,
      session.latest_draft_no,session.answered_round_count
    FROM content.guide_jobs AS job WITH (UPDLOCK,HOLDLOCK)
    JOIN content.guide_sessions AS session WITH (UPDLOCK,HOLDLOCK)
      ON session.guide_session_key=job.guide_session_key
    WHERE job.guide_job_key=@jobKey
      AND job.attempt_count=@attemptNo
      AND job.claimed_by=@workerId
      AND job.job_status='processing'
      AND job.claim_expires_at>SYSUTCDATETIME()
      AND session.status NOT IN ('cancelled','deleted');
  `);
  const row = result.recordset[0];
  if (!row) {
    throw Object.assign(new Error("La concesión del trabajo expiró o la sesión fue cancelada."), {
      number: 52627,
      code: "guide_lease_lost",
    });
  }
  return {
    sessionKey: row.guide_session_key,
    status: row.status,
    stage: row.current_stage,
    latestDraftNo: row.latest_draft_no,
    answeredRoundCount: row.answered_round_count,
  };
}

async function retireGuideJobSuccess(
  transaction: sql.Transaction,
  claimed: ClaimedGuideJob,
  workerId: string,
): Promise<void> {
  const request = new sql.Request(transaction);
  request.input("jobKey", sql.BigInt, claimed.jobKey);
  request.input("attemptNo", sql.Int, claimed.attemptNo);
  request.input("workerId", sql.NVarChar(150), workerId);
  await request.query(`
    DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
    UPDATE attempt
    SET completed_at=@now,attempt_status='succeeded',
      error_code=NULL,error_summary=NULL
    FROM content.guide_job_attempts AS attempt
    JOIN content.guide_jobs AS job ON job.guide_job_key=attempt.guide_job_key
    WHERE job.guide_job_key=@jobKey AND job.attempt_count=@attemptNo
      AND job.claimed_by=@workerId AND job.job_status='processing'
      AND job.claim_expires_at>@now
      AND attempt.attempt_no=@attemptNo
      AND attempt.worker_id=@workerId
      AND attempt.attempt_status='processing' AND attempt.completed_at IS NULL;
    IF @@ROWCOUNT<>1
      THROW 52627,N'El intento del trabajo ya no está vigente.',1;

    UPDATE content.guide_jobs
    SET job_status='succeeded',active_slot=NULL,claimed_by=NULL,
      claim_expires_at=NULL,heartbeat_at=NULL,next_attempt_at=NULL,
      failure_code=NULL,failure_summary=NULL,completed_at=@now,
      updated_at=@now,updated_by=@workerId
    WHERE guide_job_key=@jobKey AND attempt_count=@attemptNo
      AND claimed_by=@workerId AND job_status='processing'
      AND claim_expires_at>@now;
    IF @@ROWCOUNT<>1
      THROW 52627,N'La concesión del trabajo expiró.',1;
  `);
}

export type GuideArtifactWrite = {
  artifactId: string;
  kind:
    | "source_video"
    | "audio"
    | "transcript_json"
    | "transcript_text"
    | "frame"
    | "frame_reading"
    | "evidence_bundle"
    | "cited_schema"
    | "draft_markdown"
    | "verification"
    | "final_markdown";
  version: number;
  ordinal: number;
  originalName: string;
  mimeType: string;
  byteCount: number;
  sha256: string;
  stored: StoredPrivateObject;
  technicalMetadata?: Record<string, unknown>;
};

export type GuideAiRunWrite = {
  operation: "transcription" | "vision" | "draft" | "questions" | "reprocess" | "finalize";
  modelId: string;
  requestIdHash?: string;
  status: "succeeded" | "failed";
  durationMs: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  errorCode?: string;
};

async function upsertGuideArtifact(
  transaction: sql.Transaction,
  sessionKey: number,
  workerId: string,
  artifact: GuideArtifactWrite,
): Promise<void> {
  const fileKey = await ensureSqlContentFile(transaction, {
    storageProvider: artifact.stored.storageProvider,
    storageBucket: artifact.stored.storageProvider === "s3" ? artifact.stored.storageBucket : undefined,
    storageObjectKey: artifact.stored.storageProvider === "s3" ? artifact.stored.storageObjectKey : undefined,
    storageObjectEtag: artifact.stored.storageProvider === "s3" ? artifact.stored.storageObjectEtag : undefined,
    storageContainer: artifact.stored.storageProvider === "azure_blob" ? artifact.stored.storageContainer : undefined,
    storageBlobName: artifact.stored.storageProvider === "azure_blob" ? artifact.stored.storageBlobName : undefined,
    storageBlobEtag: artifact.stored.storageProvider === "azure_blob" ? artifact.stored.storageBlobEtag : undefined,
    originalName: artifact.originalName,
    mimeType: artifact.mimeType,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
  }, workerId);
  const request = new sql.Request(transaction);
  request.input("artifactId", sql.NVarChar(150), artifact.artifactId);
  request.input("sessionKey", sql.BigInt, sessionKey);
  request.input("kind", sql.VarChar(40), artifact.kind);
  request.input("version", sql.Int, artifact.version);
  request.input("ordinal", sql.Int, artifact.ordinal);
  request.input("fileKey", sql.BigInt, fileKey);
  request.input("metadata", sql.NVarChar(sql.MAX), artifact.technicalMetadata ? JSON.stringify(artifact.technicalMetadata) : null);
  request.input("workerId", sql.NVarChar(150), workerId);
  await request.query(`
    UPDATE content.guide_artifacts
    SET is_current=0
    WHERE guide_session_key=@sessionKey AND artifact_kind=@kind AND ordinal_no=@ordinal AND is_current=1;

    IF EXISTS
    (
      SELECT 1 FROM content.guide_artifacts
      WHERE guide_session_key=@sessionKey AND artifact_kind=@kind
        AND artifact_version=@version AND ordinal_no=@ordinal
    )
      UPDATE content.guide_artifacts
      SET file_key=@fileKey,is_current=1,technical_metadata_json=@metadata
      WHERE guide_session_key=@sessionKey AND artifact_kind=@kind
        AND artifact_version=@version AND ordinal_no=@ordinal;
    ELSE
      INSERT content.guide_artifacts
        (source_id,guide_session_key,artifact_kind,artifact_version,ordinal_no,file_key,
         is_current,technical_metadata_json,created_by)
      VALUES
        (@artifactId,@sessionKey,@kind,@version,@ordinal,@fileKey,1,@metadata,@workerId);
  `);
}

async function insertGuideAiRuns(
  transaction: sql.Transaction,
  sessionKey: number,
  jobKey: number,
  runs: GuideAiRunWrite[],
): Promise<void> {
  for (const run of runs) {
    const request = new sql.Request(transaction);
    request.input("sessionKey", sql.BigInt, sessionKey);
    request.input("jobKey", sql.BigInt, jobKey);
    request.input("operation", sql.VarChar(30), run.operation);
    request.input("modelId", sql.NVarChar(100), run.modelId);
    request.input("requestIdHash", sql.VarBinary(32), run.requestIdHash ? Buffer.from(run.requestIdHash, "hex") : null);
    request.input("status", sql.VarChar(20), run.status);
    request.input("inputTokens", sql.Int, run.inputTokens ?? null);
    request.input("cachedInputTokens", sql.Int, run.cachedInputTokens ?? null);
    request.input("outputTokens", sql.Int, run.outputTokens ?? null);
    request.input("reasoningTokens", sql.Int, run.reasoningTokens ?? null);
    request.input("durationMs", sql.Int, Math.max(0, Math.round(run.durationMs)));
    request.input("errorCode", sql.NVarChar(80), run.errorCode ?? null);
    await request.query(`
      INSERT content.guide_ai_runs
        (guide_session_key,guide_job_key,operation,model_id,provider_request_id_hash,run_status,
         input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,duration_ms,error_code)
      VALUES
        (@sessionKey,@jobKey,@operation,@modelId,@requestIdHash,@status,
         @inputTokens,@cachedInputTokens,@outputTokens,@reasoningTokens,@durationMs,@errorCode);
    `);
  }
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

    const quota = new sql.Request(transaction);
    quota.input("ownerId", sql.NVarChar(150), input.owner.id);
    const quotaResult = await quota.query<{ active_count: number; daily_count: number }>(`
      SELECT
        SUM(CASE WHEN session.status IN ('upload_pending','queued','processing','review','finalizing') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN session.created_at>=CONVERT(DATE,SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS daily_count
      FROM content.guide_sessions AS session WITH (UPDLOCK,HOLDLOCK)
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE owner.source_id=@ownerId;
    `);
    const activeLimit = boundedGuideLimit("GUIDE_MAX_ACTIVE_SESSIONS_PER_OWNER", 2, 5);
    const dailyLimit = boundedGuideLimit("GUIDE_MAX_CREATIONS_PER_OWNER_DAY", 5, 20);
    if (Number(quotaResult.recordset[0]?.active_count ?? 0) >= activeLimit) {
      throw Object.assign(new Error("Alcanzó el límite de sesiones de guía activas."), { status: 429 });
    }
    if (Number(quotaResult.recordset[0]?.daily_count ?? 0) >= dailyLimit) {
      throw Object.assign(new Error("Alcanzó el límite diario de creación de guías."), { status: 429 });
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
    const result = await request.query<SessionRow & { replayed: boolean }>(`
      DECLARE @sessionKey BIGINT,@declaredBytes BIGINT,@declaredMime NVARCHAR(160),@currentStatus VARCHAR(30),
        @completedKey NVARCHAR(200);
      SELECT @sessionKey=guide_session_key,@declaredBytes=declared_byte_count,
        @declaredMime=declared_mime_type,@currentStatus=status,@completedKey=upload_complete_idempotency_key
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId;
      IF @sessionKey IS NULL THROW 52621,N'La sesión no existe.',1;
      IF @completedKey=@idempotencyKey
      BEGIN
        SELECT ${SESSION_PROJECTION},CAST(1 AS BIT) AS replayed
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
      SELECT ${SESSION_PROJECTION},CAST(0 AS BIT) AS replayed
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    if (row.replayed) return mapSession(row);
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
    lock.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
    const state = await lock.query<{
      guide_session_key: number;
      status: string;
      answered_round_count: number;
      row_version: Buffer;
      last_regenerate_idempotency_key: string | null;
      open_question_count: number;
    }>(`
      SELECT session.guide_session_key,session.status,session.answered_round_count,session.row_version,
        session.last_regenerate_idempotency_key,
        (SELECT COUNT(*) FROM content.guide_questions WITH (UPDLOCK,HOLDLOCK)
         WHERE guide_session_key=session.guide_session_key AND question_status='open') AS open_question_count
      FROM content.guide_sessions AS session WITH (UPDLOCK,HOLDLOCK)
      WHERE session.source_id=@sourceId;
    `);
    const current = state.recordset[0];
    if (!current) throw Object.assign(new Error("La sesión no existe."), { status: 404 });
    if (current.last_regenerate_idempotency_key === input.idempotencyKey) {
      const replay = new sql.Request(transaction);
      replay.input("sessionKey", sql.BigInt, current.guide_session_key);
      const prior = await replay.query<SessionRow>(`
        SELECT ${SESSION_PROJECTION}
        FROM content.guide_sessions AS session
        JOIN security.users AS owner ON owner.user_key=session.owner_user_key
        WHERE session.guide_session_key=@sessionKey;
      `);
      return mapSession(prior.recordset[0]);
    }
    const answerRoundLimit = boundedGuideLimit("GUIDE_MAX_ANSWER_ROUNDS", 3, 5);
    if (current.answered_round_count >= answerRoundLimit) {
      throw Object.assign(new Error("La sesión alcanzó el límite de rondas de aclaración."), {
        status: 409,
        code: "guide_answer_round_limit",
      });
    }
    if (!current.row_version.equals(input.expectedRowVersion)) {
      throw Object.assign(new Error("La sesión cambió; actualice la página."), { status: 412 });
    }
    if (current.status !== "review") throw Object.assign(new Error("La sesión no está esperando respuestas."), { status: 409 });
    if (
      current.open_question_count !== input.answers.length
      || new Set(input.answers.map((answer) => answer.questionId)).size !== input.answers.length
    ) {
      throw Object.assign(new Error("Debe responder exactamente todas las preguntas abiertas una sola vez."), { status: 409 });
    }
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
        IF @@ROWCOUNT<>1 THROW 52620,N'Usuario no encontrado o inactivo.',1;
        UPDATE content.guide_questions SET question_status='answered' WHERE guide_question_key=@questionKey;
      `);
    }
    const update = new sql.Request(transaction);
    update.input("sessionKey", sql.BigInt, current.guide_session_key);
    update.input("roundNo", sql.Int, roundNo);
    update.input("actorId", sql.NVarChar(150), input.actor.id);
    update.input("idempotencyKey", sql.NVarChar(200), input.idempotencyKey);
    const result = await update.query<SessionRow>(`
      UPDATE content.guide_sessions
      SET answered_round_count=@roundNo,status='queued',current_stage='reprocess',
        last_regenerate_idempotency_key=@idempotencyKey,
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
    const result = await request.query<SessionRow & { replayed: boolean }>(`
      DECLARE @sessionKey BIGINT,@status VARCHAR(30),@rounds INT,@latestDraft INT,@openQuestions INT,
        @lastKey NVARCHAR(200),@requestKey NVARCHAR(200)=CONCAT(N'finalize:',@draftVersion);
      SELECT @sessionKey=guide_session_key,@status=status,@rounds=answered_round_count,
        @latestDraft=latest_draft_no,@lastKey=last_finalize_idempotency_key
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId;
      IF @sessionKey IS NULL THROW 52621,N'La sesión no existe.',1;
      IF @lastKey=@requestKey
      BEGIN
        SELECT ${SESSION_PROJECTION},CAST(1 AS BIT) AS replayed
        FROM content.guide_sessions AS session
        JOIN security.users AS owner ON owner.user_key=session.owner_user_key
        WHERE session.guide_session_key=@sessionKey;
        RETURN;
      END;
      IF NOT EXISTS(SELECT 1 FROM content.guide_sessions WHERE guide_session_key=@sessionKey AND row_version=@rowVersion)
        THROW 52628,N'La sesión cambió; actualice la página.',1;
      SELECT @openQuestions=COUNT(*) FROM content.guide_questions
      WHERE guide_session_key=@sessionKey AND question_status='open';
      IF @status<>'review' OR @rounds<1 OR @latestDraft<>@draftVersion OR @openQuestions>0
        THROW 52625,N'La sesión aún no puede finalizarse.',1;
      UPDATE content.guide_sessions
      SET status='finalizing',current_stage='finalize',last_finalize_idempotency_key=@requestKey,
        updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION},CAST(0 AS BIT) AS replayed
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    if (row.replayed) return mapSession(row);
    await enqueueGuideJob(transaction, row.guide_session_key, input.sessionId, "finalize", input.draftVersion, input.actor.id);
    await appendStatusEvent(transaction, row.guide_session_key, "review", "finalizing", "finalize", input.actor.id);
    await writeSqlAuditLog(transaction, {
      entityType: "guideSession",
      entityId: input.sessionId,
      action: "guide_finalization_queued",
      performedBy: input.actor.id,
      performedByEmail: input.actor.email,
      metadata: { draftVersion: input.draftVersion },
    });
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
    const result = await request.query<SessionRow & { replayed: boolean; prior_status: string | null }>(`
      DECLARE @sessionKey BIGINT,@fromStatus VARCHAR(30),@lastKey NVARCHAR(200),
        @requestKey NVARCHAR(200)=CONCAT(N'cancel:',@sourceId);
      SELECT @sessionKey=guide_session_key,@fromStatus=status,@lastKey=cancel_idempotency_key
      FROM content.guide_sessions WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId;
      IF @sessionKey IS NULL THROW 52621,N'La sesión no existe.',1;
      IF @lastKey=@requestKey AND @fromStatus='cancelled'
      BEGIN
        SELECT ${SESSION_PROJECTION},CAST(1 AS BIT) AS replayed,@fromStatus AS prior_status
        FROM content.guide_sessions AS session
        JOIN security.users AS owner ON owner.user_key=session.owner_user_key
        WHERE session.guide_session_key=@sessionKey;
        RETURN;
      END;
      IF NOT EXISTS(SELECT 1 FROM content.guide_sessions WHERE guide_session_key=@sessionKey AND row_version=@rowVersion)
        THROW 52628,N'La sesión cambió; actualice la página.',1;
      IF @fromStatus IN ('completed','cancelled','deleted') THROW 52626,N'La sesión ya es terminal.',1;
      UPDATE attempt
      SET completed_at=SYSUTCDATETIME(),attempt_status='failed',
        error_code=N'cancelled',error_summary=N'La sesión fue cancelada.'
      FROM content.guide_job_attempts AS attempt
      JOIN content.guide_jobs AS job ON job.guide_job_key=attempt.guide_job_key
        AND job.attempt_count=attempt.attempt_no
      WHERE job.guide_session_key=@sessionKey AND job.job_status='processing'
        AND attempt.completed_at IS NULL;
      UPDATE content.guide_jobs SET job_status='cancelled',active_slot=NULL,claimed_by=NULL,claim_expires_at=NULL,
        heartbeat_at=NULL,next_attempt_at=NULL,completed_at=SYSUTCDATETIME(),
        updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey AND job_status IN ('pending','processing');
      UPDATE content.guide_sessions
      SET status='cancelled',cancel_idempotency_key=@requestKey,cancelled_at=SYSUTCDATETIME(),
        updated_at=SYSUTCDATETIME(),updated_by=@actorId
      WHERE guide_session_key=@sessionKey;
      SELECT ${SESSION_PROJECTION},CAST(0 AS BIT) AS replayed,@fromStatus AS prior_status
      FROM content.guide_sessions AS session
      JOIN security.users AS owner ON owner.user_key=session.owner_user_key
      WHERE session.guide_session_key=@sessionKey;
    `);
    const row = result.recordset[0];
    if (row.replayed) return mapSession(row);
    await appendStatusEvent(transaction, row.guide_session_key, row.prior_status, "cancelled", row.current_stage, input.actor.id);
    await writeSqlAuditLog(transaction, {
      entityType: "guideSession",
      entityId: input.sessionId,
      action: "guide_session_cancelled",
      performedBy: input.actor.id,
      performedByEmail: input.actor.email,
      metadata: { priorStatus: row.prior_status },
    });
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
  kind: "source_video" | "audio" | "transcript_json" | "transcript_text" | "draft_markdown" | "final_markdown" | "frame";
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

export type GuideJobContext = {
  sessionId: string;
  status: GuideSessionRecord["status"];
  stage: GuideSessionRecord["currentStage"];
  fileName: string;
  mimeType: string;
  byteCount: number;
  uploadLocator?: PrivateObjectLocator;
  latestDraftNo: number;
  answeredRoundCount: number;
  finalizedDraftNo?: number;
};

export async function readSqlGuideJobContext(
  claimed: ClaimedGuideJob,
  workerId: string,
): Promise<GuideJobContext> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("jobKey", sql.BigInt, claimed.jobKey);
  request.input("attemptNo", sql.Int, claimed.attemptNo);
  request.input("workerId", sql.NVarChar(150), workerId);
  const result = await request.query<{
    source_id: string;
    status: GuideSessionRecord["status"];
    current_stage: GuideSessionRecord["currentStage"];
    original_video_name: string;
    declared_mime_type: string;
    declared_byte_count: number;
    upload_storage_provider: "s3" | "azure_blob" | null;
    upload_storage_container: string | null;
    upload_blob_name: string | null;
    upload_storage_bucket: string | null;
    upload_object_key: string | null;
    upload_object_etag: string | null;
    latest_draft_no: number;
    answered_round_count: number;
    finalized_draft_no: number | null;
  }>(`
    SELECT session.source_id,session.status,session.current_stage,session.original_video_name,
      session.declared_mime_type,session.declared_byte_count,
      session.upload_storage_provider,session.upload_storage_container,session.upload_blob_name,
      session.upload_storage_bucket,session.upload_object_key,session.upload_object_etag,
      session.latest_draft_no,session.answered_round_count,session.finalized_draft_no
    FROM content.guide_jobs AS job
    JOIN content.guide_sessions AS session ON session.guide_session_key=job.guide_session_key
    WHERE job.guide_job_key=@jobKey AND job.attempt_count=@attemptNo
      AND job.claimed_by=@workerId AND job.job_status='processing'
      AND job.claim_expires_at>SYSUTCDATETIME()
      AND session.status NOT IN ('cancelled','deleted');
  `);
  const row = result.recordset[0];
  if (!row) {
    throw Object.assign(new Error("La concesión del trabajo expiró o la sesión fue cancelada."), {
      number: 52627,
      code: "guide_lease_lost",
    });
  }
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
    sessionId: row.source_id,
    status: row.status,
    stage: row.current_stage,
    fileName: row.original_video_name,
    mimeType: row.declared_mime_type,
    byteCount: Number(row.declared_byte_count),
    uploadLocator,
    latestDraftNo: row.latest_draft_no,
    answeredRoundCount: row.answered_round_count,
    finalizedDraftNo: row.finalized_draft_no ?? undefined,
  };
}

export async function readSqlGuideAnswersForJob(
  claimed: ClaimedGuideJob,
  workerId: string,
): Promise<Array<{ id: string; question: string; answer: string }>> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("jobKey", sql.BigInt, claimed.jobKey);
  request.input("attemptNo", sql.Int, claimed.attemptNo);
  request.input("workerId", sql.NVarChar(150), workerId);
  const result = await request.query<{ source_id: string; question_text: string; answer_text: string }>(`
    SELECT answer.source_id,question.question_text,answer.answer_text
    FROM content.guide_jobs AS job
    JOIN content.guide_sessions AS session ON session.guide_session_key=job.guide_session_key
    JOIN content.guide_answers AS answer ON answer.guide_session_key=session.guide_session_key
    JOIN content.guide_questions AS question ON question.guide_question_key=answer.guide_question_key
    WHERE job.guide_job_key=@jobKey AND job.attempt_count=@attemptNo
      AND job.claimed_by=@workerId AND job.job_status='processing'
      AND job.claim_expires_at>SYSUTCDATETIME()
      AND session.status NOT IN ('cancelled','deleted')
    ORDER BY answer.answer_round_no,answer.guide_answer_key;
  `);
  return result.recordset.map((row) => ({
    id: row.source_id,
    question: row.question_text,
    answer: row.answer_text,
  }));
}

export async function readSqlCancelledGuideUploads(limit = 5): Promise<Array<{
  sessionId: string;
  locator: PrivateObjectLocator;
}>> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("limit", sql.Int, Math.max(1, Math.min(20, limit)));
  request.input("minimumAgeMinutes", sql.Int, 30);
  const result = await request.query<{
    source_id: string;
    upload_storage_provider: "s3" | "azure_blob";
    upload_storage_container: string | null;
    upload_blob_name: string | null;
    upload_storage_bucket: string | null;
    upload_object_key: string | null;
    upload_object_etag: string | null;
  }>(`
    SELECT TOP (@limit) source_id,upload_storage_provider,upload_storage_container,upload_blob_name,
      upload_storage_bucket,upload_object_key,upload_object_etag
    FROM content.guide_sessions
    WHERE upload_storage_provider IS NOT NULL
      AND updated_at<=DATEADD(minute,-@minimumAgeMinutes,SYSUTCDATETIME())
      AND (status='cancelled' OR source_file_key IS NOT NULL)
    ORDER BY updated_at,guide_session_key;
  `);
  const items: Array<{ sessionId: string; locator: PrivateObjectLocator }> = [];
  for (const row of result.recordset) {
    if (row.upload_storage_provider === "s3" && row.upload_storage_bucket && row.upload_object_key) {
      items.push({
        sessionId: row.source_id,
        locator: {
          storageProvider: "s3",
          storageBucket: row.upload_storage_bucket,
          storageObjectKey: row.upload_object_key,
          storageObjectEtag: row.upload_object_etag ?? undefined,
        },
      });
    } else if (row.upload_storage_provider === "azure_blob" && row.upload_storage_container && row.upload_blob_name) {
      items.push({
        sessionId: row.source_id,
        locator: {
          storageProvider: "azure_blob",
          storageContainer: row.upload_storage_container,
          storageBlobName: row.upload_blob_name,
          storageBlobEtag: row.upload_object_etag ?? undefined,
        },
      });
    }
  }
  return items;
}

export async function completeSqlCancelledGuideUploadCleanup(
  sessionId: string,
  locator: PrivateObjectLocator,
): Promise<void> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("sessionId", sql.NVarChar(150), sessionId);
  request.input("provider", sql.VarChar(30), locator.storageProvider);
  request.input("container", sql.NVarChar(100), locator.storageProvider === "azure_blob" ? locator.storageContainer : null);
  request.input("blobName", sql.NVarChar(1024), locator.storageProvider === "azure_blob" ? locator.storageBlobName : null);
  request.input("bucket", sql.NVarChar(255), locator.storageProvider === "s3" ? locator.storageBucket : null);
  request.input("objectKey", sql.NVarChar(1024), locator.storageProvider === "s3" ? locator.storageObjectKey : null);
  await request.query(`
    UPDATE content.guide_sessions
    SET upload_storage_provider=NULL,upload_storage_container=NULL,upload_blob_name=NULL,
      upload_storage_bucket=NULL,upload_object_key=NULL,upload_object_etag=NULL,
      updated_at=SYSUTCDATETIME(),updated_by=N'guide_cleanup'
    WHERE source_id=@sessionId AND (status='cancelled' OR source_file_key IS NOT NULL)
      AND upload_storage_provider=@provider
      AND ISNULL(upload_storage_container,N'')=ISNULL(@container,N'')
      AND ISNULL(upload_blob_name,N'')=ISNULL(@blobName,N'')
      AND ISNULL(upload_storage_bucket,N'')=ISNULL(@bucket,N'')
      AND ISNULL(upload_object_key,N'')=ISNULL(@objectKey,N'');
  `);
}

export async function expireSqlPendingGuideUploads(limit = 20, minimumAgeMinutes = 30): Promise<number> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("limit", sql.Int, Math.max(1, Math.min(100, limit)));
    request.input("minimumAgeMinutes", sql.Int, Math.max(30, Math.min(1_440, minimumAgeMinutes)));
    const result = await request.query<{ guide_session_key: number }>(`
      DECLARE @expired TABLE(guide_session_key BIGINT PRIMARY KEY);
      ;WITH candidates AS
      (
        SELECT TOP (@limit) guide_session_key
        FROM content.guide_sessions WITH (UPDLOCK,READPAST,ROWLOCK)
        WHERE status='upload_pending'
          AND created_at<=DATEADD(minute,-@minimumAgeMinutes,SYSUTCDATETIME())
        ORDER BY created_at,guide_session_key
      )
      UPDATE session
      SET status='cancelled',cancel_idempotency_key=CONCAT(N'expired:',session.source_id),
        cancelled_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME(),updated_by=N'guide_upload_expiry'
      OUTPUT INSERTED.guide_session_key INTO @expired(guide_session_key)
      FROM content.guide_sessions AS session
      JOIN candidates ON candidates.guide_session_key=session.guide_session_key;
      SELECT guide_session_key FROM @expired;
    `);
    for (const row of result.recordset) {
      await appendStatusEvent(
        transaction,
        row.guide_session_key,
        "upload_pending",
        "cancelled",
        "ingest",
        "guide_upload_expiry",
        "upload_expired",
      );
    }
    return result.recordset.length;
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function renewSqlGuideJobLease(
  claimed: ClaimedGuideJob,
  workerId: string,
  leaseSeconds = 600,
): Promise<void> {
  const pool = await getSqlPool();
  const request = pool.request();
  request.input("jobKey", sql.BigInt, claimed.jobKey);
  request.input("attemptNo", sql.Int, claimed.attemptNo);
  request.input("workerId", sql.NVarChar(150), workerId);
  request.input("leaseSeconds", sql.Int, Math.max(60, Math.min(1800, leaseSeconds)));
  const result = await request.query<{ renewed: boolean }>(`
    IF EXISTS
    (
      SELECT 1
      FROM content.guide_jobs AS completed_job
      JOIN content.guide_job_attempts AS completed_attempt
        ON completed_attempt.guide_job_key=completed_job.guide_job_key
        AND completed_attempt.attempt_no=@attemptNo
      WHERE completed_job.guide_job_key=@jobKey
        AND completed_job.attempt_count=@attemptNo
        AND completed_job.job_status='succeeded'
        AND completed_job.active_slot IS NULL
        AND completed_attempt.worker_id=@workerId
        AND completed_attempt.attempt_status='succeeded'
        AND completed_attempt.completed_at IS NOT NULL
    )
    BEGIN
      SELECT CAST(1 AS BIT) AS renewed;
      RETURN;
    END;
    UPDATE job
    SET claim_expires_at=DATEADD(second,@leaseSeconds,SYSUTCDATETIME()),
      heartbeat_at=SYSUTCDATETIME(),updated_at=SYSUTCDATETIME(),updated_by=@workerId
    FROM content.guide_jobs AS job
    JOIN content.guide_sessions AS session ON session.guide_session_key=job.guide_session_key
    WHERE job.guide_job_key=@jobKey AND job.attempt_count=@attemptNo
      AND job.claimed_by=@workerId AND job.job_status='processing'
      AND job.claim_expires_at>SYSUTCDATETIME()
      AND session.status NOT IN ('cancelled','deleted');
    SELECT CAST(CASE WHEN @@ROWCOUNT=1 THEN 1 ELSE 0 END AS BIT) AS renewed;
  `);
  if (result.recordset[0]?.renewed !== true) {
    throw Object.assign(new Error("La concesión del trabajo expiró o la sesión fue cancelada."), {
      number: 52627,
      code: "guide_lease_lost",
    });
  }
}

export async function updateSqlGuideProcessingStage(
  claimed: ClaimedGuideJob,
  workerId: string,
  stage: GuideSessionRecord["currentStage"],
): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const state = await assertGuideJobLease(transaction, claimed, workerId);
    const request = new sql.Request(transaction);
    request.input("sessionKey", sql.BigInt, state.sessionKey);
    request.input("stage", sql.VarChar(30), stage);
    request.input("workerId", sql.NVarChar(150), workerId);
    await request.query(`
      UPDATE content.guide_sessions
      SET status='processing',current_stage=@stage,updated_at=SYSUTCDATETIME(),updated_by=@workerId
      WHERE guide_session_key=@sessionKey;
    `);
    if (state.status !== "processing") {
      await appendStatusEvent(transaction, state.sessionKey, state.status, "processing", stage, workerId);
    }
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function claimSqlGuideJobs(workerId: string, batchSize = 1, leaseSeconds = 600): Promise<ClaimedGuideJob[]> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("batchSize", sql.Int, Math.max(1, Math.min(1, batchSize)));
    request.input("leaseSeconds", sql.Int, Math.max(60, Math.min(1800, leaseSeconds)));
    const result = await request.query<{
      guide_job_key: number; job_id: string; guide_session_key: number; session_id: string;
      job_type: ClaimedGuideJob["jobType"]; input_version: number; attempt_count: number;
    }>(`
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
      DECLARE @claimLockResult INT;
      EXEC @claimLockResult=sys.sp_getapplock
        @Resource=N'PortalSAGWeb:guide-worker:global-claim',
        @LockMode=N'Exclusive',
        @LockOwner=N'Transaction',
        @LockTimeout=5000;
      IF @claimLockResult<0
        THROW 52629,N'No fue posible serializar la reclamación del trabajador.',1;
      UPDATE attempt SET completed_at=@now,attempt_status='failed',error_code=N'lease_expired',
        error_summary=N'La concesión del trabajador expiró.'
      FROM content.guide_job_attempts AS attempt
      JOIN content.guide_jobs AS job ON job.guide_job_key=attempt.guide_job_key AND job.attempt_count=attempt.attempt_no
      WHERE job.job_status='processing' AND job.claim_expires_at<=@now AND attempt.completed_at IS NULL;
      UPDATE job
      SET job_status='failed',active_slot=NULL,claimed_by=NULL,claim_expires_at=NULL,heartbeat_at=NULL,
        next_attempt_at=NULL,failure_code=N'lease_expired',
        failure_summary=N'El trabajo agotó sus intentos después de expirar la concesión.',
        completed_at=@now,updated_at=@now,updated_by=N'guide_worker_recovery'
      FROM content.guide_jobs AS job
      WHERE job.job_status='processing' AND job.claim_expires_at<=@now
        AND job.attempt_count>=job.max_attempts;
      DECLARE @failedSessions TABLE
      (
        guide_session_key BIGINT PRIMARY KEY,
        from_status VARCHAR(30) NOT NULL
      );
      UPDATE session
      SET status='failed',failure_code=N'lease_expired',
        failure_summary=N'El procesamiento agotó sus intentos.',
        updated_at=@now,updated_by=N'guide_worker_recovery'
      OUTPUT INSERTED.guide_session_key,DELETED.status
        INTO @failedSessions(guide_session_key,from_status)
      FROM content.guide_sessions AS session
      WHERE session.status NOT IN ('completed','cancelled','deleted')
        AND EXISTS
        (
          SELECT 1 FROM content.guide_jobs AS failed_job
          WHERE failed_job.guide_session_key=session.guide_session_key
            AND failed_job.job_status='failed' AND failed_job.failure_code=N'lease_expired'
            AND failed_job.completed_at=@now
        );
      INSERT content.guide_status_events
        (guide_session_key,event_no,from_status,to_status,stage,reason_code,occurred_by)
      SELECT failed.guide_session_key,
        ISNULL((SELECT MAX(existing.event_no) FROM content.guide_status_events AS existing
          WHERE existing.guide_session_key=failed.guide_session_key),0)+1,
        failed.from_status,'failed',session.current_stage,N'lease_expired',N'guide_worker_recovery'
      FROM @failedSessions AS failed
      JOIN content.guide_sessions AS session
        ON session.guide_session_key=failed.guide_session_key;
      ;WITH candidates AS
      (
        SELECT TOP (@batchSize) job.guide_job_key
        FROM content.guide_jobs AS job WITH (UPDLOCK,READPAST,ROWLOCK)
        JOIN content.guide_sessions AS session ON session.guide_session_key=job.guide_session_key
        WHERE job.active_slot=1 AND job.attempt_count<job.max_attempts
          AND session.status NOT IN ('completed','cancelled','deleted','failed')
          AND NOT EXISTS
          (
            SELECT 1
            FROM content.guide_jobs AS active_job WITH (UPDLOCK,HOLDLOCK)
            WHERE active_job.job_status='processing'
              AND active_job.claim_expires_at>@now
          )
          AND ((job.job_status='pending' AND (job.next_attempt_at IS NULL OR job.next_attempt_at<=@now))
            OR (job.job_status='processing' AND job.claim_expires_at<=@now))
        ORDER BY job.priority,job.created_at,job.guide_job_key
      )
      UPDATE job SET job_status='processing',claimed_by=@workerId,claim_expires_at=DATEADD(second,@leaseSeconds,@now),
        heartbeat_at=@now,attempt_count=attempt_count+1,updated_at=@now,updated_by=@workerId
      OUTPUT INSERTED.guide_job_key,INSERTED.source_id AS job_id,INSERTED.guide_session_key,
        session.source_id AS session_id,INSERTED.job_type,INSERTED.input_version,INSERTED.attempt_count
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
      jobKey: row.guide_job_key, jobId: row.job_id, sessionKey: row.guide_session_key,
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
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME(),@attemptCount INT,@maxAttempts INT,
        @sessionKey BIGINT,@priorStatus VARCHAR(30);
      IF @ok=1 AND EXISTS
      (
        SELECT 1
        FROM content.guide_jobs AS completed_job WITH (UPDLOCK,HOLDLOCK)
        JOIN content.guide_job_attempts AS completed_attempt WITH (UPDLOCK,HOLDLOCK)
          ON completed_attempt.guide_job_key=completed_job.guide_job_key
          AND completed_attempt.attempt_no=@attemptNo
        WHERE completed_job.guide_job_key=@jobKey
          AND completed_job.attempt_count=@attemptNo
          AND completed_job.job_status='succeeded'
          AND completed_job.active_slot IS NULL
          AND completed_attempt.worker_id=@workerId
          AND completed_attempt.attempt_status='succeeded'
          AND completed_attempt.completed_at IS NOT NULL
      )
        RETURN;
      SELECT @attemptCount=attempt_count,@maxAttempts=max_attempts,
        @sessionKey=session.guide_session_key,@priorStatus=session.status
      FROM content.guide_jobs AS job WITH (UPDLOCK,HOLDLOCK)
      JOIN content.guide_sessions AS session WITH (UPDLOCK,HOLDLOCK)
        ON session.guide_session_key=job.guide_session_key
      WHERE job.guide_job_key=@jobKey AND job.attempt_count=@attemptNo
        AND job.claimed_by=@workerId AND job.job_status='processing'
        AND job.claim_expires_at>SYSUTCDATETIME()
        AND session.status NOT IN ('cancelled','deleted');
      IF @attemptCount IS NULL THROW 52627,N'La concesión del trabajo expiró.',1;
      IF NOT EXISTS
      (
        SELECT 1 FROM content.guide_job_attempts
        WHERE guide_job_key=@jobKey AND attempt_no=@attemptNo
          AND attempt_status='processing' AND completed_at IS NULL
      )
        THROW 52627,N'El intento del trabajo ya no está vigente.',1;
      DECLARE @permanent BIT=CASE WHEN @errorCode IN
        (N'invalid_video_signature',N'invalid_video_codec',N'invalid_duration',N'invalid_video_shape',
         N'guide_source_mismatch',N'guide_prompt_too_large',N'unsafe_manual_output',
         N'invalid_manual_structure',N'unresolved_evidence_citation',N'unresolved_final_content',
         N'empty_transcript',N'audio_too_large',N'guide_frame_too_large',N'guide_answer_round_limit')
        THEN 1 ELSE 0 END;
      DECLARE @terminal BIT=CASE WHEN @ok=0 AND (@attemptCount>=@maxAttempts OR @permanent=1) THEN 1 ELSE 0 END;
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
      BEGIN
        UPDATE content.guide_sessions SET status='failed',failure_code=@errorCode,failure_summary=@errorSummary,
          updated_at=@now,updated_by=@workerId
        WHERE guide_session_key=@sessionKey;
        IF @@ROWCOUNT=1
        BEGIN
          DECLARE @eventNo INT=ISNULL((SELECT MAX(event_no)
            FROM content.guide_status_events WITH (UPDLOCK,HOLDLOCK)
            WHERE guide_session_key=@sessionKey),0)+1;
          INSERT content.guide_status_events
            (guide_session_key,event_no,from_status,to_status,stage,reason_code,occurred_by)
          SELECT @sessionKey,@eventNo,@priorStatus,'failed',current_stage,@errorCode,@workerId
          FROM content.guide_sessions WHERE guide_session_key=@sessionKey;
        END;
      END;
    `);
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function commitSqlGuideDraftProcessing(input: {
  claimed: ClaimedGuideJob;
  workerId: string;
  draftVersion: number;
  questionRound: number;
  title?: string;
  artifacts: GuideArtifactWrite[];
  questions: Array<{ id: string; number: number; targetField: string; text: string }>;
  aiRuns: GuideAiRunWrite[];
}): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const state = await assertGuideJobLease(transaction, input.claimed, input.workerId);
    if (state.status === "review" && state.latestDraftNo >= input.draftVersion) {
      await retireGuideJobSuccess(transaction, input.claimed, input.workerId);
      return;
    }
    if (!["queued", "processing"].includes(state.status)) {
      throw Object.assign(new Error("La sesión no admite resultados de borrador."), {
        code: "guide_session_state_changed",
      });
    }
    for (const artifact of input.artifacts) {
      await upsertGuideArtifact(transaction, state.sessionKey, input.workerId, artifact);
    }
    const supersede = new sql.Request(transaction);
    supersede.input("sessionKey", sql.BigInt, state.sessionKey);
    await supersede.query(`
      UPDATE content.guide_questions
      SET question_status='superseded'
      WHERE guide_session_key=@sessionKey AND question_status='open';
    `);
    for (const question of input.questions) {
      const request = new sql.Request(transaction);
      request.input("questionId", sql.NVarChar(150), question.id);
      request.input("sessionKey", sql.BigInt, state.sessionKey);
      request.input("roundNo", sql.Int, input.questionRound);
      request.input("questionNo", sql.Int, question.number);
      request.input("targetField", sql.NVarChar(120), question.targetField);
      request.input("questionText", sql.NVarChar(2000), question.text);
      request.input("workerId", sql.NVarChar(150), input.workerId);
      await request.query(`
        IF NOT EXISTS
        (
          SELECT 1 FROM content.guide_questions
          WHERE guide_session_key=@sessionKey AND round_no=@roundNo AND question_no=@questionNo
        )
          INSERT content.guide_questions
            (source_id,guide_session_key,round_no,question_no,target_field,question_text,question_status,created_by)
          VALUES
            (@questionId,@sessionKey,@roundNo,@questionNo,@targetField,@questionText,'open',@workerId);
      `);
    }
    await insertGuideAiRuns(transaction, state.sessionKey, input.claimed.jobKey, input.aiRuns);
    const update = new sql.Request(transaction);
    update.input("sessionKey", sql.BigInt, state.sessionKey);
    update.input("draftVersion", sql.Int, input.draftVersion);
    update.input("title", sql.NVarChar(240), input.title?.slice(0, 240) ?? null);
    update.input("workerId", sql.NVarChar(150), input.workerId);
    await update.query(`
      UPDATE content.guide_sessions
      SET status='review',current_stage='questions',latest_draft_no=@draftVersion,
        title=COALESCE(@title,title),failure_code=NULL,failure_summary=NULL,
        updated_at=SYSUTCDATETIME(),updated_by=@workerId
      WHERE guide_session_key=@sessionKey;
    `);
    await appendStatusEvent(
      transaction,
      state.sessionKey,
      state.status,
      "review",
      "questions",
      input.workerId,
    );
    await retireGuideJobSuccess(transaction, input.claimed, input.workerId);
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function commitSqlGuideFinalProcessing(input: {
  claimed: ClaimedGuideJob;
  workerId: string;
  draftVersion: number;
  artifact: GuideArtifactWrite;
  aiRuns: GuideAiRunWrite[];
}): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const state = await assertGuideJobLease(transaction, input.claimed, input.workerId);
    if (state.status === "completed" && state.latestDraftNo === input.draftVersion) {
      await retireGuideJobSuccess(transaction, input.claimed, input.workerId);
      return;
    }
    if (state.status !== "finalizing" || state.latestDraftNo !== input.draftVersion || state.answeredRoundCount < 1) {
      throw Object.assign(new Error("La sesión no admite el resultado final."), {
        code: "guide_session_state_changed",
      });
    }
    const open = new sql.Request(transaction);
    open.input("sessionKey", sql.BigInt, state.sessionKey);
    const openResult = await open.query<{ open_count: number }>(`
      SELECT COUNT(*) AS open_count
      FROM content.guide_questions
      WHERE guide_session_key=@sessionKey AND question_status='open';
    `);
    if (Number(openResult.recordset[0]?.open_count ?? 0) !== 0) {
      throw Object.assign(new Error("La sesión conserva preguntas sin responder."), {
        code: "guide_questions_open",
      });
    }
    await upsertGuideArtifact(transaction, state.sessionKey, input.workerId, input.artifact);
    await insertGuideAiRuns(transaction, state.sessionKey, input.claimed.jobKey, input.aiRuns);
    const update = new sql.Request(transaction);
    update.input("sessionKey", sql.BigInt, state.sessionKey);
    update.input("draftVersion", sql.Int, input.draftVersion);
    update.input("workerId", sql.NVarChar(150), input.workerId);
    await update.query(`
      UPDATE content.guide_sessions
      SET status='completed',current_stage='completed',finalized_draft_no=@draftVersion,
        completed_at=SYSUTCDATETIME(),failure_code=NULL,failure_summary=NULL,
        updated_at=SYSUTCDATETIME(),updated_by=@workerId
      WHERE guide_session_key=@sessionKey;
    `);
    await appendStatusEvent(
      transaction,
      state.sessionKey,
      state.status,
      "completed",
      "completed",
      input.workerId,
    );
    await retireGuideJobSuccess(transaction, input.claimed, input.workerId);
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
    await assertGuideJobLease(transaction, input.claimed, input.workerId);
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
      SET source_file_key=@fileKey,
        status='processing',current_stage='transcription',updated_at=SYSUTCDATETIME(),updated_by=@workerId
      WHERE guide_session_key=@sessionKey;
    `);
  });
}
