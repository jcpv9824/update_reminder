import { getContainer } from "./cosmos";
import type { UserRecord } from "../types/models";

import { isValidEmail } from "./inputValidation";
import { getDataBackend } from "./dataBackend";
import { readSqlPublicUsers } from "./securityUsersSqlRepository";

const RECIPIENT_ROLE_ALIASES: Record<string, string[]> = {
  admin: ["super_admin"],
  super_admin: ["admin"],
  "formatos_impresion.admin": ["print_formats_admin"],
  print_formats_admin: ["formatos_impresion.admin"],
};

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
  const effectiveRoleIds = Array.from(new Set(
    roleIds.flatMap((role) => [role, ...(RECIPIENT_ROLE_ALIASES[role] ?? [])])
  ));
  if (effectiveRoleIds.length === 0) return [];
  if (getDataBackend() === "sql") {
    const result = await readSqlPublicUsers({ enabled: false, page: 1, pageSize: 500 });
    const users = Array.isArray(result) ? result : result.items;
    return users.filter((user) => user.active && user.roles.some((role) => effectiveRoleIds.includes(role)))
      .map((user) => user.email).filter(Boolean);
  }
  const clauses = effectiveRoleIds.map((_, i) => `ARRAY_CONTAINS(c.roles, @r${i})`).join(" OR ");
  const parameters = effectiveRoleIds.map((role, i) => ({ name: `@r${i}`, value: role }));
  const { resources } = await getContainer("users")
    .items.query<UserRecord>({ query: `SELECT * FROM c WHERE c.active = true AND (${clauses})`, parameters })
    .fetchAll();
  return resources.map((u) => u.email).filter(Boolean);
}

export async function resolveConfiguredRecipients(roleIds: string[] = [], customEmails: string[] = []): Promise<string[]> {
  const byRole = await resolveEmailsByRoles(roleIds);
  return uniqueEmails([...byRole, ...customEmails]);
}
