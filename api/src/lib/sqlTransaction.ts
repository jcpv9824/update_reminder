import sql from "mssql";
import { getSqlPool } from "./sql";

export async function runSqlTransaction<T>(
  work: (transaction: sql.Transaction) => Promise<T>,
  isolationLevel: number = sql.ISOLATION_LEVEL.SERIALIZABLE,
): Promise<T> {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(isolationLevel);
  try {
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}
