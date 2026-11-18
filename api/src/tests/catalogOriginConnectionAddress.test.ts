import { describe, expect, it } from "vitest";
import { parseCatalogOriginConnectionAddress } from "../lib/catalogOriginConnectionAddress";

describe("catalog origin address notation", () => {
  it("separates an explicit port from an asserted instance name", () => {
    expect(parseCatalogOriginConnectionAddress("tcp:db.example.test\\SAG_ERP,15433")).toEqual({
      server: "db.example.test", port: 15433, expectedInstanceName: "SAG_ERP",
    });
    expect(parseCatalogOriginConnectionAddress("db.example.test\\SAG_ERP", "15433")).toEqual({
      server: "db.example.test", port: 15433, expectedInstanceName: "SAG_ERP",
    });
    expect(parseCatalogOriginConnectionAddress("db.example.test,15433\\SAG_ERP")).toEqual({
      server: "db.example.test", port: 15433, expectedInstanceName: "SAG_ERP",
    });
    expect(parseCatalogOriginConnectionAddress("db.example.test, 1433")).toEqual({ server: "db.example.test", port: 1433 });
    expect(parseCatalogOriginConnectionAddress("db.example.test")).toEqual({ server: "db.example.test", port: 1433 });
  });

  it("never discovers a named port, silently chooses among conflicting ports, or reads a connection string", () => {
    for (const input of ["db.example.test\\SAG_ERP", "db.example.test;Server=db2.example.test", "https://db.example.test,443",
      "db..example.test,15433", "db.example.test,65536", "db.example.test,0", "db.example.test\\SAG_ERP,15433 trailing"]) {
      expect(parseCatalogOriginConnectionAddress(input)).toBeNull();
    }
    expect(parseCatalogOriginConnectionAddress("db.example.test,15433", "1433")).toBeNull();
    expect(parseCatalogOriginConnectionAddress("db.example.test\\SAG_ERP,15433\\OTHER")).toBeNull();
  });
});
