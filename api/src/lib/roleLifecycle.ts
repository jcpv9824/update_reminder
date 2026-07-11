type UserRoleReference = { roles?: string[] };
type ScheduleRoleReference = {
  active?: boolean;
  assignedRole?: string;
  domainAssignedRole?: string;
  databaseAssignedRole?: string;
};
type TaskRoleReference = { status?: string; assignedRole?: string };

export type RoleUsage = {
  users: number;
  activeSchedules: number;
  openTasks: number;
  hasReferences: boolean;
};

function scheduleReferencesRole(schedule: ScheduleRoleReference, roleId: string): boolean {
  return [schedule.assignedRole, schedule.domainAssignedRole, schedule.databaseAssignedRole].includes(roleId);
}

export function roleUsageSummary(
  roleId: string,
  users: UserRoleReference[],
  schedules: ScheduleRoleReference[],
  tasks: TaskRoleReference[]
): RoleUsage {
  const userCount = users.filter((user) => user.roles?.includes(roleId)).length;
  const scheduleCount = schedules.filter((schedule) => schedule.active !== false && scheduleReferencesRole(schedule, roleId)).length;
  const taskCount = tasks.filter((task) => task.assignedRole === roleId && !["completed", "cancelled"].includes(task.status ?? "")).length;

  return {
    users: userCount,
    activeSchedules: scheduleCount,
    openTasks: taskCount,
    hasReferences: userCount + scheduleCount + taskCount > 0,
  };
}

export function roleUsageMessage(usage: RoleUsage): string {
  const references = [
    usage.users ? `${usage.users} usuario(s)` : null,
    usage.activeSchedules ? `${usage.activeSchedules} programación(es) activa(s)` : null,
    usage.openTasks ? `${usage.openTasks} tarea(s) abierta(s)` : null,
  ].filter(Boolean).join(", ");
  return `No se puede desactivar o eliminar el rol mientras esté asignado a ${references}. Reasigne o cierre esas referencias primero.`;
}
