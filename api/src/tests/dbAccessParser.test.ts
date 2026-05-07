import { describe, it, expect } from "vitest";
import { parseDbAccessString } from "../lib/dbAccessParser";

describe("parseDbAccessString", () => {
  it("parsea el formato esperado con espacios", () => {
    const input =
      "data12.sagerp.co,54101; Initial Catalog = LA-COCINA-DE-LA-CASA; User ID = ATYNCONSULS-INS01 ; Password = example;";
    const result = parseDbAccessString(input);
    expect(result).toEqual({
      serverHostPort: "data12.sagerp.co,54101",
      initialCatalog: "LA-COCINA-DE-LA-CASA",
      userId: "ATYNCONSULS-INS01",
      password: "example",
    });
  });

  it("parsea sin espacios alrededor del igual", () => {
    const input =
      "data12.sagerp.co,54101;Initial Catalog=LA-COCINA-DE-LA-CASA;User ID=ATYNCONSULS-INS01;Password=example";
    const result = parseDbAccessString(input);
    expect(result.serverHostPort).toBe("data12.sagerp.co,54101");
    expect(result.initialCatalog).toBe("LA-COCINA-DE-LA-CASA");
    expect(result.userId).toBe("ATYNCONSULS-INS01");
    expect(result.password).toBe("example");
  });

  it("es insensible a mayúsculas/minúsculas en las claves", () => {
    const input =
      "data12.sagerp.co,54101; initial catalog = LA-COCINA-DE-LA-CASA; user id = ATYNCONSULS-INS01; password = example;";
    const result = parseDbAccessString(input);
    expect(result.initialCatalog).toBe("LA-COCINA-DE-LA-CASA");
    expect(result.userId).toBe("ATYNCONSULS-INS01");
    expect(result.password).toBe("example");
  });

  it("lanza error si la cadena está vacía", () => {
    expect(() => parseDbAccessString("")).toThrow();
    expect(() => parseDbAccessString("   ")).toThrow();
  });

  it("lanza error si falta la contraseña", () => {
    const input =
      "data12.sagerp.co,54101; Initial Catalog = X; User ID = Y;";
    expect(() => parseDbAccessString(input)).toThrow();
  });

  it("lanza error si falta el Initial Catalog", () => {
    const input = "data12.sagerp.co,54101; User ID = Y; Password = Z;";
    expect(() => parseDbAccessString(input)).toThrow();
  });
});
