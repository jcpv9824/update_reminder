import type sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { activateCatalogScheduleFromHistoryInTransaction, writeCatalogScheduleActivationInTransaction } from "../lib/catalogScheduleActivationSqlRepository";
import { catalogSchedulePopulationDigest } from "../lib/catalogSchedulePopulationCoverage";

const due = new Date("2026-11-20T05:00:00Z");
const born = new Date("2026-11-19T12:00:00Z");
const scope = { scheduleId: "schedule-copy", environment: "qa", definitionVersion: "0000000000000001" } as const;
const boundary = { scheduleKey: "42", startDate: "2026-11-20", createdAt: born, sqlNow: due, priorPhase: null };
const linkId = "d832a70e-b525-42fa-ab14-a4d54ea5158c";
const targetId = "cd20054c-1449-48a2-8c85-9ce6e9b25320";
const futureTarget = "437b679c-b6a5-486a-bd43-227ce11cc9c9";
const label = { linkId, clientId: "cliente", clientName: "Cliente de prueba", domainId: "domain",
  domainName: "dominio de prueba", targetId: "database", targetName: "base de prueba",
  verifiedTargetId: targetId, kind: "database", environment: "test" } as const;
const responsible = { targetKind: "database", principalKind: "user", principalId: "operador-sintetico" } as const;

function transaction(rows: unknown[]) {
  const query = vi.fn().mockResolvedValueOnce({ recordset: rows }).mockResolvedValue({ recordset: [] });
  const bindings: Record<string, unknown> = {};
  const request = {
    input: vi.fn((name: string, _sqlType: unknown, value: unknown) => { bindings[name] = value; return request; }),
    query,
  };
  return { tx: { request: () => request } as unknown as sql.Transaction, query, bindings };
}

