import { describe, expect, it } from "vitest";
import {
  buildClientMutationValues,
  isSqlUniqueConstraintError,
  planClientLicenseReconciliation,
} from "../lib/clientsSqlWriteRepository";

describe("Clients SQL write contract", () => {
  it("normalizes mutable values and keeps deletion metadata consistent", () => {
    const active = buildClientMutationValues({
      name: "  Cliente   Ejemplo  ", externalId: "  EXT  100  ", notes: "  Nota  ", status: "active",
    }, "user-1", new Date("2026-07-22T20:00:00.000Z"));
    expect(active).toEqual({
      name: "Cliente Ejemplo", nameNormalized: "cliente ejemplo", externalId: "EXT 100",
      notes: "Nota", status: "active", updatedBy: "user-1",
      updatedAt: new Date("2026-07-22T20:00:00.000Z"), deletedAt: null, deletedBy: null,
    });

    const deleted = buildClientMutationValues({ name: "Cliente", status: "deleted" }, "user-2",
      new Date("2026-07-22T20:01:00.000Z"));
    expect(deleted.deletedBy).toBe("user-2");
    expect(deleted.deletedAt?.toISOString()).toBe("2026-07-22T20:01:00.000Z");
  });

  it("reconciles client licenses and permits an inactive module only when already assigned", () => {
    const plan = planClientLicenseReconciliation(
      [{ id: "module-old", name: "Anterior" }, { id: "module-keep", name: "Conservar" }],
      [
        { id: "module-keep", name: "Conservar", status: "inactive" },
        { id: "module-new", name: "Nueva", status: "active" },
      ],
    );
    expect(plan).toEqual({
      ids: ["module-keep", "module-new"], names: ["Conservar", "Nueva"],
      added: ["module-new"], removed: ["module-old"], retained: ["module-keep"],
    });
    expect(() => planClientLicenseReconciliation([], [
      { id: "module-inactive", name: "Inactiva", status: "inactive" },
    ])).toThrow(/activas/);
  });

  it("recognizes SQL unique-index violations without exposing provider messages", () => {
    expect(isSqlUniqueConstraintError({ number: 2601 })).toBe(true);
    expect(isSqlUniqueConstraintError({ originalError: { info: { number: 2627 } } })).toBe(true);
    expect(isSqlUniqueConstraintError({ number: 547 })).toBe(false);
  });
});
