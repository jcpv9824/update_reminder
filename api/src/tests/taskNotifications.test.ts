import { describe, expect, it } from "vitest";
import { decidirNotificacionPorEstado } from "../lib/taskNotifications";

describe("decidirNotificacionPorEstado (matriz Atención + fallida + éxito)", () => {
  it("completada con éxito → correo de éxito", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "completed", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("exito");
  });

  it("completada con problemas → correo de problema (siempre, ignora blockedAlertsEnabled)", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "completed", completedWithProblems: true, blockedAlertsEnabled: false })).toBe("problema");
  });

  it("fallida → correo de problema cuando las alertas están activas", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "failed", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("problema");
  });

  it("fallida → sin correo si las alertas están desactivadas", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "failed", completedWithProblems: false, blockedAlertsEnabled: false })).toBe("none");
  });

  it("bloqueada → correo de problema cuando las alertas están activas", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "blocked", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("problema");
  });

  it("en progreso / cancelada / reabierta → sin correo", () => {
    expect(decidirNotificacionPorEstado({ newStatus: "in_progress", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("none");
    expect(decidirNotificacionPorEstado({ newStatus: "cancelled", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("none");
    expect(decidirNotificacionPorEstado({ newStatus: "pending", completedWithProblems: false, blockedAlertsEnabled: true })).toBe("none");
  });
});
