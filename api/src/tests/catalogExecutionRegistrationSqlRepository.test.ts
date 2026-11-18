import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateTask } from "../types/models";

const mock = vi.hoisted(() => ({ query: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), insert: vi.fn(), lockDay: vi.fn(), license: vi.fn(), population: vi.fn(), tx: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    parameters: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    query(query: string) { return mock.query(query, this.parameters, this.tx); }
  },
  NVarChar: vi.fn(), VarChar: vi.fn(), VarBinary: vi.fn(), DateTime2: vi.fn(), Date: Symbol(), BigInt: Symbol(), Bit: Symbol(), MAX: Symbol(),
} }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (fn: (tx: object) => Promise<unknown>) => {
  mock.begin();
  try { const result = await fn(mock.tx); mock.commit(); return result; }
  catch (error) { mock.rollback(); throw error; }
} }));
vi.mock("../lib/workflowTaskGenerationSqlRepository", () => ({ insertSqlGeneratedTaskInTransaction: mock.insert }));
vi.mock("../lib/catalogExecutionCoexistenceSql", () => ({ lockCatalogTaskDay: mock.lockDay }));
vi.mock("../lib/catalogExecutionLicenseSqlProof", () => ({ revalidateSqlCatalogExecutionLicenses: mock.license }));
vi.mock("../lib/catalogSchedulePopulationCoverage", () => ({
  catalogPopulationRevisionPrefix: "catalog-population-v1:",
  lockSqlCatalogSchedulePopulationApproval: mock.population,
}));

import { registerSqlCatalogTaskExecution, registerSqlCatalogTaskExecutionInTransaction,
  catalogRegistrationConflictReason, type CatalogExecutionRegistration } from "../lib/catalogExecutionRegistrationSqlRepository";
import { catalogTaskExecutionKey } from "../lib/catalogTaskTargetPlanning";
import { runSqlTransaction } from "../lib/sqlTransaction";

const sourceId = "00000000-0000-0000-0000-000000000001";
const externalLinkId = "00000000-0000-0000-0000-000000000021";
const linkId = (n: number) => n === 1 ? externalLinkId : `link${n}`;
const physicalId = "31140f4d-81c3-4938-9ab2-a275473feb17";
const cutoffAt = new Date("2030-06-23T05:00:00.000Z");
const now = new Date("2030-06-21T01:00:00.000Z");
const occurrenceId = "2030-06-22";
const logical = (n: number) => ({ linkId: linkId(n), customerId: `customer${n}`, domainId: `domain${n}`, databaseId: `database${n}`,
  kind: "database" as const, state: "active" as const, environment: "production" as const, catalogRecordId: `record${n}`,
  moduleIds: ["module1"], target: { status: "verified" as const, id: physicalId } });
const task: UpdateTask = { id: "catalog_workflow1", taskDate: occurrenceId, taskBucket: "2030-06-22-database",
  clientId: "customer1", clientName: "Cliente uno", domainId: "domain1", domainName: "Dominio uno", targetType: "database",
  targetId: "database1", targetName: "Base uno", scheduleId: "schedule_1", assignedRole: "db_updater", assignedUserIds: [],
  status: "pending", result: null, notes: "", completedAt: null, completedBy: null,
  createdAt: now.toISOString(), updatedAt: now.toISOString(), createdBy: "system", updatedBy: "system" };

const input = (): CatalogExecutionRegistration => {
  const assignment = { kind: "role" as const, id: "db_updater" };
  return { group: { occurrenceId, revisionId: "revision1", kind: "database", targetId: physicalId, operationId: "release1", assignment,
    executionKey: catalogTaskExecutionKey(occurrenceId, "database", physicalId),
    sources: [1, 2].map(n => ({ scheduleId: `schedule_${n}`, operationId: "release1", assignment, link: logical(n) })) },
  task, cutoffAt, portalEnvironment: "qa", catalogSourceIdsByLink: new Map([[externalLinkId, sourceId], ["link2", null]]),
    catalogEvidenceByLink: new Map([[externalLinkId, { sourceId, revisionId: "100", bindingVersion: "0000000000000010",
      profileVersion: "0000000000000020", verifiedUntil: cutoffAt.toISOString() }]]),
    scheduleVersions: new Map([["schedule_1", "0000000000000001"], ["schedule_2", "0000000000000002"]]) };
};

const scheduleRows = [{ scheduleId: "schedule_1", scheduleKey: "1", origin: "licensing", selectionMode: "manual" },
  { scheduleId: "schedule_2", scheduleKey: "2", origin: "special", selectionMode: null }];
const licensedRows = [{ ...scheduleRows[0], selectionMode: "licensing" }, scheduleRows[1]];
const existing = { executionId: "2", taskKey: "17", taskId: task.id, operationId: "release1", occurrenceId, targetId: physicalId, kind: "database",
  status: "completed", taskDate: task.taskDate, cutoffAt, retiredAt: null, representativeTarget: task.targetId, representativeClient: task.clientId,
  representativeDomain: task.domainId, primaryScheduleId: "schedule_1", assignedRole: task.assignedRole, usersJson: "[]" };
const existingLinks = [1, 2].map(n => ({ linkId: linkId(n), clientId: `customer${n}`, domainId: `domain${n}`, databaseId: `database${n}`,
  catalogSourceId: n === 1 ? sourceId : null, recordId: `record${n}`, environment: "production", scheduleId: `schedule_${n}`,
  detachedAt: null, state: "active", linkRetiredAt: null }));
const rows = (...response: object[][]) => {
  for (const recordset of response) mock.query.mockResolvedValueOnce({ recordset });
};

beforeEach(() => { vi.resetAllMocks(); mock.insert.mockResolvedValue(17); mock.lockDay.mockResolvedValue(true); mock.population.mockResolvedValue(cutoffAt); });

