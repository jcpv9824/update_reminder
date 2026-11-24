import { describe, expect, it } from "vitest";
import * as L from "../pages/queHayDeNuevo/logica";
import { entradasIniciales, USUARIOS_SIMULADOS } from "../pages/queHayDeNuevo/datosSimulados";
import type { DatosFormulario, Entrada } from "../pages/queHayDeNuevo/tipos";

const ahora = "2026-11-18T15:00:00.000Z";
const usuario = (id: string) => USUARIOS_SIMULADOS.find((u) => u.id === id)!;
const entrada = (id: string): Entrada => entradasIniciales().find((e) => e.id === id)!;

function ruta(id: string, ...valores: string[]) {
  return { id, niveles: valores.map((valor) => ({ valor })) };
}

function datosCompletos(cambio: Partial<DatosFormulario> = {}): DatosFormulario {
  return {
    tipo: "mejora",
    sistema: "sag_web",
    rutas: [ruta("r1", "Barra lateral", "Ventas", "Facturas", "Factura de venta")],
    queCambio: L.docDeTexto("Cambio"),
    acciones: [{ accionId: "probar_opciones", nombre: "Probar", texto: L.docDeTexto("Probar la factura") }],
    cliente: "",
    asesorInicialId: "",
    reglasNegocio: [],
    videos: [],
    ...cambio,
  };
}

describe("Qué hay de nuevo · constructor de rutas", () => {
  it("empieza con 3 niveles, agrega submenús hasta 5 y los quita hasta 3", () => {
    let r = L.rutaVacia();
    expect(r.niveles.map((n) => n.valor)).toEqual(["Barra de navegación", "", ""]);
    r = L.agregarSubmenu(L.agregarSubmenu(r));
    expect(r.niveles).toHaveLength(5);
    expect(L.agregarSubmenu(r).niveles).toHaveLength(5);
    r = L.quitarSubmenu(L.quitarSubmenu(L.quitarSubmenu(r)));
    expect(r.niveles).toHaveLength(3);
  });

  it("el submenú se agrega antes de la opción y × quita el último submenú", () => {
    const base = ruta("r", "Barra lateral", "Ventas", "Factura de venta");
    expect(L.agregarSubmenu(base).niveles.map((n) => n.valor)).toEqual(["Barra lateral", "Ventas", "", "Factura de venta"]);
    const cuatro = ruta("r", "Barra lateral", "Ventas", "Facturas", "Factura de venta");
    expect(L.quitarSubmenu(cuatro).niveles.map((n) => n.valor)).toEqual(["Barra lateral", "Ventas", "Factura de venta"]);
  });
});

describe("Qué hay de nuevo · validación al publicar", () => {
  it("acepta una entrada completa y exige el detalle de cada acción", () => {
    expect(L.contarErrores(L.validarParaPublicar(datosCompletos()))).toBe(0);
    const sinDetalle = L.validarParaPublicar(datosCompletos({ acciones: [{ accionId: "otro", nombre: "Otro", texto: null }] }));
    expect(sinDetalle.accionesTexto?.otro).toMatch(/Otro/);
  });

  it("exige cliente y asesor activo de Soporte solo para Nuevo", () => {
    const errores = L.validarParaPublicar(datosCompletos({ tipo: "nuevo" }), USUARIOS_SIMULADOS);
    expect(errores.cliente).toBeTruthy();
    expect(errores.asesorInicialId).toBeTruthy();
    const conInactivo = L.validarParaPublicar(datosCompletos({ tipo: "nuevo", cliente: "ACME", asesorInicialId: "u-sofia" }), USUARIOS_SIMULADOS);
    expect(conInactivo.asesorInicialId).toMatch(/activo/);
    expect(L.validarParaPublicar(datosCompletos(), USUARIOS_SIMULADOS).cliente).toBeUndefined();
  });

  it("rechaza rutas repetidas, incompletas y más de 10 rutas", () => {
    const r = datosCompletos().rutas[0];
    expect(L.validarParaPublicar(datosCompletos({ rutas: [r, { ...r, id: "r2" }] })).rutas).toMatch(/idénticas/);
    expect(L.validarParaPublicar(datosCompletos({ rutas: [L.rutaVacia()] })).rutas).toMatch(/Completa/);
    const muchas = Array.from({ length: 11 }, (_, i) => ruta(`r${i}`, "Barra lateral", "Ventas", `Opción ${i}`));
    expect(L.validarParaPublicar(datosCompletos({ rutas: muchas })).rutas).toMatch(/10/);
  });

  it("descarta los datos de Nuevo si el tipo cambia", () => {
    const limpio = L.normalizarDatos(datosCompletos({ cliente: "ACME", asesorInicialId: "u-felipe" }));
    expect(limpio.cliente).toBe("");
    expect(limpio.asesorInicialId).toBe("");
  });
});

