import { describe, it, expect } from "vitest";
import { formatDomainForPublishing } from "../lib/domainFormat";

describe("formatDomainForPublishing", () => {
  const casos: Array<[unknown, string]> = [
    ["https://argatex.sagerp.cloud:54678/", "argatex.sagerp.cloud"],
    ["http://argatex.sagerp.cloud:54678/", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud:54678", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud/", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud", "argatex.sagerp.cloud"],
    ["test.cres-contratos.sagerp.cloud", "test.cres-contratos.sagerp.cloud"],
    ["  HTTPS://INVENGY.SAGERP.CLOUD:54678/  ", "invengy.sagerp.cloud"],
    ["https://machineparts.sagerp.cloud:54678/path?x=1", "machineparts.sagerp.cloud"],
    ["https://x.sagerp.cloud/algo#seccion", "x.sagerp.cloud"],
    ["ftp://x.sagerp.cloud:21/", "x.sagerp.cloud"],
    ["user:pass@x.sagerp.cloud", "x.sagerp.cloud"],
  ];

  for (const [entrada, esperado] of casos) {
    it(`convierte ${JSON.stringify(entrada)} → ${esperado}`, () => {
      expect(formatDomainForPublishing(entrada)).toBe(esperado);
    });
  }

  it("entrada vacía / null / undefined no rompe", () => {
    expect(formatDomainForPublishing("")).toBe("");
    expect(formatDomainForPublishing(null)).toBe("");
    expect(formatDomainForPublishing(undefined)).toBe("");
    expect(formatDomainForPublishing(123 as any)).toBe("123");
  });
});
