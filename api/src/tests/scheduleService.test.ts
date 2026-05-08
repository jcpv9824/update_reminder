import { describe, it, expect } from "vitest";
import { buildScheduleRecord, validateFrequency } from "../lib/scheduleService";

const user = { id: "u1", email: "u@x", displayName: "U", roles: ["admin"] };

describe("validateFrequency", () => {
  it("valida frecuencia semanal con días", () => {
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", assignedRole: "domain_updater" })).not.toThrow();
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: [], startDate: "2026-05-01", assignedRole: "x" } as any)).toThrow(/al menos un día/i);
  });
  it("rechaza intervalo sin días", () => {
    expect(() => validateFrequency({ frequencyType: "interval", intervalDays: 0, startDate: "2026-05-01", assignedRole: "x" })).toThrow();
    expect(() => validateFrequency({ frequencyType: "interval", intervalDays: 15, startDate: "2026-05-01", assignedRole: "x" })).not.toThrow();
  });
  it("rechaza fecha inválida", () => {
    expect(() => validateFrequency({ frequencyType: "manual", startDate: "no", assignedRole: "x" })).toThrow();
  });

  it("permite frecuencia sin rol manual y valida fecha de fin opcional", () => {
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", endDate: "2026-05-31" })).not.toThrow();
    expect(() => validateFrequency({ frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-31", endDate: "2026-05-01" })).toThrow(/fecha de fin/i);
  });
});

describe("buildScheduleRecord", () => {
  it("construye una frecuencia tipo dominio asociada al dominio recién creado", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01", assignedRole: "domain_updater" },
      clientId: "c1", clientName: "C",
      domainId: "d1", domainName: "x.com",
      targetType: "domain", targetIds: ["d1"],
      currentUser: user,
    });
    expect(r.targetType).toBe("domain");
    expect(r.targetIds).toEqual(["d1"]);
    expect(r.id).toMatch(/^schedule_/);
    expect(r.assignedRole).toBe("domain_updater");
  });

  it("infiere el rol responsable según el tipo de objetivo", () => {
    const r = buildScheduleRecord({
      input: { frequencyType: "weekly", weekdays: ["FRIDAY"], startDate: "2026-05-01" },
      clientId: "c1", clientName: "C",
      domainId: "d1", domainName: "x.com",
      targetType: "database", targetIds: ["db1"],
      currentUser: user,
    });
    expect(r.assignedRole).toBe("database_updater");
    expect(r.endDate).toBeNull();
  });
});
