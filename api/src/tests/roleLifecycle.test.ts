import { describe, expect, it } from "vitest";
import { roleUsageSummary } from "../lib/roleLifecycle";

describe("role lifecycle", () => {
  it("identifies users, active schedules, and open tasks that still reference a role", () => {
    const usage = roleUsageSummary("legacy_role", [
      { id: "u1", roles: ["legacy_role"] },
      { id: "u2", roles: ["other_role"] },
    ], [
      { id: "schedule_active", active: true, assignedRole: "legacy_role" },
      { id: "schedule_inactive", active: false, domainAssignedRole: "legacy_role" },
    ], [
      { id: "task_open", status: "pending", assignedRole: "legacy_role" },
      { id: "task_closed", status: "completed", assignedRole: "legacy_role" },
    ]);

    expect(usage).toEqual({ users: 1, activeSchedules: 1, openTasks: 1, hasReferences: true });
  });

  it("does not block a role that is only present in historical inactive records", () => {
    const usage = roleUsageSummary("legacy_role", [], [
      { id: "schedule_inactive", active: false, assignedRole: "legacy_role" },
    ], [
      { id: "task_completed", status: "completed", assignedRole: "legacy_role" },
    ]);

    expect(usage).toEqual({ users: 0, activeSchedules: 0, openTasks: 0, hasReferences: false });
  });
});
