import { describe, expect, it } from "vitest";
import { catalogCopyOpaqueId, issueCatalogCopyIntent, validateCatalogCopySelection,
  type CopyIntentAuthority } from "../lib/catalogScheduleCopyIntent";

const secret = "fictional-copy-key-only-for-unit-tests";
const now = new Date("2030-06-22T12:00:00Z");
const authority: CopyIntentAuthority = { actorId: "operator-a", scheduleId: "original", scheduleVersion: "0102030405060708",
  operationId: "release-1", date: "2030-06-22", revisionId: "approved", environment: "qa", coverage: "partial",
  heldLinkIds: ["unknown"], candidates: [
    { kind: "domain", linkId: "domain-conflicting", state: "conflict", targetId: "physical-1" },
    { kind: "domain", linkId: "domain-alias", state: "ready", targetId: "physical-1" },
    { kind: "database", linkId: "database-independent", state: "ready", targetId: "physical-1" },
    { kind: "database", linkId: "database-other", state: "ready", targetId: "physical-2" },
  ] };

describe("short-lived authority for the selected copy scope", () => {
  const issued = issueCatalogCopyIntent(secret, now, authority);
  const select = (...links: string[]) => ({ previewId: issued.previewId,
    linkIds: links.map(link => catalogCopyOpaqueId(issued.nonce, "link", link)) });

  it("accepts a subset of remaining links, but neither conflicting aliases nor duplicate or raw IDs", () => {
    const verify = (request: ReturnType<typeof select>) => validateCatalogCopySelection(secret, now, authority, request);
    expect(verify(select("database-independent"))).toEqual([authority.candidates[2]]);
    expect(verify(select("domain-alias"))).toBeNull();
    expect(verify(select("unknown"))).toBeNull();
    expect(verify(select())).toBeNull();
    expect(verify(select("database-other", "database-other"))).toBeNull();
    expect(verify({ ...select(), linkIds: ["database-independent"] })).toBeNull();
  });

  it("rejects another identity/environment/date, a stale definition or conflict, tampering and expiry", () => {
    const request = select("database-independent");
    for (const changes of [{ actorId: "operator-b" }, { environment: "production" as const }, { date: "2030-06-23" },
      { scheduleVersion: "0102030405060709" }, { operationId: "release-2" }, { revisionId: "new-approval" },
      { candidates: authority.candidates.map(row => ({ ...row, state: "conflict" as const })) }]) {
      expect(validateCatalogCopySelection(secret, now, { ...authority, ...changes }, request)).toBeNull();
    }
    expect(validateCatalogCopySelection(secret, now, authority, { ...request, previewId: `${issued.previewId}x` })).toBeNull();
    expect(validateCatalogCopySelection(secret, new Date(now.getTime() + 300_000), authority, request)).toBeNull();
    expect(validateCatalogCopySelection(secret, now, { ...authority, candidates: [...authority.candidates].reverse() }, request))
      .toEqual([authority.candidates[2]]);
  });
});
