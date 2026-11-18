import { findSqlUserByEmail, findSqlUserById } from "./securityManagementSqlWriteRepository";
import { canSendConfiguredReport } from "./managementAccess";
import { loadRoleDefinitions } from "./roleDefinitionStore";
import { readAuthorizedCatalogSourceIds } from "./catalogSourceAccessSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

const maxRecipients = 25;
const maxSources = 50;
const sourceId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validActor = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 150 && value === value.trim() && !/\p{C}/u.test(value);
const isEnvironment = (value: unknown): value is CatalogEnvironment => value === "qa" || value === "production";
const emailCode = (value: string) => value.trim().toLowerCase();

export type CatalogMastersReportScope = Readonly<{
  senderId: string;
  environment: CatalogEnvironment;
  sourceIds: readonly string[];
  recipientIds: readonly string[];
}>;

export function catalogMastersReportsEnabled(): boolean {
  return process.env.PORTAL_CATALOG_MASTERS_REPORT_ENABLED?.trim() === "true";
}

export function catalogMastersReportEnvironment(): CatalogEnvironment | null {
  if (process.env.PORTAL_CATALOG_READ_ENABLED?.trim() !== "true") return null;
  const value = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  return isEnvironment(value) ? value : null;
}

function validSources(value: readonly unknown[]): value is readonly string[] {
  return value.length > 0 && value.length <= maxSources && value.every(id => typeof id === "string" && sourceId.test(id))
    && new Set(value).size === value.length;
}

function parseScope(value: unknown): CatalogMastersReportScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4) return null;
  const { senderId, environment, sourceIds, recipientIds } = value as Partial<CatalogMastersReportScope>;
  if (!validActor(senderId) || !isEnvironment(environment) || !Array.isArray(sourceIds) || !validSources(sourceIds)
    || !Array.isArray(recipientIds) || !recipientIds.length || recipientIds.length > maxRecipients
    || !recipientIds.every(validActor) || new Set(recipientIds).size !== recipientIds.length) return null;
  return { senderId, environment, sourceIds, recipientIds };
}

/** All principals must have the configured-report action plus at least one shared active ERP source. */
export async function resolveCatalogMastersReportScope(senderId: string, recipients: readonly string[],
  environment: CatalogEnvironment): Promise<CatalogMastersReportScope | null> {
  if (!validActor(senderId) || !isEnvironment(environment) || !recipients.length || recipients.length > maxRecipients
    || recipients.some(email => typeof email !== "string" || !emailCode(email))) return null;
  const normalized = recipients.map(emailCode);
  if (new Set(normalized).size !== normalized.length) return null;
  try {
    const roles = await loadRoleDefinitions();
    const sender = await findSqlUserById(senderId);
    if (!sender || sender.id !== senderId || sender.active !== true || !canSendConfiguredReport(sender, roles)) return null;
    const recipientIds: string[] = [];
    for (const email of normalized) {
      const user = await findSqlUserByEmail(email);
      if (!user || !validActor(user.id) || user.active !== true || emailCode(user.email) !== email ||
          !canSendConfiguredReport(user, roles)) return null;
      recipientIds.push(user.id);
    }
    if (new Set(recipientIds).size !== normalized.length) return null;
    let shared: string[] | undefined;
    // Sequential, bounded SQL lookups, once for each distinct principal.
    for (const actorId of new Set([senderId, ...recipientIds])) {
      const allowed = [...await readAuthorizedCatalogSourceIds({ actorId, environment })];
      if (!validSources(allowed)) return null;
      const current = new Set(allowed);
      shared = shared ? shared.filter(source => current.has(source)) : allowed;
      if (!shared.length) return null;
    }
    return shared?.length ? { senderId, environment, sourceIds: shared.sort(), recipientIds: recipientIds.sort() } : null;
  } catch { return null; }
}

/** A queued report is immutable: a revoked source or transferred email must block it, not shrink it. */
export async function mayDeliverCatalogMastersReport(metadata: unknown, recipients: readonly string[],
  environment: CatalogEnvironment | null): Promise<boolean> {
  const pinned = parseScope(metadata);
  if (!pinned || pinned.environment !== environment) return false;
  const current = await resolveCatalogMastersReportScope(pinned.senderId, recipients, pinned.environment);
  if (!current || current.recipientIds.length !== pinned.recipientIds.length) return false;
  const currentRecipients = new Set(current.recipientIds), currentSources = new Set(current.sourceIds);
  return pinned.recipientIds.every(id => currentRecipients.has(id)) && pinned.sourceIds.every(id => currentSources.has(id));
}

/** Recheck at generation and delivery. A mixed/unknown group is rejected as a whole. */
export async function mayReceiveCatalogActiveUsersReport(recipients: readonly string[]): Promise<boolean> {
  if (!recipients.length || recipients.length > maxRecipients) return false;
  try {
    const roles = await loadRoleDefinitions();
    // Sequential, capped SQL lookups; user-controlled addresses never cause fan-out.
    for (const email of recipients) {
      const user = await findSqlUserByEmail(email);
      if (!user || user.active !== true || !canSendConfiguredReport(user, roles)) return false;
    }
    return true;
  } catch { return false; }
}
