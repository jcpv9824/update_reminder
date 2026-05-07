import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccesoBdParseado } from "../components/AccesoBdParseado";

describe("AccesoBdParseado", () => {
  it("muestra las cuatro partes del acceso, ocultando la contraseña", () => {
    const cadena = "data12.sagerp.co,54101; Initial Catalog = LCC; User ID = U1; Password = secreto;";
    render(<AccesoBdParseado texto={cadena} />);
    expect(screen.getByText(/data12\.sagerp\.co,54101/)).toBeInTheDocument();
    expect(screen.getByText(/LCC/)).toBeInTheDocument();
    expect(screen.getByText(/U1/)).toBeInTheDocument();
    // La contraseña real no debe aparecer en la vista previa.
    expect(screen.queryByText(/secreto/)).toBeNull();
    expect(screen.getByText(/Detectada/i)).toBeInTheDocument();
  });

  it("muestra mensaje de error en español si la cadena es inválida", () => {
    render(<AccesoBdParseado texto="cadena-invalida" />);
    expect(screen.getByText(/debe incluir/i)).toBeInTheDocument();
  });
});
