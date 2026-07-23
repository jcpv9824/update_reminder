import { describe, expect, it } from "vitest";
import { buildDomainMutationValues, planDomainAssigneeReconciliation } from "../lib/domainsSqlWriteRepository";

describe("Domains SQL write contract", () => {
  it("normalizes HTTPS domains and deletion metadata", () => {
    const values = buildDomainMutationValues({
      domainName: "  HTTPS://Portal.Example.Test/// ", environment: "production",
      currentWebVersion: " 16.2 ", notes: "  Nota ", status: "active",
    }, "user-1", new Date("2026-07-22T21:00:00.000Z"));
    expect(values).toEqual({
      domainName: "HTTPS://Portal.Example.Test///", domainNameNormalized: "https://portal.example.test",
      publishableDomain: "HTTPS://Portal.Example.Test///", environment: "production",
      currentWebVersion: "16.2", notes: "Nota", status: "active", updatedBy: "user-1",
      updatedAt: new Date("2026-07-22T21:00:00.000Z"), deletedAt: null, deletedBy: null,
    });
  });

  it("keeps an inactive existing assignee but rejects a new inactive user", () => {
    expect(planDomainAssigneeReconciliation(
      ["user-keep", "user-remove"],
      [{ id: "user-keep", active: false }, { id: "user-new", active: true }],
    )).toEqual({
      ids: ["user-keep", "user-new"], added: ["user-new"],
      removed: ["user-remove"], retained: ["user-keep"],
    });
    expect(() => planDomainAssigneeReconciliation([], [{ id: "inactive", active: false }]))
      .toThrow(/activos/);
  });
});
