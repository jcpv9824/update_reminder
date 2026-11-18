import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateTask } from "../types/models";

const mock = vi.hoisted(() => ({ query: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), insert: vi.fn(), lockDay: vi.fn(), license: vi.fn(), tx: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    parameters: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    query(query: string) { return mock.query(query, this.parameters, this.tx); }
  },
  NVarChar: vi.fn(), VarChar: vi.fn(), VarBinary: vi.fn(), DateTime2: vi.fn(), Date: Symbol(), BigInt: Symbol(), MAX: Symbol(),
} }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (fn: (tx: object) => Promise<unknown>) => {
  mock.begin();
  try { const result = await fn(mock.tx); mock.commit(); return result; }
  catch (error) { mock.rollback(); throw error; }
} }));
vi.mock("../lib/workflowTaskGenerationSqlRepository", () => ({ insertSqlGeneratedTaskInTransaction: mock.insert }));
vi.mock("../lib/catalogExecutionCoexistenceSql", () => ({ lockCatalogTaskDay: mock.lockDay }));
vi.mock("../lib/catalogExecutionLicenseSqlProof", () => ({ revalidateSqlCatalogExecutionLicenses: mock.license }));

import { registerSqlCatalogTaskExecution, type CatalogExecutionRegistration } from "../lib/catalogExecutionRegistrationSqlRepository";
import { catalogTaskExecutionKey } from "../lib/catalogTaskTargetPlanning";

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
const existing = { executionId: "2", taskId: task.id, operationId: "release1", occurrenceId, targetId: physicalId, kind: "database",
  status: "completed", taskDate: task.taskDate, cutoffAt, retiredAt: null, representativeTarget: task.targetId, representativeClient: task.clientId,
  representativeDomain: task.domainId, primaryScheduleId: "schedule_1", assignedRole: task.assignedRole, usersJson: "[]" };
const existingLinks = [1, 2].map(n => ({ linkId: linkId(n), clientId: `customer${n}`, domainId: `domain${n}`, databaseId: `database${n}`,
  catalogSourceId: n === 1 ? sourceId : null, recordId: `record${n}`, environment: "production", scheduleId: `schedule_${n}`,
  detachedAt: null, state: "active" }));
const rows = (...response: object[][]) => {
  for (const recordset of response) mock.query.mockResolvedValueOnce({ recordset });
};

beforeEach(() => { vi.resetAllMocks(); mock.insert.mockResolvedValue(17); mock.lockDay.mockResolvedValue(true); });

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
