import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMocks = vi.hoisted(() => {
  const request = {
    input: vi.fn(),
    query: vi.fn(),
  };
  request.input.mockReturnValue(request);
  return { request };
});

vi.mock("../lib/sql", () => ({
  getSqlPool: vi.fn(async () => ({
    request: () => sqlMocks.request,
  })),
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (read: (tx: unknown) => unknown) => read({ request: () => sqlMocks.request }) }));

import { mapSqlSchedule, readSqlCatalogScheduleRoster, readSqlSchedules } from "../lib/schedulingSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Scheduling SQL mapping", () => {
  beforeEach(() => {
    sqlMocks.request.input.mockClear();
    sqlMocks.request.query.mockReset();
    sqlMocks.request.query.mockResolvedValue({ recordset: [] });
    vi.stubEnv("PORTAL_CATALOG_SCHEDULE_LIFECYCLE_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("excludes soft-deleted schedules from every operational list query", async () => {
    await readSqlSchedules({}, { enabled: false, page: 1, pageSize: 50 }, "2026-07-23");

    expect(sqlMocks.request.query).toHaveBeenCalledOnce();
    expect(sqlMocks.request.query.mock.calls[0][0]).toMatch(
      /WHERE\s+s\.deleted_at\s+IS\s+NULL/i,
    );
    expect(sqlMocks.request.query.mock.calls[0][0]).not.toContain("version_hex");
  });

  it("loads candidate schedules for one day with an exact SQL Server 2019 version without legacy truncation", async () => {
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).resolves.toEqual([]);
    expect(sqlMocks.request.query.mock.calls[0][0]).toContain("COL_LENGTH");
    const query = sqlMocks.request.query.mock.calls[1][0];
    expect(query).toContain("CONVERT(binary(8),s.row_version)");
    expect(query).toContain("s.active=1 AND s.start_date<=CONVERT(date,@today,23)");
    expect(query).toContain("TOP (@catalogTake)");
    expect(query).not.toContain("workflow.update_tasks");
    expect(query).not.toContain("catalog_schedule_activation_snapshots");
    expect(sqlMocks.request.input).toHaveBeenCalledWith("catalogTake", expect.anything(), 5001);
  });

  it("keeps registered lifecycle schedules held when the lifecycle flag is rolled back", async () => {
    const version = "0000000000000001";
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ installed: true }] })
      .mockResolvedValueOnce({ recordset: [{ source_id: "registered", created_at: at, updated_at: at,
        version_hex: version, activation_enabled: true }] });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).resolves.toMatchObject([{ version, activation: null }]);
    const query = sqlMocks.request.query.mock.calls[1][0];
    expect(query).toContain("s.catalog_activation_enabled AS activation_enabled");
    expect(query).not.toContain("catalog_schedule_activation_snapshots");
  });

  it("reads internal frozen scope only with lifecycle enabled and does not put it in the public list SQL", async () => {
    vi.stubEnv("PORTAL_CATALOG_SCHEDULE_LIFECYCLE_ENABLED", "true");
    const version = "0000000000000001";
    const snapshot = { version, phase: "frozen", environment: "qa", targets: [{ kind: "database",
      linkId: "31140f4d-81c3-4938-9ab2-a275473feb17", targetId: "31140f4d-81c3-4938-9ab2-a275473feb18" }],
      principals: [{ kind: "database", principalKind: "user", id: "frozen-user" }] };
    const row = { source_id: "programmed", created_at: at, updated_at: at, version_hex: version, activation_enabled: true };
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ ...row, activation_snapshot: JSON.stringify(snapshot) }] });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).resolves.toMatchObject([{ version, activation: snapshot }]);
    expect(sqlMocks.request.query.mock.calls[0][0]).toContain("t.evidence_state='eligible'");
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ ...row, activation_snapshot: null }] });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).resolves.toMatchObject([{ version, activation: null }]);
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ ...row,
      activation_snapshot: JSON.stringify({ ...snapshot, version: "0000000000000002" }) }] });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).rejects.toThrow("roster_activation_invalid");
    await readSqlSchedules({}, { enabled: false, page: 1, pageSize: 50 }, "2026-07-23");
    expect(sqlMocks.request.query.mock.lastCall?.[0]).not.toContain("catalog_schedule_activation_snapshots");
  });

  it("refuses invalid dates, incomplete rosters and malformed schedule versions", async () => {
    await expect(readSqlCatalogScheduleRoster("2026-02-30")).rejects.toThrow("schedule_date");
    expect(sqlMocks.request.query).not.toHaveBeenCalled();
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ installed: false }] })
      .mockResolvedValueOnce({ recordset: Array(5001).fill({}) });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).rejects.toThrow("roster_limit");
    sqlMocks.request.query.mockResolvedValueOnce({ recordset: [{ installed: false }] })
      .mockResolvedValueOnce({ recordset: [{ version_hex: "not-hex" }] });
    await expect(readSqlCatalogScheduleRoster("2026-07-23")).rejects.toThrow("roster_invalid");
  });

  it("reconstructs normalized schedule scope, reminders, licensing and shared-task summary", () => {
    const schedule = mapSqlSchedule({
      schedule_key: 1,
      source_id: "schedule-1",
      client_source_id: "client-1",
      client_name: "Cliente Uno",
      domain_source_id: "domain-1",
      domain_name: "https://example.test",
      name: "Actualización semanal",
      target_type: "database",
      frequency_type: "weekly",
      every_n_weeks: 2,
      interval_days: null,
      day_of_month: null,
      start_date: "2026-07-01",
      end_date: null,
      timezone: "America/Bogota",
      assigned_role: "database_updater",
      domain_assigned_role: "domain_updater",
      database_assigned_role: "database_updater",
      database_reminder_recipients_mode: "assignedUsers",
      selection_mode: "licensing",
      manual_target_types: null,
      assignment_mode: "users",
      origin: "special",
      active: true,
      completed_at: null,
      completed_reason: null,
      notes: "Ventana nocturna",
      created_at: at,
      created_by: "user-1",
      updated_at: at,
      updated_by: "user-1",
      target_ids_json: '[{"id":"database-1"}]',
      weekdays_json: '[{"weekday":1},{"weekday":5}]',
      preferred_weekdays_json: '[{"weekday":2}]',
      general_assignees_json: '[{"id":"user-1"}]',
      database_assignees_json: '[{"id":"user-2"}]',
      reminders_json: '{"remindersEnabled":true,"reminderTime":"08:30","reminderRecipientsMode":"customEmails","reminderDaysBefore":[{"value":0},{"value":2}],"customReminderEmails":[{"value":"ops@example.test"}]}',
      scope_groups_json: '[{"clientId":"client-1","includeAllDomains":false,"domains":[{"domainId":"domain-1","includeAllDatabases":false,"databaseIds":[{"id":"database-1"}]}]}]',
      licensing_scope_json: '{"licenseMatchMode":"all","environment":null,"targetTypes":"databases_only","activeOnly":true,"licenseModuleIds":[{"id":"module-1"}],"excludedDomainIds":[{"id":"domain-2"}],"excludedDatabaseIds":[{"id":"database-2"}]}',
      proximas: 3,
      vencidas: 1,
      con_error: 2,
      completadas: 4,
      total_count: 1,
    });

    expect(schedule).toMatchObject({
      id: "schedule-1",
      targetIds: ["database-1"],
      weekdays: ["MONDAY", "FRIDAY"],
      preferredWeekdays: ["TUESDAY"],
      assignedUserIds: ["user-1"],
      databaseAssignedUserIds: ["user-2"],
      reminders: {
        reminderTime: "08:30",
        reminderDaysBefore: [0, 2],
        customReminderEmails: ["ops@example.test"],
      },
      scopeGroups: [{ domains: [{ databaseIds: ["database-1"] }] }],
      licensingScope: {
        environment: "all",
        licenseModuleIds: ["module-1"],
        excludedDomainIds: ["domain-2"],
        excludedDatabaseIds: ["database-2"],
      },
      summary: { proximas: 3, vencidas: 1, conError: 2, completadas: 4, requiereAtencion: true },
    });
  });

  it("fails closed to empty normalized collections when optional JSON is absent", () => {
    const schedule = mapSqlSchedule({
      schedule_key: 2, source_id: "schedule-2", client_source_id: "client-1", client_name: "Cliente",
      domain_source_id: null, domain_name: null, name: "Única", target_type: "domain", frequency_type: "once",
      every_n_weeks: null, interval_days: null, day_of_month: null, start_date: "2026-07-21", end_date: null,
      timezone: "America/Bogota", assigned_role: "domain_updater", domain_assigned_role: null,
      database_assigned_role: null, database_reminder_recipients_mode: null, selection_mode: "manual",
      manual_target_types: "domains_only", assignment_mode: "role", origin: null, active: true,
      completed_at: null, completed_reason: null, notes: null, created_at: at, created_by: "migration",
      updated_at: at, updated_by: "migration", target_ids_json: null, weekdays_json: null,
      preferred_weekdays_json: null, general_assignees_json: null, database_assignees_json: null,
      reminders_json: null, scope_groups_json: null, licensing_scope_json: null,
      proximas: null, vencidas: null, con_error: null, completadas: null, total_count: 1,
    });

    expect(schedule.targetIds).toEqual([]);
    expect(schedule.assignedUserIds).toEqual([]);
    expect(schedule.reminders).toBeUndefined();
    expect(schedule.licensingScope).toBeUndefined();
    expect(schedule.summary.requiereAtencion).toBe(false);
  });
});
