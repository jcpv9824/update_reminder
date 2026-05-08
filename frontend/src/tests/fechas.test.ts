import { describe, it, expect } from "vitest";
import { clasificarTareaPorFecha, hoyEnBogotaIso, sumarDiasIso } from "../utils/fechas";

describe("clasificación de tareas por fecha (zona Bogotá)", () => {
  it("tarea de hoy aparece en HOY", () => {
    expect(clasificarTareaPorFecha("2026-05-07", "pending", "2026-05-07")).toBe("hoy");
  });

  it("tarea de mañana aparece en PRÓXIMAS, no en HOY (bug del 2026-05-08)", () => {
    expect(clasificarTareaPorFecha("2026-05-08", "pending", "2026-05-07")).toBe("proximas");
  });

  it("tarea de ayer pendiente aparece en VENCIDAS", () => {
    expect(clasificarTareaPorFecha("2026-05-06", "pending", "2026-05-07")).toBe("vencidas");
  });

  it("tarea completada aparece en COMPLETADAS sin importar la fecha", () => {
    expect(clasificarTareaPorFecha("2026-05-06", "completed", "2026-05-07")).toBe("completadas");
    expect(clasificarTareaPorFecha("2026-05-08", "completed", "2026-05-07")).toBe("completadas");
  });

  it("hoyEnBogotaIso a las 8pm Bogotá del 7 de mayo NO devuelve 8 de mayo", () => {
    // 8pm Bogotá = 01:00 UTC del día siguiente.
    // Si usáramos toISOString() sin compensar, daría "2026-05-08".
    const fakeNow = new Date("2026-05-08T01:00:00Z");
    expect(hoyEnBogotaIso(fakeNow)).toBe("2026-05-07");
  });

  it("hoyEnBogotaIso a las 11pm Bogotá del 7 de mayo sigue siendo 7 de mayo", () => {
    const fakeNow = new Date("2026-05-08T04:00:00Z"); // 11pm Bogotá del 7
    expect(hoyEnBogotaIso(fakeNow)).toBe("2026-05-07");
  });

  it("hoyEnBogotaIso a las 4am Bogotá del 8 de mayo es 8 de mayo", () => {
    const fakeNow = new Date("2026-05-08T09:00:00Z"); // 4am Bogotá del 8
    expect(hoyEnBogotaIso(fakeNow)).toBe("2026-05-08");
  });

  it("sumarDiasIso preserva fechas correctamente", () => {
    expect(sumarDiasIso("2026-05-07", 1)).toBe("2026-05-08");
    expect(sumarDiasIso("2026-05-07", -7)).toBe("2026-04-30");
    expect(sumarDiasIso("2026-05-07", 7)).toBe("2026-05-14");
  });
});
