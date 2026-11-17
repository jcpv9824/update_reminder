import { describe, expect, it } from "vitest";
import { z } from "zod";
import { partialUpdate } from "../lib/zodPartial";

const Schema = z.object({
  nombre: z.string().trim().min(1),
  activo: z.boolean().default(true),
  status: z.enum(["active", "inactive"]).optional().default("active"),
  ids: z.array(z.string()).default([]),
}).strict();

describe("partialUpdate", () => {
  it("leaves omitted fields undefined instead of applying defaults (Zod 4 regression guard)", () => {
    expect(partialUpdate(Schema).parse({ nombre: " x " })).toEqual({ nombre: "x" });
    expect(partialUpdate(Schema).parse({})).toEqual({});
  });

  it("keeps the validation and the values that are sent", () => {
    expect(partialUpdate(Schema).parse({ activo: false, status: "inactive", ids: ["a"] }))
      .toEqual({ activo: false, status: "inactive", ids: ["a"] });
    expect(partialUpdate(Schema).safeParse({ nombre: "" }).success).toBe(false);
    expect(partialUpdate(Schema).safeParse({ status: "deleted" }).success).toBe(false);
    expect(partialUpdate(Schema).safeParse({ otro: 1 }).success).toBe(false);
  });

  it("does not change the full schema used to create", () => {
    expect(Schema.parse({ nombre: "x" })).toEqual({ nombre: "x", activo: true, status: "active", ids: [] });
  });
});
