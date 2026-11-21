import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import ResolucionConflictosProgramacion, {
  type ScheduleConflictPreview,
  type RemainingScheduleDraft,
} from "../components/ResolucionConflictosProgramacion";

const preview: ScheduleConflictPreview = {
  previewId: "preview-one",
  groups: [
    { kind: "domain", physicalTargetId: "target-1", label: "Dominio con conflicto",
      conflict: { id: "conflict-1", reason: "Otra operación vigente" },
      links: [{ id: "conflicting-domain", label: "Dominio excluido", verified: true }] },
    { kind: "database", physicalTargetId: "target-1", label: "Base bajo el mismo dominio",
      links: [{ id: "eligible-db", label: "Base elegible", verified: true },
        { id: "pending-db", label: "Base sin verificar", verified: false }] },
    { kind: "domain", physicalTargetId: "target-2", label: "Dominio sin conflicto",
      links: [{ id: "eligible-domain", label: "Dominio elegible", verified: true }] },
  ],
};

describe("resolución de conflictos de programación", () => {
  it("abre un borrador nuevo editable sin guardar ni modificar la original y conserva la base elegible", () => {
    const onOpenDraft = vi.fn();
    const onAllowDouble = vi.fn();
    const onSubmitOriginal = vi.fn();
    function Host() {
      const [draft, setDraft] = useState<RemainingScheduleDraft | null>(null);
      return <form onSubmit={onSubmitOriginal}>
        {draft ? <section aria-label="Nuevo borrador">
          {preview.groups.flatMap(group => group.links).filter(link => draft.linkIds.includes(link.id))
            .map(link => <label key={link.id}><input type="checkbox" defaultChecked />{link.label}</label>)}
        </section> : <ResolucionConflictosProgramacion preview={preview} onAllowDouble={onAllowDouble}
          onOpenDraft={value => { onOpenDraft(value); setDraft(value); }} />}
      </form>;
    }
    render(<Host />);

    fireEvent.click(screen.getByRole("button", { name: "Trabajar con las restantes" }));
    const draft = screen.getByRole("region", { name: "Nuevo borrador" });
    expect(within(draft).getByRole("checkbox", { name: "Base elegible" })).toBeChecked();
    expect(within(draft).getByRole("checkbox", { name: "Dominio elegible" })).toBeChecked();
    expect(within(draft).queryByRole("checkbox", { name: "Dominio excluido" })).not.toBeInTheDocument();
    expect(within(draft).queryByRole("checkbox", { name: "Base sin verificar" })).not.toBeInTheDocument();
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith({ kind: "new", previewId: "preview-one", linkIds: ["eligible-db", "eligible-domain"] });
    fireEvent.click(within(draft).getByRole("checkbox", { name: "Dominio elegible" }));
    expect(within(draft).getByRole("checkbox", { name: "Dominio elegible" })).not.toBeChecked();
    expect(onSubmitOriginal).not.toHaveBeenCalled();
    expect(onAllowDouble).not.toHaveBeenCalled();
  });

  it("solo permite trabajo doble tras elegir el conflicto, escribir un motivo y confirmar", () => {
    const onAllowDouble = vi.fn();
    const onOpenDraft = vi.fn();
    render(<ResolucionConflictosProgramacion preview={preview} onOpenDraft={onOpenDraft} onAllowDouble={onAllowDouble} />);
    fireEvent.click(screen.getByRole("button", { name: "Permitir doble" }));
    const confirmation = screen.getByRole("region", { name: "Confirmar trabajo doble" });
    const confirm = within(confirmation).getByRole("button", { name: "Confirmar Permitir doble" });
    expect(confirm).toBeDisabled();
    expect(onAllowDouble).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("checkbox", { name: /Dominio con conflicto/ }));
    expect(confirm).toBeDisabled();
    fireEvent.change(within(confirmation).getByRole("textbox", { name: "Motivo" }),
      { target: { value: "  Ventana aprobada por responsables  " } });
    fireEvent.click(confirm);
    expect(onAllowDouble).toHaveBeenCalledExactlyOnceWith({
      previewId: "preview-one", conflictIds: ["conflict-1"], reason: "Ventana aprobada por responsables",
    });
    expect(onOpenDraft).not.toHaveBeenCalled();
  });

  it("no ofrece trabajo doble sin un consumidor autorizado y entrega solo vínculos de la vista previa vigente", () => {
    const onOpenDraft = vi.fn();
    const { rerender } = render(<ResolucionConflictosProgramacion preview={preview} onOpenDraft={onOpenDraft} />);
    expect(screen.getByRole("button", { name: "Permitir doble" })).toBeDisabled();
    rerender(<ResolucionConflictosProgramacion preview={{ previewId: "preview-two", groups: [preview.groups[2]] }} onOpenDraft={onOpenDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "Trabajar con las restantes" }));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith({ kind: "new", previewId: "preview-two", linkIds: ["eligible-domain"] });
  });

  it("no permite un borrador vacío cuando todos los vínculos tienen conflicto o falta evidencia", () => {
    const onOpenDraft = vi.fn();
    render(<ResolucionConflictosProgramacion
      preview={{ ...preview, groups: [preview.groups[0], { ...preview.groups[1], links: [preview.groups[1].links[1]] }] }}
      onOpenDraft={onOpenDraft} />);
    expect(screen.getByRole("button", { name: "Trabajar con las restantes" })).toBeDisabled();
    expect(screen.getByText("No quedan destinos verificados sin conflicto.")).toBeInTheDocument();
    expect(onOpenDraft).not.toHaveBeenCalled();
  });

  it("excluye toda aparición del mismo destino en conflicto, pero nunca arrastra el conflicto al otro tipo", () => {
    const onOpenDraft = vi.fn();
    render(<ResolucionConflictosProgramacion
      preview={{ ...preview, groups: [preview.groups[0], { kind: "domain", physicalTargetId: "target-1", label: "Alias",
        links: [{ id: "alias", label: "Alias de dominio", verified: true }] }, preview.groups[1]] }}
      onOpenDraft={onOpenDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "Trabajar con las restantes" }));
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith({ kind: "new", previewId: "preview-one", linkIds: ["eligible-db"] });
  });
});
