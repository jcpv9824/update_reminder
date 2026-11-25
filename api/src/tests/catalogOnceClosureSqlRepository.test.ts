import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogOnceClosureCandidate } from "../lib/catalogOnceClosureSqlRepository";

const m = vi.hoisted(() => ({
  tx: {}, lock: vi.fn(), query: vi.fn(), audit: vi.fn(), committed: vi.fn(), rolledBack: vi.fn(),
}));
vi.mock("mssql", () => ({ default: {
  Request: class {
    parameters: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    query(statement: string) { return m.query(statement, this.tx, this.parameters); }
  },
  Date: Symbol(), BigInt: Symbol(), Int: Symbol(), VarChar: vi.fn(), Char: vi.fn(), NVarChar: vi.fn(), VarBinary: vi.fn(),
} }));
vi.mock("../lib/catalogExecutionCoexistenceSql", () => ({ lockCatalogTaskDay: m.lock }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: m.audit }));
vi.mock("../lib/sqlTransaction", () => ({
  runSqlTransaction: async (fn: (tx: object) => Promise<unknown>) => {
    try {
      const result = await fn(m.tx);
      m.committed();
      return result;
    } catch (error) {
      m.rolledBack();
      throw error;
    }
  },
}));

import { completeCatalogFrozenOnceCandidate, completeSqlCatalogOnceSchedule, reserveSqlCatalogOnceClosureCandidates,
  reserveCatalogOnceClosureCandidatesSql } from "../lib/catalogOnceClosureSqlRepository";
import { readCatalogFrozenOnceClosureProofSql, readCatalogOnceClosureProofSql } from "../lib/catalogOnceClosureSql";
import sql from "mssql";
const item: CatalogOnceClosureCandidate = { portalEnvironment: "qa", taskDate: "2030-01-01", observationKey: "9007199254740993" };
const proof = { scheduleId: "once-a", scheduleVersion: "0000000000000001", clientId: "customer-a" };

beforeEach(() => {
  vi.resetAllMocks();
  m.lock.mockResolvedValue(true);
  Object.assign(m.tx, { request: () => new sql.Request(m.tx as never) });
});

