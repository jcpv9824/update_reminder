import { getContainer } from "./cosmos";
import type { UserRecord } from "../types/models";

import { isValidEmail } from "./inputValidation";

export function parseSemicolonEmails(value: string): { emails: string[]; invalid: string[] } {
  const parts = String(value ?? "").split(";").map((e) => e.trim()).filter(Boolean);
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const email of parts) {
    if (isValidEmail(email)) emails.push(email);
    else invalid.push(email);
  }
  return { emails, invalid };
}

export function uniqueEmails(emails: string[]): string[] {
  return Array.from(
    new Set(
      emails
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .filter((e) => isValidEmail(e))
    )
  );
}

export async function resolveEmailsByRoles(roleIds: string[] = []): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const clauses = roleIds.map((_, i) => `ARRAY_CONTAINS(c.roles, @r${i})`).join(" OR ");
  const parameters = roleIds.map((role, i) => ({ name: `@r${i}`, value: role }));
  const { resources } = await getContainer("users")
    .items.query<UserRecord>({ query: `SELECT * FROM c WHERE c.active = true AND (${clauses})`, parameters })
    .fetchAll();
  return resources.map((u) => u.email).filter(Boolean);
}

export async function resolveConfiguredRecipients(roleIds: string[] = [], customEmails: string[] = []): Promise<string[]> {
  const byRole = await resolveEmailsByRoles(roleIds);
  return uniqueEmails([...byRole, ...customEmails]);
}
