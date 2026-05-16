import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Paginacion } from "../components/Comunes";

describe("Paginacion", () => {
  it("muestra rango, página actual y total de páginas", () => {
    render(<Paginacion page={1} pageSize={10} total={85} onPageChange={vi.fn()} />);

    expect(screen.getByText("Mostrando 1-10 de 85")).toBeInTheDocument();
    expect(screen.getByText("Página 1 de 9")).toBeInTheDocument();
  });

  it("permite avanzar y volver de página", () => {
    const onPageChange = vi.fn();
    render(<Paginacion page={2} pageSize={10} total={85} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });
});
