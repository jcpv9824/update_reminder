import { describe, expect, it, vi } from "vitest";
import { activateApprovedSameDayCatalogCopyInTransaction } from "../lib/catalogScheduleCopyActivation";
import { buildCatalogCopyDefinition, materializeApprovedCatalogCopyProposal, saveApprovedCatalogCopy } from "../lib/catalogScheduleSaveCopy";

const date = "2030-06-22";
const born = new Date(`${date}T16:00:00.000Z`);
const approvedAt = new Date(born.valueOf() + 20);
const cutoff = new Date("2030-06-23T05:00:00.000Z");
const intentId = "e2702961-b2cd-4dbc-adde-c7d85684f17b";
const linkId = "69e53908-9221-455b-91b3-a2f950df4c70";
const targetId = "cf647381-8764-4b0c-af3d-c7e2b91ba062";
const operationId = "actualizacion-certificada";
const actor = "actor";
const version = "0000000000000007";
const copyId = `catalog-copy-${intentId}`;
const selected = [{ kind: "database", state: "ready", linkId, targetId }] as const;
const day = { date, cutoffAt: cutoff, checkedAt: born, portalEnvironment: "qa", revision: { id: "certified", complete: true },
  previewOrigin: { scheduleId: "original", scheduleVersion: version, operationId }, previewActorId: actor,
  inventory: [{ link: { kind: "database", linkId, customerId: "cliente", domainId: "dominio", databaseId: "base", environment: "test",
    state: "active", catalogRecordId: "1", target: { status: "unverifiable" }, moduleIds: [] }, sourceId: "authorized-source",
    sourceEvidence: { sourceId: "authorized-source", revisionId: "1", bindingVersion: version, profileVersion: version, verifiedUntil: cutoff.toISOString() },
    clientName: "Cliente", domainName: "test.example.test", targetName: "Base" }],
  rules: [{ scope: { kind: "database", linkIds: [linkId] }, calendar: { id: "original", startDate: date, frequencyType: "once", timezone: "America/Bogota", version },
    assignment: { kind: "users", ids: ["operator-1"] }, workflowRole: "database_updater", operationId }],
} satisfies Parameters<typeof buildCatalogCopyDefinition>[0]["day"];

function setup() {
  const record = buildCatalogCopyDefinition({ day, intentId, selected, proofValidUntil: cutoff,
    original: {} as Parameters<typeof buildCatalogCopyDefinition>[0]["original"], tightenDeadline: vi.fn() }, "Nueva copia", actor, born);
  const query = vi.fn().mockResolvedValueOnce({ recordset: [{ version, createdAt: born, approvedAt }] }).mockResolvedValue({ recordset: [{ count: 1 }] });
  const request = { input: vi.fn(() => request), query };
  const tx = { request: () => request } as unknown as Parameters<typeof activateApprovedSameDayCatalogCopyInTransaction>[0];
  const approve = vi.fn().mockResolvedValue(new Map([[copyId, { scheduleVersion: version, operationId }]]));
  const write = vi.fn<NonNullable<Parameters<typeof activateApprovedSameDayCatalogCopyInTransaction>[2]>["write"]>()
    .mockImplementation(async (_tx, _scope, proof) => {
      await proof({ scheduleKey: "42", asOf: approvedAt, sqlNow: new Date(approvedAt.getTime() + 1) });
      return "frozen";
    });
  return { tx, record, approve, write, query, input: { record, definitionVersion: version, intentId, day, selected, expectedOperationId: operationId,
    certifiedAt: born, proofValidUntil: cutoff } };
}