describe("activation snapshot transaction", () => {
  it("does not request evidence or write before the SQL clock reaches the Bogotá start", async () => {
    const { tx, query } = transaction([{ ...boundary, sqlNow: new Date(due.valueOf() - 1) }]);
    const proof = vi.fn();
    await expect(writeCatalogScheduleActivationInTransaction(tx, scope, proof)).resolves.toBe("waiting");
    expect(query).toHaveBeenCalledOnce();
    expect(proof).not.toHaveBeenCalled();
  });

  it("keeps an existing snapshot intact and ignores a stale or removed definition", async () => {
    for (const [rows, expected] of [[[ { ...boundary, priorPhase: "frozen" } ], "existing"],
      [[ { ...boundary, priorPhase: "unsealed" } ], "held"],
      [[], "superseded"]] as const) {
      const { tx, query } = transaction([...rows]);
      const proof = vi.fn();
      await expect(writeCatalogScheduleActivationInTransaction(tx, scope, proof)).resolves.toBe(expected);
      expect(query).toHaveBeenCalledOnce();
      expect(proof).not.toHaveBeenCalled();
    }
  });

  it("writes only the cohort proven at activation, with the responsible and historical labels", async () => {
    const { tx, query, bindings } = transaction([boundary]);
    const proof = vi.fn(async () => ({
      previousMembers: [], evidence: { observedAt: due.valueOf(), complete: true,
        targets: [{ linkId, state: "eligible" as const }] },
      labelsByLink: new Map([[linkId, label], [futureTarget, { ...label, linkId: futureTarget }]]), responsibles: [responsible],
    }));
    await expect(writeCatalogScheduleActivationInTransaction(tx, scope, proof)).resolves.toBe("frozen");
    expect(proof).toHaveBeenCalledWith({ scheduleKey: "42", asOf: due, sqlNow: due });
    expect(query.mock.calls[0][0]).toContain("UPDLOCK,HOLDLOCK");
    expect(query.mock.calls[1][0]).toContain("row_version=@version AND active=1 AND deleted_at IS NULL");
    expect(query.mock.calls[1][0]).toContain("SET sealed_at=SYSUTCDATETIME()");
    expect(query.mock.calls[1][0].indexOf("SET sealed_at=SYSUTCDATETIME()"))
      .toBeGreaterThan(query.mock.calls[1][0].indexOf("INSERT scheduling.catalog_schedule_activation_responsibles"));
    expect(JSON.parse(String(bindings.members))).toEqual([{ ...label, state: "eligible" }]);
    expect(JSON.parse(String(bindings.responsibles))).toEqual([responsible]);
  });

  it("anchors an approved same-day copy to its own SQL approval, not the copied birth or an HTTP timestamp", async () => {
    const copyScope = { ...scope, sameDayCopyApproval: { intentId: linkId, operationId: "daily-update" } };
    const copyApprovedAt = new Date(due.valueOf() + 20);
    const sqlNow = new Date(due.valueOf() + 25);
    const sameDay = { ...boundary, createdAt: due, copyApprovedAt, sqlNow };
    const { tx, query, bindings } = transaction([sameDay]);
    const proof = vi.fn(async () => ({
      previousMembers: [], evidence: { observedAt: copyApprovedAt.valueOf(), complete: true,
        targets: [{ linkId, state: "eligible" as const }] },
      labelsByLink: new Map([[linkId, label]]), responsibles: [responsible],
    }));
    await expect(writeCatalogScheduleActivationInTransaction(tx, copyScope, proof)).resolves.toBe("frozen");
    expect(bindings.asOf).toEqual(copyApprovedAt);
    expect(proof).toHaveBeenCalledExactlyOnceWith({ scheduleKey: "42", asOf: copyApprovedAt, sqlNow });
    expect(query.mock.calls[0][0]).toContain("approval.schedule_version=s.row_version");
    const missing = transaction([{ ...sameDay, copyApprovedAt: null }]);
    await expect(writeCatalogScheduleActivationInTransaction(missing.tx, copyScope, proof)).rejects.toThrow();
    expect(missing.query).toHaveBeenCalledTimes(1);
  });

  it("does not persist a terminal snapshot when coverage at the boundary is unverified", async () => {
    const { tx, query } = transaction([{ ...boundary, sqlNow: new Date(due.getTime() + 1000) }]);
    const proof = vi.fn(async () => ({ previousMembers: [], labelsByLink: new Map([[linkId, label]]), responsibles: [responsible],
      evidence: { complete: true, observedAt: due.valueOf(), targets: [{ linkId, state: "unverifiable" as const }] } }));
    await expect(writeCatalogScheduleActivationInTransaction(tx, scope, proof)).resolves.toBe("held");
    expect(query).toHaveBeenCalledOnce();
  });

  it("uses only the new draft's exact SQL approval for a start on the same Bogotá day", async () => {
    const draftScope = { ...scope, scheduleId: `catalog-draft-${linkId}`, sameDayDraftApproval: { proposalId: linkId, operationId: "CHANGE-1234" } };
    const draftApprovedAt = new Date(due.valueOf() + 20);
    const sqlNow = new Date(due.valueOf() + 25);
    const sameDay = { ...boundary, createdAt: due, draftApprovedAt, sqlNow };
    const { tx, query, bindings } = transaction([sameDay]);
    const proof = vi.fn(async () => ({
      previousMembers: [], evidence: { observedAt: draftApprovedAt.valueOf(), complete: true,
        targets: [{ linkId, state: "eligible" as const }] },
      labelsByLink: new Map([[linkId, label]]), responsibles: [responsible],
    }));
    await expect(writeCatalogScheduleActivationInTransaction(tx, draftScope, proof)).resolves.toBe("frozen");
    expect(bindings.draftProposal).toEqual(linkId);
    expect(bindings.asOf).toEqual(draftApprovedAt);
    expect(query.mock.calls[0][0]).toContain("approval.approved_at=d.approved_at AND approval.retired_at IS NULL");
    expect(proof).toHaveBeenCalledExactlyOnceWith({ scheduleKey: "42", asOf: draftApprovedAt, sqlNow });
    for (const bad of [{ ...sameDay, createdAt: born }, { ...sameDay, draftApprovedAt: null }]) {
      const rejected = transaction([bad]);
      await expect(writeCatalogScheduleActivationInTransaction(rejected.tx, draftScope, proof)).rejects.toThrow();
      expect(rejected.query).toHaveBeenCalledOnce();
    }
  });

  it("persists cancellation only with positively bounded complete evidence and preserves absence history", async () => {
    const { tx, query, bindings } = transaction([{ ...boundary, sqlNow: new Date(due.getTime() + 1000) }]);
    await expect(writeCatalogScheduleActivationInTransaction(tx, scope, async () => ({ previousMembers: [],
      labelsByLink: new Map([[linkId, label]]), responsibles: [responsible], evidence: { complete: true,
        observedAt: due.valueOf(), targets: [{ linkId, state: "absent" }] } }))).resolves.toBe("cancelled");
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(bindings.members))).toEqual([{ ...label, state: "absent" }]);
  });

  const sourceIds = ["00000000-0000-0000-0000-000000000010", "00000000-0000-0000-0000-000000000020"];
  const headRows = () => sourceIds.map((id, index) => ({ sourceId: id, role: index ? "sag-admin" as const : "erp-customers" as const,
    revisionId: String(index + 100), bindingVersion: "0000000000000001", profileVersion: "0000000000000002",
    recordedAt: new Date(due.getTime() - 1000), observedAt: new Date(due.getTime() - 5000),
    sealedAt: new Date(due.getTime() - 1100), validUntil: new Date(due.getTime() + 86_400_000) }));
  const historicalScope = { ...scope, matchKeyVersion: 7 };
  const approval = () => ({ sourceCount: 2, linkCount: 1, digest: catalogSchedulePopulationDigest("qa", headRows(), [linkId]),
    validUntil: new Date(due.valueOf() + 2 * 86_400_000) });
  const historicalRows = [{ linkId, sourceId: sourceIds[0] }];
  const historicalBindings = headRows().map(({ sourceId, role }) => ({ sourceId, role }));

  it("resolves a late activation only against the exact source revisions already published at cutoff", async () => {
    const { tx, query, bindings } = transaction([{ ...boundary, sqlNow: new Date(due.getTime() + 360_000) }]);
    const heads = headRows();
    query.mockResolvedValueOnce({ recordsets: [heads, historicalBindings, [approval()], historicalRows] });
    const resolve = vi.fn(async () => ({ previousMembers: [], labelsByLink: new Map([[linkId,label]]), responsibles: [responsible],
      evidence: { complete: true, observedAt: due.valueOf(), targets: [{ linkId, state: "eligible" as const }] } }));
    await expect(activateCatalogScheduleFromHistoryInTransaction(tx, historicalScope, resolve)).resolves.toBe("frozen");
    expect(query.mock.calls[1][0]).toMatch(/WHERE e\.catalog_source_key=b\.catalog_source_key AND e\.recorded_at<=@asOf\s+ORDER BY e\.head_event_key DESC/);
    expect(query.mock.calls[1][0]).toContain("AND h.attempt_status='succeeded'");
    expect(bindings.asOf).toEqual(due);
    expect(query.mock.calls[1][0]).toContain("l.registered_at<=@asOf AND (l.retired_at IS NULL OR l.retired_at>@asOf)");
    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ asOf: due }), { heads, linkIds: [linkId], validUntil: heads[0].validUntil });
  });

  it.each(["missing", "expired", "late", "other source", "mismatched approval", "uncertified extra binding"])("does not freeze or cancel with %s source history", async state => {
    const { tx, query } = transaction([{ ...boundary, sqlNow: new Date(due.getTime() + 360_000) }]);
    const heads = headRows();
    if (state === "missing") heads.pop();
    if (state === "expired") heads[0].validUntil = due;
    if (state === "late") heads[0].recordedAt = new Date(due.getTime() + 1);
    if (state === "other source") heads[0].sourceId = linkId;
    const certificate = approval();
    if (state === "mismatched approval") certificate.digest = Buffer.alloc(32);
    const bindings = state === "uncertified extra binding" ? [...historicalBindings, { sourceId: futureTarget, role: "erp-customers" }] : historicalBindings;
    query.mockResolvedValueOnce({ recordsets: [heads, bindings, [certificate], historicalRows] });
    const resolve = vi.fn();
    await expect(activateCatalogScheduleFromHistoryInTransaction(tx, historicalScope, resolve)).resolves.toBe("held");
    expect(resolve).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects a resolver's eligible link outside the approved historical population", async () => {
    const { tx, query } = transaction([boundary]);
    query.mockResolvedValueOnce({ recordsets: [headRows(), historicalBindings, [approval()], historicalRows] });
    await expect(activateCatalogScheduleFromHistoryInTransaction(tx, historicalScope, async () => ({
      previousMembers: [], labelsByLink: new Map(), responsibles: [], evidence: { complete: true,
        observedAt: due.valueOf(), targets: [{ state: "eligible", linkId: futureTarget }] },
    }))).resolves.toBe("held");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
