import { z } from "zod";
import type { CurrentUser } from "../types/models";
import {
  DEFAULT_ROLE_DEFINITIONS,
  allPermissionKeys,
  type RoleDefinition,
  type TaskVisibility,
} from "./permissionModel";

export type RoleDefinitionRecord = RoleDefinition & {
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

const TaskVisibilityLevelSchema = z.enum(["none", "assigned", "all"]);

const RoleDefinitionPayloadSchema = z.object({
  id: z.string().trim().min(3).max(80).regex(/^[a-z0-9_.-]+$/, "El ID del rol solo puede contener minúsculas, números, guiones, puntos y guiones bajos.").optional(),
  name: z.string().trim().min(1, "El nombre del rol es obligatorio.").max(100),
  permissions: z.array(z.string()).default([]),
  taskVisibility: z.object({
    domain: TaskVisibilityLevelSchema,
    database: TaskVisibilityLevelSchema,
  }).default({ domain: "none", database: "none" }),
  active: z.boolean().default(true),
});

export type RoleDefinitionPayload = z.infer<typeof RoleDefinitionPayloadSchema>;

export function parseRoleDefinitionPayload(input: unknown): RoleDefinitionPayload {
  const parsed = RoleDefinitionPayloadSchema.parse(input);
  const allowed = new Set(allPermissionKeys());
  const unknown = parsed.permissions.find((permission) => !allowed.has(permission));
  if (unknown) throw new Error(`Permiso no reconocido: ${unknown}`);

  return {
    ...parsed,
    permissions: Array.from(new Set(parsed.permissions)),
  };
}

export function validateAssignableRoleIds(roleIds: string[], availableRoles: RoleDefinition[]): string | null {
  for (const roleId of roleIds) {
    const role = availableRoles.find((item) => item.id === roleId);
    if (!role) return `El rol ${roleId} no existe.`;
    if (role.active === false) return `El rol ${role.name} está inactivo y no se puede asignar.`;
  }
  return null;
}

export function slugifyRoleId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function createRoleDefinitionRecord(input: unknown, actor: CurrentUser, now: string): RoleDefinitionRecord {
  const parsed = parseRoleDefinitionPayload(input);
  const id = parsed.id ?? slugifyRoleId(parsed.name);
  if (!id) throw new Error("El ID del rol no pudo generarse.");

  return protectRoleDefinition({
    id,
    name: parsed.name,
    permissions: parsed.permissions,
    taskVisibility: parsed.taskVisibility,
    system: false,
    active: parsed.active,
    createdAt: now,
    createdBy: actor.id,
    updatedAt: now,
    updatedBy: actor.id,
  });
}

export function updateRoleDefinitionRecord(
  existing: RoleDefinition | RoleDefinitionRecord,
  input: unknown,
  actor: CurrentUser,
  now: string
): RoleDefinitionRecord {
  const parsed = parseRoleDefinitionPayload(input);
  const previous = toRecord(existing, actor.id, now);

  return protectRoleDefinition({
    ...previous,
    name: parsed.name,
    permissions: parsed.permissions,
    taskVisibility: parsed.taskVisibility,
    active: parsed.active,
    updatedAt: now,
    updatedBy: actor.id,
  });
}

export function mergeRoleDefinitions(storedRoles: Array<Partial<RoleDefinitionRecord> & RoleDefinition> = []): RoleDefinitionRecord[] {
  const merged = new Map<string, RoleDefinitionRecord>();
  const now = new Date(0).toISOString();

  for (const role of DEFAULT_ROLE_DEFINITIONS) {
    merged.set(role.id, protectRoleDefinition(toRecord(role, "system", now)));
  }

  for (const stored of storedRoles) {
    const base = merged.get(stored.id);
    const record = toRecord({
      ...(base ?? {}),
      ...stored,
      system: base?.system ?? stored.system ?? false,
      protected: base?.protected ?? stored.protected,
    }, stored.updatedBy ?? "system", stored.updatedAt ?? now);
    merged.set(stored.id, protectRoleDefinition(record));
  }

  const defaultIds = DEFAULT_ROLE_DEFINITIONS.map((role) => role.id);
  const defaults = defaultIds.map((id) => merged.get(id)!).filter(Boolean);
  const custom = Array.from(merged.values())
    .filter((role) => !defaultIds.includes(role.id))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  return [...defaults, ...custom];
}

function toRecord(role: RoleDefinition | Partial<RoleDefinitionRecord> & RoleDefinition, actorId: string, now: string): RoleDefinitionRecord {
  return {
    id: role.id,
    name: role.name,
    permissions: [...role.permissions],
    taskVisibility: normalizeTaskVisibility(role.taskVisibility),
    system: role.system,
    protected: role.protected,
    active: "active" in role && typeof role.active === "boolean" ? role.active : true,
    createdAt: "createdAt" in role && typeof role.createdAt === "string" ? role.createdAt : now,
    createdBy: "createdBy" in role && typeof role.createdBy === "string" ? role.createdBy : actorId,
    updatedAt: "updatedAt" in role && typeof role.updatedAt === "string" ? role.updatedAt : now,
    updatedBy: "updatedBy" in role && typeof role.updatedBy === "string" ? role.updatedBy : actorId,
  };
}

function normalizeTaskVisibility(value: TaskVisibility | undefined): TaskVisibility {
  return {
    domain: value?.domain ?? "none",
    database: value?.database ?? "none",
  };
}

function protectRoleDefinition(role: RoleDefinitionRecord): RoleDefinitionRecord {
  if (role.id !== "super_admin") return role;
  const protectedRole = DEFAULT_ROLE_DEFINITIONS.find((item) => item.id === "super_admin")!;
  return {
    ...role,
    permissions: [...protectedRole.permissions],
    taskVisibility: { ...protectedRole.taskVisibility },
    system: true,
    protected: true,
    active: true,
  };
}
