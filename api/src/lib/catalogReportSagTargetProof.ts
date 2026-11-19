import { readSqlCatalogPhysicalTargetPinsInTransaction } from "./catalogPhysicalTargetSqlRepository";
import { readSqlCatalogReportingProfilesInTransaction, type SqlCatalogReportingProfile } from "./catalogReportingProfilesSqlRepository";
import { verifyCatalogSagTargetRuntimeProof } from "./catalogSagTargetRuntimeSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { catalogReportDatabaseLinkIds, type SqlMastersReportData } from "./mastersReportSqlData";
import { runSqlTransaction } from "./sqlTransaction";

type PhysicalRequest = Parameters<typeof readSqlCatalogPhysicalTargetPinsInTransaction>[1]["links"][number];
export type CatalogReportDatabaseLink = Extract<PhysicalRequest, { kind: "database" }>;

/** Revalidate authorized aliases and the independent counting profile together, without external SQL I/O. */
export async function recheckCatalogReportSagTarget(input: {
  portalEnvironment: CatalogEnvironment; links: readonly CatalogReportDatabaseLink[]; data: SqlMastersReportData;
  matchKey: Buffer; matchKeyVersion: number; expected: SqlCatalogReportingProfile; signal: AbortSignal;
}): Promise<SqlCatalogReportingProfile | null> {
  const { portalEnvironment, links, data, matchKey, matchKeyVersion, expected, signal } = input;
  if (!links.length || signal.aborted) return null;
  const anchors = links.map(link => catalogReportDatabaseLinkIds(data, link.databaseId));
  if (anchors.some(ids => !ids.length)) return null;
  const { physicalDatabaseId, serverGroupId } = expected.target;
  try {
    return await runSqlTransaction(async transaction => {
      const pins = await readSqlCatalogPhysicalTargetPinsInTransaction(transaction, { portalEnvironment, links });
      if (pins.length !== links.length || signal.aborted) return null;
      let validUntil = Number.POSITIVE_INFINITY;
      for (const [index, pin] of pins.entries()) {
        if (pin.status !== "verified" || pin.id !== physicalDatabaseId) return null;
        let matched = false;
        for (const operationalLinkId of anchors[index]) {
          if (signal.aborted) return null;
          const result = await verifyCatalogSagTargetRuntimeProof(transaction, {
            environment: portalEnvironment, purpose: "report", operationalLinkId, physicalLinkId: pin.physicalLinkId,
            physicalTargetId: pin.id, matchKeyVersion, reportInstanceId: serverGroupId,
          }, matchKey);
          if (!result || result.targetId !== pin.id) continue;
          const expiry = result.validUntil.valueOf();
          if (!Number.isFinite(expiry) || expiry <= Date.now()) continue;
          validUntil = Math.min(validUntil, expiry);
          matched = true;
          break;
        }
        if (!matched) return null;
      }
      const profiles = await readSqlCatalogReportingProfilesInTransaction(transaction, {
        portalEnvironment, physicalIds: new Set([physicalDatabaseId]),
      });
      return signal.aborted || Date.now() >= validUntil ? null : profiles.get(physicalDatabaseId) ?? null;
    });
  } catch {
    return null;
  }
}
