import type { CurrentUser } from "../types/models";
import type { RoleDefinition } from "./permissionModel";
import { hasPermissionWithRoleDefinitions } from "./taskAccess";
import { PERMISSIONS, WhatsNewError, type AreaCode, type EntryStatus } from "./whatsNewModel";

/* Permisos y área (`06`). La regla es permiso && área, consultada en cada
   petición (no viaja en el JWT). super_admin tiene todas las claves, pero
   necesita el área para crear (Desarrollo) o probar (Soporte). */

export type WhatsNewActor = {
  id: string;
  email: string;
  displayName: string;
  permissions: ReadonlySet<string>;
  areas: ReadonlySet<AreaCode>;
};

export type WhatsNewView = "desarrollador" | "asesor" | "lectura";

export function buildActor(user: CurrentUser, roleDefinitions: RoleDefinition[], areas: AreaCode[]): WhatsNewActor {
  const permissions = new Set<string>();
  for (const key of [...Object.values(PERMISSIONS), "configuration.users.view", "configuration.users.edit"]) {
    if (hasPermissionWithRoleDefinitions(user, key, roleDefinitions)) permissions.add(key);
  }
  return { id: user.id, email: user.email, displayName: user.displayName, permissions, areas: new Set(areas) };
}

const has = (actor: WhatsNewActor, key: string) => actor.permissions.has(key);

export const access = {
  view: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view),
  /** Visión Desarrollador: `author` + área Desarrollo. */
  developer: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view) && has(actor, PERMISSIONS.author) && actor.areas.has("desarrollo"),
  /** Visión Asesor: `test` + área Soporte. */
  tester: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view) && has(actor, PERMISSIONS.test) && actor.areas.has("soporte"),
  publishClient: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view) && has(actor, PERMISSIONS.publishClient) && actor.areas.has("soporte"),
  report: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view) && has(actor, PERMISSIONS.report),
  viewAll: (actor: WhatsNewActor) => has(actor, PERMISSIONS.view) && has(actor, PERMISSIONS.viewAll),
  configView: (actor: WhatsNewActor) => has(actor, PERMISSIONS.configView) || has(actor, PERMISSIONS.manage),
  manage: (actor: WhatsNewActor) => has(actor, PERMISSIONS.manage),
};

export function viewsFor(actor: WhatsNewActor): WhatsNewView[] {
  if (!access.view(actor)) return [];
  const views: WhatsNewView[] = [];
  if (access.developer(actor)) views.push("desarrollador");
  if (access.tester(actor)) views.push("asesor");
  if (views.length === 0 && (access.viewAll(actor) || access.report(actor) || access.manage(actor))) views.push("lectura");
  return views;
}

export function requireView(actor: WhatsNewActor): void {
  if (!access.view(actor)) throw new WhatsNewError(403, "sin_permiso", "No tiene permisos para esta acción.");
}

export function requireDeveloper(actor: WhatsNewActor): void {
  requireView(actor);
  if (!actor.permissions.has(PERMISSIONS.author)) throw new WhatsNewError(403, "sin_permiso", "No tiene permisos para esta acción.");
  if (!actor.areas.has("desarrollo")) throw new WhatsNewError(403, "area_requerida", "Necesita el área Desarrollo para esta acción.");
}

export function requireTester(actor: WhatsNewActor): void {
  requireView(actor);
  if (!actor.permissions.has(PERMISSIONS.test)) throw new WhatsNewError(403, "sin_permiso", "No tiene permisos para esta acción.");
  if (!actor.areas.has("soporte")) throw new WhatsNewError(403, "area_requerida", "Necesita el área Soporte para esta acción.");
}

export function requirePermission(actor: WhatsNewActor, check: (actor: WhatsNewActor) => boolean): void {
  if (!check(actor)) throw new WhatsNewError(403, "sin_permiso", "No tiene permisos para esta acción.");
}

/**
 * Quién puede ver una entrada (`06` §4):
 * - borrador: solo su desarrollador y `manage` (los demás reciben 404, no 403);
 * - eliminada: solo `manage`;
 * - publicada: `view` y alguna visión (desarrollador, asesor, lectura) o `manage`.
 */
export function canSeeEntry(actor: WhatsNewActor, entry: { status: EntryStatus; developerId: string }): boolean {
  if (!access.view(actor)) return false;
  if (access.manage(actor)) return true;
  if (entry.status === "eliminada") return false;
  if (entry.status === "borrador") return entry.developerId === actor.id && access.developer(actor);
  return viewsFor(actor).length > 0;
}

export function assertCanSeeEntry(actor: WhatsNewActor, entry: { status: EntryStatus; developerId: string } | null): void {
  if (!entry || !canSeeEntry(actor, entry)) throw new WhatsNewError(404, "no_encontrado", "No encontrado.");
}

/** Nadie prueba una entrada que creó, editó, publicó o corrigió (H-01, QA-04). */
export function assertMayTest(actor: WhatsNewActor, contributorIds: readonly string[]): void {
  requireTester(actor);
  if (contributorIds.includes(actor.id)) {
    throw new WhatsNewError(403, "autor_no_puede_probar", "Quien creó o editó esta entrada no puede probarla.");
  }
}
