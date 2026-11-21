import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error("catalog_copy_review_not_available"), { status: 409 });

/** The procedure owns approval validation; this adapter never supplies a reviewer identity. */
export async function consumeSqlCatalogCopyReviewInTransaction(transaction: sql.Transaction, input: Readonly<{
  environment: CatalogEnvironment; proposalId: string; reviewId: string; copyVersion: string;
}>): Promise<Date> {
  if (!["qa", "production"].includes(input.environment) || !guid.test(input.proposalId) ||
      !guid.test(input.reviewId) || !/^[a-f0-9]{16}$/.test(input.copyVersion)) throw fail();
  try {
    const { recordset } = await transaction.request().input("environment", sql.VarChar(10), input.environment)
      .input("proposal", sql.UniqueIdentifier, input.proposalId).input("review", sql.UniqueIdentifier, input.reviewId)
      .input("copyVersion", sql.VarBinary(8), Buffer.from(input.copyVersion, "hex"))
      .execute<{ approvedAt: Date; validUntil: Date }>("settings.consume_catalog_schedule_copy_review");
    const row = recordset?.[0];
    if (recordset?.length !== 1 || !(row?.approvedAt instanceof Date) || !(row.validUntil instanceof Date) ||
        !Number.isFinite(row.approvedAt.valueOf()) || !Number.isFinite(row.validUntil.valueOf()) ||
        row.approvedAt >= row.validUntil) throw fail();
    return row.validUntil;
  } catch { throw fail(); }
}

/** A replay may report existing only after proving the committed exact approval and same-day snapshot. */
export async function confirmReviewedCatalogCopyReplayInTransaction(transaction: sql.Transaction, input: Readonly<{
  environment: CatalogEnvironment; proposalId: string; copyId: string;
}>): Promise<boolean> {
  const { recordset } = await transaction.request().input("environment", sql.VarChar(10), input.environment)
    .input("proposal", sql.UniqueIdentifier, input.proposalId).input("copy", sql.NVarChar(150), input.copyId)
    .query<{ confirmed: boolean }>(`
      SELECT CONVERT(bit,1) AS confirmed
      FROM scheduling.catalog_schedule_copy_intents i WITH (HOLDLOCK)
      JOIN scheduling.update_schedules s WITH (HOLDLOCK) ON s.schedule_key=i.copy_schedule_key
        AND s.source_id=@copy COLLATE Latin1_General_100_BIN2 AND DATALENGTH(s.source_id)=DATALENGTH(@copy)
      JOIN scheduling.catalog_schedule_operation_approvals a WITH (HOLDLOCK) ON a.schedule_key=s.schedule_key
        AND a.schedule_version=s.row_version AND a.portal_environment=i.portal_environment
        AND a.operation_id=i.operation_id AND a.approved_at<=SYSUTCDATETIME() AND a.retired_at IS NULL
      WHERE i.intent_id=@proposal AND i.portal_environment=@environment
        AND s.active=1 AND s.deleted_at IS NULL AND s.catalog_activation_enabled=1
        AND (CONVERT(date,DATEADD(hour,-5,a.approved_at))<s.start_date OR EXISTS (
          SELECT 1 FROM scheduling.catalog_schedule_activation_snapshots proof WITH (HOLDLOCK)
          WHERE proof.schedule_key=s.schedule_key AND proof.definition_version=s.row_version
            AND proof.portal_environment=i.portal_environment AND proof.activation_state='frozen' AND proof.sealed_at IS NOT NULL
            AND proof.activation_at=a.approved_at));`);
  return recordset?.length === 1 && recordset[0].confirmed === true;
}
