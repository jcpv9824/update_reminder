import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function repositorySource(): Promise<string> {
  return readFile(resolve(process.cwd(), "src/lib/guideBuilderSqlRepository.ts"), "utf8");
}

describe("guide SQL repository safety contract", () => {
  it("fences renewal, stage writes, and completion by attempt and unexpired lease", async () => {
    const source = await repositorySource();
    expect(source).toContain("job.attempt_count=@attemptNo");
    expect(source).toContain("job.claim_expires_at>SYSUTCDATETIME()");
    expect(source).toContain("session.status NOT IN ('cancelled','deleted')");
    expect(source).toContain("renewSqlGuideJobLease");
    expect(source).toContain("assertGuideJobLease");
  });

  it("persists equivalent mutation replay keys and short-circuits replay side effects", async () => {
    const source = await repositorySource();
    expect(source).toContain("last_regenerate_idempotency_key");
    expect(source).toContain("last_finalize_idempotency_key");
    expect(source).toContain("cancel_idempotency_key");
    expect(source.match(/if \(row\.replayed\) return mapSession\(row\);/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces owner quotas and exact current-question answers", async () => {
    const source = await repositorySource();
    expect(source).toContain("GUIDE_MAX_ACTIVE_SESSIONS_PER_OWNER");
    expect(source).toContain("GUIDE_MAX_CREATIONS_PER_OWNER_DAY");
    expect(source).toContain("Debe responder exactamente todas las preguntas abiertas una sola vez.");
    expect(source).toContain('boundedGuideLimit("GUIDE_MAX_ANSWER_ROUNDS", 3, 5)');
    expect(source).toContain('"guide_answer_round_limit"');
  });

  it("makes the first human answer round authoritative and closes the question loop", async () => {
    const source = await readFile(resolve(process.cwd(), "src/lib/guideProcessor.ts"), "utf8");
    expect(source).toContain('const finalClarificationRound = job.jobType === "reprocess"');
    expect(source).toContain("if (finalClarificationRound) draft.questions = []");
  });

  it("permits finalization after an answer round and supersedes stale open questions", async () => {
    const source = await repositorySource();
    expect(source).toContain("SET question_status='superseded'");
    expect(source).toContain("IF @status<>'review' OR @rounds<1 OR @latestDraft<>@draftVersion");
  });

  it("serializes claims and permits only one unexpired processing lease globally", async () => {
    const source = await repositorySource();
    expect(source).toContain("sys.sp_getapplock");
    expect(source).toContain("PortalSAGWeb:guide-worker:global-claim");
    expect(source).toContain("active_job.job_status='processing'");
    expect(source).toContain("active_job.claim_expires_at>@now");
    expect(source).toContain("Math.min(1, batchSize)");
  });

  it("retires the claimed job and attempt in the same draft/final transaction", async () => {
    const source = await repositorySource();
    expect(source).toContain("async function retireGuideJobSuccess");
    expect(source).toContain("SET completed_at=@now,attempt_status='succeeded'");
    expect(source).toContain("SET job_status='succeeded',active_slot=NULL,claimed_by=NULL");
    expect(source).toContain("claim_expires_at=NULL,heartbeat_at=NULL,next_attempt_at=NULL");
    expect(source.match(/await retireGuideJobSuccess\(transaction, input\.claimed, input\.workerId\);/g)?.length)
      .toBeGreaterThanOrEqual(4);
  });

  it("treats worker heartbeat and completion as no-ops after atomic retirement", async () => {
    const source = await repositorySource();
    expect(source.match(/completed_job\.job_status='succeeded'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("completed_attempt.attempt_status='succeeded'");
    expect(source).toContain("IF @ok=1 AND EXISTS");
    expect(source).toContain("SELECT CAST(1 AS BIT) AS renewed;");
  });

  it("rejects a different active job before enqueueing new work", async () => {
    const source = await repositorySource();
    expect(source).toContain("WHERE guide_session_key=@sessionKey AND active_slot=1");
    expect(source).toContain("AND idempotency_key<>@idempotencyKey");
    expect(source).toContain("La sesión ya tiene un trabajo activo.");
  });

  it("expires abandoned direct uploads and delays cleanup beyond signed URL expiry", async () => {
    const source = await repositorySource();
    const expiryImplementation = source.slice(
      source.indexOf("export async function expireSqlPendingGuideUploads"),
      source.indexOf("export async function renewSqlGuideJobLease"),
    );
    expect(source).toContain("expireSqlPendingGuideUploads");
    expect(source).toContain("created_at<=DATEADD(minute,-@minimumAgeMinutes");
    expect(source).toContain("Math.max(30");
    expect(source).toContain("updated_at<=DATEADD(minute,-@minimumAgeMinutes");
    expect(source).toContain("(status='cancelled' OR source_file_key IS NOT NULL)");
    expect(expiryImplementation).toContain("sql.ISOLATION_LEVEL.READ_COMMITTED");
  });
});
