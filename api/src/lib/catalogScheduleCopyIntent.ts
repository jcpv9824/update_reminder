import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ScheduleConflictCandidate } from "./catalogScheduleConflictSelection";

const tokenDomain = "portal-sag/catalog-copy-intent/v1";
const ttlMs = 5 * 60_000;
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digestPattern = /^[A-Za-z0-9_-]{43}$/;
const linkPattern = /^[0-9a-f]{64}$/;
export type CopyIntentAuthority = Readonly<{
  actorId: string; scheduleId: string; scheduleVersion: string; operationId: string;
  environment: "qa" | "production"; date: string; revisionId: string;
  coverage: "verified" | "partial"; heldLinkIds: readonly string[];
  candidates: readonly ScheduleConflictCandidate[];
}>;
const domainKey = (secret: string) => {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("catalog_copy_intent_key_unavailable");
  return createHmac("sha256", secret).update(tokenDomain).digest();
};
function signature(secret: string, nonce: string, expiration: number, state: CopyIntentAuthority) {
  const rows = state.candidates.map(row => JSON.stringify([row.kind, row.targetId, row.linkId, row.state])).sort();
  const body = JSON.stringify([nonce, expiration, state.actorId, state.environment, state.date,
    state.scheduleId, state.scheduleVersion, state.operationId, state.revisionId, state.coverage,
    [...state.heldLinkIds].sort(), rows]);
  const key = domainKey(secret);
  try { return createHmac("sha256", key).update(body).digest("base64url"); }
  finally { key.fill(0); }
}

/** Result IDs are meaningful only within this short-lived preview. */
export const catalogCopyOpaqueId = (nonce: string, ...parts: string[]) => createHash("sha256")
  .update(JSON.stringify([nonce, ...parts])).digest("hex");

export function issueCatalogCopyIntent(secret: string, at: Date, authority: CopyIntentAuthority) {
  const now = at.getTime();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("catalog_copy_intent_clock_invalid");
  const nonce = randomUUID();
  const expires = now + ttlMs;
  return { nonce, previewId: `v1.${nonce}.${expires}.${signature(secret, nonce, expires, authority)}` };
}

/**
 * Use only with the current server-recomputed authority inside the save transaction.
 * No data is decoded from the browser other than format metadata. Link IDs must be
 * a nonempty subset of currently verified and nonconflicting exact logical links.
 */
export function validateCatalogCopySelection(secret: string, now: Date, authority: CopyIntentAuthority,
  request: Readonly<{ previewId: string; linkIds: readonly string[] }>,
): readonly ScheduleConflictCandidate[] | null {
  if (!request || typeof request.previewId !== "string" || request.previewId.length > 140 ||
      !Array.isArray(request.linkIds) || !request.linkIds.length || request.linkIds.length > 5000 ||
      request.linkIds.some(id => typeof id !== "string" || !linkPattern.test(id)) ||
      new Set(request.linkIds).size !== request.linkIds.length) return null;
  const [version, nonce, rawExpires, mac, ...rest] = request.previewId.split(".");
  const expiration = Number(rawExpires);
  if (version !== "v1" || rest.length || !guid.test(nonce ?? "") || !/^[1-9]\d{12}$/.test(rawExpires ?? "") ||
      !digestPattern.test(mac ?? "") || !Number.isSafeInteger(now.getTime()) || expiration <= now.getTime() ||
      expiration - now.getTime() > ttlMs) return null;
  const expected = signature(secret, nonce, expiration, authority);
  if (!timingSafeEqual(Buffer.from(mac, "ascii"), Buffer.from(expected, "ascii"))) return null;
  const physical = (row: ScheduleConflictCandidate) => JSON.stringify([row.kind, row.targetId]);
  const conflictKeys = new Set(authority.candidates.filter(row => row.state === "conflict").map(physical));
  const byPublicId = new Map(authority.candidates.flatMap(row => row.state === "ready" && row.targetId &&
    !conflictKeys.has(physical(row)) ? [[catalogCopyOpaqueId(nonce, "link", row.linkId), row] as const] : []));
  const allowed = request.linkIds.map(id => byPublicId.get(id));
  if (allowed.some(row => !row)) return null;
  return allowed as readonly ScheduleConflictCandidate[];
}
