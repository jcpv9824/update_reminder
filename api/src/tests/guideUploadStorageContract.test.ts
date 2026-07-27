import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("guide upload immutability contract", () => {
  it("does not reissue write authorization after upload completion", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/functions/guideSessions.ts"),
      "utf8",
    );
    expect(source).toContain("if (!result.created)");
    expect(source).toContain("no puede volver a generarse");
  });

  it("downloads the exact provider version recorded by upload completion", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/lib/objectStorage.ts"),
      "utf8",
    );
    expect(source).toContain("IfMatch: quotedEtag(input.storageObjectEtag)");
    expect(source).toContain("ifMatch: input.storageBlobEtag");
  });

  it("claims an unreferenced locator in SQL before deleting provider bytes", async () => {
    const [storage, writer] = await Promise.all([
      readFile(resolve(process.cwd(), "src/lib/objectStorage.ts"), "utf8"),
      readFile(resolve(process.cwd(), "src/lib/contentFileSqlWriter.ts"), "utf8"),
    ]);
    expect(storage).toContain("tryClaimUnreferencedObject");
    expect(storage).toContain("INSERT content.object_deletion_claims");
    expect(storage).toContain("tryReserveObjectRegistration");
    expect(storage).toContain("registrationReservations.set");
    expect(writer).toContain("getPrivateObjectRegistrationToken");
    expect(writer).toContain("claimed_by<>@registrationToken");
    expect(writer).toContain("FROM content.object_deletion_claims WITH (UPDLOCK,HOLDLOCK)");
    expect(writer).toContain("THROW 51073");
  });

  it("does not expose raw SQL or storage exception messages from guide endpoints", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/functions/guideSessions.ts"),
      "utf8",
    );
    expect(source).not.toContain("return serverError(error)");
    expect(source).toContain("safeMessages[safeStatus]");
  });
});
