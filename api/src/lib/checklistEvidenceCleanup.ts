import type { PrivateObjectLocator } from "./objectStorage";
import { maintenanceModeEnabled } from "./maintenanceMode";
export type EvidenceCleanupCandidate = { id: string; checklistId: string };
export type EvidenceCleanupClaim = EvidenceCleanupCandidate & {
  kind: string; status: string; deletedAt: Date | null; leaseId: string; leaseUntil: Date;
  storageDeletedAt: Date | null; locator: PrivateObjectLocator;
};
export interface EvidenceCleanupStore {
  candidates(limit: number): Promise<EvidenceCleanupCandidate[]>;
  claim(candidate: EvidenceCleanupCandidate): Promise<EvidenceCleanupClaim | null>;
  confirm(claim: EvidenceCleanupClaim): Promise<boolean>;
  finish(claim: EvidenceCleanupClaim): Promise<void>;
}
export function checklistEvidenceObjectKey(id: string, extension: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !/^\.(png|jpg|gif|webp|mp4|mov|webm|bin)$/.test(extension)) throw new Error("Invalid checklist object identity.");
  return `checklists/${id.toLowerCase()}/payload${extension}`;
}
export function isChecklistEvidenceLocator(id: string, locator: PrivateObjectLocator): boolean {
  const key = locator.storageProvider === "s3" ? locator.storageObjectKey : locator.storageBlobName;
  const extension = key.substring(key.lastIndexOf("."));
  try { return key === checklistEvidenceObjectKey(id, extension); } catch { return false; }
}
/** RN-43: claim must be durably tombstoned, committed and re-confirmed before
 * bytes can be touched. A saved row is never eligible, including deleted saved
 * rows. Provider I/O occurs outside SQL transactions; a failed/unknown commit
 * never authorizes deletion. Leases are retriable; tombstones are permanent. */
export async function cleanupPendingChecklistEvidence(deps: {
  store: EvidenceCleanupStore; storage: { remove(locator: PrivateObjectLocator): Promise<boolean> }; now(): Date; maintenance?(): boolean;
}) {
  const result = { claimed: 0, deleted: 0, failed: 0, skipped: 0 };
  const maintenance = deps.maintenance ?? maintenanceModeEnabled;
  if (maintenance()) return result;
  const deadline = deps.now().getTime() + 120_000;
  for (const candidate of await deps.store.candidates(50)) {
    if (maintenance() || deps.now().getTime() >= deadline) break;
    try {
      const claim = await deps.store.claim(candidate);
      if (!claim || !["image", "video", "file"].includes(claim.kind) || claim.status !== "pending" || !claim.deletedAt || claim.storageDeletedAt || claim.leaseUntil <= deps.now() || !isChecklistEvidenceLocator(claim.id, claim.locator)) { result.skipped++; continue; }
      result.claimed++;
      if (maintenance()) break;
      if (!await deps.store.confirm(claim)) { result.skipped++; continue; }
      if (maintenance()) break;
      if (!await deps.storage.remove(claim.locator)) { result.failed++; continue; }
      if (maintenance()) break;
      await deps.store.finish(claim); result.deleted++;
    } catch { result.failed++; }
  }
  return result;
}