describe("Qué hay de nuevo · ciclo de pruebas", () => {
  it("nadie prueba una entrada que creó o corrigió, y solo prueba Soporte", () => {
    expect(L.motivoNoPuedeTomar(entrada("e-103"), usuario("u-laura"))).toMatch(/creaste/);
    const editada = { ...entrada("e-102"), editoresIds: ["u-andres", "u-diana"] };
    expect(L.motivoNoPuedeTomar(editada, usuario("u-diana"))).toMatch(/editaste/);
    expect(L.motivoNoPuedeTomar(entrada("e-102"), usuario("u-andres"))).toMatch(/Soporte/);
    expect(L.motivoNoPuedeTomar(entrada("e-102"), usuario("u-laura"))).toBeNull();
  });

  it("soltar reinicia la prueba, conserva la ronda soltada y el texto para clientes, y lo registra en el historial", () => {
    let e = L.tomar(entrada("e-102"), usuario("u-laura"), ahora);
    expect(e.estado).toBe("en_pruebas");
    e = L.alternarChecklist(e, "u-laura", "dar_permiso");
    expect(L.avanceChecklist(e).hechos).toBe(1);
    e = { ...L.soltar(e, "u-laura", ahora), textoClientes: L.docDeTexto("se conserva") };
    expect(e.estado).toBe("sin_probar");
    expect(e.rondas.at(-2)?.resultado).toBe("soltada");
    expect(e.rondas.at(-2)?.checklist.dar_permiso).toBe(true);
    expect(L.avanceChecklist(e).hechos).toBe(0);
    expect(e.historial.at(-1)?.accion).toMatch(/Soltó/);
    e = L.tomar(e, usuario("u-felipe"), ahora);
    expect(L.avanceChecklist(e).hechos).toBe(0);
    expect(L.textoPlano(e.textoClientes)).toBe("se conserva");
    expect(L.asesoresParticipantes(e)).toEqual(["u-laura", "u-felipe"]);
  });

  it("marcar fallida exige un hallazgo vigente de la ronda actual; anular no borra", () => {
    let e = L.tomar(entrada("e-102"), usuario("u-laura"), ahora);
    expect(() => L.marcarFallida(e, "u-laura", ahora)).toThrow(/hallazgo/);
    e = L.agregarNota(e, "u-laura", L.docDeTexto("Falla"), true, ahora);
    e = L.anularHallazgo(e, "u-laura", 1, "Era un error de datos", ahora);
    expect(e.hallazgos).toHaveLength(1);
    expect(e.hallazgos[0].anulacion?.motivo).toBe("Era un error de datos");
    expect(() => L.marcarFallida(e, "u-laura", ahora)).toThrow(/hallazgo/);
    e = L.agregarNota(e, "u-laura", L.docDeTexto("Falla real"), true, ahora);
    expect(L.marcarFallida(e, "u-laura", ahora).estado).toBe("fallida");
  });

  it("marcar probado exige el checklist completo y solo lo hace quien la tiene", () => {
    let e = L.tomar(entrada("e-102"), usuario("u-laura"), ahora);
    expect(() => L.marcarProbado(e, "u-laura", ahora)).toThrow(/checklist/);
    e = L.alternarChecklist(L.alternarChecklist(e, "u-laura", "dar_permiso"), "u-laura", "probar_opciones");
    expect(() => L.marcarProbado(e, "u-felipe", ahora)).toThrow(/tomó/);
    const probada = L.marcarProbado(e, "u-laura", ahora);
    expect(probada.estado).toBe("probado");
    expect(probada.probadaEn).toBe(ahora);
  });

  it("el autor corrige en fallida o sin probar, nunca en pruebas; corregir abre ronda y conserva hallazgos", () => {
    expect(L.motivoNoPuedeCorregir(entrada("e-105"), "u-camilo")).toMatch(/suelte/);
    const corregida = L.corregir(entrada("e-106"), usuario("u-laura"), { queCambio: L.docDeTexto("Nuevo texto"), acciones: entrada("e-106").acciones, nota: null }, ahora);
    expect(corregida.estado).toBe("sin_probar");
    expect(corregida.rondas).toHaveLength(2);
    expect(corregida.hallazgos).toHaveLength(2);
  });

  it("las fallidas viven dentro de Probadas con su filtro de resultado", () => {
    expect(L.RESULTADOS_PROBADAS.ambas.estados).toEqual(expect.arrayContaining(["probado", "fallida"]));
    expect(L.RESULTADOS_PROBADAS.aprobadas.estados).not.toContain("fallida");
    expect(L.RESULTADOS_PROBADAS.fallidas.estados).toEqual(["fallida"]);
  });
});

