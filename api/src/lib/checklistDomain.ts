import type { CreateChecklistInput, SaveChecklistInput } from "./checklistRequestSchemas";

type Environment = NonNullable<CreateChecklistInput["environment"]>;
type Combination = { clientId: string; templateId: string; environment: Environment | null };
export type ChecklistDuplicate = Combination & {
  id: string; status: "in_progress" | "completed"; deleted: boolean;
  ownerName?: string; createdAt?: string; completedAt?: string | null;
};
type WriteActor = { id: string; canView: boolean; isSuperAdmin: boolean };
export class ChecklistError extends Error {
  constructor(readonly status: number, readonly error: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ChecklistError";
  }
}

/** RN-04/05: consult the currently locked version, never client-supplied metadata. */
export function decideEnvironment(requiresEnvironment: boolean, environment?: Environment): Environment | null {
  if (requiresEnvironment && !environment) throw new ChecklistError(400, "environment_required", "Seleccione el ambiente");
  if (!requiresEnvironment && environment) throw new ChecklistError(400, "environment_not_allowed", "La versión no requiere ambiente.");
  return environment ?? null;
}

/** RN-06/07/18: caller must serialize the lookup with SQL insert/reopen. */
export function checkCombination(target: Combination, candidates: readonly ChecklistDuplicate[], options: {
  confirmDuplicate?: boolean; reopeningId?: string;
} = {}): void {
  const matches = candidates.filter((row) => !row.deleted && row.id !== options.reopeningId &&
    row.clientId === target.clientId && row.templateId === target.templateId && row.environment === target.environment);
  const open = matches.find(({ status }) => status === "in_progress");
  const existing = open ?? (!options.confirmDuplicate && !options.reopeningId ? matches.find(({ status }) => status === "completed") : undefined);
  if (!existing) return;
  throw new ChecklistError(409, open ? "duplicate_in_progress" : "duplicate_completed",
    open ? "Ya hay un checklist en progreso para esta combinación." : "¿Crear otro de todos modos?", {
      existing: { id: existing.id, ownerName: existing.ownerName, createdAt: existing.createdAt, completedAt: existing.completedAt },
    });
}

export function mayWriteChecklist(actor: WriteActor, ownerId: string): boolean {
  return actor.isSuperAdmin || (actor.canView && actor.id === ownerId);
}

/** RN-13–16: validate exact membership and completeness before any write. */
export function preparePointSave(expected: readonly string[], points: SaveChecklistInput["points"], complete: boolean) {
  const byId = new Map(points.map((point) => [point.pointId, point]));
  if (byId.size !== points.length || byId.size !== expected.length || expected.some((id) => !byId.has(id))) {
    throw new ChecklistError(400, "invalid_points", "Los puntos deben corresponder al checklist.");
  }
  const ordered = expected.map((id) => byId.get(id)!);
  const missing = ordered.filter(({ checked }) => !checked).map(({ pointId }) => pointId);
  if (complete && missing.length) {
    throw new ChecklistError(422, "missing_points", `Faltan ${missing.length} puntos por marcar`, { pointIds: missing });
  }
  return ordered;
}

export function checklistProgress(checked: number, total: number): number {
  return total > 0 ? Math.round(100 * checked / total) : 0;
}
