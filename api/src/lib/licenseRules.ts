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

export function hasDuplicateLicenseCode(modules: LicenseModuleRecord[], code: string, excludeId?: string): boolean {
  const normalized = normalizeLicenseCode(code);
  return modules.some((module) => {
    if (module.id === excludeId) return false;
    if (module.status === "deleted" || module.deletedAt) return false;
    return normalizeLicenseCode(module.code ?? "") === normalized;
  });
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
