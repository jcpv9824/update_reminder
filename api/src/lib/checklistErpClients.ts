import type sql from "mssql";
import { selectCatalogCustomerDirectory, type CatalogDirectoryInput } from "./catalogCustomerDirectory";
import { readSqlCatalogCustomerSnapshots } from "./catalogCustomerSnapshotsSqlRepository";
import { readAuthorizedCatalogSourceIdsInTransaction } from "./catalogSourceAccessSqlRepository";
import { catalogClientsReadEnabled, catalogDirectoryV2Enabled } from "./catalogReadScope";
import { runSqlTransaction } from "./sqlTransaction";
import { FindChecklistClientsSchema } from "./checklistRequestSchemas";
import { ChecklistError } from "./checklistDomain";

type Selection = { search?: string; clientId?: string };
type ChecklistCreateActor = { id: string; canCreate: boolean };
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
const unavailable = () => new ChecklistError(503, "erp_unavailable", "El catálogo de clientes del ERP no está disponible.");

/** RN-02: name-only, eligible ERP rows; no SAG-only fallbacks or document fields. */
export function selectChecklistErpClients(input: CatalogDirectoryInput, args: Selection): { id: string; name: string }[] {
  const erp = input.erp.filter((source) => source.state === "verified" && input.allowedSourceIds.has(source.sourceId));
  const term = fold(args.search ?? "");
  return selectCatalogCustomerDirectory({ ...input, erp, sagOnlyCustomers: [], showDocuments: false },
    { state: "all", web: "all", pageSize: args.clientId ? 1 : 20 },
    ({ name }) => name.trim().length > 0 && name.length <= 200 && fold(name).includes(term), args.clientId,
  ).items.map(({ id, name }) => ({ id, name }));
}

async function read(actor: ChecklistCreateActor, args: Selection, existingTransaction?: sql.Transaction) {
  if (!actor.canCreate) throw new ChecklistError(403, "forbidden", "No tiene permiso para crear checklists.");
  const environment = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  const rawKey = process.env.PORTAL_CATALOG_MATCH_KEY_VERSION ?? "";
  const matchKeyVersion = Number(rawKey);
  if (!catalogClientsReadEnabled() || (environment !== "qa" && environment !== "production") ||
      !/^[1-9][0-9]{0,4}$/.test(rawKey) || matchKeyVersion > 32767) throw unavailable();

  const work = async (db: sql.Transaction) => {
    const allowedSourceIds = await readAuthorizedCatalogSourceIdsInTransaction(db, { actorId: actor.id, environment });
    if (allowedSourceIds.size === 0) return [];
    const includeSagDirectory = catalogDirectoryV2Enabled();
    const snapshot = await readSqlCatalogCustomerSnapshots({
      environment, allowedSourceIds, matchKeyVersion, actorId: actor.id, includeSagDirectory,
      erpAutocomplete: includeSagDirectory && !existingTransaction && args.search !== undefined,
    }, db);
    if (!snapshot.erp.some((source) => source.state === "verified" && allowedSourceIds.has(source.sourceId))) throw unavailable();
    return selectChecklistErpClients(snapshot, args);
  };
  try { return existingTransaction ? await work(existingTransaction) : await runSqlTransaction(work); }
  catch { throw unavailable(); }
}

export function findChecklistErpClients(actor: ChecklistCreateActor, query: unknown) {
  return read(actor, { search: FindChecklistClientsSchema.parse(query).q });
}

export async function resolveChecklistErpClient(actor: ChecklistCreateActor, clientId: string, transaction: sql.Transaction) {
  const [result] = await read(actor, { clientId }, transaction);
  if (!result) throw new ChecklistError(400, "invalid_client", "Seleccione un cliente de la lista");
  return result;
}