describe("certified-day additive schedule provenance", () => {
  const transaction = mock.tx as Parameters<typeof registerSqlCatalogTaskExecutionInTransaction>[0];
  const mode = { replayMode: "certified-day" as const };
  const addedSchedule = { scheduleId: "schedule_3", scheduleKey: "3", origin: "licensing", selectionMode: "licensing" };
  const addition = (): CatalogExecutionRegistration => {
    const value = input();
    return { ...value, matchKeyVersion: 3, task: { ...value.task, scheduleId: "schedule_3" },
      group: { ...value.group, revisionId: "catalog-population-v1:00000000-0000-0000-0000-000000000099",
        sources: [{ ...value.group.sources[0], scheduleId: "schedule_3" }] },
      catalogSourceIdsByLink: new Map([[externalLinkId, sourceId]]),
      scheduleVersions: new Map([["schedule_3", "0000000000000003"]]) };
  };
  const proofExpiry = new Date(now.valueOf() + 90_000);
  const licenseExpiry = new Date(now.valueOf() + 30_000);
  const successfulAppend = (finalResult = "registered") => rows([existing], existingLinks, [addedSchedule], [{ now }],
    [{ linkId: externalLinkId, validUntil: proofExpiry }], [{ count: 1 }], [{ count: 1 }], [{ result: finalResult }]);
  const append = () => registerSqlCatalogTaskExecutionInTransaction(transaction, addition(), mode);
  const lateId = "10000000-0000-0000-0000-000000000050";
  const lateAlias = (): CatalogExecutionRegistration => {
    const value = addition();
    const source = value.group.sources[0];
    return { ...value, task: { ...value.task, clientId: "late-client", domainId: "late-domain", targetId: "late-database" },
      group: { ...value.group, sources: [{ ...source, link: { ...source.link, linkId: lateId, customerId: "late-client",
        domainId: "late-domain", databaseId: "late-database", catalogRecordId: "500" } }] },
      catalogSourceIdsByLink: new Map([[lateId, sourceId]]), catalogEvidenceByLink: new Map([[lateId, value.catalogEvidenceByLink!.get(externalLinkId)!]]) };
  };

  it("appends only the missing pair and nonprimary source, without changing task/link/lifecycle or emitting registered", async () => {
    mock.license.mockResolvedValue(licenseExpiry);
    successfulAppend();
    const result = await append();
    expect(result).toEqual({ outcome: { status: "existing", taskId: task.id }, validUntil: licenseExpiry });
    expect(mock.query).toHaveBeenCalledTimes(8);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
    expect(mock.query.mock.calls[2][0]).toContain("s.row_version=TRY_CONVERT(binary(8),ids.expected_version,2)");
    expect(mock.query.mock.calls[2][0]).toContain("approved_operation.schedule_version=s.row_version");
    expect(mock.query.mock.calls[2][1]).toMatchObject({ operationId: "release1", portalEnvironment: "qa" });
    expect(mock.query.mock.calls[4][1]).toMatchObject({ executionId: "2", insertLinks: false });
    expect(mock.query.mock.calls[4][0]).toContain("IF @insertLinks=1\n          INSERT workflow.catalog_task_execution_links");
    expect(mock.query.mock.calls[4][0]).toContain("bridge.revision_key=TRY_CONVERT(bigint,r.revisionId)");
    expect(mock.query.mock.calls[4][0]).toContain("pt.access_profile_version=ap.row_version");
    expect(mock.license).toHaveBeenCalledExactlyOnceWith(transaction, { executionId: "2", portalEnvironment: "qa", matchKeyVersion: 3,
      attachments: [{ linkId: externalLinkId, scheduleId: "schedule_3", moduleIds: ["module1"] }] });
    expect(mock.query.mock.calls[5][1].attachments).toBe(JSON.stringify([{ linkId: externalLinkId, scheduleId: "schedule_3" }]));
    expect(mock.query.mock.calls[5][0]).toContain("WHERE NOT EXISTS (SELECT 1 FROM workflow.catalog_task_execution_sources prior WITH (HOLDLOCK)");
    expect(mock.query.mock.calls[6][1]).toMatchObject({ taskKey: "17", origins: '[{"key":"3","origin":"licensing"}]' });
    expect(mock.query.mock.calls[6][0]).toContain("WHERE NOT EXISTS (SELECT 1 FROM workflow.task_sources prior WITH (HOLDLOCK)");
    expect(mock.query.mock.calls[6][0]).toContain("present.is_primary=0");
    expect(mock.query.mock.calls[7][1]).toMatchObject({ insertRegistrationEvent: false, validUntil: licenseExpiry });
    expect(mock.query.mock.calls[7][0]).toContain("IF @insertRegistrationEvent=1\n          INSERT workflow.catalog_task_execution_events");
    expect(mock.query.mock.calls.every(([text]) => !/\b(?:UPDATE|DELETE|MERGE)\s+(?:workflow|core)\./.test(text))).toBe(true);
    expect(mock.query.mock.calls.some(([text]) => /INSERT workflow\.catalog_task_executions\s/.test(text))).toBe(false);
    expect(existing.primaryScheduleId).toBe("schedule_1");
    expect(existing.status).toBe("completed");
  });

  it("becomes a read-only subset replay after the new pair was attached", async () => {
    rows([existing], [...existingLinks, { ...existingLinks[0], scheduleId: "schedule_3" }]);
    expect(await append()).toEqual({ outcome: { status: "existing", taskId: task.id }, validUntil: null });
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.license).not.toHaveBeenCalled();
    expect(mock.population).not.toHaveBeenCalled();
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("passes only missing pairs when the request includes already attached pairs too", async () => {
    const value = addition();
    const combined = { ...value, group: { ...value.group, sources: [input().group.sources[0], value.group.sources[0]] },
      scheduleVersions: new Map([["schedule_1", "0000000000000001"], ["schedule_3", "0000000000000003"]]) };
    mock.license.mockResolvedValue(licenseExpiry);
    rows([existing], existingLinks, [scheduleRows[0], addedSchedule], [{ now }], [{ linkId: externalLinkId, validUntil: proofExpiry }],
      [{ count: 1 }], [{ count: 1 }], [{ result: "registered" }]);
    await registerSqlCatalogTaskExecutionInTransaction(transaction, combined, mode);
    expect(JSON.parse(mock.query.mock.calls[5][1].attachments)).toEqual([{ linkId: externalLinkId, scheduleId: "schedule_3" }]);
    expect(mock.query.mock.calls[6][1].origins).toBe('[{"key":"3","origin":"licensing"}]');
  });

  it.each([
    ["hidden", { state: "hidden" }], ["retired", { state: "retired", linkRetiredAt: now }],
    ["detached only origin", { detachedAt: now }], ["orphaned", { scheduleId: null }],
    ["identity changed", { domainId: "different-domain" }],
  ])("denies additive writes when a requested link is %s", async (_name, change) => {
    rows([existing], [{ ...existingLinks[0], ...change }, existingLinks[1]]);
    await expect(append()).rejects.toThrow("source-set-changed");
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
  });

  it("does not reattach a previously detached pair even when the link has another active origin", async () => {
    rows([existing], [...existingLinks, { ...existingLinks[0], scheduleId: "schedule_3", detachedAt: now }]);
    await expect(append()).rejects.toThrow("source-set-changed");
    expect(mock.query).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "completed"])("records a distinct late alias as receipt only while preserving the %s task", async status => {
    mock.license.mockResolvedValue(licenseExpiry);
    const request = lateAlias();
    rows([{ ...existing, status }], existingLinks, [addedSchedule], [{ now }], [{ linkId: lateId, validUntil: proofExpiry }],
      [{ count: 1 }], [{ result: "registered" }]);
    expect(await registerSqlCatalogTaskExecutionInTransaction(transaction, request, mode))
      .toEqual({ outcome: { status: "existing", taskId: task.id, accountedOrigins: 1, receiptOnly: true }, validUntil: licenseExpiry });
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.query.mock.calls[4][1]).toMatchObject({ executionId: "2", insertLinks: false, physicalId });
    expect(mock.license).toHaveBeenCalledExactlyOnceWith(transaction, { executionId: "2", portalEnvironment: "qa", matchKeyVersion: 3,
      attachments: [{ linkId: lateId, scheduleId: "schedule_3", moduleIds: ["module1"] }], proofOnlyLinks: [lateId] });
    const [receiptSql, params] = mock.query.mock.calls[5];
    expect(receiptSql).toContain("INSERT workflow.catalog_task_origin_receipts");
    expect(receiptSql).toContain("prior.schedule_version");
    expect(params).toMatchObject({ portalEnvironment: "qa", executionId: "2", validUntil: licenseExpiry });
    expect(JSON.parse(params.receipts)).toEqual([{ linkId: lateId, scheduleId: "schedule_3", scheduleVersion: "0000000000000003" }]);
    expect(mock.query.mock.calls[6][1]).toMatchObject({ insertRegistrationEvent: false, validUntil: licenseExpiry });
    expect(mock.query.mock.calls.some(([sql]) => /INSERT workflow\.(catalog_task_execution_sources|task_sources)/.test(sql))).toBe(false);
  });

  it("revalidates a late receipt and keeps its SQL insert idempotent on replay", async () => {
    mock.license.mockResolvedValue(licenseExpiry);
    for (let retry = 0; retry < 2; retry++) {
      rows([existing], existingLinks, [addedSchedule], [{ now }], [{ linkId: lateId, validUntil: proofExpiry }],
        [{ count: 1 }], [{ result: "registered" }]);
      expect(await registerSqlCatalogTaskExecutionInTransaction(transaction, lateAlias(), mode))
        .toEqual({ outcome: { status: "existing", taskId: task.id, accountedOrigins: 1, receiptOnly: true }, validUntil: licenseExpiry });
    }
    const queries = mock.query.mock.calls.filter(([sql]) => sql.includes("INSERT workflow.catalog_task_origin_receipts"));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toEqual(queries[1]);
    expect(queries[0][0]).toContain("WHERE NOT EXISTS");
  });

  it("appends a regular missing source but does not make a receipt-only schedule operative", async () => {
    const known = addition();
    const late = lateAlias();
    const combined = { ...known, group: { ...known.group, sources: [...known.group.sources,
      { ...late.group.sources[0], scheduleId: "schedule_4" }] },
      catalogSourceIdsByLink: new Map([...known.catalogSourceIdsByLink, ...late.catalogSourceIdsByLink]),
      catalogEvidenceByLink: new Map([...known.catalogEvidenceByLink!, ...late.catalogEvidenceByLink!]),
      scheduleVersions: new Map([...known.scheduleVersions, ["schedule_4", "0000000000000004"]]) };
    mock.license.mockResolvedValue(licenseExpiry);
    rows([existing], existingLinks, [addedSchedule, { ...addedSchedule, scheduleId: "schedule_4", scheduleKey: "4", selectionMode: "manual" }], [{ now }],
      [{ linkId: externalLinkId, validUntil: proofExpiry }, { linkId: lateId, validUntil: proofExpiry }],
      [{ count: 1 }], [{ count: 1 }], [{ count: 1 }], [{ result: "registered" }]);
    expect((await registerSqlCatalogTaskExecutionInTransaction(transaction, combined, mode)).outcome)
      .toEqual({ status: "existing", taskId: task.id, accountedOrigins: 1 });
    const receipt = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT workflow.catalog_task_origin_receipts"))!;
    const schedule = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT workflow.task_sources"))!;
    const regular = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT workflow.catalog_task_execution_sources"))!;
    expect(JSON.parse(receipt[1].receipts)).toEqual([{ linkId: lateId, scheduleId: "schedule_4", scheduleVersion: "0000000000000004" }]);
    expect(JSON.parse(regular[1].attachments)).toEqual([{ linkId: externalLinkId, scheduleId: "schedule_3" }]);
    expect(JSON.parse(schedule[1].origins)).toEqual([{ key: "3", origin: "licensing" }]);
    expect(mock.license).toHaveBeenCalledExactlyOnceWith(transaction, { executionId: "2", portalEnvironment: "qa", matchKeyVersion: 3,
      attachments: [{ linkId: externalLinkId, scheduleId: "schedule_3", moduleIds: ["module1"] }] });
  });

  it("keeps an already-attached requested pair operative alongside accounting receipts", async () => {
    const known = input();
    const late = lateAlias();
    const combined = { ...late, group: { ...late.group, sources: [known.group.sources[0], ...late.group.sources] },
      catalogSourceIdsByLink: new Map([[externalLinkId, sourceId], ...late.catalogSourceIdsByLink]),
      catalogEvidenceByLink: new Map([[externalLinkId, known.catalogEvidenceByLink!.get(externalLinkId)!], ...late.catalogEvidenceByLink!]),
      scheduleVersions: new Map([["schedule_1", "0000000000000001"], ...late.scheduleVersions]) };
    mock.license.mockResolvedValue(licenseExpiry);
    rows([existing], existingLinks, [scheduleRows[0], addedSchedule], [{ now }],
      [{ linkId: externalLinkId, validUntil: proofExpiry }, { linkId: lateId, validUntil: proofExpiry }],
      [{ count: 1 }], [{ result: "registered" }]);
    expect((await registerSqlCatalogTaskExecutionInTransaction(transaction, combined, mode)).outcome)
      .toEqual({ status: "existing", taskId: task.id, accountedOrigins: 1 });
    expect(mock.query.mock.calls.some(([sql]) => /INSERT workflow\.(catalog_task_execution_sources|task_sources)/.test(sql))).toBe(false);
  });

  it("does not accept a local-only late alias without the distinct 042 proof", async () => {
    const value = lateAlias();
    rows([existing], existingLinks);
    await expect(registerSqlCatalogTaskExecutionInTransaction(transaction, { ...value,
      catalogSourceIdsByLink: new Map([[lateId, null]]), catalogEvidenceByLink: undefined,
    }, mode)).rejects.toThrow("source-set-changed");
    expect(mock.query).toHaveBeenCalledTimes(2);
  });

  it("rolls back a late receipt when the proof expires before the final SQL clock", async () => {
    mock.license.mockResolvedValue(licenseExpiry);
    rows([existing], existingLinks, [addedSchedule], [{ now }], [{ linkId: lateId, validUntil: proofExpiry }],
      [{ count: 1 }], [{ result: "catalog-reference-changed" }]);
    await expect(runSqlTransaction(tx => registerSqlCatalogTaskExecutionInTransaction(tx, lateAlias(), mode)))
      .rejects.toThrow("catalog-reference-changed");
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it.each(["proof missing", "proof mismatch", "missing receipt row"] as const)("denies receipt-only reconciliation when %s", async issue => {
    mock.license.mockResolvedValue(licenseExpiry);
    rows([existing], existingLinks, [addedSchedule], [{ now }],
      issue === "proof missing" ? [] : [{ linkId: issue === "proof mismatch" ? externalLinkId : lateId, validUntil: proofExpiry }],
      [{ count: 0 }]);
    await expect(runSqlTransaction(tx => registerSqlCatalogTaskExecutionInTransaction(tx, lateAlias(), mode)))
      .rejects.toThrow("catalog-reference-changed");
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT workflow.catalog_task_origin_receipts"))).toBe(issue === "missing receipt row");
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it.each(["schedule guard", "physical/ERP proof", "licensing proof"])("denies append when current %s is unavailable", async stage => {
    mock.license.mockResolvedValue(null);
    if (stage === "schedule guard") rows([existing], existingLinks, []);
    else rows([existing], existingLinks, [addedSchedule], [{ now }], stage === "physical/ERP proof" ? [] : [{ linkId: externalLinkId, validUntil: proofExpiry }]);
    await expect(append()).rejects.toThrow("catalog-reference-changed");
    expect(mock.query.mock.calls.some(([text]) => text.includes("INSERT workflow.catalog_task_execution_sources"))).toBe(false);
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it.each(["cutoff-passed", "catalog-reference-changed"])("throws on final %s so outer owner rolls back provenance additions", async result => {
    mock.license.mockResolvedValue(licenseExpiry);
    successfulAppend(result);
    await expect(runSqlTransaction(tx => registerSqlCatalogTaskExecutionInTransaction(tx, addition(), mode))).rejects.toThrow(result);
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.insert).not.toHaveBeenCalled();
  });
});

describe("certified-day read-only subset replay", () => {
  const transaction = mock.tx as Parameters<typeof registerSqlCatalogTaskExecutionInTransaction>[0];
  const mode = { replayMode: "certified-day" as const };
  const timerInput = (): CatalogExecutionRegistration => {
    const value = input();
    return { ...value, group: { ...value.group,
      revisionId: "catalog-population-v1:00000000-0000-0000-0000-000000000099",
      sources: value.group.sources.slice(1) },
      task: { ...value.task, clientId: "customer2", domainId: "domain2", targetId: "database2", scheduleId: "schedule_2" },
      catalogSourceIdsByLink: new Map([["link2", null]]), catalogEvidenceByLink: undefined,
      scheduleVersions: new Map([["schedule_2", "0000000000000002"]]) };
  };
  const deny = async (request = timerInput(), reason = "source-set-changed") => {
    let failure: unknown;
    try { await registerSqlCatalogTaskExecutionInTransaction(transaction, request, mode); }
    catch (error) { failure = error; }
    expect(catalogRegistrationConflictReason(failure)).toBe(reason);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
  };

  it("accepts timer-after-manual subset without replacing the stored manual representative/root or writing anything", async () => {
    rows([existing], existingLinks);
    const result = await registerSqlCatalogTaskExecutionInTransaction(transaction, timerInput(), mode);
    expect(result).toEqual({ outcome: { status: "existing", taskId: task.id }, validUntil: null });
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.query.mock.calls.every(([statement]) => !/\b(?:INSERT|UPDATE|DELETE|MERGE)\s/i.test(statement))).toBe(true);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
    expect(mock.population).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
    expect(existing.representativeTarget).toBe("database1");
    expect(existing.primaryScheduleId).toBe("schedule_1");
  });

  it("retains extra historical detached/retired pairs without using them to satisfy requested membership", async () => {
    rows([existing], [{ ...existingLinks[0], state: "retired", detachedAt: now, linkRetiredAt: now }, existingLinks[1],
      { ...existingLinks[1], scheduleId: "historical-extra", detachedAt: now }]);
    expect(await registerSqlCatalogTaskExecutionInTransaction(transaction, timerInput(), mode)).toEqual({
      outcome: { status: "existing", taskId: task.id }, validUntil: null,
    });
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.query).toHaveBeenCalledTimes(2);
  });

  it("keeps the default in-transaction and standalone replay exact even if an input has a replayMode-like field", async () => {
    const value = { ...timerInput(), replayMode: "certified-day" };
    rows([existing], [existing]);
    let failure: unknown;
    try { await registerSqlCatalogTaskExecutionInTransaction(transaction, value); }
    catch (error) { failure = error; }
    expect(catalogRegistrationConflictReason(failure)).toBe("execution-conflict");
    expect(await registerSqlCatalogTaskExecution(value)).toEqual({ status: "conflict", reason: "execution-conflict" });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["task ID", { taskId: "different-task" }], ["physical target", { targetId: "different-target" }],
    ["business date", { taskDate: "2030-06-23" }], ["occurrence", { occurrenceId: "2030-06-23" }],
    ["operation", { operationId: "other-operation" }], ["kind", { kind: "domain" }],
    ["cutoff", { cutoffAt: new Date(cutoffAt.valueOf() + 1) }], ["assigned role", { assignedRole: "other-role" }],
    ["explicit users", { usersJson: '[{"id":"unrequested-user"}]' }],
  ])("does not relax exact %s identity", async (_label, mismatch) => {
    rows([{ ...existing, ...mismatch }]);
    await deny(timerInput(), "execution-conflict");
    expect(mock.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["client", { clientId: "other-client" }], ["domain", { domainId: "other-domain" }],
    ["database", { databaseId: "other-database" }], ["environment", { environment: "test" }],
    ["ERP record", { recordId: "other-record" }], ["ERP source", { catalogSourceId: sourceId }],
    ["detached attachment", { detachedAt: now }], ["retired state", { state: "retired" }],
    ["retired timestamp", { linkRetiredAt: now }], ["missing schedule", { scheduleId: null }],
    ["unknown link", { linkId: "link_unknown" }],
  ])("rejects requested pair with mismatched %s", async (_label, mismatch) => {
    rows([existing], [existingLinks[0], { ...existingLinks[1], ...mismatch }]);
    await deny();
    expect(mock.query).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown requested pair even when another alias has the same physical target", async () => {
    const value = timerInput();
    const sources = value.group.sources.map(source => ({ ...source, scheduleId: "schedule_unknown" }));
    rows([existing], existingLinks, []);
    await deny({ ...value, group: { ...value.group, sources }, task: { ...value.task, scheduleId: "schedule_unknown" },
      scheduleVersions: new Map([["schedule_unknown", "0000000000000003"]]) }, "catalog-reference-changed");
  });

  it("rejects missing or duplicate requested rows instead of borrowing an extra historical pair", async () => {
    rows([existing], [existingLinks[0]], [existing], [existingLinks[0], existingLinks[1], existingLinks[1]]);
    await deny();
    await deny();
  });

  it.each([{ retiredAt: now }, { status: "cancelled" }])("cannot revive a retired/cancelled execution %j", async state => {
    rows([{ ...existing, ...state }]);
    await deny(timerInput(), "retired");
  });

  it("rejects an unknown internal replay mode before locks or SQL", async () => {
    await expect(registerSqlCatalogTaskExecutionInTransaction(transaction, input(), {
      replayMode: "unsupported" as "certified-day",
    })).rejects.toThrow("invalid-plan");
    expect(mock.lockDay).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });
});

describe("caller-owned catalog registration transaction", () => {
  const ownedTransaction = { callerOwned: true } as unknown as Parameters<typeof registerSqlCatalogTaskExecutionInTransaction>[0];

  it.each(["population", "physical", "licensing"])("returns the minimum %s deadline without owning transaction lifetime", async earliest => {
    const deadlines = {
      population: new Date(now.valueOf() + (earliest === "population" ? 10_000 : 40_000)),
      physical: new Date(now.valueOf() + (earliest === "physical" ? 10_000 : 50_000)),
      licensing: new Date(now.valueOf() + (earliest === "licensing" ? 10_000 : 60_000)),
    };
    const value = input();
    const revisionId = "catalog-population-v1:00000000-0000-0000-0000-000000000099";
    mock.population.mockResolvedValue(deadlines.population);
    mock.license.mockResolvedValue(deadlines.licensing);
    rows([], [{ collision: false }], licensedRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: deadlines.physical }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result: "registered" }]);
    const result = await registerSqlCatalogTaskExecutionInTransaction(ownedTransaction, {
      ...value, matchKeyVersion: 3, group: { ...value.group, revisionId },
    });
    expect(result).toEqual({ outcome: { status: "registered", taskId: task.id }, validUntil: new Date(now.valueOf() + 10_000) });
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
    expect(mock.lockDay).toHaveBeenCalledExactlyOnceWith(ownedTransaction, task);
    expect(mock.query.mock.calls.every(([, , tx]) => tx === ownedTransaction)).toBe(true);
    expect(mock.insert).toHaveBeenCalledWith(ownedTransaction, expect.anything());
    expect(mock.population).toHaveBeenCalledWith(ownedTransaction, "qa", revisionId);
    expect(mock.license).toHaveBeenCalledWith(ownedTransaction, expect.anything());
    expect(mock.query.mock.calls[8][1].validUntil).toEqual(result.validUntil);
    expect(mock.query.mock.calls[8][0]).toContain("@finalNow>=@validUntil");
    expect(mock.query.mock.calls[8][0]).toContain("@finalNow>=@cutoffAt");
  });

  it("returns an exact replay with null deadline and no fresh writes or nested transaction", async () => {
    rows([existing], existingLinks);
    expect(await registerSqlCatalogTaskExecutionInTransaction(ownedTransaction, input())).toEqual({
      outcome: { status: "existing", taskId: task.id }, validUntil: null,
    });
    expect(mock.lockDay).toHaveBeenCalledExactlyOnceWith(ownedTransaction, task);
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.population).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
  });

  it("throws preflight conflicts for caller rollback instead of returning a conflict outcome", async () => {
    let failure: unknown;
    try {
      await registerSqlCatalogTaskExecutionInTransaction(ownedTransaction, { ...input(), catalogEvidenceByLink: undefined });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(catalogRegistrationConflictReason(failure)).toBe("invalid-plan");
    expect(mock.lockDay).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
  });

  it("does not swallow a provisional-write conflict or independently roll back the caller's transaction", async () => {
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }], [{ linkId: externalLinkId }]);
    let failure: unknown;
    try { await registerSqlCatalogTaskExecutionInTransaction(ownedTransaction, input()); }
    catch (error) { failure = error; }
    expect(catalogRegistrationConflictReason(failure)).toBe("catalog-reference-changed");
    expect(mock.insert).toHaveBeenCalledOnce();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
  });

  it.each(["cutoff-passed", "catalog-reference-changed"])("lets one outer owner roll back all provisional writes on final %s", async result => {
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: cutoffAt }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result }]);
    const continued = vi.fn();
    let failure: unknown;
    try {
      await runSqlTransaction(async tx => {
        await registerSqlCatalogTaskExecutionInTransaction(tx, input());
        continued();
      });
    } catch (error) { failure = error; }
    expect(catalogRegistrationConflictReason(failure)).toBe(result);
    expect(mock.insert).toHaveBeenCalledOnce();
    expect(mock.begin).toHaveBeenCalledOnce();
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
  });

  it("propagates driver errors untouched and does not classify lookalike conflicts", async () => {
    const failure = Object.assign(new Error("driver failed"), { number: 2627 });
    mock.lockDay.mockRejectedValueOnce(failure);
    await expect(registerSqlCatalogTaskExecutionInTransaction(ownedTransaction, input())).rejects.toBe(failure);
    for (const error of [failure, null, undefined, "invalid-plan", { reason: "invalid-plan" },
      Object.assign(new Error("invalid-plan"), { name: "RegistrationConflict", reason: "invalid-plan" })]) {
      expect(catalogRegistrationConflictReason(error)).toBeNull();
    }
    expect(mock.begin).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
  });
});

