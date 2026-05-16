import { describe, expect, it } from "vitest";
import { paginateArray } from "../lib/pagination";

function buscar<T>(items: T[], texto: string, selector: (item: T) => string) {
  const normalizado = texto.trim().toLowerCase();
  return items.filter((item) => selector(item).toLowerCase().includes(normalizado));
}

describe("pagination", () => {
  const registros = Array.from({ length: 25 }, (_, index) => ({
    id: `item_${index + 1}`,
    name: `Cliente ${index + 1}`,
    status: index % 2 === 0 ? "active" : "inactive",
  }));

  it("retorna máximo 10 registros cuando pageSize es 10", () => {
    const result = paginateArray(registros, 1, 10);

    expect(result.items).toHaveLength(10);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.total).toBe(25);
  });

  it("retorna datos diferentes en página 2 cuando hay suficientes registros", () => {
    const page1 = paginateArray(registros, 1, 10);
    const page2 = paginateArray(registros, 2, 10);

    expect(page1.items.map((item) => item.id)).not.toEqual(page2.items.map((item) => item.id));
    expect(page2.items[0].id).toBe("item_11");
  });

  it("mantiene filtros y búsqueda antes de paginar", () => {
    const activos = registros.filter((item) => item.status === "active");
    const buscados = buscar(activos, "cliente 2", (item) => item.name);
    const result = paginateArray(buscados, 1, 10);

    expect(result.items.every((item) => item.status === "active")).toBe(true);
    expect(result.items.every((item) => item.name.toLowerCase().includes("cliente 2"))).toBe(true);
    expect(result.total).toBe(buscados.length);
  });
});