describe("Qué hay de nuevo · página de clientes", () => {
  it("SP crítico nunca se muestra; Nuevo con cliente sí (se muestra a todos)", () => {
    expect(L.motivoNoPuedeMostrarClientes(entrada("e-110"))).toMatch(/nunca/);
    expect(L.visibleParaClientes(entrada("e-108"))).toBe(true);
    expect(entrada("e-108").cliente).not.toBe("");
    expect(L.visibleParaClientes({ ...entrada("e-110"), mostrarClientes: true, tituloClientes: "x", textoClientes: L.docDeTexto("x") })).toBe(false);
    expect(L.visibleParaClientes({ ...entrada("e-107"), estado: "archivada" })).toBe(false);
  });

  it("ordena de la más reciente a la más antigua y respeta la publicación activa", () => {
    expect(L.entradasPublicas(entradasIniciales(), true).map((e) => e.id)).toEqual(["e-108", "e-107"]);
    expect(L.entradasPublicas(entradasIniciales(), false)).toEqual([]);
  });

  it("filtra por mes de aprobación en hora de Bogotá", () => {
    const hoy = "2026-11-18T15:00:00.000Z";
    expect(L.cumpleFiltroFecha("2026-11-04T21:00:00.000Z", "mes_actual", hoy)).toBe(true);
    expect(L.cumpleFiltroFecha("2026-10-28T20:00:00.000Z", "mes_actual", hoy)).toBe(false);
    expect(L.cumpleFiltroFecha("2026-09-18T20:00:00.000Z", "ultimos_3", hoy)).toBe(true);
    expect(L.cumpleFiltroFecha("2026-08-31T20:00:00.000Z", "ultimos_3", hoy)).toBe(false);
    expect(L.cumpleFiltroFecha("2025-12-02T20:00:00.000Z", "ultimo_anio", hoy)).toBe(true);
    expect(L.cumpleFiltroFecha("2025-11-02T20:00:00.000Z", "ultimo_anio", hoy)).toBe(false);
    // 1 de noviembre a las 02:00 UTC todavía es 31 de octubre en Bogotá.
    expect(L.cumpleFiltroFecha("2026-11-01T02:00:00.000Z", "rango", hoy, { desde: "2026-10-01", hasta: "2026-10-31" })).toBe(true);
    expect(L.cumpleFiltroFecha(null, "todo", hoy)).toBe(true);
  });

  it("al copiar «Qué cambió» quita las menciones", () => {
    const limpio = L.quitarMenciones(entrada("e-104").queCambio);
    expect(L.textoPlano(limpio)).not.toContain("@");
    expect(L.textoPlano(entrada("e-104").queCambio)).toContain("@Camilo Rojas");
  });
});
