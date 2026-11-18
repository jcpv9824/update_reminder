import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogOneTimeScheduleObservation } from "../lib/catalogScheduleDay";
import type { CatalogScheduleDayTransactionContext } from "../lib/catalogScheduleDayTransaction";

const mock = vi.hoisted(() => ({ execute: vi.fn(), tx: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    parameters: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    execute(procedure: string) { return mock.execute(procedure, this.tx, this.parameters); }
  },
  VarChar: vi.fn(), Date: Symbol(), DateTime2: vi.fn(), UniqueIdentifier: Symbol(), NVarChar: vi.fn(), MAX: Symbol(),
} }));

import { recordSqlCatalogOnceObservationsInTransaction } from "../lib/catalogOnceObservationSqlRepository";
type Context = CatalogScheduleDayTransactionContext;
type Observation = CatalogOneTimeScheduleObservation;
const tx = mock.tx as Parameters<typeof recordSqlCatalogOnceObservationsInTransaction>[0];
const date = "2030-05-22";
const cutoff = new Date("2030-05-23T05:00:00Z");
const later = new Date("2030-05-23T06:00:00Z");
const populationId = "00000000-0000-0000-0000-000000000099";
const revisionId = `catalog-population-v1:${populationId}`;
const context: Context = { date, cutoffAt: cutoff, revisionId, scope: {
  date, portalEnvironment: "qa", links: [], checkedAt: new Date("2030-05-22T07:00:00Z"),
}, roster: new Map([["once-a", "0000000000000001"], ["once-b", "0000000000000002"]]), manualIntents: new Map() };
const positive: Observation = { scheduleId: "once-a", scheduleVersion: "0000000000000001", operationId: "release:1", pairs: [
  { linkId: "00000000-0000-0000-0000-000000000011", executionKey: "a".repeat(64) },
  { linkId: "00000000-0000-0000-0000-000000000012", executionKey: "a".repeat(64) },
] };
const blocked: Observation = { scheduleId: "once-b", scheduleVersion: "0000000000000002", operationId: "release:1", pairs: null };
beforeEach(() => mock.execute.mockReset());

describe("persisting exact one-time catalog observations", () => {
  it("uses the caller's transaction and one parameterized call; does not cap the recorded expiry at cutoff", async () => {
    mock.execute.mockResolvedValue({ recordset: [{ accepted: 2 }] });
    const untrustedExtraField = { ...positive, exampleSecret: "not part of the contract" };
    await recordSqlCatalogOnceObservationsInTransaction(tx, context, [untrustedExtraField, blocked], later);
    expect(mock.execute).toHaveBeenCalledExactlyOnceWith("scheduling.record_catalog_once_observations", tx, {
      portalEnvironment: "qa", taskDate: date, cutoffAt: cutoff, validUntil: later, populationId,
      observations: JSON.stringify([positive, blocked]),
    });
  });

  it.each([
    { ...positive, pairs: [] },
    { ...positive, pairs: [{ ...positive.pairs![0], linkId: "not-a-canonical-uuid" }] },
    { ...positive, pairs: [{ ...positive.pairs![0], executionKey: "a".repeat(63) }] },
    { ...positive, pairs: [positive.pairs![0], positive.pairs![0]] },
    { ...positive, scheduleVersion: "0000000000000003" },
    { ...positive, operationId: "release:*" },
  ])("rejects malformed/stale metadata or pairs before SQL", async candidate => {
    await expect(recordSqlCatalogOnceObservationsInTransaction(tx, context, [candidate], later))
      .rejects.toThrow("catalog_once_observation_invalid");
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...context, revisionId: "unreviewed" },
    { ...context, cutoffAt: new Date(cutoff.valueOf() - 1) },
    { ...context, scope: { ...context.scope, date: "2030-05-23" } },
  ])("rejects a noncanonical occurrence fence before SQL", async candidate => {
    await expect(recordSqlCatalogOnceObservationsInTransaction(tx, candidate, [positive], later))
      .rejects.toThrow("catalog_once_observation_invalid");
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate schedule observations", async () => {
    await expect(recordSqlCatalogOnceObservationsInTransaction(tx, context, [positive, positive], later))
      .rejects.toThrow("catalog_once_observation_invalid");
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it.each([{ recordset: [] }, { recordset: [{ accepted: 1 }] }, { recordset: [{ accepted: 2 }, { accepted: 2 }] }])(
    "rejects incomplete or ambiguous acknowledgment so the outer transaction rolls back", async ({ recordset }) => {
      mock.execute.mockResolvedValue({ recordset });
      await expect(recordSqlCatalogOnceObservationsInTransaction(tx, context, [positive, blocked], later))
        .rejects.toThrow("catalog_once_observation_not_recorded");
    });
});
