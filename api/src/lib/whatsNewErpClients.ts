import type sql from "mssql";
import { z } from "zod";
import type { CatalogDirectoryInput } from "./catalogCustomerDirectory";
import { selectCatalogCustomerDirectory } from "./catalogCustomerDirectory";
import { readSqlCatalogCustomerSnapshots } from "./catalogCustomerSnapshotsSqlRepository";
import { catalogClientsReadEnabled, catalogDirectoryV2Enabled } from "./catalogReadScope";
import { readAuthorizedCatalogSourceIdsInTransaction } from "./catalogSourceAccessSqlRepository";
import { runSqlTransaction } from "./sqlTransaction";
import { access, requireDeveloper, requirePermission, type WhatsNewActor } from "./whatsNewAccess";
import { LIMITS, WhatsNewError } from "./whatsNewModel";

type ErpClientSelection = { search?: string; clientId?: string };
const searchSchema = z.string().trim().max(100);

export function selectWhatsNewErpClients(input: CatalogDirectoryInput, args: ErpClientSelection = {}) {
  const freshErp = input.erp.filter((source) => source.state === "verified" && input.allowedSourceIds.has(source.sourceId));
  const directory = selectCatalogCustomerDirectory({
    ...input, erp: freshErp, sagOnlyCustomers: [], showDocuments: false,
  }, {
    state: "active_or_unverified", web: "all", search: args.search, pageSize: args.clientId ? 1 : 50,
  }, (item) => item.web !== "not_in_web" && item.name.length <= LIMITS.clientName, args.clientId);
  return directory.items.map((item) => ({ id: item.id, label: item.name }));
}

export const canReadWhatsNewErpClients = (actor: WhatsNewActor) =>
  access.developer(actor) && actor.permissions.has("clients.clients.view") && catalogClientsReadEnabled();

const unavailable = () => new WhatsNewError(503, "catalogo_clientes_no_disponible", "El catálogo de clientes del ERP no está disponible.");

async function readClients(actor: WhatsNewActor, args: ErpClientSelection, transaction?: sql.Transaction) {
  requireDeveloper(actor);
  requirePermission(actor, (a) => a.permissions.has("clients.clients.view"));
  if (!catalogClientsReadEnabled()) throw unavailable();
  const environment = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  const version = process.env.PORTAL_CATALOG_MATCH_KEY_VERSION ?? "";
  const matchKeyVersion = Number(version);
  if ((environment !== "qa" && environment !== "production") || !/^[1-9][0-9]{0,4}$/.test(version) ||
      matchKeyVersion > 32767) throw unavailable();
  try {
    const run = async (db: sql.Transaction) => {
      const allowedSourceIds = await readAuthorizedCatalogSourceIdsInTransaction(db, { actorId: actor.id, environment });
      if (!allowedSourceIds.size) return [];
      const input = await readSqlCatalogCustomerSnapshots({
        environment, allowedSourceIds, matchKeyVersion, actorId: actor.id, includeSagDirectory: catalogDirectoryV2Enabled(),
      }, db);
      if (!input.erp.some((source) => source.state === "verified" && allowedSourceIds.has(source.sourceId))) throw unavailable();
      return selectWhatsNewErpClients(input, args);
    };
    return transaction ? await run(transaction) : await runSqlTransaction(run);
  } catch {
    throw unavailable();
  }
}

export function lookupWhatsNewErpClients(actor: WhatsNewActor, search: string) {
  return readClients(actor, { search: searchSchema.parse(search) });
}

export async function resolveWhatsNewErpClientName(actor: WhatsNewActor, clientId: string, transaction: sql.Transaction) {
  const [client] = await readClients(actor, { clientId }, transaction);
  if (!client) throw new WhatsNewError(400, "cliente_erp_no_disponible", "Seleccione un cliente disponible del ERP.");
  return client.label;
}
