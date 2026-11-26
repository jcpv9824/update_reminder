import { describe, expect, it } from "vitest";
import { checkCombination, decideEnvironment, preparePointSave, mayWriteChecklist, checklistProgress } from "../lib/checklistDomain";

const clientId = "cliente";
const templateId = "plantilla";
const combination = { clientId, templateId, environment: "testing" as const };
const entry = { ...combination, id: "anterior", status: "in_progress" as const, deleted: false };
const point = { pointId: "punto", checked: false, notes: null };
const expectConflict = (operation: () => unknown, error: string) => expect(operation).toThrow(expect.objectContaining({ status: 409, error }));

describe("Reglas de Checklists, sin SQL ni HTTP", () => {
  it("CA-04 CA-05 el ambiente es obligatorio si la vigente lo pide, nulo si no", () => {
    expect(() => decideEnvironment(true)).toThrow(expect.objectContaining({ status: 400 }));
    expect(decideEnvironment(true, "demo")).toBe("demo");
    expect(decideEnvironment(false)).toBeNull();
    expect(() => decideEnvironment(false, "testing")).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("CA-06 bloquea un en progreso de la misma combinación antes de la confirmación", () => {
    expectConflict(() => checkCombination(combination, [entry], { confirmDuplicate: true }), "duplicate_in_progress");
  });
  it("CA-07 solo con confirmación permite crear sobre un completado", () => {
    const completed = { ...entry, status: "completed" as const };
    expectConflict(() => checkCombination(combination, [completed]), "duplicate_completed");
    expect(() => checkCombination(combination, [completed], { confirmDuplicate: true })).not.toThrow();
  });
  it("CA-08 CA-09 permite ambientes distintos e ignora borrados", () => {
    expect(() => checkCombination({ ...combination, environment: "production" }, [entry])).not.toThrow();
    expect(() => checkCombination(combination, [{ ...entry, deleted: true }])).not.toThrow();
    expectConflict(() => checkCombination({ ...combination, environment: null }, [{ ...entry, environment: null }]), "duplicate_in_progress");
  });
  it("CA-10 CA-11 solo el responsable o superadministrador pueden escribir", () => {
    expect(mayWriteChecklist({ id: "otro", canView: true, isSuperAdmin: false }, "dueño")).toBe(false);
    expect(mayWriteChecklist({ id: "dueño", canView: true, isSuperAdmin: false }, "dueño")).toBe(true);
    expect(mayWriteChecklist({ id: "dueño", canView: false, isSuperAdmin: false }, "dueño")).toBe(false);
    expect(mayWriteChecklist({ id: "otro", canView: false, isSuperAdmin: true }, "dueño")).toBe(true);
  });
  it("CA-13 rechaza la finalización incompleta con los puntos faltantes", () => {
    expect(() => preparePointSave(["punto"], [point], true)).toThrow(expect.objectContaining({
      status: 422, error: "missing_points", details: { pointIds: ["punto"] },
    }));
  });
  it("CA-14 permite finalizar con todos marcados, sin texto ni evidencias", () => {
    expect(preparePointSave(["punto"], [{ ...point, checked: true }], true)).toEqual([{ ...point, checked: true }]);
  });
  it("CA-15 deja guardar cero marcados y conserva el documento del punto", () => {
    const notes = { type: "doc" as const, content: [{ type: "paragraph" }] };
    expect(preparePointSave(["punto"], [{ ...point, notes }], false)).toEqual([{ ...point, notes }]);
    expect(() => preparePointSave(["punto"], [{ ...point, pointId: "otro" }], false)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("CA-35 reabrir no exige confirmar completados, pero no admite otro en progreso", () => {
    const completed = { ...entry, status: "completed" as const };
    expect(() => checkCombination(combination, [completed], { reopeningId: completed.id })).not.toThrow();
    expectConflict(() => checkCombination(combination, [completed, { ...entry, id: "segundo" }], { reopeningId: completed.id }), "duplicate_in_progress");
  });
  it("RN-20 calcula el porcentaje entero de avance", () => {
    expect(checklistProgress(1, 3)).toBe(33);
    expect(checklistProgress(2, 3)).toBe(67);
    expect(checklistProgress(0, 0)).toBe(0);
  });
});
