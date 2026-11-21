import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogDraftProposalListHttp, draftProposalListSql } from "../lib/catalogScheduleDraftProposalList";

const actor = { actorId: "author", allowedKinds: ["domain"] as const, allowLicensing: false };
const row = { id: "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95", name: "Programación", date: "2030-06-22", status: "scheduled" };
const request = (query = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/schedules/catalog-draft-proposals${query}` });

describe("own catalog draft proposals", () => {
  it("does not accept an external owner and returns only a no-store summary", async () => {
    const list = vi.fn().mockResolvedValue([{ ...row, reviewerId: "hidden", reviewId: "hidden-receipt", operationId: "hidden-operation" }]);
    const handler = createCatalogDraftProposalListHttp({ authorize: async () => actor, list });
    expect((await handler(request("?actorId=other"))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(await handler(request())).toMatchObject({ status: 200, jsonBody: { items: [row] },
      headers: { "Cache-Control": "no-store" } });
    expect(list).toHaveBeenCalledExactlyOnceWith(actor);
    const privateResult = await createCatalogDraftProposalListHttp({ authorize: async () => ({ status: 403 }), list })(request());
    expect(privateResult.status).toBe(403);
    expect(list).toHaveBeenCalledOnce();
  });

  it("requires the exact active approval and a frozen snapshot to claim active, and filters by actor and access", () => {
    expect(draftProposalListSql).toContain("TOP (20)");
    expect(draftProposalListSql).toContain("p.requester_source_id=@actor COLLATE Latin1_General_100_BIN2");
    expect(draftProposalListSql).toContain("a.schedule_version=d.schedule_version");
    expect(draftProposalListSql).toContain("a.approved_at=d.approved_at AND a.retired_at IS NULL");
    expect(draftProposalListSql).toContain("proof.activation_state='frozen'");
    expect(draftProposalListSql).toMatch(/@withLicensing.*@withDomains.*@withDatabases/s);
    expect(draftProposalListSql).not.toMatch(/receipt|reviewer|sha256/i);
  });
});
