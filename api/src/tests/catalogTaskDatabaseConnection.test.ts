import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readAuditedTaskDatabaseConnection } from "../lib/catalogTaskDatabaseConnection";

const request = { databaseId: "db-a", taskId: "task-a", actor: { id: "actor", email: "test@example.invalid", roles: ["ops"],
  displayName: "QA" }, environment: "qa" as const };
const grant = { serverHostPort: "synthetic.invalid:1433", initialCatalog: "synthetic-db", userId: "synthetic-login",
  secretName: "synthetic-reference", databaseId: "db-a", taskId: "task-a", linkId: "link-a", profileVersion: "1",
  linkVersion: "2", executionVersion: "3", catalogSourceId: null, catalogRevisionId: null,
  catalogBindingVersion: null, catalogProfileVersion: null, catalogVerifiedUntil: null };
const externalGrant = { ...grant, linkId: "31140f4d-81c3-4938-9ab2-a275473feb17",
  catalogSourceId: "41140f4d-81c3-4938-9ab2-a275473feb17", catalogRevisionId: "9007199254740993",
  catalogBindingVersion: "0000000000000001", catalogProfileVersion: "0000000000000002",
  catalogVerifiedUntil: new Date("2030-01-01T00:00:00.000Z") };
function setup() {
  return { transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn({} as never),
    read: vi.fn().mockResolvedValue(grant), audit: vi.fn(), secret: vi.fn().mockResolvedValue("fixture-password") };
}
describe("task-bound database connection disclosure", () => {
  it("only opens audited metadata and does not read the password", async () => {
    const io = setup();
    const result = await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "view" } }, io);
    expect(result).toEqual({ kind: "info", info: { server: grant.serverHostPort, databaseName: grant.initialCatalog,
      user: grant.userId, hasPassword: true } });
    expect(io.audit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      action: "task_database_connection_opened", metadata: { databaseId: "db-a", linkId: "link-a" }, entityId: "task-a",
    }));
    expect(io.secret).not.toHaveBeenCalled();
    expect(JSON.stringify(io.audit.mock.calls)).not.toMatch(/synthetic-login|synthetic-reference|fixture-password/);
  });

  it("discards a retrieved password if access is revoked or the locked version changes", async () => {
    for (const after of [null, { ...grant, profileVersion: "changed" }, { ...grant, linkId: "other" }]) {
      const io = setup();
      io.read.mockResolvedValueOnce(grant).mockResolvedValueOnce(after);
      expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
      expect(io.secret).toHaveBeenCalledOnce();
      expect(io.audit).not.toHaveBeenCalled();
    }
  });

  it("fails closed before retrieving any credential for a denied task, and on audit failure", async () => {
    const io = setup();
    io.read.mockResolvedValueOnce(null);
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
    expect(io.secret).not.toHaveBeenCalled();
    io.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).rejects.toThrow("audit unavailable");
  });

  it.each([
    { kind: "view" as const },
    { kind: "copy" as const, part: "userId" as const },
    { kind: "reveal" as const },
    { kind: "copy" as const, part: "password" as const },
  ])("never reads a secret or audits a future catalog task denied by SQL: %j", async action => {
    const io = setup();
    io.read.mockResolvedValue(null);
    expect(await readAuditedTaskDatabaseConnection({ ...request, action }, io)).toBeNull();
    expect(io.read).toHaveBeenCalledOnce();
    expect(io.secret).not.toHaveBeenCalled();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("audits explicit field and password copies separately without the copied value", async () => {
    const io = setup();
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "copy", part: "userId" } }, io))
      .toEqual({ kind: "part", part: "userId", value: grant.userId });
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "copy", part: "password" } }, io))
      .toEqual({ kind: "password", value: "fixture-password" });
    expect(io.audit.mock.calls.map(([, event]) => [event.action, event.metadata.part])).toEqual([
      ["task_database_connection_copied", "userId"], ["task_database_connection_copied", "password"],
    ]);
    expect(JSON.stringify(io.audit.mock.calls)).not.toMatch(/synthetic-login|fixture-password/);
  });

  it.each([
    { catalogSourceId: "51140f4d-81c3-4938-9ab2-a275473feb17" },
    { catalogRevisionId: "9007199254740994" },
    { catalogBindingVersion: "0000000000000003" },
    { catalogProfileVersion: "0000000000000004" },
    { catalogVerifiedUntil: new Date("2030-01-02T00:00:00.000Z") },
    { catalogRevisionId: null },
  ])("discards the retrieved password when external approval evidence changes mid-reveal: %j", async changed => {
    const io = setup();
    io.read.mockResolvedValueOnce(externalGrant).mockResolvedValueOnce({ ...externalGrant, ...changed });
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
    expect(io.secret).toHaveBeenCalledOnce();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("does not disclose or audit a stable external witness on metadata, copy or reveal", async () => {
    const io = setup();
    io.read.mockResolvedValue(externalGrant);
    const view = await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "view" } }, io);
    expect(view).toEqual({ kind: "info", info: { server: grant.serverHostPort,
      databaseName: grant.initialCatalog, user: grant.userId, hasPassword: true } });
    const copy = await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "copy", part: "password" } }, io);
    expect(copy).toEqual({ kind: "password", value: "fixture-password" });
    const reveal = await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io);
    expect(reveal).toEqual({ kind: "password", value: "fixture-password" });
    const publicAndAudit = JSON.stringify([view, copy, reveal, io.audit.mock.calls]);
    expect(publicAndAudit).not.toMatch(/catalogSourceId|catalogRevisionId|catalogBindingVersion|catalogProfileVersion|catalogVerifiedUntil/);
    expect(publicAndAudit).not.toContain(externalGrant.catalogSourceId);
    expect(publicAndAudit).not.toContain(externalGrant.catalogRevisionId);
    expect(publicAndAudit).not.toContain(externalGrant.catalogBindingVersion);
    expect(publicAndAudit).not.toContain(externalGrant.catalogProfileVersion);
    expect(publicAndAudit).not.toContain(externalGrant.catalogVerifiedUntil.toISOString());
  });

  it.each([
    { kind: "view" as const },
    { kind: "copy" as const, part: "userId" as const },
    { kind: "reveal" as const },
    { kind: "copy" as const, part: "password" as const },
  ])("rolls back the staged audit and withholds disclosure when the final SQL clock check expires: %j", async action => {
    const needsPassword = action.kind === "reveal" || (action.kind === "copy" && action.part === "password");
    const committed: unknown[] = [];
    const rollback = vi.fn();
    const transaction = async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
      const staged: unknown[] = [];
      try {
        const result = await fn({ staged } as never);
        committed.push(...staged);
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    };
    const io = { ...setup(), transaction,
      audit: vi.fn(async (tx: { staged: unknown[] }, event: unknown) => { tx.staged.push(event); }) };
    if (needsPassword) io.read.mockResolvedValueOnce(externalGrant);
    io.read.mockResolvedValueOnce(externalGrant).mockResolvedValueOnce(null);
    expect(await readAuditedTaskDatabaseConnection({ ...request, action }, io)).toBeNull();
    expect(io.read).toHaveBeenCalledTimes(needsPassword ? 3 : 2);
    expect(io.secret).toHaveBeenCalledTimes(needsPassword ? 1 : 0);
    expect(io.audit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(committed).toEqual([]);
  });

  it("also rolls back when the post-audit witness changes, not only when the grant disappears", async () => {
    const io = setup();
    const rollback = vi.fn();
    io.transaction = async fn => {
      try { return await fn({} as never); }
      catch (error) { rollback(); throw error; }
    };
    io.read.mockResolvedValueOnce(externalGrant).mockResolvedValueOnce(externalGrant)
      .mockResolvedValueOnce({ ...externalGrant, catalogRevisionId: "9007199254740994" });
    expect(await readAuditedTaskDatabaseConnection({ ...request, action: { kind: "reveal" } }, io)).toBeNull();
    expect(io.audit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not hide a real database failure during the final grant check", async () => {
    const io = setup();
    const failure = new Error("final grant read unavailable");
    io.read.mockResolvedValueOnce(externalGrant).mockRejectedValueOnce(failure);
    await expect(readAuditedTaskDatabaseConnection({ ...request, action: { kind: "view" } }, io)).rejects.toBe(failure);
    expect(io.audit).toHaveBeenCalledOnce();
  });

  it("shares the current representative selector and requires every exact bridge dimension for external links", () => {
    const source = readFileSync(new URL("../lib/catalogTaskDatabaseConnection.ts", import.meta.url), "utf8");
    const query = source.split("`").find(part => /^\s*DECLARE @now/.test(part))!;
    expect(query).toBeTruthy();
    const selector = '${catalogTaskCurrentLinkSql("e", "visible_link", "@environment")}';
    const actionDate = '${catalogTaskActionDateSql}';
    expect(query).toContain(selector);
    expect(query).toContain("DECLARE @now datetime2(3)=SYSUTCDATETIME();");
    expect(query).toContain("OR (e.retired_at IS NULL AND " + actionDate);
    expect(query.replace(selector, "").replace(actionDate, "")).not.toContain("${");
    for (const predicate of [
      "FROM core.catalog_operational_link_evidence AS bridge",
      "bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72",
      "bridge.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(bridge.portal_environment)=DATALENGTH(@environment)",
      "bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key AND bridge.database_key=l.database_key",
      "bridge.target_kind='database'",
      "bridge.link_environment COLLATE Latin1_General_100_BIN2=l.link_environment COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(bridge.link_environment)=DATALENGTH(l.link_environment)",
      "bridge.catalog_source_key=l.catalog_source_key",
      "bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)",
      "CONVERT(nvarchar(11),bridge.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(CONVERT(nvarchar(11),bridge.source_record_id))=DATALENGTH(l.catalog_record_id)",
      "bridge.retired_at IS NULL AND bridge.owner_retired_at IS NULL",
      "bridge.evidence_state='verified' AND bridge.verified_until>@now",
      "approved.revision_key IS NOT NULL AND EXISTS",
    ]) expect(query).toContain(predicate);
    // No retirement/environment exemption: a known external UUID cannot become local.
    expect(query).toContain("l.catalog_source_key IS NULL AND NOT EXISTS");
    const knownExternal = query.slice(query.indexOf("SELECT 1 FROM core.catalog_operational_links AS knownExternal"),
      query.indexOf(")) OR (approved.revision_key"));
    expect(knownExternal).toContain("knownExternal.link_id=TRY_CONVERT(uniqueidentifier,l.link_id)");
    expect(knownExternal).not.toMatch(/retired_at|portal_environment/);
    // Legacy tasks still use their own scoped target, not the external bridge.
    expect(query).toContain("e.catalog_execution_key IS NULL AND task.database_key=db.database_key AND task.domain_key=db.domain_key AND task.client_key=db.client_key");
    expect(query).toContain("visible_link.catalog_execution_link_key");
    expect(query.indexOf(selector)).toBeLessThan(query.indexOf("ORDER BY CASE WHEN visible_link.database_key"));
    expect(query).toContain("NOT EXISTS(SELECT 1 FROM workflow.task_assignees WHERE task_key=task.task_key)");
    for (const alias of ["catalogSourceId", "catalogRevisionId", "catalogBindingVersion", "catalogProfileVersion", "catalogVerifiedUntil"])
      expect(query).toContain(` AS ${alias}`);
  });
});