describe("atomic catalog execution registration", () => {
  it("rejects alternate occurrence IDs for the same business date before taking locks", async () => {
    const valid = input();
    const alternate = "manual-2030-06-22";
    const group = { ...valid.group, occurrenceId: alternate,
      executionKey: catalogTaskExecutionKey(alternate, "database", physicalId) };
    await expect(registerSqlCatalogTaskExecution({ ...valid, group })).resolves.toEqual({ status: "conflict", reason: "invalid-plan" });
    expect(mock.begin).not.toHaveBeenCalled();
  });
  it("locks the execution and every legacy logical target, then writes all origins and an immutable event in one transaction", async () => {
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: cutoffAt }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result: "registered" }]);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "registered", taskId: task.id });
    expect(mock.begin).toHaveBeenCalledOnce();
    expect(mock.commit).toHaveBeenCalledOnce();
    expect(mock.license).not.toHaveBeenCalled();
    expect(mock.rollback).not.toHaveBeenCalled();
    expect(mock.lockDay).toHaveBeenCalledExactlyOnceWith(mock.tx, task);
    expect(mock.lockDay.mock.invocationCallOrder[0]).toBeLessThan(mock.query.mock.invocationCallOrder[0]);
    expect(mock.query.mock.calls.every(([, , transaction]) => transaction === mock.tx)).toBe(true);
    expect(mock.query.mock.calls[0][0]).toContain("UPDLOCK,HOLDLOCK");
    expect(mock.query.mock.calls[0][0]).toContain("WHERE e.execution_key");
    expect(mock.query.mock.calls[1][1].targetIds).toBe('["database1","database2"]');
    expect(mock.query.mock.calls[1][0]).toContain("e.verified_target_id=@physicalId");
    expect(mock.query.mock.calls[2][0]).toContain("s.row_version=TRY_CONVERT(binary(8),ids.expected_version,2)");
    expect(mock.query.mock.calls[2][0]).toContain("scheduling.catalog_schedule_operation_approvals AS approved_operation WITH (HOLDLOCK)");
    expect(mock.query.mock.calls[2][0]).toContain("approved_operation.schedule_version=s.row_version");
    expect(mock.query.mock.calls[2][0]).toContain("approved_operation.retired_at IS NULL");
    expect(mock.query.mock.calls[2][1]).toMatchObject({ portalEnvironment: "qa", operationId: "release1" });
    expect(mock.query.mock.calls[2][0]).toContain("grant_row.permission_key=N'updates.tasks.view'");
    expect(mock.query.mock.calls[2][0]).toContain("task_role.database_task_visibility");
    expect(mock.query.mock.calls[2][1]).toMatchObject({ assignmentKind: "role", targetKind: "database" });
    expect(JSON.parse(mock.query.mock.calls[2][1].schedules)).toEqual([
      { id: "schedule_1", version: "0000000000000001" }, { id: "schedule_2", version: "0000000000000002" },
    ]);
    expect(mock.insert).toHaveBeenCalledExactlyOnceWith(mock.tx, expect.objectContaining({ targetId: "database1", createdBy: "system",
      sources: [{ scheduleId: "schedule_1", scheduleType: "licensing", createdAt: now.toISOString() }] }));
    expect(mock.query.mock.calls[5][0]).toContain("b.portal_environment=@portalEnvironment");
    expect(mock.query.mock.calls[5][0]).toContain("core.catalog_physical_target_links AS pt WITH (UPDLOCK,HOLDLOCK)");
    expect(mock.query.mock.calls[5][0]).toContain("pt.access_profile_version=ap.row_version");
    expect(mock.query.mock.calls[5][0]).toContain("pt.valid_until>@registryNow");
    expect(mock.query.mock.calls[5][0]).toContain("h.attempt_status='succeeded'");
    expect(mock.query.mock.calls[5][0]).toContain("revision.binding_version=b.row_version AND revision.profile_version=p.row_version");
    expect(mock.query.mock.calls[5][0]).toContain("evidence.source_record_id=TRY_CONVERT(int,r.recordId)");
    expect(mock.query.mock.calls[5][0]).toContain("DATALENGTH(r.recordId)");
    expect(mock.query.mock.calls[5][0]).toContain("b.source_role<>'erp-customers' OR evidence.active_code='S'");
    expect(mock.query.mock.calls[5][0]).toContain("WHEN revision.verified_until<pt.valid_until THEN revision.verified_until");
    expect(mock.query.mock.calls[5][1].physicalId).toBe(physicalId);
    expect(mock.query.mock.calls[5][0]).toContain("bridge.revision_key=TRY_CONVERT(bigint,r.revisionId)");
    expect(mock.query.mock.calls[5][0]).toContain("bridge.profile_version=TRY_CONVERT(binary(8),r.profileVersion,2)");
    expect(mock.query.mock.calls[5][0]).toContain("r.catalogSourceId IS NULL AND NOT EXISTS");
    expect(mock.query.mock.calls[5][0]).toContain("externalLink.link_id=TRY_CONVERT(uniqueidentifier,r.linkId)");
    expect(JSON.parse(mock.query.mock.calls[5][1].links)).toEqual([expect.objectContaining({ linkId: externalLinkId, catalogSourceId: sourceId,
      revisionId: "100", bindingVersion: "0000000000000010", profileVersion: "0000000000000020" }),
      expect.objectContaining({ linkId: "link2", catalogSourceId: null })]);
    expect(mock.query.mock.calls[6][1].attachments).toContain('"scheduleId":"schedule_2"');
    expect(mock.query.mock.calls[7][1].origins).toBe('[{"key":"2","origin":"special"}]');
    expect(mock.query.mock.calls[8][0]).toContain("'registered'");
    expect(mock.query.mock.calls[8][0]).toContain("@finalNow>=@validUntil");
    expect(mock.query.mock.calls[8][1].validUntil).toEqual(cutoffAt);
    expect(Buffer.isBuffer(mock.query.mock.calls[8][1].token)).toBe(true);
  });

  it("revalidates only the SQL-persisted licensing attachments and binds the earliest evidence expiry", async () => {
    const expiry = new Date(now.valueOf() + 60_000);
    mock.license.mockResolvedValue(expiry);
    rows([], [{ collision: false }], licensedRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: cutoffAt }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result: "registered" }]);
    await expect(registerSqlCatalogTaskExecution({ ...input(), matchKeyVersion: 3 }))
      .resolves.toEqual({ status: "registered", taskId: task.id });
    expect(mock.license).toHaveBeenCalledExactlyOnceWith(mock.tx, {
      executionId: "2", portalEnvironment: "qa", matchKeyVersion: 3,
      attachments: [{ linkId: externalLinkId, scheduleId: "schedule_1", moduleIds: ["module1"] }],
    });
    expect(mock.query.mock.invocationCallOrder[5]).toBeLessThan(mock.license.mock.invocationCallOrder[0]);
    expect(mock.license.mock.invocationCallOrder[0]).toBeLessThan(mock.query.mock.invocationCallOrder[6]);
    expect(mock.query.mock.calls[8][1].validUntil).toEqual(expiry);
  });

  it("locks an approved population and checks its deadline again at the final registration write", async () => {
    const revisionId = "catalog-population-v1:00000000-0000-0000-0000-000000000099";
    const expiry = new Date(now.valueOf() + 30_000);
    mock.population.mockResolvedValue(expiry);
    const value = input();
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: cutoffAt }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result: "catalog-reference-changed" }]);
    await expect(registerSqlCatalogTaskExecution({ ...value, group: { ...value.group, revisionId } }))
      .resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.population).toHaveBeenCalledExactlyOnceWith(mock.tx, "qa", revisionId);
    expect(mock.query.mock.calls[8][1].validUntil).toEqual(expiry);
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("cannot write when the reviewed population was retired or replaced after planning", async () => {
    const value = input();
    rows([]);
    mock.population.mockResolvedValue(null);
    await expect(registerSqlCatalogTaskExecution({ ...value, group: { ...value.group,
      revisionId: "catalog-population-v1:00000000-0000-0000-0000-000000000099" } }))
      .resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.query).toHaveBeenCalledTimes(1);
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("rolls back all provisional writes when transactional licenses cannot be verified", async () => {
    mock.license.mockResolvedValue(null);
    rows([], [{ collision: false }], licensedRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: cutoffAt }, { linkId: "link2", validUntil: cutoffAt }]);
    await expect(registerSqlCatalogTaskExecution({ ...input(), matchKeyVersion: 3 }))
      .resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.query).toHaveBeenCalledTimes(6);
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it("cannot register a persisted licensing schedule without explicit match-key enrollment input", async () => {
    rows([], [{ collision: false }], licensedRows);
    await expect(registerSqlCatalogTaskExecution(input()))
      .resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.query).toHaveBeenCalledTimes(3);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
  });

  it("does not let a physical alias borrow another schedule's licensed ERP proof", async () => {
    const bothLicensed = [licensedRows[0], { ...licensedRows[1], selectionMode: "licensing" }];
    rows([], [{ collision: false }], bothLicensed);
    await expect(registerSqlCatalogTaskExecution({ ...input(), matchKeyVersion: 3 }))
      .resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.query).toHaveBeenCalledTimes(3);
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.license).not.toHaveBeenCalled();
  });

  it("does not register after a concurrent scope or assignment edit changes a schedule version", async () => {
    rows([], [{ collision: false }], scheduleRows.slice(0, 1));
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("rolls back the task if accepted evidence expires while waiting on later writes", async () => {
    const expiry = new Date(now.valueOf() + 60_000);
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }],
      [{ linkId: externalLinkId, validUntil: expiry }, { linkId: "link2", validUntil: cutoffAt }],
      [{ count: 2 }], [{ count: 1 }], [{ result: "catalog-reference-changed" }]);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.query.mock.calls[8][1].validUntil).toEqual(expiry);
    expect(mock.commit).not.toHaveBeenCalled();
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("returns the exact completed execution on replay without any writes or status changes", async () => {
    rows([existing], existingLinks);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "existing", taskId: task.id });
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("replays a historical operation label exactly but does not use it to create new work", async () => {
    const valid = input();
    const operationId = "Actualización histórica 2026";
    const historical = { ...valid, group: { ...valid.group, operationId,
      sources: valid.group.sources.map(source => ({ ...source, operationId })) } };
    rows([{ ...existing, operationId }], existingLinks, []);
    await expect(registerSqlCatalogTaskExecution(historical)).resolves.toEqual({ status: "existing", taskId: task.id });
    await expect(registerSqlCatalogTaskExecution(historical)).resolves.toEqual({ status: "conflict", reason: "invalid-plan" });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("compares explicit assignees as an exact set on replay, never falling back to the role", async () => {
    const valid = input();
    const assignment = { kind: "users" as const, ids: ["b", "a", "a"] };
    const request = { ...valid, task: { ...valid.task, assignedUserIds: ["a", "b"] },
      group: { ...valid.group, assignment, sources: valid.group.sources.map(source => ({ ...source, assignment })) } };
    rows([{ ...existing, usersJson: '[{"id":"b"},{"id":"a"}]' }], existingLinks);
    await expect(registerSqlCatalogTaskExecution(request)).resolves.toEqual({ status: "existing", taskId: task.id });
    rows([{ ...existing, usersJson: '[{"id":"a"}]' }]);
    await expect(registerSqlCatalogTaskExecution(request)).resolves.toEqual({ status: "conflict", reason: "execution-conflict" });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("does not attach changed origins, reuse a different operation, or reopen retired work", async () => {
    rows([existing], [{ ...existingLinks[0], detachedAt: now }, existingLinks[1]], [{ ...existing, operationId: "other" }],
      [{ ...existing, retiredAt: now }]);
    for (const reason of ["source-set-changed", "execution-conflict", "retired"]) {
      await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason });
    }
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.rollback).toHaveBeenCalledTimes(3);
  });

  it("rejects prior legacy tasks and cutoff expiry without a workflow write", async () => {
    rows([], [{ collision: true }], [], [{ collision: false }], scheduleRows, []);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "legacy-task-collision" });
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "cutoff-passed" });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it("fails before relation locks or writes when a legacy generator holds the date lock", async () => {
    mock.lockDay.mockResolvedValueOnce(false);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "coexistence-lock-unavailable" });
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("rolls back the new task if any logical reference went stale before persistence", async () => {
    rows([], [{ collision: false }], scheduleRows, [{ now }], [{ key: "2" }], [{ linkId: externalLinkId }]);
    await expect(registerSqlCatalogTaskExecution(input())).resolves.toEqual({ status: "conflict", reason: "catalog-reference-changed" });
    expect(mock.insert).toHaveBeenCalledOnce();
    expect(mock.rollback).toHaveBeenCalledOnce();
    expect(mock.commit).not.toHaveBeenCalled();
  });

  it("propagates unexpected duplicate-key errors rather than counting them as idempotency", async () => {
    rows([], [{ collision: false }], scheduleRows, [{ now }]);
    const sqlError = Object.assign(new Error("duplicate from driver"), { number: 2627 });
    mock.insert.mockRejectedValueOnce(sqlError);
    await expect(registerSqlCatalogTaskExecution(input())).rejects.toBe(sqlError);
    expect(mock.rollback).toHaveBeenCalledOnce();
  });

  it("rejects spoofed representatives and absent origin mapping before starting a transaction", async () => {
    const valid = input();
    await expect(registerSqlCatalogTaskExecution({ ...valid, task: { ...valid.task, targetId: physicalId } }))
      .resolves.toEqual({ status: "conflict", reason: "invalid-plan" });
    await expect(registerSqlCatalogTaskExecution({ ...valid, catalogSourceIdsByLink: new Map([[externalLinkId, sourceId]]) }))
      .resolves.toEqual({ status: "conflict", reason: "invalid-plan" });
    await expect(registerSqlCatalogTaskExecution({ ...valid, group: { ...valid.group, assignment: { kind: "unassigned" } } }))
      .resolves.toEqual({ status: "conflict", reason: "workflow-assignment-required" });
    expect(mock.begin).not.toHaveBeenCalled();
  });

  it("rejects an external link without a versioned origin before opening SQL", async () => {
    await expect(registerSqlCatalogTaskExecution({ ...input(), catalogEvidenceByLink: undefined }))
      .resolves.toEqual({ status: "conflict", reason: "invalid-plan" });
    expect(mock.begin).not.toHaveBeenCalled();
  });
});
