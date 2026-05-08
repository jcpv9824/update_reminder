import { describe, it, expect } from "vitest";
import { formatDomainForPublishing } from "../utils/dominio";

describe("formatDomainForPublishing (frontend)", () => {
  const casos: Array<[unknown, string]> = [
    ["https://argatex.sagerp.cloud:54678/", "argatex.sagerp.cloud"],
    ["http://argatex.sagerp.cloud:54678/", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud:54678", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud/", "argatex.sagerp.cloud"],
    ["argatex.sagerp.cloud", "argatex.sagerp.cloud"],
    ["test.cres-contratos.sagerp.cloud", "test.cres-contratos.sagerp.cloud"],
    ["  HTTPS://INVENGY.SAGERP.CLOUD:54678/  ", "invengy.sagerp.cloud"],
    ["https://machineparts.sagerp.cloud:54678/path?x=1", "machineparts.sagerp.cloud"],
  ];
  for (const [entrada, esperado] of casos) {
    it(`convierte ${JSON.stringify(entrada)} → ${esperado}`, () => {
      expect(formatDomainForPublishing(entrada)).toBe(esperado);
    });
  }

  it("entrada vacía/null/undefined no rompe", () => {
    expect(formatDomainForPublishing("")).toBe("");
    expect(formatDomainForPublishing(null)).toBe("");
    expect(formatDomainForPublishing(undefined)).toBe("");
  });
});
