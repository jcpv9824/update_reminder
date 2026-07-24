import { describe, expect, it } from "vitest";
import { contentFileLocatorProjection } from "../lib/contentFileSqlSchema";

describe("content file SQL schema compatibility", () => {
  it("selects provider-neutral locators after migration 024", () => {
    const projection = contentFileLocatorProjection("f", true);
    expect(projection).toContain("f.storage_bucket");
    expect(projection).toContain("f.object_key");
    expect(projection).toContain("f.object_etag");
  });

  it("projects null S3 fields while Azure Blob runs on the legacy schema", () => {
    const projection = contentFileLocatorProjection("file_record", false);
    expect(projection).toContain("file_record.storage_container");
    expect(projection).toContain("file_record.blob_name");
    expect(projection).toContain("AS storage_bucket");
    expect(projection).toContain("AS object_key");
    expect(projection).toContain("AS object_etag");
    expect(projection).not.toContain("file_record.storage_bucket");
  });

  it("rejects an unsafe SQL alias", () => {
    expect(() => contentFileLocatorProjection("f;DROP TABLE content.files", true))
      .toThrow(/Alias SQL/);
  });
});
