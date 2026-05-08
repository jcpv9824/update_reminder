import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SeleccionFrecuencia, depurarFrecuenciaParaEnvio, valoresFrecuenciaPorDefecto, type ValoresFrecuencia } from "../components/SeleccionFrecuencia";
import type { Usuario } from "../types";

const usuarios: Usuario[] = [
  { id: "mateo", displayName: "Mateo Palacio", email: "mateo@empresa.com", roles: ["domain_updater"], active: true },
  { id: "laura", displayName: "Laura Gomez", email: "laura@empresa.com", roles: ["database_updater"], active: true },
  { id: "inactivo", displayName: "Inactivo", email: "inactivo@empresa.com", roles: ["domain_updater"], active: false },
];

function renderSelector(valor: ValoresFrecuencia = valoresFrecuenciaPorDefecto("domain_updater")) {
  const onChange = vi.fn();
  render(<SeleccionFrecuencia valor={valor} onChange={onChange} usuarios={usuarios} tipoObjetivo="domain" rolesPermitidos={["domain_updater"]} />);
  return onChange;
}

describe("SeleccionFrecuencia", () => {
  it("inicia en modo rol con recordatorios activos y dias 1, 0", () => {
    renderSelector();
    expect(screen.getAllByLabelText("Usar rol predeterminado")[0]).toBeChecked();
    expect(screen.getByLabelText("Activar recordatorios automáticos")).toBeChecked();
    expect(screen.getByDisplayValue("1, 0")).toBeInTheDocument();
    expect(screen.getByText(/Las tareas y recordatorios se asignarán automáticamente a las personas con el rol Actualizador de dominios/i)).toBeInTheDocument();
  });

  it("muestra selector al elegir responsable especifico y no lista usuarios inactivos", () => {
    renderSelector();
    fireEvent.click(screen.getAllByLabelText("Asignar responsable específico")[0]);
    expect(screen.getByLabelText("Responsable específico")).toBeInTheDocument();
    expect(screen.getByText(/Mateo Palacio/i)).toBeInTheDocument();
    expect(screen.queryByText(/Inactivo/i)).toBeNull();
  });

  it("envia assignedUserIds y reminderRecipientsMode assignedUsers cuando hay responsable manual", () => {
    const valor = valoresFrecuenciaPorDefecto("domain_updater");
    const depurado = depurarFrecuenciaParaEnvio({
      ...valor,
      assignedUserIds: ["mateo"],
      reminders: { ...valor.reminders, reminderRecipientsMode: "assignedUsers" },
    });
    expect(depurado.assignedUserIds).toEqual(["mateo"]);
    expect(depurado.reminders.reminderRecipientsMode).toBe("assignedUsers");
  });

  it("al volver al modo predeterminado limpia responsables y usa roleUsers", () => {
    const valor = {
      ...valoresFrecuenciaPorDefecto("domain_updater"),
      assignedUserIds: ["mateo"],
      reminders: { ...valoresFrecuenciaPorDefecto("domain_updater").reminders, reminderRecipientsMode: "assignedUsers" as const },
    };
    const onChange = renderSelector(valor);
    fireEvent.click(screen.getAllByLabelText("Usar rol predeterminado")[0]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      assignedUserIds: [],
      reminders: expect.objectContaining({ reminderRecipientsMode: "roleUsers" }),
    }));
  });

  it("carga en modo manual cuando la frecuencia existente tiene assignedUserIds", () => {
    renderSelector({
      ...valoresFrecuenciaPorDefecto("domain_updater"),
      assignedUserIds: ["mateo"],
      reminders: { ...valoresFrecuenciaPorDefecto("domain_updater").reminders, reminderRecipientsMode: "assignedUsers" },
    });
    expect(screen.getAllByLabelText("Asignar responsable específico")[0]).toBeChecked();
    expect(screen.getByLabelText("Responsable específico")).toBeInTheDocument();
  });

  it("carga en modo rol cuando la frecuencia existente no tiene assignedUserIds", () => {
    renderSelector({
      ...valoresFrecuenciaPorDefecto("domain_updater"),
      assignedUserIds: [],
      reminders: { ...valoresFrecuenciaPorDefecto("domain_updater").reminders, reminderRecipientsMode: "roleUsers" },
    });
    expect(screen.getAllByLabelText("Usar rol predeterminado")[0]).toBeChecked();
  });

  it("permite definir responsables especificos para bases heredadas", () => {
    const valor = valoresFrecuenciaPorDefecto("domain_updater");
    const depurado = depurarFrecuenciaParaEnvio({
      ...valor,
      databaseAssignedUserIds: ["laura"],
      databaseReminderRecipientsMode: "assignedUsers",
    });
    expect(depurado.databaseAssignedUserIds).toEqual(["laura"]);
    expect(depurado.databaseReminderRecipientsMode).toBe("assignedUsers");
  });
});
