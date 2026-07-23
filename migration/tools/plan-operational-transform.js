/*
 * Builds a value-free, deterministic plan for transforming a restricted Cosmos
 * snapshot into Portal SAG Web operational SQL tables. This tool never opens a
 * SQL or Blob connection and never prints document values, IDs, emails or hashes.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_CONTAINERS = [
  "users", "clients", "domains", "databases", "updateSchedules", "updateTasks",
  "licenseModules", "licenseAssignments", "auditLogs", "appSettings",
  "emailNotifications", "securityRateLimits", "authSessions", "roles",
  "fuentesFormatos", "formatosImpresion", "publicDownloads",
];

const ROLE_ALIASES = new Map([
  ["admin", "super_admin"],
  ["formatos_impresion.admin", "print_formats_admin"],
  ["client_manager", "client_operations_manager"],
  ["viewer", "audit_viewer"],
  ["public_downloads.admin", "public_downloads_manager"],
]);

const TASK_PERMISSIONS = [
  "updates.tasks.view", "updates.tasks.start", "updates.tasks.complete",
  "updates.tasks.block", "updates.tasks.resolve_block", "updates.tasks.fail",
  "updates.tasks.cancel", "updates.tasks.reopen",
];

const PUBLIC_FILE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".vsd",
  ".vsdx", ".html", ".htm", ".md", ".txt", ".csv", ".url",
  ".mp4", ".m4v", ".mov", ".webm",
]);
const VIDEO_FILE_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

function validVideoSignature(extension, bytes) {
  if (extension === ".webm") return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalRoleId(value) {
  const id = String(value || "").trim();
  return ROLE_ALIASES.get(id) || id;
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-CO");
}

function rootScheduleId(value) {
  return String(value || "").split("__")[0];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function printFormatSourceIds(record) {
  const listed = unique(array(record.fuenteIds).map((value) => String(value || "").trim()).filter(Boolean));
  return listed.length > 0 ? listed : unique([String(record.fuenteId || "").trim()].filter(Boolean));
}

function countUnique(values) {
  return unique(values).length;
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskIdentity(task) {
  return [task.targetType, task.targetId, task.taskDate].join("\u0000");
}

function chooseCanonicalTask(group) {
  return [...group].sort((left, right) => {
    const leftPreferred = left.status === "cancelled" && left.result === "obsolete" ? 0 : 1;
    const rightPreferred = right.status === "cancelled" && right.result === "obsolete" ? 0 : 1;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    const updatedDifference = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    if (updatedDifference) return updatedDifference;
    const createdDifference = timestamp(right.createdAt) - timestamp(left.createdAt);
    if (createdDifference) return createdDifference;
    return String(left.id).localeCompare(String(right.id), "en");
  })[0];
}

function consolidateTasks(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = taskIdentity(task);
    const group = groups.get(key) || [];
    group.push(task);
    groups.set(key, group);
  }

  const logicalTasks = [];
  let aliasCount = 0;
  let assigneeCount = 0;
  let sourceCount = 0;
  let reminderCount = 0;
  let reminderRecipientCount = 0;
  let overdueAlertCount = 0;
  let statusHistoryCount = 0;

  for (const group of groups.values()) {
    const canonical = chooseCanonicalTask(group);
    const aliases = group.filter((task) => task !== canonical);
    aliasCount += aliases.length;
    assigneeCount += countUnique(group.flatMap((task) => array(task.assignedUserIds)));

    const sources = new Set();
    const reminders = new Map();
    const overdueDates = new Set();
    for (const task of group) {
      for (const source of array(task.sources)) {
        if (!source || !source.scheduleId) continue;
        sources.add([source.scheduleId, source.scheduleType || ""].join("\u0000"));
      }
      for (const reminder of array(task.remindersSent)) {
        if (!reminder) continue;
        const key = [reminder.type || "", reminder.daysBefore ?? "", reminder.sentAt || ""].join("\u0000");
        if (!reminders.has(key)) reminders.set(key, new Set());
        for (const recipient of array(reminder.recipients)) reminders.get(key).add(normalizeText(recipient));
      }
      for (const sentDate of array(task.overdueAlertSentDates)) overdueDates.add(sentDate);

      if (task.completedAt) statusHistoryCount += 1;
      if (task.blockedAt) statusHistoryCount += 1;
      if (task.resolvedAt) statusHistoryCount += 1;
      if (task.reopenedAt) statusHistoryCount += 1;
    }

    sourceCount += sources.size;
    reminderCount += reminders.size;
    reminderRecipientCount += [...reminders.values()].reduce((sum, recipients) => sum + recipients.size, 0);
    overdueAlertCount += overdueDates.size;
    statusHistoryCount += 1 + aliases.length; // imported canonical + one inferred row per superseded ID
    logicalTasks.push({ canonical, group });
  }

  return {
    logicalTasks,
    counts: {
      updateTasks: logicalTasks.length,
      taskSourceAliases: aliasCount,
      taskAssignees: assigneeCount,
      taskSources: sourceCount,
      taskReminders: reminderCount,
      taskReminderRecipients: reminderRecipientCount,
      taskOverdueAlerts: overdueAlertCount,
      taskStatusHistory: statusHistoryCount,
    },
  };
}

function decodeStrictBase64(value) {
  const encoded = String(value || "").replace(/\s+/g, "");
  if (!encoded || encoded.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/, "");
  const canonicalOutput = bytes.toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalOutput ? bytes : null;
}

function fileExtension(filename) {
  const clean = String(filename || "").trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index) : "";
}

function validateFilePlan(data) {
  let critical = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const contentHashes = [];

  for (const record of data.formatosImpresion) {
    const bytes = decodeStrictBase64(record.pdfBase64);
    const valid = bytes
      && bytes.length > 0
      && bytes.length <= 1_500_000
      && bytes.subarray(0, 4).toString("utf8") === "%PDF"
      && String(record.pdfMimeType || "").toLowerCase() === "application/pdf"
      && fileExtension(record.pdfNombreOriginal) === ".pdf";
    if (!valid) {
      critical += 1;
      continue;
    }
    fileCount += 1;
    totalBytes += bytes.length;
    contentHashes.push(sha256Hex(bytes));
  }

  for (const record of data.publicDownloads.filter((item) => item.type === "document")) {
    const bytes = decodeStrictBase64(record.archivoBase64);
    const extension = fileExtension(record.archivoNombreOriginal);
    const isVideo = VIDEO_FILE_EXTENSIONS.has(extension);
    const valid = bytes
      && bytes.length > 0
      && bytes.length <= (isVideo ? 100_000_000 : 8_000_000)
      && PUBLIC_FILE_EXTENSIONS.has(extension)
      && (!isVideo || (String(record.archivoMimeType || "").startsWith("video/") && validVideoSignature(extension, bytes)))
      && Number(record.archivoBytes) === bytes.length;
    if (!valid) {
      critical += 1;
      continue;
    }
    fileCount += 1;
    totalBytes += bytes.length;
    contentHashes.push(sha256Hex(bytes));
  }

  return {
    fileCount,
    totalBytes,
    critical,
    duplicateContentCount: contentHashes.length - new Set(contentHashes).size,
  };
}

function readPermissionCatalog(repoRoot) {
  const sql = fs.readFileSync(path.join(repoRoot, "migration", "sql", "007_indexes_constraints_permissions.sql"), "utf8");
  const permissions = new Set();
  const rowPattern = /\(N'([^']+)',\s*N'([^']+)',\s*N'([^']+)',\s*N'[^']*',\s*N'(\[[^\r\n]+\])'\)/g;
  for (const match of sql.matchAll(rowPattern)) {
    const prefix = match[3];
    const actions = JSON.parse(match[4].replace(/''/g, "'"));
    for (const action of actions) permissions.add(`${prefix}.${action.id}`);
  }
  if (permissions.size !== 89) throw new Error(`Permission catalog parser expected 89 keys; found ${permissions.size}.`);
  return permissions;
}

function defaultRoleDefinitions(permissionCatalog) {
  const domainPermissions = new Set(TASK_PERMISSIONS);
  const databasePermissions = new Set([
    ...TASK_PERMISSIONS,
    "updates.tasks.view_database_connection",
    "updates.tasks.copy_database_connection_part",
    "updates.tasks.reveal_database_password",
  ]);
  const printPermissions = new Set([...permissionCatalog].filter((key) => key.startsWith("configuration.print_formats.")));
  return new Map([
    ["super_admin", { permissions: new Set(permissionCatalog), domain: "all", database: "all", system: true, protected: true }],
    ["database_updater", { permissions: databasePermissions, domain: "none", database: "assigned", system: true, protected: false }],
    ["domain_updater", { permissions: domainPermissions, domain: "assigned", database: "none", system: true, protected: false }],
    ["print_formats_admin", { permissions: printPermissions, domain: "none", database: "none", system: true, protected: false }],
  ]);
}

function compatibilityRoleDefinitions(permissionCatalog) {
  return new Map([
    ["client_operations_manager", {
      permissions: new Set([
        ...[...permissionCatalog].filter((key) => key.startsWith("clients.") || key.startsWith("updates.schedules.")),
        "configuration.alerts.send_report", "visibility.audit.view",
      ]), domain: "none", database: "none", system: false, protected: false,
    }],
    ["audit_viewer", { permissions: new Set(["visibility.audit.view"]), domain: "none", database: "none", system: false, protected: false }],
    ["public_downloads_manager", {
      permissions: new Set([...permissionCatalog].filter((key) => key.startsWith("implementation.public_downloads."))),
      domain: "none", database: "none", system: false, protected: false,
    }],
  ]);
}

function collectRoleReferences(data) {
  const refs = [];
  for (const user of data.users) refs.push(...array(user.roles));
  for (const schedule of data.updateSchedules) {
    refs.push(schedule.assignedRole, schedule.domainAssignedRole, schedule.databaseAssignedRole);
  }
  for (const task of data.updateTasks) refs.push(task.assignedRole);
  for (const settings of data.appSettings) {
    refs.push(...array(settings.overdueAlertRecipientRoleIds), ...array(settings.blockedAlertRecipientRoleIds));
  }
  return refs.filter(Boolean);
}

function buildRolePlan(data, permissionCatalog) {
  const roles = defaultRoleDefinitions(permissionCatalog);
  const compatibility = compatibilityRoleDefinitions(permissionCatalog);
  let unknownPermissionCount = 0;
  let aliasUseCount = 0;

  for (const stored of data.roles) {
    const roleId = canonicalRoleId(stored.id);
    if (roleId !== stored.id) aliasUseCount += 1;
    const base = roles.get(roleId);
    const storedPermissions = new Set(array(stored.permissions));
    for (const permission of storedPermissions) if (!permissionCatalog.has(permission)) unknownPermissionCount += 1;
    if (roleId === "super_admin") continue;
    roles.set(roleId, {
      permissions: storedPermissions,
      domain: stored.taskVisibility?.domain || base?.domain || "none",
      database: stored.taskVisibility?.database || base?.database || "none",
      system: base?.system || !!stored.system,
      protected: base?.protected || !!stored.protected,
    });
  }

  const references = collectRoleReferences(data);
  for (const original of references) {
    const canonical = canonicalRoleId(original);
    if (canonical !== original) aliasUseCount += 1;
    if (!roles.has(canonical) && compatibility.has(canonical)) roles.set(canonical, compatibility.get(canonical));
  }

  const missingRoleReferenceCount = references.filter((roleId) => !roles.has(canonicalRoleId(roleId))).length;
  const rolePermissionCount = [...roles.values()].reduce((sum, role) => sum + role.permissions.size, 0);
  const userRoleCount = data.users.reduce((sum, user) => sum + countUnique(array(user.roles).map(canonicalRoleId)), 0);
  const activeUsersWithoutRole = data.users.filter((user) => user.active !== false && countUnique(array(user.roles).map(canonicalRoleId)) === 0).length;

  return {
    roles,
    rolePermissionCount,
    userRoleCount,
    unknownPermissionCount,
    missingRoleReferenceCount,
    activeUsersWithoutRole,
    aliasUseCount,
  };
}

function countScheduleChildren(schedules, maps) {
  const counts = {
    scheduleWeekdays: 0, scheduleTargets: 0, scheduleAssignees: 0,
    scheduleReminderSettings: 0, scheduleReminderDays: 0, scheduleReminderEmails: 0,
    scopeGroups: 0, scopeDomains: 0, scopeDatabases: 0, licensingScope: 0,
    licensingScopeModules: 0, licensingExcludedDomains: 0, licensingExcludedDatabases: 0,
  };
  let missingActiveTarget = 0;
  let missingHistoricalTarget = 0;
  let missingAssignee = 0;
  let missingScopeReference = 0;
  let invalidWeekday = 0;
  const allowedWeekdays = new Set(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);

  for (const schedule of schedules) {
    const weeklyDays = unique(array(schedule.weekdays));
    const preferredDays = unique(array(schedule.preferredWeekdays));
    invalidWeekday += weeklyDays.filter((day) => !allowedWeekdays.has(day)).length;
    invalidWeekday += preferredDays.filter((day) => !allowedWeekdays.has(day)).length;
    counts.scheduleWeekdays += weeklyDays.length + preferredDays.length;
    for (const targetId of unique(array(schedule.targetIds))) {
      const exists = schedule.targetType === "domain" ? maps.domains.has(targetId) : maps.databases.has(targetId);
      if (exists) counts.scheduleTargets += 1;
      else if (schedule.active) missingActiveTarget += 1;
      else missingHistoricalTarget += 1;
    }

    const assigned = [
      ...array(schedule.assignedUserIds).map((id) => `general:${id}`),
      ...array(schedule.databaseAssignedUserIds).map((id) => `database:${id}`),
    ];
    for (const value of unique(assigned)) {
      const userId = value.slice(value.indexOf(":") + 1);
      if (maps.users.has(userId)) counts.scheduleAssignees += 1;
      else missingAssignee += 1;
    }

    if (schedule.reminders) {
      counts.scheduleReminderSettings += 1;
      counts.scheduleReminderDays += countUnique(array(schedule.reminders.reminderDaysBefore));
      counts.scheduleReminderEmails += countUnique(array(schedule.reminders.customReminderEmails).map(normalizeText));
    }

    for (const group of array(schedule.scopeGroups)) {
      counts.scopeGroups += 1;
      const groupClient = maps.clients.get(group.clientId);
      if (!groupClient) missingScopeReference += 1;
      for (const domain of array(group.domains)) {
        counts.scopeDomains += 1;
        const domainRecord = maps.domains.get(domain.domainId);
        if (!domainRecord || domainRecord.clientId !== group.clientId) missingScopeReference += 1;
        for (const databaseId of unique(array(domain.databaseIds))) {
          counts.scopeDatabases += 1;
          const database = maps.databases.get(databaseId);
          if (!database || database.domainId !== domain.domainId || database.clientId !== group.clientId) missingScopeReference += 1;
        }
      }
    }

    if (schedule.licensingScope) {
      counts.licensingScope += 1;
      for (const moduleId of unique(array(schedule.licensingScope.licenseModuleIds))) {
        counts.licensingScopeModules += 1;
        if (!maps.modules.has(moduleId)) missingScopeReference += 1;
      }
      for (const domainId of unique(array(schedule.licensingScope.excludedDomainIds))) {
        counts.licensingExcludedDomains += 1;
        if (!maps.domains.has(domainId)) missingScopeReference += 1;
      }
      for (const databaseId of unique(array(schedule.licensingScope.excludedDatabaseIds))) {
        counts.licensingExcludedDatabases += 1;
        if (!maps.databases.has(databaseId)) missingScopeReference += 1;
      }
    }
  }
  return { counts, missingActiveTarget, missingHistoricalTarget, missingAssignee, missingScopeReference, invalidWeekday };
}

function countLicenseAssignments(data, maps) {
  const candidates = new Map();
  let invalid = 0;
  for (const client of data.clients) {
    for (const moduleId of unique(array(client.licenseModuleIds))) {
      if (!maps.modules.has(moduleId)) { invalid += 1; continue; }
      candidates.set([moduleId, "client", client.id, ""].join("\u0000"), { explicit: false });
    }
  }
  for (const assignment of data.licenseAssignments) {
    const targetType = assignment.targetType || (assignment.databaseId ? "database" : assignment.domainId ? "domain" : "client");
    const targetId = assignment.databaseId || assignment.domainId || assignment.clientId || assignment.targetId;
    const targetExists = targetType === "client" ? maps.clients.has(targetId)
      : targetType === "domain" ? maps.domains.has(targetId)
      : targetType === "database" ? maps.databases.has(targetId) : false;
    if (!maps.modules.has(assignment.moduleId) || !targetExists) { invalid += 1; continue; }
    candidates.set([assignment.moduleId, targetType, targetId, assignment.environment || ""].join("\u0000"), { explicit: true });
  }
  return { count: candidates.size, invalid };
}

function tableCountObject(entries) {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right, "en")));
}

function loadSnapshot(snapshotDirectory) {
  const manifestPath = path.join(snapshotDirectory, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("Snapshot manifest is missing.");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const names = Object.keys(manifest.containers || {}).sort();
  if (names.length !== EXPECTED_CONTAINERS.length || EXPECTED_CONTAINERS.some((name) => !names.includes(name))) {
    throw new Error("Snapshot does not contain the exact 17-container contract.");
  }

  const data = {};
  let total = 0;
  for (const name of EXPECTED_CONTAINERS) {
    const info = manifest.containers[name];
    if (!info || info.status !== "ok") throw new Error(`Container failed manifest validation: ${name}.`);
    const filePath = path.join(snapshotDirectory, info.file || `${name}.json`);
    const bytes = fs.readFileSync(filePath);
    if (sha256Hex(bytes) !== String(info.sha256 || "").toLowerCase()) throw new Error(`Container checksum mismatch: ${name}.`);
    const documents = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(documents) || documents.length !== Number(info.count)) throw new Error(`Container count mismatch: ${name}.`);
    data[name] = documents;
    total += documents.length;
  }
  return { manifest, data, total, manifestBytes };
}

function buildPlan(snapshotDirectory, repoRoot = path.resolve(__dirname, "..", "..")) {
  const { manifest, data, total } = loadSnapshot(snapshotDirectory);
  const permissionCatalog = readPermissionCatalog(repoRoot);
  const rolePlan = buildRolePlan(data, permissionCatalog);
  const maps = {
    users: new Map(data.users.map((item) => [item.id, item])),
    clients: new Map(data.clients.map((item) => [item.id, item])),
    domains: new Map(data.domains.map((item) => [item.id, item])),
    databases: new Map(data.databases.map((item) => [item.id, item])),
    schedules: new Map(data.updateSchedules.map((item) => [item.id, item])),
    modules: new Map(data.licenseModules.map((item) => [item.id, item])),
  };
  const taskPlan = consolidateTasks(data.updateTasks);
  const schedulePlan = countScheduleChildren(data.updateSchedules, maps);
  const licensePlan = countLicenseAssignments(data, maps);
  const filePlan = validateFilePlan(data);

  const domainAssignees = data.domains.reduce((sum, item) => sum + countUnique(array(item.assignedUpdaterIds).filter((id) => maps.users.has(id))), 0);
  const databaseAssignees = data.databases.reduce((sum, item) => sum + countUnique(array(item.assignedUpdaterIds).filter((id) => maps.users.has(id))), 0);
  const missingMasterAssignees = data.domains.concat(data.databases).reduce(
    (sum, item) => sum + array(item.assignedUpdaterIds).filter((id) => !maps.users.has(id)).length, 0
  );
  const missingTaskAssignees = data.updateTasks.reduce(
    (sum, item) => sum + array(item.assignedUserIds).filter((id) => !maps.users.has(id)).length, 0
  );

  let historicalOrphanLogicalTasks = 0;
  let activeOrphanLogicalTasks = 0;
  for (const { canonical } of taskPlan.logicalTasks) {
    const domain = maps.domains.get(canonical.domainId);
    const target = canonical.targetType === "domain" ? maps.domains.get(canonical.targetId) : maps.databases.get(canonical.targetId);
    const hierarchyMismatch = canonical.targetType === "database" && target && target.domainId !== canonical.domainId;
    const orphan = !maps.clients.has(canonical.clientId) || !domain || !target || hierarchyMismatch;
    if (!orphan) continue;
    if (["completed", "cancelled"].includes(canonical.status)) historicalOrphanLogicalTasks += 1;
    else activeOrphanLogicalTasks += 1;
  }

  const settings = data.appSettings[0] || {};
  const publicSections = data.publicDownloads.filter((item) => item.type === "section");
  const publicDocuments = data.publicDownloads.filter((item) => item.type === "document");
  const unknownPublicTypes = data.publicDownloads.length - publicSections.length - publicDocuments.length;
  const notificationRecipients = data.emailNotifications.reduce(
    (sum, item) => sum + countUnique(array(item.recipients).map(normalizeText)), 0
  );
  const printFormatSourceAssignments = data.formatosImpresion.reduce(
    (sum, item) => sum + printFormatSourceIds(item).length, 0
  );
  const invalidPrintFormatSourceContract = data.formatosImpresion.filter((item) => {
    const rawIds = array(item.fuenteIds).map((value) => String(value || "").trim()).filter(Boolean);
    const resolved = printFormatSourceIds(item);
    return resolved.length === 0 || resolved.length > 50
      || rawIds.length !== new Set(rawIds).size
      || (rawIds.length > 0 && rawIds[0] !== String(item.fuenteId || "").trim());
  }).length;
  const missingPrintFormatSourceReferences = data.formatosImpresion.reduce(
    (sum, item) => sum + printFormatSourceIds(item).filter((id) => !new Set(data.fuentesFormatos.map((source) => source.id)).has(id)).length,
    0
  );
  const activePrintFormatSourceNames = data.formatosImpresion
    .filter((item) => item.status !== "deleted")
    .flatMap((item) => printFormatSourceIds(item).map((sourceId) => `${sourceId}\u0000${normalizeText(item.nombre)}`));
  const duplicatePrintFormatNamesPerSource = activePrintFormatSourceNames.length - new Set(activePrintFormatSourceNames).size;

  const businessReportPath = path.join(snapshotDirectory, "business-validation.json");
  const businessReport = fs.existsSync(businessReportPath) ? JSON.parse(fs.readFileSync(businessReportPath, "utf8")) : null;
  const knownWarningCount = businessReport?.warningCount ?? 0;
  const businessCriticalCount = businessReport?.criticalErrorCount ?? 0;

  const criticalChecks = [
    ["BUSINESS_PREFLIGHT", businessCriticalCount],
    ["ROLE_UNKNOWN_PERMISSION", rolePlan.unknownPermissionCount],
    ["ROLE_MISSING_REFERENCE", rolePlan.missingRoleReferenceCount],
    ["INVALID_LICENSE_ASSIGNMENT", licensePlan.invalid],
    ["ACTIVE_SCHEDULE_TARGET_MISSING", schedulePlan.missingActiveTarget],
    ["SCHEDULE_SCOPE_REFERENCE_MISSING", schedulePlan.missingScopeReference],
    ["SCHEDULE_WEEKDAY_INVALID", schedulePlan.invalidWeekday],
    ["ACTIVE_TASK_ORPHAN_AFTER_CONSOLIDATION", activeOrphanLogicalTasks],
    ["UNKNOWN_PUBLIC_DOWNLOAD_TYPE", unknownPublicTypes],
    ["INVALID_FILE_PAYLOAD", filePlan.critical],
    ["INVALID_PRINT_FORMAT_SOURCE_CONTRACT", invalidPrintFormatSourceContract],
    ["PRINT_FORMAT_SOURCE_REFERENCE_MISSING", missingPrintFormatSourceReferences],
    ["DUPLICATE_PRINT_FORMAT_NAME_PER_SOURCE", duplicatePrintFormatNamesPerSource],
  ];
  const criticalIssueCount = criticalChecks.reduce((sum, [, count]) => sum + count, 0);

  const tables = tableCountObject([
    ["audit.audit_logs", data.auditLogs.length],
    ["content.files", filePlan.fileCount],
    ["content.print_format_files", data.formatosImpresion.length],
    ["content.print_format_source_assignments", printFormatSourceAssignments],
    ["content.print_format_sources", data.fuentesFormatos.length],
    ["content.print_formats", data.formatosImpresion.length],
    ["content.public_download_documents", publicDocuments.length],
    ["content.public_download_files", publicDocuments.length],
    ["content.public_download_sections", publicSections.length],
    ["core.clients", data.clients.length],
    ["core.database_access_profiles", data.databases.length],
    ["core.database_assignees", databaseAssignees],
    ["core.databases", data.databases.length],
    ["core.domain_assignees", domainAssignees],
    ["core.domains", data.domains.length],
    ["core.environments", 3],
    ["licensing.license_assignments", licensePlan.count],
    ["licensing.license_modules", data.licenseModules.length],
    ["notifications.email_notification_recipients", notificationRecipients],
    ["notifications.email_notifications", data.emailNotifications.length],
    ["scheduling.licensing_excluded_databases", schedulePlan.counts.licensingExcludedDatabases],
    ["scheduling.licensing_excluded_domains", schedulePlan.counts.licensingExcludedDomains],
    ["scheduling.licensing_scope", schedulePlan.counts.licensingScope],
    ["scheduling.licensing_scope_modules", schedulePlan.counts.licensingScopeModules],
    ["scheduling.schedule_assignees", schedulePlan.counts.scheduleAssignees],
    ["scheduling.schedule_reminder_days", schedulePlan.counts.scheduleReminderDays],
    ["scheduling.schedule_reminder_emails", schedulePlan.counts.scheduleReminderEmails],
    ["scheduling.schedule_reminder_settings", schedulePlan.counts.scheduleReminderSettings],
    ["scheduling.schedule_targets", schedulePlan.counts.scheduleTargets],
    ["scheduling.schedule_weekdays", schedulePlan.counts.scheduleWeekdays],
    ["scheduling.scope_databases", schedulePlan.counts.scopeDatabases],
    ["scheduling.scope_domains", schedulePlan.counts.scopeDomains],
    ["scheduling.scope_groups", schedulePlan.counts.scopeGroups],
    ["scheduling.update_schedules", data.updateSchedules.length],
    ["security.auth_sessions", 0],
    ["security.permissions", permissionCatalog.size],
    ["security.rate_limits", 0],
    ["security.role_permissions", rolePlan.rolePermissionCount],
    ["security.roles", rolePlan.roles.size],
    ["security.user_roles", rolePlan.userRoleCount],
    ["security.users", data.users.length],
    ["settings.administrative_reminder_recipients", array(settings.administrativeReminders?.sagWebVersionReminder?.recipients).length + array(settings.administrativeReminders?.whatsNewReminder?.recipients).length],
    ["settings.administrative_reminders", settings.administrativeReminders ? 2 : 0],
    ["settings.alert_recipient_emails", countUnique([...array(settings.overdueAlertCustomEmails).map(normalizeText), ...array(settings.blockedAlertCustomEmails).map((email) => `blocked:${normalizeText(email)}`), ...array(settings.customAdminAlertEmails).map((email) => `legacy:${normalizeText(email)}`)])],
    ["settings.alert_recipient_roles", countUnique([...array(settings.overdueAlertRecipientRoleIds).map(canonicalRoleId), ...array(settings.blockedAlertRecipientRoleIds).map((role) => `blocked:${canonicalRoleId(role)}`)])],
    ["settings.blocked_reminder_days", countUnique(array(settings.blockedReminderDaysAfter))],
    ["settings.default_reminder_days", countUnique(array(settings.defaultReminderDaysBefore))],
    ["settings.email_settings", data.appSettings.length],
    ["settings.overdue_alert_weekdays", countUnique(array(settings.overdueAlertWeekdays))],
    ["workflow.task_assignees", taskPlan.counts.taskAssignees],
    ["workflow.task_overdue_alerts", taskPlan.counts.taskOverdueAlerts],
    ["workflow.task_reminder_recipients", taskPlan.counts.taskReminderRecipients],
    ["workflow.task_reminders", taskPlan.counts.taskReminders],
    ["workflow.task_source_aliases", taskPlan.counts.taskSourceAliases],
    ["workflow.task_sources", taskPlan.counts.taskSources],
    ["workflow.task_status_history", taskPlan.counts.taskStatusHistory],
    ["workflow.update_tasks", taskPlan.counts.updateTasks],
  ]);

  return {
    planVersion: 1,
    sourceExportedAt: manifest.exportedAt || manifest.generatedAt || null,
    sourceContainerCount: EXPECTED_CONTAINERS.length,
    sourceDocumentCount: total,
    operationalTableCounts: tables,
    operationalExclusions: {
      authSessions: data.authSessions.length,
      securityRateLimits: data.securityRateLimits.length,
      resolvedSecretValues: 0,
      base64ValuesStoredInSql: 0,
    },
    deterministicDecisions: {
      taskDuplicateGroups: data.updateTasks.length - taskPlan.counts.updateTasks,
      taskAliases: taskPlan.counts.taskSourceAliases,
      historicalOrphanLogicalTasks,
      roleAliasUses: rolePlan.aliasUseCount,
      activeUsersWithDenyAllRoleSet: rolePlan.activeUsersWithoutRole,
      filesPlannedForPrivateBlob: filePlan.fileCount,
      fileBytesPlannedForPrivateBlob: filePlan.totalBytes,
      duplicateFilePayloads: filePlan.duplicateContentCount,
      knownSourceWarnings: knownWarningCount,
    },
    checks: {
      critical: Object.fromEntries(criticalChecks),
      warning: {
        KNOWN_SOURCE_WARNINGS: knownWarningCount,
        HISTORICAL_SCHEDULE_TARGET_MISSING: schedulePlan.missingHistoricalTarget,
        HISTORICAL_TASK_ORPHAN_AFTER_CONSOLIDATION: historicalOrphanLogicalTasks,
        MISSING_ASSIGNEE_REFERENCE: missingMasterAssignees + missingTaskAssignees + schedulePlan.missingAssignee,
      },
    },
    criticalIssueCount,
    readyForNonProductionOperationalTransform: criticalIssueCount === 0,
    safety: {
      sqlConnectionOpened: false,
      blobConnectionOpened: false,
      documentValuesEmitted: false,
    },
  };
}

function main() {
  const snapshotDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (!snapshotDirectory) {
    process.stderr.write("Usage: node migration/tools/plan-operational-transform.js <snapshot-directory> [output.json]\n");
    process.exit(1);
  }
  try {
    const plan = buildPlan(snapshotDirectory);
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "w", mode: 0o600 });
    }
    process.stdout.write(
      `Operational transform plan: ${plan.sourceContainerCount} containers; ${plan.sourceDocumentCount} documents; `
      + `${plan.operationalTableCounts["workflow.update_tasks"]} logical tasks; `
      + `${plan.operationalTableCounts["workflow.task_source_aliases"]} task aliases; `
      + `${plan.operationalTableCounts["content.files"]} files; ${plan.criticalIssueCount} critical transformation issues.\n`
    );
    process.stdout.write(`Known deterministic source warnings retained for approval: ${plan.deterministicDecisions.knownSourceWarnings}.\n`);
    process.stdout.write("No SQL or Blob connection was opened and no document values were emitted.\n");
    if (outputPath) process.stdout.write(`Value-free plan written: ${outputPath}\n`);
    if (plan.criticalIssueCount > 0) process.exit(2);
  } catch (error) {
    process.stderr.write(`Operational transform planning failed: ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  buildPlan,
  canonicalRoleId,
  chooseCanonicalTask,
  consolidateTasks,
  decodeStrictBase64,
  rootScheduleId,
  validateFilePlan,
};
