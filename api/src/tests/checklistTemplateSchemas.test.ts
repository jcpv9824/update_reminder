import { describe, expect, it } from "vitest";
import { CreateTemplateSchema, SaveTemplateVersionSchema, TemplateIdParamsSchema, TemplateVersionParamsSchema } from "../lib/checklistTemplateSchemas";

const id = "11111111-1111-4111-8111-111111111111";
const rowVersion = "AAAAAAAAAAE=";
const save = () => ({ requiresEnvironment: false, points: [{ title: "Punto" }], rowVersion });

describe("Plantillas · contratos de solicitud (no HTTP)", () => {
  it("CA-33 / RN-30 recorta el nombre y exige 1–150 caracteres", () => {
    expect(CreateTemplateSchema.parse({ name: "  Migración  " })).toEqual({ name: "Migración" });
    for (const name of ["", "   ", "x".repeat(151)]) expect(CreateTemplateSchema.safeParse({ name }).success).toBe(false);
    expect(CreateTemplateSchema.safeParse({ name: "x".repeat(150) }).success).toBe(true);
  });
  it("CA-32 / RN-32 rechaza campos de dueño, permisos y estado enviados por el cliente", () => {
    for (const extra of [{ ownerId: id }, { createdBy: id }, { status: "current" }, { isSuperAdmin: true }]) {
      expect(CreateTemplateSchema.safeParse({ name: "Plantilla", ...extra }).success).toBe(false);
      expect(SaveTemplateVersionSchema.safeParse({ ...save(), ...extra }).success).toBe(false);
    }
  });
  it("CA-24 / RN-37–38 limita puntos, títulos y detalles sin imponer un mínimo al guardar", () => {
    expect(SaveTemplateVersionSchema.parse({ ...save(), points: [] }).points).toEqual([]);
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: Array.from({ length: 101 }, () => ({ title: "P" })) }).success).toBe(false);
    for (const title of ["", "  ", "x".repeat(201)]) expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: [{ title }] }).success).toBe(false);
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: [{ title: "P", detail: "x".repeat(1001) }] }).success).toBe(false);
    expect(SaveTemplateVersionSchema.parse({ ...save(), points: [{ title: " P ", detail: "  \n " }] }).points[0]).toEqual({ title: "P", detail: null });
  });
  it("CA-37 / API-26 exige booleano explícito y una ROWVERSION base64 canónica de ocho bytes", () => {
    expect(SaveTemplateVersionSchema.parse(save()).requiresEnvironment).toBe(false);
    for (const invalid of ["", "1", "AAAAAAAAAAE", "AAAAAAAAAAE==", "AAAAAAAAAA==", "AAAAAAAAAAF=", "0000000000000001"]) {
      expect(SaveTemplateVersionSchema.safeParse({ ...save(), rowVersion: invalid }).success).toBe(false);
    }
    expect(SaveTemplateVersionSchema.safeParse({ points: [], rowVersion }).success).toBe(false);
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), requiresEnvironment: "false" }).success).toBe(false);
  });
  it("CA-24 / API-26 exige UUIDs únicos para puntos existentes y rechaza campos ajenos", () => {
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: [{ id, title: "Uno" }, { id, title: "Dos" }] }).success).toBe(false);
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: [{ id: "otro", title: "P" }] }).success).toBe(false);
    expect(SaveTemplateVersionSchema.safeParse({ ...save(), points: [{ title: "P", versionId: id }] }).success).toBe(false);
  });
  it("CA-22–27 / API-22–28 valida ID UUID y número entero positivo de ruta", () => {
    expect(TemplateIdParamsSchema.parse({ id })).toEqual({ id });
    expect(TemplateVersionParamsSchema.parse({ id, number: "3" })).toEqual({ id, number: 3 });
    for (const number of [0, -1, 1.2, "1.0", "3x", true, "", "0"]) expect(TemplateVersionParamsSchema.safeParse({ id, number }).success).toBe(false);
    expect(TemplateIdParamsSchema.safeParse({ id: "no-es-un-uuid" }).success).toBe(false);
  });
});
