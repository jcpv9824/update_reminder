/* Synthetic, value-free regression tests for the operational transform planner. */
const assert = require("node:assert/strict");
const {
  canonicalRoleId,
  chooseCanonicalTask,
  consolidateTasks,
  decodeStrictBase64,
  rootScheduleId,
  validateFilePlan,
} = require("./plan-operational-transform");

assert.equal(canonicalRoleId("admin"), "super_admin");
assert.equal(canonicalRoleId("formatos_impresion.admin"), "print_formats_admin");
assert.equal(canonicalRoleId("custom_role"), "custom_role");
assert.equal(rootScheduleId("schedule_one__db_database_one"), "schedule_one");

const obsolete = {
  id: "old", targetType: "domain", targetId: "target", taskDate: "2026-01-01",
  status: "cancelled", result: "obsolete", updatedAt: "2026-02-01T00:00:00Z",
  assignedUserIds: ["user_a"], sources: [{ scheduleId: "schedule_a", scheduleType: "normal" }],
  remindersSent: [], overdueAlertSentDates: [],
};
const current = {
  id: "current", targetType: "domain", targetId: "target", taskDate: "2026-01-01",
  status: "pending", result: null, updatedAt: "2026-01-01T00:00:00Z",
  assignedUserIds: ["user_a", "user_b"], sources: [{ scheduleId: "schedule_b", scheduleType: "special" }],
  remindersSent: [{ type: "before", daysBefore: 1, sentAt: "2025-12-31T12:00:00Z", recipients: ["Test@Example.com"] }],
  overdueAlertSentDates: ["2026-01-02"],
};
assert.equal(chooseCanonicalTask([obsolete, current]).id, "current");
const taskPlan = consolidateTasks([obsolete, current]);
assert.equal(taskPlan.counts.updateTasks, 1);
assert.equal(taskPlan.counts.taskSourceAliases, 1);
assert.equal(taskPlan.counts.taskAssignees, 2);
assert.equal(taskPlan.counts.taskSources, 2);
assert.equal(taskPlan.counts.taskReminders, 1);
assert.equal(taskPlan.counts.taskReminderRecipients, 1);
assert.equal(taskPlan.counts.taskOverdueAlerts, 1);
assert.equal(taskPlan.counts.taskStatusHistory, 2);

const pdf = Buffer.from("%PDF-synthetic-test", "utf8");
assert.deepEqual(decodeStrictBase64(pdf.toString("base64")), pdf);
assert.equal(decodeStrictBase64("not base64"), null);
const files = validateFilePlan({
  formatosImpresion: [{ pdfBase64: pdf.toString("base64"), pdfMimeType: "application/pdf", pdfNombreOriginal: "test.pdf" }],
  publicDownloads: [{
    type: "document", archivoBase64: Buffer.from("hello").toString("base64"),
    archivoNombreOriginal: "test.txt", archivoBytes: 5,
  }],
});
assert.equal(files.critical, 0);
assert.equal(files.fileCount, 2);

process.stdout.write("Operational transform planner synthetic tests passed.\n");
