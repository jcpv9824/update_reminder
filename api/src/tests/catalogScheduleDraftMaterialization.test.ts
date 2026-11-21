import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { consumeSqlCatalogDraftReviewInTransaction, materializeReviewedCatalogDraftInTransaction } from "../lib/catalogScheduleDraftMaterializationSqlRepository";
import type { UpdateSchedule } from "../types/models";

const tx = {} as sql.Transaction;
const proposalId = "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95";
const reviewId = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
const receipt = { environment: "qa", proposalId, reviewId } as const;
const approvedAt = new Date("2030-06-22T12:00:00Z"), validUntil = new Date("2030-06-22T12:03:00Z");
const catalogValidUntil = new Date("2030-06-22T12:05:00Z");
const version = "0000000000000001";
const record: UpdateSchedule = { id: `catalog-draft-${proposalId}`, name: "QA", clientId: "client", clientName: "Cliente",
  targetType: "database", targetIds: [], frequencyType: "once", startDate: "2030-06-22", timezone: "America/Bogota",
  assignedRole: "database_updater", assignedUserIds: [], selectionMode: "manual", active: true, createdAt: approvedAt.toISOString(),
  updatedAt: approvedAt.toISOString(), createdBy: "author", updatedBy: "author" };
const pins = [{ linkId: "pin", targetId: "physical", kind: "database" as const }];
const args = { ...receipt, actor: { id: "author", email: "author@example.invalid" }, catalogValidUntil };

function fixtures(saved = record) {
  return { callbacks: { tightenDeadline: vi.fn(), freezeSameDay: vi.fn().mockResolvedValue(true) },
    io: { insert: vi.fn().mockResolvedValue({ key: 1, version, record: saved }),
      approve: vi.fn().mockResolvedValue({ approvedAt, validUntil, operationId: "CHANGE-1234" }), now: () => approvedAt } };
}

describe("catalog draft materialization", () => {
  it("requires a same-day snapshot and propagates any failure to the surrounding SQL transaction", async () => {
    const { callbacks, io } = fixtures();
    callbacks.freezeSameDay.mockResolvedValue(false);
    await expect(materializeReviewedCatalogDraftInTransaction(tx, { record, exactManualPins: pins }, args, callbacks, io))
      .rejects.toMatchObject({ status: 409 });
    expect(io.insert).toHaveBeenCalledWith(tx, record, args.actor, { catalogLifecycle: true });
    expect(io.approve).toHaveBeenCalledWith(tx, { ...receipt, version });
    expect(callbacks.freezeSameDay).toHaveBeenCalledWith(tx, { draft: { record, exactManualPins: pins },
      approval: { approvedAt, validUntil, operationId: "CHANGE-1234" }, version });
    expect(callbacks.tightenDeadline.mock.calls).toEqual([[catalogValidUntil],[validUntil]]);
  });

  it("waits until the start date to freeze a future schedule and refuses an empty manual scope", async () => {
    const later = { ...record, startDate: "2030-06-23" };
    const { callbacks, io } = fixtures(later);
    await expect(materializeReviewedCatalogDraftInTransaction(tx, { record: later, exactManualPins: pins }, args, callbacks, io))
      .resolves.toEqual({ id: record.id, status: "created" });
    expect(callbacks.freezeSameDay).not.toHaveBeenCalled();
    await expect(materializeReviewedCatalogDraftInTransaction(tx, { record: later, exactManualPins: [] }, args, callbacks, io))
      .rejects.toMatchObject({ status: 409 });
    expect(io.insert).toHaveBeenCalledOnce();
  });

  it("passes only the receipt and version and refuses a malformed approval result", async () => {
    const request = { input: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({ recordset: [{ approvedAt, validUntil,
      operationId: "CHANGE-1234" }] }) };
    const fake = { request: () => request } as unknown as sql.Transaction;
    await expect(consumeSqlCatalogDraftReviewInTransaction(fake, { ...receipt, version })).resolves.toMatchObject({ approvedAt, validUntil });
    expect(request.input.mock.calls.map(call => call[0])).toEqual(["environment","proposal","review","version"]);
    expect(request.execute).toHaveBeenCalledWith("settings.materialize_catalog_schedule_draft_review");
    request.execute.mockResolvedValueOnce({ recordset: [{ approvedAt, validUntil: approvedAt, operationId: "CHANGE-1234" }] });
    await expect(consumeSqlCatalogDraftReviewInTransaction(fake, { ...receipt, version })).rejects.toMatchObject({ status: 409 });
  });

  it("hash pins the guarded SQL, exact operation and protected manual destinations without granting execution", () => {
    const file = "080_catalog_schedule_draft_materialization.sql";
    const migration = readFileSync(new URL(`../../../migration/sql/${file}`, import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../../migration/sql/MANIFEST.sha256", import.meta.url), "utf8");
    expect(manifest).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${file}`);
    expect(migration).toContain("proof.reviewed_state_sha256=r.reviewed_state_sha256");
    expect(migration).toContain("s.row_version=@version");
    for (const field of ["frequency_type", "selection_mode", "assignment_mode"])
      expect(migration).toContain(`s.${field} COLLATE Latin1_General_100_BIN2=p.${field}`);
    expect(migration).toContain("OR review_id=@review");
    expect(migration).toContain("REFERENCES scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version)");
    expect(migration).toContain("SELECT @key,link_id,target_kind,target_id FROM @pins WHERE included=1");
    expect(migration).toContain("SELECT DISTINCT pin.schedule_key,pin.link_id,pin.target_kind,pin.verified_target_id");
    expect(migration).not.toMatch(/^\s*GRANT\s|\bEXECUTE AS\b/im);
  });

  it("isolates object execution from the normal installer unless separately approved", () => {
    const name = "081_catalog_schedule_draft_runtime_execute.sql";
    const migration = readFileSync(new URL(`../../../migration/sql/${name}`, import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../../migration/sql/MANIFEST.sha256", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../../../migration/tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1", import.meta.url), "utf8");
    expect(manifest).toContain(`${createHash("sha256").update(migration).digest("hex")}  ${name}`);
    expect(migration.match(/^\s*(?:GRANT|DENY|REVOKE|ALTER ROLE)\b.*$/gmi)?.map(line => line.trim())).toEqual([
      "GRANT EXECUTE ON OBJECT::settings.materialize_catalog_schedule_draft_review TO portal_runtime;",
    ]);
    expect(migration).not.toMatch(/\bEXECUTE AS\b|WITH GRANT OPTION/i);
    expect(migration).toContain("permission_name IN (N'SELECT',N'INSERT',N'UPDATE',N'DELETE'))<>4");
    expect(migration).toContain("m.execute_as_principal_id IS NULL");
    expect(runner.indexOf("if([bool]$IncludeScheduleLifecycle -ne [bool]$AuthorizeScheduleProcedureGrants)"))
      .toBeLessThan(runner.indexOf("$descriptorPath="));
    expect(runner).toContain("version='081'");
  });
});