describe("atomic closure of one catalogue schedule", () => {
  it("advances a serialized fair cursor before processing and wraps instead of starving behind a blocked key", async () => {
    m.query.mockResolvedValueOnce({ recordset: [item] });
    expect(await reserveSqlCatalogOnceClosureCandidates("qa",50)).toEqual([item]);
    expect(m.query).toHaveBeenCalledExactlyOnceWith(reserveCatalogOnceClosureCandidatesSql,m.tx,
      { portalEnvironment:"qa",take:50 });
    expect(reserveCatalogOnceClosureCandidatesSql).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(reserveCatalogOnceClosureCandidatesSql).toContain("CASE WHEN o.observation_key>@after THEN 0 ELSE 1 END");
    expect(reserveCatalogOnceClosureCandidatesSql).toContain("last_observation_key=COALESCE(@last,0)");
    expect(reserveCatalogOnceClosureCandidatesSql).toContain("newer.observation_key>o.observation_key");
    expect(reserveCatalogOnceClosureCandidatesSql).toContain("s.catalog_activation_enabled=1");
    expect(m.lock).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("takes both transaction day locks, proves current eligibility, closes by exact version and audits before commit", async () => {
    m.query.mockResolvedValueOnce({ recordset: [proof] }).mockResolvedValueOnce({ recordset: [{ changed: 1 }] });
    expect(await completeSqlCatalogOnceSchedule(item)).toBe(true);
    expect(m.lock.mock.calls).toEqual([
      [m.tx, { taskDate: item.taskDate, targetType: "database" }],
      [m.tx, { taskDate: item.taskDate, targetType: "domain" }],
    ]);
    expect(m.query.mock.calls[0]).toEqual([readCatalogOnceClosureProofSql, m.tx, item]);
    const [update, tx, params] = m.query.mock.calls[1];
    expect(tx).toBe(m.tx);
    expect(params).toEqual({ ...item, scheduleId: proof.scheduleId, scheduleVersion: proof.scheduleVersion });
    expect(update).toContain("s.row_version=TRY_CONVERT(binary(8),@scheduleVersion,2)");
    expect(update).toContain("o.observation_key=@observationKey");
    expect(update).toContain("o.portal_environment=@portalEnvironment");
    expect(update).toContain("s.active=1 AND s.frequency_type='once'");
    expect(update).toContain("IF @enrolled=1 BEGIN SELECT 0 AS changed; RETURN; END");
    expect(readCatalogOnceClosureProofSql).toMatch(/IF @enrolled=1 OR @candidateSchedule IS NULL\s+BEGIN\s+SELECT [^;]+WHERE 1=0;\s+RETURN;/);
    expect(m.audit).toHaveBeenCalledExactlyOnceWith(m.tx, {
      entityType: "schedule", entityId: proof.scheduleId, clientId: proof.clientId,
      action: "schedule_one_time_completed", performedBy: "system", performedByEmail: "system",
      metadata: { reason: "one_time_schedule_executed", runDate: item.taskDate,
        scheduleId: proof.scheduleId, observationId: item.observationKey },
    });
    expect(m.audit.mock.invocationCallOrder[0]).toBeLessThan(m.committed.mock.invocationCallOrder[0]);
  });

  it("does not invoke proof or writes when a task day lock is busy", async () => {
    m.lock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await completeSqlCatalogOnceSchedule(item)).toBe(false);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("closes a lifecycle schedule only when the locked SQL proof covers the complete frozen cohort", async () => {
    const candidate = { taskDate: item.taskDate, scheduleKey: item.observationKey };
    m.query.mockResolvedValueOnce({ recordset: [] }).mockResolvedValueOnce({ recordset: [proof] })
      .mockResolvedValueOnce({ recordset: [{ count: 1 }] });
    expect(await completeCatalogFrozenOnceCandidate("qa", candidate)).toBe(false);
    expect(m.audit).not.toHaveBeenCalled();
    expect(await completeCatalogFrozenOnceCandidate("qa", candidate)).toBe(true);
    expect(m.query.mock.calls[1]).toEqual([readCatalogFrozenOnceClosureProofSql, m.tx,
      { ...candidate, portalEnvironment: "qa" }]);
    expect(readCatalogFrozenOnceClosureProofSql).toContain("f.evidence_state='eligible' AND NOT EXISTS (");
    expect(readCatalogFrozenOnceClosureProofSql).toContain("LOWER(CONVERT(char(16),CONVERT(binary(8),s.row_version),2)) AS scheduleVersion");
    expect(readCatalogFrozenOnceClosureProofSql).toContain("TRY_CONVERT(uniqueidentifier,e.verified_target_id)=f.verified_target_id");
    expect(readCatalogFrozenOnceClosureProofSql).toContain("t.completed_at>=a.attached_at");
    expect(readCatalogFrozenOnceClosureProofSql).toContain("explicitCompletionSuccess");
    expect(readCatalogFrozenOnceClosureProofSql).not.toMatch(/catalog_customer_revision_heads|catalog_once_observations/);
    expect(m.audit).toHaveBeenCalledWith(m.tx, expect.objectContaining({ metadata: expect.objectContaining({
      proof: "catalog_activation_snapshot",
    }) }));
  });

  it("never falls back to another observation and makes no audit when current proof is gone", async () => {
    m.query.mockResolvedValueOnce({ recordset: [] });
    expect(await completeSqlCatalogOnceSchedule(item)).toBe(false);
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("does not create audit after a stale comparison; a subsequent replay finds no active schedule", async () => {
    m.query.mockResolvedValueOnce({ recordset: [proof] }).mockResolvedValueOnce({ recordset: [{ changed: 0 }] })
      .mockResolvedValueOnce({ recordset: [] });
    expect(await completeSqlCatalogOnceSchedule(item)).toBe(false);
    expect(await completeSqlCatalogOnceSchedule(item)).toBe(false);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("propagates audit failure to the transaction owner to roll back the status update", async () => {
    m.query.mockResolvedValueOnce({ recordset: [proof] }).mockResolvedValueOnce({ recordset: [{ changed: 1 }] });
    m.audit.mockRejectedValueOnce(new Error("synthetic audit failure"));
    await expect(completeSqlCatalogOnceSchedule(item)).rejects.toThrow("synthetic audit failure");
    expect(m.committed).not.toHaveBeenCalled();
    expect(m.rolledBack).toHaveBeenCalledOnce();
  });

  it.each(["1e5", "01", "9223372036854775808", " 3", "0"])("rejects a malformed observation key %s ahead of SQL", async observationKey => {
    await expect(completeSqlCatalogOnceSchedule({ ...item, observationKey })).rejects.toThrow("catalog_once_closure_candidate_invalid");
    expect(m.lock).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});
