import { describe, expect, it } from "vitest";
import { CreateChecklistSchema, FindChecklistClientsSchema, SaveChecklistSchema } from "../lib/checklistRequestSchemas";

const clientId = "11111111-1111-4111-8111-111111111111";
const templateId = "22222222-2222-4222-8222-222222222222";
const pointId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const rowVersion = "AAAAAAAAAAE=";
const emptyEvidence = { add: [], remove: [] };

describe("Checklists: validación del contrato, sin acceso SQL", () => {
  it("CA-01 rechaza una consulta de cliente de menos de tres letras", () => {
    expect(FindChecklistClientsSchema.safeParse({ q: "  po " }).success).toBe(false);
    expect(FindChecklistClientsSchema.safeParse({ q: "123" }).success).toBe(false);
    expect(FindChecklistClientsSchema.parse({ q: " póL " })).toEqual({ q: "póL" });
  });

  it("CA-03 no acepta texto de cliente, versión ni responsable enviados por el navegador", () => {
    for (const extras of [{ clientName: "Cliente" }, { ownerId: clientId }, { versionNumber: 2 }]) {
      expect(CreateChecklistSchema.safeParse({ clientId, templateId, ...extras }).success).toBe(false);
    }
    expect(CreateChecklistSchema.safeParse({ templateId, clientId: "cliente escrito" }).success).toBe(false);
  });

  it("CA-04 CA-05 restringe los ambientes sin aplicar un valor por defecto", () => {
    expect(CreateChecklistSchema.parse({ clientId, templateId })).toEqual({ clientId, templateId });
    for (const environment of ["testing", "production", "demo"]) {
      expect(CreateChecklistSchema.safeParse({ clientId, templateId, environment }).success).toBe(true);
    }
    for (const environment of ["", "staging", null]) {
      expect(CreateChecklistSchema.safeParse({ clientId, templateId, environment }).success).toBe(false);
    }
  });

  it("CA-07 no convierte una cadena en confirmación de duplicado", () => {
    expect(CreateChecklistSchema.safeParse({ clientId, templateId, confirmDuplicate: "true" }).success).toBe(false);
    expect(CreateChecklistSchema.safeParse({ clientId, templateId, confirmDuplicate: true }).success).toBe(true);
  });

  it("CA-15 conserva notas al desmarcar un punto y rechaza HTML como documento", () => {
    const notes = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Nota" }] }] };
    const payload = { rowVersion, evidence: emptyEvidence, points: [{ pointId, checked: false, notes }] };
    expect(SaveChecklistSchema.parse(payload)).toEqual(payload);
    expect(SaveChecklistSchema.safeParse({ ...payload, points: [{ pointId, checked: false, notes: "<p>Nota</p>" }] }).success).toBe(false);
  });

  it("CA-34 exige ROWVERSION y rechaza puntos repetidos", () => {
    const point = { pointId, checked: true, notes: null };
    const payload = { rowVersion, evidence: emptyEvidence, points: [point] };
    expect(SaveChecklistSchema.safeParse(payload).success).toBe(true);
    expect(SaveChecklistSchema.safeParse({ ...payload, rowVersion: "1" }).success).toBe(false);
    expect(SaveChecklistSchema.safeParse({ ...payload, points: [point, point] }).success).toBe(false);
  });

  it("RN-43 RN-44 rechaza un ID de evidencia repetido o en ambas operaciones", () => {
    const payload = { rowVersion, points: [{ pointId, checked: true, notes: null }] };
    for (const evidence of [{ add: [evidenceId, evidenceId], remove: [] }, { add: [evidenceId], remove: [evidenceId] }]) {
      expect(SaveChecklistSchema.safeParse({ ...payload, evidence }).success).toBe(false);
    }
  });
});
