import type { CurrentUser, LicenseModuleRecord } from "../types/models";
import { hasAnyRole, hasRole } from "./permissions";

export type LicenseAssignmentInput = {
  targetType?: "client" | "domain" | "database";
  clientId?: string;
  domainId?: string;
  databaseId?: string;
};

export function normalizeLicenseCode(code: string): string {
  return code.trim().toUpperCase();
}

export function normalizeLicenseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function generateLicenseCodeFromName(name: string): string {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "MODULO";
}

export function hasDuplicateLicenseCode(modules: LicenseModuleRecord[], code: string, excludeId?: string): boolean {
  const normalized = normalizeLicenseCode(code);
  return modules.some((module) => {
    if (module.id === excludeId) return false;
    if (module.status === "deleted" || module.deletedAt) return false;
    return normalizeLicenseCode(module.code ?? "") === normalized;
  });
}

export function hasDuplicateLicenseName(modules: LicenseModuleRecord[], name: string, excludeId?: string): boolean {
  const normalized = normalizeLicenseName(name);
  return modules.some((module) => {
    if (module.id === excludeId) return false;
    if (module.status === "deleted" || module.deletedAt) return false;
    return normalizeLicenseName(module.name ?? "") === normalized;
  });
}

export function buildUniqueLicenseCode(modules: LicenseModuleRecord[], baseCode: string, excludeId?: string): string {
  const base = normalizeLicenseCode(baseCode) || "MODULO";
  let candidate = base;
  let suffix = 2;
  while (hasDuplicateLicenseCode(modules, candidate, excludeId)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function validateLicenseAssignmentRequirements(input: LicenseAssignmentInput): string | null {
  if (!input.clientId?.trim()) return "Seleccione un cliente.";
  if ((input.targetType === "domain" || input.targetType === "database") && !input.domainId?.trim()) {
    return "Seleccione un dominio.";
  }
  if (input.targetType === "database" && !input.databaseId?.trim()) {
    return "Seleccione una base de datos.";
  }
  return null;
}

export function canViewLicensing(user: CurrentUser): boolean {
  return hasAnyRole(user, ["admin", "client_manager"]);
}

export function canManageLicenseModules(user: CurrentUser): boolean {
  return hasRole(user, "admin");
}

export function canManageLicenseAssignments(user: CurrentUser): boolean {
  return hasAnyRole(user, ["admin", "client_manager"]);
}
