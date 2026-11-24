import { useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueHayDeNuevo } from "./almacen";
import { Dialogo } from "./componentes/Comunes";
import { VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { categoriaCliente, cumpleFiltroFecha, entradasPublicas, mesAnio, rutaTexto, textoPlano, type FiltroFechaPublica } from "./logica";
import "./queHayDeNuevo.css";

/*
 * Visión Cliente · /novedades (diseño §6). Página completa, sin inicio de sesión y sin barra lateral,
 * como /formatos-impresion. Solo muestra el texto para clientes de entradas probadas y marcadas para mostrar.
 * Mostrar a clientes = mostrar a TODOS los clientes. Nunca muestra: cliente, desarrollador, asesores,
 * documentos de reglas de negocio, videos, notas internas ni hallazgos.
 */

const LOGO_SAG_WEB = "https://pya.com.co/wp-content/uploads/2025/12/H_LOGO.png";

type Filtro = "todo" | "nuevo" | "mejora";

const OPCIONES_FECHA: { id: FiltroFechaPublica; etiqueta: string }[] = [
  { id: "mes_actual", etiqueta: "Mes actual" },
  { id: "ultimos_3", etiqueta: "Últimos 3 meses" },
  { id: "ultimo_anio", etiqueta: "Último año" },
  { id: "todo", etiqueta: "Todo" },
  { id: "rango", etiqueta: "Rango de fechas" },
];

/** `ahora` solo existe para las pruebas; en la página real es la fecha del navegador. */
export default function NovedadesPublicPage({ ahora }: { ahora?: string } = {}) {
  const { estado } = useQueHayDeNuevo();
  const [filtro, setFiltro] = useState<Filtro>("todo");
  const [filtroFecha, setFiltroFecha] = useState<FiltroFechaPublica>("todo");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const ids = { fecha: useId(), desde: useId(), hasta: useId() };
  const momento = ahora ?? new Date().toISOString();
  const [params, setParams] = useSearchParams();
  const visibles = useMemo(
    () => entradasPublicas(estado.entradas, estado.configuracion.publicacionActiva),
    [estado.entradas, estado.configuracion.publicacionActiva],
  );
  const lista = visibles
    .filter((e) => filtro === "todo" || categoriaCliente(e.tipo) === filtro)
    .filter((e) => cumpleFiltroFecha(e.probadaEn, filtroFecha, momento, { desde, hasta }));
  // QA-23: el detalle usa el identificador aleatorio público, nunca el id interno.
  const detalleId = params.get("detalle");
  const detalle = detalleId ? visibles.find((e) => e.idPublico === detalleId) : undefined;

  const abrir = (idPublico: string) => setParams((p) => { p.set("detalle", idPublico); return p; });
  const cerrar = () => setParams((p) => { p.delete("detalle"); return p; });

  const filtros: { id: Filtro; etiqueta: string }[] = [
    { id: "todo", etiqueta: "Todo" },
    { id: "nuevo", etiqueta: "Opciones nuevas" },
    { id: "mejora", etiqueta: "Mejoras" },
  ];

  return (
    <main className="catalogo-formatos-publico qhdn-novedades">
      <section className="catalogo-shell qhdn-novedades-shell">
        <header className="catalogo-encabezado">
          <div>
            <h1>Novedades de SAG Web</h1>
            <p>Lo nuevo y mejorado en tu sistema, explicado en palabras simples</p>
          </div>
          <img className="catalogo-logo" src={LOGO_SAG_WEB} alt="SAG Web" />
        </header>

        {visibles.length === 0 ? (
          <p className="catalogo-panel qhdn-novedades-vacio">Sin novedades por ahora.</p>
        ) : (
          <>
            <div className="qhdn-novedades-barra">
              <div className="qhdn-novedades-filtros" role="group" aria-label="Filtrar por tipo de novedad">
                {filtros.map((f) => (
                  <button key={f.id} type="button" aria-pressed={filtro === f.id} className={filtro === f.id ? "activo" : ""} onClick={() => setFiltro(f.id)}>
                    {f.etiqueta}
                  </button>
                ))}
              </div>
              <div className="qhdn-novedades-fechas">
                <div>
                  <label htmlFor={ids.fecha}>Fecha de liberación</label>
                  <select id={ids.fecha} value={filtroFecha} onChange={(e) => setFiltroFecha(e.target.value as FiltroFechaPublica)}>
                    {OPCIONES_FECHA.map((o) => <option key={o.id} value={o.id}>{o.etiqueta}</option>)}
                  </select>
                </div>
                {filtroFecha === "rango" && (
                  <>
                    <div>
                      <label htmlFor={ids.desde}>Desde</label>
                      <input id={ids.desde} type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor={ids.hasta}>Hasta</label>
                      <input id={ids.hasta} type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} />
                    </div>
                  </>
                )}
              </div>
            </div>
            {lista.length === 0 ? (
              <p className="catalogo-panel qhdn-novedades-vacio" role="status">No hay novedades con estos filtros.</p>
            ) : (
              <ul className="qhdn-novedades-lista" aria-label="Novedades">
                {lista.map((e) => {
                  const categoria = categoriaCliente(e.tipo);
                  return (
                    <li key={e.idPublico} className="catalogo-panel qhdn-novedad">
                      <div className="qhdn-novedad-cabecera">
                        <span className={`qhdn-tipo qhdn-tipo-${categoria === "nuevo" ? "nuevo" : "mejora"}`}>{categoria === "nuevo" ? "Nuevo" : "Mejora"}</span>
                        <span className="qhdn-novedad-fecha">{mesAnio(e.probadaEn)}</span>
                      </div>
                      <h2>{e.tituloClientes}</h2>
                      <p className="qhdn-novedad-texto">{textoPlano(e.textoClientes)}</p>
                      <p className="qhdn-novedad-ruta"><strong>Dónde lo encuentras:</strong> {rutaTexto(e.rutas[0])}</p>
                      <button type="button" onClick={() => abrir(e.idPublico)} aria-label={`Ver detalle de ${e.tituloClientes}`}>Ver detalle</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <Dialogo titulo={detalle?.tituloClientes ?? ""} abierto={Boolean(detalle)} onCerrar={cerrar} className="qhdn-dialogo-ancho">
        {detalle && (
          <>
            <p className="texto-ayuda">{categoriaCliente(detalle.tipo) === "nuevo" ? "Opción nueva" : "Mejora"} · {mesAnio(detalle.probadaEn)}</p>
            <VisorEnriquecido valor={detalle.textoClientes} />
            <p className="qhdn-novedad-ruta"><strong>Dónde lo encuentras:</strong> {rutaTexto(detalle.rutas[0])}</p>
          </>
        )}
      </Dialogo>
    </main>
  );
}
