import sql from "mssql";
import type { CatalogTaskKind } from "./catalogTaskTargetPlanning";

type TaskDay = { taskDate: string; targetType: CatalogTaskKind };
type LegacyCandidate = TaskDay & { id: string; targetId: string };

/** Shared by legacy creation/sync and catalog registration. Always acquire before relation locks. */
export const CATALOG_TASK_DAY_LOCK_SQL = `
  IF @taskDate IS NULL OR @targetType IS NULL OR @targetType COLLATE Latin1_General_100_BIN2 NOT IN ('domain','database')
    THROW 53210,N'La fecha o clase de la tarea no es válida.',1;
  DECLARE @resource nvarchar(255)=CONCAT(N'portal.catalog-task.v1:',@targetType,N':',CONVERT(char(10),@taskDate,23));
  DECLARE @lockCode int;
  EXEC @lockCode=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=3000;
  SELECT @lockCode AS lockCode;`;

// No link-state filter: even a hidden/retired reservation must not be replayed by the legacy path.
export const LEGACY_CATALOG_COVERAGE_SQL = `
  SET @covered=CONVERT(bit,CASE WHEN EXISTS (
    SELECT 1
    FROM workflow.catalog_task_executions AS e
    JOIN workflow.update_tasks AS owned ON owned.task_key=e.task_key
    WHERE owned.source_id=@taskId OR EXISTS (
      SELECT 1 FROM workflow.task_source_aliases AS alias
      WHERE alias.alias_source_id=@taskId AND alias.task_key=owned.task_key
    )
  ) OR EXISTS (
    SELECT 1 FROM (
      SELECT @targetType AS target_type,@targetId AS target_source_id,@taskDate AS task_date
      UNION ALL
      SELECT persisted.target_type,persisted.target_source_id,persisted.task_date
      FROM workflow.update_tasks AS persisted WHERE persisted.source_id=@taskId
    ) AS candidate
    JOIN workflow.update_tasks AS catalog_task ON catalog_task.task_date=candidate.task_date
      AND catalog_task.target_type=candidate.target_type
    JOIN workflow.catalog_task_executions AS e ON e.task_key=catalog_task.task_key
      AND e.execution_kind=candidate.target_type
    JOIN workflow.catalog_task_execution_links AS link ON link.catalog_execution_key=e.catalog_execution_key
    LEFT JOIN core.domains AS domain_record ON candidate.target_type='domain' AND domain_record.domain_key=link.domain_key
    LEFT JOIN core.databases AS db ON candidate.target_type='database' AND db.database_key=link.database_key
    WHERE domain_record.source_id=candidate.target_source_id OR db.source_id=candidate.target_source_id
  ) THEN 1 ELSE 0 END);`;

export const LEGACY_CATALOG_COVERAGE_GATE_SQL = `
  DECLARE @hasExecutions int=OBJECT_ID(N'workflow.catalog_task_executions',N'U');
  DECLARE @hasLinks int=OBJECT_ID(N'workflow.catalog_task_execution_links',N'U');
  IF @hasExecutions IS NULL AND @hasLinks IS NULL
  BEGIN
    SELECT CONVERT(bit,0) AS covered;
    RETURN;
  END;
  IF @hasExecutions IS NULL OR @hasLinks IS NULL
    THROW 53211,N'El esquema de tareas del catálogo está incompleto.',1;

  DECLARE @covered bit;
  EXEC sys.sp_executesql @statement,
    N'@taskId nvarchar(260), @targetType varchar(20), @targetId nvarchar(150), @taskDate date, @covered bit OUTPUT',
    @taskId=@taskId,@targetType=@targetType,@targetId=@targetId,@taskDate=@taskDate,@covered=@covered OUTPUT;
  SELECT @covered AS covered;`;

export async function lockCatalogTaskDay(transaction: sql.Transaction, key: TaskDay): Promise<boolean> {
  const result = await new sql.Request(transaction).input("taskDate", sql.Date, key.taskDate)
    .input("targetType", sql.VarChar(20), key.targetType).query<{ lockCode: number }>(CATALOG_TASK_DAY_LOCK_SQL);
  // SQL Server success codes are 0 (immediate) and 1 (after waiting).
  return result.recordset[0]?.lockCode === 0 || result.recordset[0]?.lockCode === 1;
}

/** Must run after the shared task-day lock, in the same transaction as the caller's writes. */
export async function isLegacyCandidateCoveredByCatalog(transaction: sql.Transaction, task: LegacyCandidate): Promise<boolean> {
  const result = await new sql.Request(transaction).input("taskDate", sql.Date, task.taskDate)
    .input("targetType", sql.VarChar(20), task.targetType).input("taskId", sql.NVarChar(260), task.id)
    .input("targetId", sql.NVarChar(150), task.targetId).input("statement", sql.NVarChar(sql.MAX), LEGACY_CATALOG_COVERAGE_SQL)
    .query<{ covered: boolean }>(LEGACY_CATALOG_COVERAGE_GATE_SQL);
  return result.recordset[0]?.covered !== false;
}