describe("activation of a separately approved same-day copy", () => {
  it("revalidates stored proposal pins before asking the independent authority for the copy's own version", async () => {
    const { tx } = setup();
    const sqlClock = { request: () => ({ query: async () => ({ recordset: [{ now: born }] }) }) } as typeof tx;
    const req = { actorId: actor, allowedKinds: ["database"] as const, allowLicensing: false, scheduleId: "original", date,
      portalEnvironment: "qa" as const, matchKeyVersion: 1, checkedAt: born, proposalId: intentId };
    const requester = { id: actor, email: "operator@example.test" };
    const independent = "reviewer-1";
    const authorized = vi.fn();
    const readProposal = vi.fn().mockResolvedValue({ proposalId: intentId, requesterId: actor, environment: "qa",
      scheduleId: "original", scheduleVersion: version, operationId, date, name: "Nombre guardado",
      links: [{ linkId, kind: "database", physicalId: targetId }] });
    const io = { verify: vi.fn(), fresh: vi.fn(async (_req, use) => use(sqlClock, { day },
      { candidates: selected }, cutoff, vi.fn())), readProposal,
      insert: vi.fn(async (_tx, intent, record, _actor, finalize) => {
        await finalize(sqlClock, record, intent, version, cutoff);
        return { status: "created" as const, id: record.id };
      }), activate: vi.fn(), readApproval: vi.fn() };
    await expect(materializeApprovedCatalogCopyProposal(req, requester, independent, authorized, io))
      .resolves.toEqual({ status: "created", id: copyId });
    expect(io.insert.mock.calls[0][2]).toMatchObject({ name: "Nombre guardado", createdBy: actor });
    expect(authorized).toHaveBeenCalledExactlyOnceWith(sqlClock, expect.objectContaining({ approverId: independent,
      copyId, copyVersion: version, proposalId: intentId, operationId }));
    expect(io.activate).toHaveBeenCalledExactlyOnceWith(sqlClock, expect.objectContaining({ definitionVersion: version, selected }));
    readProposal.mockResolvedValueOnce({ ...await readProposal(), links: [{ linkId, kind: "database", physicalId: "new-physical" }] });
    await expect(materializeApprovedCatalogCopyProposal(req, requester, independent, authorized, io))
      .rejects.toMatchObject({ status: 409 });
    expect(io.insert).toHaveBeenCalledTimes(1);
    expect(() => materializeApprovedCatalogCopyProposal(req, requester, actor, authorized, io)).toThrow();
  });
  it("persists a separately approved future copy without freezing before Bogotá midnight", async () => {
    const sqlNow = new Date("2030-06-21T16:00:00Z");
    const tx = { request: () => ({ query: async () => ({ recordset: [{ now: sqlNow }] }) }) };
    const tightenDeadline = vi.fn();
    const selection = { day, intentId, selected, tightenDeadline, proofValidUntil: cutoff };
    const io = { verify: vi.fn(async (_req, use) => use(tx, selection)),
      insert: vi.fn(async (_tx, intent, record, _actor, finalize) => {
        await finalize(tx, record, intent, version, cutoff);
        return { status: "created" as const, id: record.id };
      }), activate: vi.fn(), readApproval: vi.fn().mockResolvedValue(new Map([[copyId, { scheduleVersion: version, operationId }]])) };
    const approve = vi.fn();
    const request = { actorId: actor, allowedKinds: ["database"] as const, allowLicensing: false, scheduleId: "original", date,
      portalEnvironment: "qa" as const, matchKeyVersion: 1, checkedAt: sqlNow, previewId: "fixture", linkIds: [linkId], name: "Copia" };
    await expect(saveApprovedCatalogCopy(request, { id: actor, email: "operator@example.test" }, approve, false, io))
      .resolves.toEqual({ status: "created", id: copyId });
    expect(approve).toHaveBeenCalledWith(tx, expect.objectContaining({ copyId, originalId: "original", operationId }));
    expect(tightenDeadline).toHaveBeenCalledWith(cutoff);
    expect(io.activate).not.toHaveBeenCalled();
    io.readApproval.mockResolvedValueOnce(new Map());
    await expect(saveApprovedCatalogCopy(request, { id: actor, email: "operator@example.test" }, approve, false, io))
      .rejects.toMatchObject({ status: 409 });
  });

  it("uses its own exact SQL approval instant, selected DB and frozen assignee", async () => {
    const { tx, approve, write, input, record } = setup();
    expect(record).toMatchObject({ id: copyId, targetType: "database", manualTargetTypes: "databases_only", targetIds: [],
      databaseAssignedUserIds: ["operator-1"], startDate: date });
    expect(record).not.toHaveProperty("reminders");
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, input, { approve, write })).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledExactlyOnceWith(tx, "qa", [{ scheduleId: copyId, scheduleVersion: version }]);
    const proof = await write.mock.calls[0][2]({ scheduleKey: "42", asOf: approvedAt, sqlNow: approvedAt });
    expect(proof.evidence).toMatchObject({ observedAt: approvedAt.getTime(), targets: [{ linkId, state: "eligible" }] });
    expect(proof.responsibles).toEqual([{ targetKind: "database", principalKind: "user", principalId: "operator-1" }]);
  });

  it("cannot use the original approval or change the approved operation", async () => {
    const { tx, approve, write, input, query } = setup();
    approve.mockResolvedValueOnce(new Map([["original", { scheduleVersion: version, operationId }]]));
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, input, { approve, write })).rejects.toMatchObject({ status: 409 });
    query.mockResolvedValueOnce({ recordset: [{ version, createdAt: born, approvedAt }] });
    approve.mockResolvedValueOnce(new Map([[copyId, { scheduleVersion: version, operationId: "another-operation" }]]));
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, input, { approve, write })).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
  });

  it("cannot take the cut from a backdated or next-day approval", async () => {
    for (const invalidApproval of [new Date(born.valueOf()-1), cutoff]) {
      const { tx, approve, write, input, query } = setup();
      query.mockReset().mockResolvedValue({ recordset: [{ version, createdAt: born, approvedAt: invalidApproval }] });
      await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, input, { approve, write })).rejects.toMatchObject({ status: 409 });
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the assigned role no longer passes the current scheduling gate", async () => {
    const { tx, approve, write, input, query } = setup();
    query.mockResolvedValueOnce({ recordset: [{ count: 0 }] });
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, input, { approve, write })).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects an expired proof or changed responsible before writing the snapshot", async () => {
    const { tx, approve, write, input, record } = setup();
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, { ...input, proofValidUntil: born }, { approve, write }))
      .rejects.toMatchObject({ status: 409 });
    await expect(activateApprovedSameDayCatalogCopyInTransaction(tx, { ...input, record: { ...record, databaseAssignedUserIds: ["other-user"] } },
      { approve, write })).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
  });
});
