import { buildCatalogCustomerDirectory } from "./catalogCustomerDirectory";
import { addCatalogCustomerDocuments } from "./catalogCustomerDocumentDisplay";
import { readSqlCatalogCustomerSnapshots } from "./catalogCustomerSnapshotsSqlRepository";
import type { CatalogObservedInventoryV2Query } from "./catalogObservedInventoryV2Http";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

/** Load identifier labels only for the exact, independently authorized inventory page. */
export async function readCatalogObservedInventoryDocuments(
  scope: Pick<CatalogObservedInventoryV2Query, "actorId" | "allowedSourceIds" | "sourceIds"> &
    { environment: CatalogEnvironment; matchKeyVersion: number },
  customerIds: readonly string[],
  io = { readSnapshots: readSqlCatalogCustomerSnapshots, addDocuments: addCatalogCustomerDocuments },
): Promise<ReadonlyMap<string, string>> {
  if (!customerIds.length || customerIds.length > 100) return new Map();
  const ids = new Set(customerIds);
  const requested = scope.sourceIds ? new Set(scope.sourceIds) : scope.allowedSourceIds;
  const allowedSourceIds = new Set([...requested].filter(id => scope.allowedSourceIds.has(id)));
  if (scope.sourceIds && !allowedSourceIds.size) return new Map();
  const input = await io.readSnapshots({
    environment: scope.environment, matchKeyVersion: scope.matchKeyVersion,
    actorId: scope.actorId, allowedSourceIds, includeSagDirectory: true,
  });
  const eligibleOrphans = !scope.sourceIds && input.sag.state === "verified"
    ? input.sagOnlyCustomers?.filter(row => ids.has(row.customerId)) : undefined;
  const documentInput = {
    ...input,
    // Even a miswired reader must not grant access to another source or an old row.
    allowedSourceIds,
    erp: input.erp.filter(source => allowedSourceIds.has(source.sourceId) && source.state === "verified")
      .map(source => ({ ...source,
        customers: source.customers.filter(row => ids.has(row.customerId))
          .map(row => ({ ...row, displayDocument: undefined })),
      })),
    sagOnlyCustomers: eligibleOrphans?.map(row => ({ ...row, displayDocument: undefined })),
  };
  const resolved = await io.addDocuments(documentInput, scope.environment, scope.matchKeyVersion,
    scope.sourceIds ? [...allowedSourceIds] : undefined);
  const page = buildCatalogCustomerDirectory(resolved, { state: "all", web: "all", pageSize: 100 });
  return new Map(page.items.flatMap(row => ids.has(row.id) && row.displayDocument
    ? [[row.id, row.displayDocument] as const] : []));
}
