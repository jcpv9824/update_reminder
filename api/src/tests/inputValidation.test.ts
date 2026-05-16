import { describe, expect, it } from "vitest";
import { isValidEmail, isValidHttpsDomain, trimText } from "../lib/inputValidation";
import { parseSemicolonEmails, uniqueEmails } from "../lib/emailRecipients";

describe("inputValidation", () => {
  it("aplica trim a textos", () => {
    expect(trimText("  valor  ")).toBe("valor");
  });

  it("valida dominios con https", () => {
    expect(isValidHttpsDomain(" https://demo.sagerp.cloud ")).toBe(true);
    expect(isValidHttpsDomain("http://demo.sagerp.cloud")).toBe(false);
    expect(isValidHttpsDomain("demo.sagerp.cloud")).toBe(false);
  });

  it("valida correos individuales", () => {
    expect(isValidEmail(" usuario@empresa.com ")).toBe(true);
    expect(isValidEmail("correo-mal")).toBe(false);
  });

  it("parsea listas separadas por punto y coma e ignora punto y coma final", () => {
    const parsed = parseSemicolonEmails("uno@empresa.com; dos@empresa.com; ");

    expect(parsed.emails).toEqual(["uno@empresa.com", "dos@empresa.com"]);
    expect(parsed.invalid).toEqual([]);
  });

  it("reporta correos inválidos en listas separadas por punto y coma", () => {
    const parsed = parseSemicolonEmails("uno@empresa.com; correo-mal; dos@empresa.com");

    expect(parsed.emails).toEqual(["uno@empresa.com", "dos@empresa.com"]);
    expect(parsed.invalid).toEqual(["correo-mal"]);
  });

  it("deduplica correos normalizando mayúsculas y espacios", () => {
    expect(uniqueEmails([" Uno@Empresa.com ", "uno@empresa.com", "malo"])).toEqual(["uno@empresa.com"]);
  });
});
