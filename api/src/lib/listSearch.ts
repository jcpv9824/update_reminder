import type { DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule } from "../types/models";

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function containsAny(search: string | null | undefined, values: unknown[]): boolean {
  const normalized = normalize(search);
  if (!normalized) return true;
  return values.some((value) => normalize(value).includes(normalized));
}

export function matchesDomainSearch(domain: DomainRecord, search: string | null | undefined): boolean {
  return containsAny(search, [
    domain.clientName,
    domain.domainName,
    domain.environment,
    domain.status,
    domain.notes,
  ]);
}

export function matchesDatabaseSearch(database: DatabaseRecord, search: string | null | undefined): boolean {
  return containsAny(search, [
    database.clientName,
    database.domainName,
    database.companyName,
    database.dbAccess?.initialCatalog,
    database.dbAccess?.serverHostPort,
    database.environment,
    database.status,
    database.notes,
  ]);
}

export function matchesLicenseModuleSearch(module: LicenseModuleRecord, search: string | null | undefined): boolean {
  return containsAny(search, [
    module.name,
    module.code,
    module.description,
    module.status,
  ]);
}

export function matchesScheduleSearch(
  schedule: UpdateSchedule,
  search: string | null | undefined,
  modulesById: Map<string, LicenseModuleRecord> = new Map(),
): boolean {
  const licenseTerms = schedule.licensingScope?.licenseModuleIds.flatMap((id) => {
    const module = modulesById.get(id);
    return [module?.name, module?.code];
  }) ?? [];
  const activeLabel = schedule.active ? "activo" : "inactivo";
  const targetLabel = schedule.targetType === "database" ? "base de datos" : "dominio";
  const modeLabel = schedule.selectionMode === "licensing" ? "licenciamiento" : "manual";

  return containsAny(search, [
    schedule.clientName,
    schedule.domainName,
    targetLabel,
    modeLabel,
    schedule.frequencyType,
    schedule.assignedRole,
    schedule.domainAssignedRole,
    schedule.databaseAssignedRole,
    schedule.active,
    activeLabel,
    (schedule as { status?: string }).status,
    schedule.notes,
    ...licenseTerms,
  ]);
}
