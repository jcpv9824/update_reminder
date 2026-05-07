import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelectorBuscable } from "../components/SelectorBuscable";

const opciones = [
  { id: "1", etiqueta: "Cliente Alfa" },
  { id: "2", etiqueta: "Cliente Beta" },
  { id: "3", etiqueta: "Cliente Gamma", subtitulo: "Centro" },
];

describe("SelectorBuscable", () => {
  it("filtra por etiqueta", () => {
    const onChange = vi.fn();
    render(<SelectorBuscable opciones={opciones} valor="" onChange={onChange} placeholder="Buscar..." />);
    const input = screen.getByPlaceholderText("Buscar...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.getByText("Cliente Beta")).toBeInTheDocument();
    expect(screen.queryByText("Cliente Alfa")).toBeNull();
  });

  it("permite seleccionar una opción", () => {
    const onChange = vi.fn();
    render(<SelectorBuscable opciones={opciones} valor="" onChange={onChange} placeholder="Buscar..." />);
    fireEvent.focus(screen.getByPlaceholderText("Buscar..."));
    fireEvent.mouseDown(screen.getByText("Cliente Alfa"));
    expect(onChange).toHaveBeenCalledWith("1");
  });

  it("muestra opción 'sin selección' cuando permiteVacio", () => {
    render(<SelectorBuscable opciones={opciones} valor="2" onChange={() => {}} permiteVacio textoVacio="Todos" placeholder="..." />);
    fireEvent.focus(screen.getByPlaceholderText("..."));
    expect(screen.getByText("Todos")).toBeInTheDocument();
  });
});
