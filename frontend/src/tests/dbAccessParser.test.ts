import { describe, it, expect } from "vitest";
import { parseDbAccessString } from "../utils/dbAccessParser";

describe("frontend - parseDbAccessString", () => {
  it("parsea correctamente la cadena estándar", () => {
    const r = parseDbAccessString(
      "data12.sagerp.co,54101; Initial Catalog = LA-COCINA-DE-LA-CASA; User ID = ATYNCONSULS-INS01 ; Password = example;"
    );
    expect(r).toEqual({
      serverHostPort: "data12.sagerp.co,54101",
      initialCatalog: "LA-COCINA-DE-LA-CASA",
      userId: "ATYNCONSULS-INS01",
      password: "example",
    });
  });

  it("muestra mensaje en español al fallar", () => {
    expect(() => parseDbAccessString("")).toThrow(/obligatoria/i);
  });
});
