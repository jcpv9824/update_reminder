import { describe, it, expect } from "vitest";
import { toKeyVaultSecretName } from "../lib/keyVaultNames";

describe("toKeyVaultSecretName", () => {
  it("reemplaza guiones bajos por guiones", () => {
    expect(toKeyVaultSecretName("db-db_f9fd2821-password")).toBe("db-db-f9fd2821-password");
  });

  it("colapsa guiones repetidos", () => {
    expect(toKeyVaultSecretName("db--db__pwd")).toBe("db-db-pwd");
  });

  it("elimina guiones al inicio y al final", () => {
    expect(toKeyVaultSecretName("__db-pwd__")).toBe("db-pwd");
  });

  it("permite letras y números, descarta el resto", () => {
    expect(toKeyVaultSecretName("DB.123 / PWD@xyz")).toBe("DB-123-PWD-xyz");
  });

  it("limita la longitud a 127", () => {
    const r = toKeyVaultSecretName("a".repeat(200));
    expect(r.length).toBeLessThanOrEqual(127);
  });
});
