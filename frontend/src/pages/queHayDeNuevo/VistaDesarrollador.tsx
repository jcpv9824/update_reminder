import { useId, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useQueHayDeNuevo } from "./almacen";
import {
  EtiquetaEstadoQhdn,
  EtiquetaSistema,
  EtiquetaTipo,
  ListaAdjuntosLectura,
  ListaRutas,
} from "./componentes/Comunes";
import { VisorEnriquecido } from "./componentes/EditorEnriquecido";
import {
  asesoresParticipantes,
  avanceChecklist,
  contarErrores,
  ETIQUETAS_ESTADO_QHDN,
  ETIQUETAS_SISTEMA,
  ETIQUETAS_TIPO,
  fechaCorta,
  fechaHora,
  motivoNoPuedeCorregir,
  rutaTexto,
  textoPlano,
  validarParaPublicar,
} from "./logica";
import type { Entrada, EstadoEntrada, Sistema, TipoEntrada } from "./tipos";

export const RUTA_BASE = import.meta.env.DEV && window.location.pathname.startsWith("/__dev/") ? "/__dev/que-hay-de-nuevo" : "/actualizaciones/que-hay-de-nuevo";

type Pestana = "todas" | "borradores" | "publicadas";

/** Detalle corto del estado para la tabla: «Faltan campos», «2 hallazgos», «Felipe Cardona · 2 de 3». */
export function detalleEstado(entrada: Entrada, nombre: (id: string | null) => string, usuarios = [] as Parameters<typeof validarParaPublicar>[1]): string {
  if (entrada.estado === "borrador") return contarErrores(validarParaPublicar(entrada, usuarios)) > 0 ? "Faltan campos" : "Listo para publicar";
  if (entrada.estado === "en_pruebas") {
    const { hechos, total } = avanceChecklist(entrada);
    return `${nombre(entrada.tomadaPorId)} · ${hechos} de ${total}`;
  }
  const vigentes = entrada.hallazgos.filter((h) => !h.anulacion).length;
  if (vigentes > 0) return vigentes === 1 ? "1 hallazgo" : `${vigentes} hallazgos`;
  return "";
}

export function MisEntradas() {
  const { estado, usuarioActual, usuarioPorId } = useQueHayDeNuevo();
  const location = useLocation();
  const [pestana, setPestana] = useState<Pestana>("todas");
  const [alcance, setAlcance] = useState<"mias" | "equipo">("mias");
  const [tipo, setTipo] = useState<TipoEntrada | "">("");
  const [sistema, setSistema] = useState<Sistema | "">("");
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoEntrada | "">("");
  const [busqueda, setBusqueda] = useState("");
  const ids = { alcance: useId(), tipo: useId(), sistema: useId(), estado: useId(), busqueda: useId() };
  const nombre = (id: string | null) => usuarioPorId(id)?.nombre ?? "—";
  const aviso = (location.state as { aviso?: string } | null)?.aviso;

  // QA-03: los desarrolladores ven todas las entradas publicadas en solo lectura; solo editan las suyas.
  const base = useMemo(
    () => estado.entradas.filter((e) => {
      const mia = e.autorId === usuarioActual?.id;
      return alcance === "mias" ? mia : mia || e.estado !== "borrador";
    }),
    [estado.entradas, alcance, usuarioActual?.id],
  );
  const contadores = useMemo(() => {
    const cuenta = (s: EstadoEntrada) => base.filter((e) => e.estado === s).length;
    return [
      { etiqueta: "Total", valor: base.length },
      { etiqueta: "Borradores", valor: cuenta("borrador") },
      { etiqueta: "Sin probar", valor: cuenta("sin_probar") },
      { etiqueta: "En pruebas", valor: cuenta("en_pruebas") },
      { etiqueta: "Fallidas", valor: cuenta("fallida") },
      { etiqueta: "Probadas", valor: cuenta("probado") + cuenta("archivada") },
    ];
  }, [base]);

  const q = busqueda.trim().toLowerCase();
  const filtradas = base
    .filter((e) => (pestana === "borradores" ? e.estado === "borrador" : pestana === "publicadas" ? e.estado !== "borrador" : true))
    .filter((e) => !tipo || e.tipo === tipo)
    .filter((e) => !sistema || e.sistema === sistema)
    .filter((e) => !estadoFiltro || e.estado === estadoFiltro)
    .filter((e) => !q || e.rutas.some((r) => rutaTexto(r).toLowerCase().includes(q)) || textoPlano(e.queCambio).toLowerCase().includes(q))
    .sort((a, b) => b.creadaEn.localeCompare(a.creadaEn));

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Qué hay de nuevo · Mis entradas</h2>
        <Link to={`${RUTA_BASE}/nueva`} className="qhdn-boton-primario-enlace"><Plus size={16} aria-hidden="true" /> Nueva entrada</Link>
      </div>
      {aviso && <div className="alerta alerta-exito" role="status">{aviso}</div>}
      <div className="alerta alerta-info">
        Las entradas publicadas son de solo lectura. Si un asesor registra un hallazgo, lo verás en el detalle de la entrada.
      </div>

      <ul className="dashboard-grid qhdn-contadores" aria-label="Resumen de entradas">
        {contadores.map((c) => (
          <li key={c.etiqueta} className="dashboard-tarjeta">
            <span className="numero">{c.valor}</span>
            <span className="etiqueta">{c.etiqueta}</span>
          </li>
        ))}
      </ul>

      <div className="barra-filtros" role="search" aria-label="Filtrar entradas">
        <div className="campo">
          <label htmlFor={ids.alcance}>Ver</label>
          <select id={ids.alcance} value={alcance} onChange={(e) => setAlcance(e.target.value as "mias" | "equipo")}>
            <option value="mias">Mis entradas</option>
            <option value="equipo">Todo el equipo (solo lectura)</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.tipo}>Tipo</label>
          <select id={ids.tipo} value={tipo} onChange={(e) => setTipo(e.target.value as TipoEntrada | "")}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETAS_TIPO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.sistema}>Sistema</label>
          <select id={ids.sistema} value={sistema} onChange={(e) => setSistema(e.target.value as Sistema | "")}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETAS_SISTEMA).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.estado}>Estado</label>
          <select id={ids.estado} value={estadoFiltro} onChange={(e) => setEstadoFiltro(e.target.value as EstadoEntrada | "")}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETAS_ESTADO_QHDN).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.busqueda}>Buscar por ruta o texto</label>
          <input id={ids.busqueda} type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Ruta o texto" />
        </div>
      </div>

      <div className="pestanas" role="tablist" aria-label="Entradas por publicación">
        {([["todas", "Todas"], ["borradores", "Borradores"], ["publicadas", "Publicadas"]] as const).map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={pestana === v} className={pestana === v ? "activo" : ""} onClick={() => setPestana(v)}>{l}</button>
        ))}
      </div>

      <div role="tabpanel" className="qhdn-tabla-contenedor">
        {filtradas.length === 0 ? (
          <div className="vacio">
            {base.length === 0 ? "Aún no tienes entradas. Crea la primera con «Nueva entrada»." : "No hay entradas con estos filtros."}
          </div>
        ) : (
          <table>
            <caption className="sr-only">Entradas de Qué hay de nuevo</caption>
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Ruta</th>
                <th scope="col">Qué cambió</th>
                <th scope="col">Sistema</th>
                <th scope="col">Estado</th>
                <th scope="col">Creada</th>
                <th scope="col">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map((e) => {
                const propia = e.autorId === usuarioActual?.id;
                const detalle = detalleEstado(e, nombre, estado.usuarios);
                return (
                  <tr key={e.id}>
                    <td><EtiquetaTipo tipo={e.tipo} /></td>
                    <td className="qhdn-celda-ruta">{rutaTexto(e.rutas[0]) || "—"}{e.rutas.length > 1 && <small> +{e.rutas.length - 1}</small>}</td>
                    <td className="qhdn-celda-resumen">{textoPlano(e.queCambio) || <span className="texto-ayuda">Sin descripción</span>}</td>
                    <td>{e.sistema ? ETIQUETAS_SISTEMA[e.sistema] : "—"}</td>
                    <td>
                      <EtiquetaEstadoQhdn estado={e.estado} />
                      {detalle && <small className="qhdn-detalle-estado">{detalle}</small>}
                    </td>
                    <td>{fechaCorta(e.creadaEn)}{!propia && <small className="qhdn-detalle-estado">{nombre(e.autorId)}</small>}</td>
                    <td>
                      <div className="acciones-tabla">
                        {e.estado === "borrador" && propia
                          ? <Link to={`${RUTA_BASE}/${e.id}/editar`} aria-label={`Continuar ${rutaTexto(e.rutas[0]) || "borrador"}`}>Continuar</Link>
                          : <Link to={`${RUTA_BASE}/${e.id}`} aria-label={`Ver detalle de ${rutaTexto(e.rutas[0])}`}>Ver detalle</Link>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function DetalleDesarrollador() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { estado, usuarioActual, usuarioPorId } = useQueHayDeNuevo();
  const entrada = estado.entradas.find((e) => e.id === id);
  const nombre = (uid: string | null) => usuarioPorId(uid)?.nombre ?? "—";
  const aviso = (location.state as { aviso?: string } | null)?.aviso;

  if (!entrada) {
    return (
      <div className="tarjeta" role="alert">
        <p>La entrada no existe o ya no está disponible.</p>
        <Link to={RUTA_BASE}>Volver a Mis entradas</Link>
      </div>
    );
  }
  const motivoCorregir = usuarioActual ? motivoNoPuedeCorregir(entrada, usuarioActual.id) : "Sin usuario.";
  const propia = entrada.autorId === usuarioActual?.id;
  const asesorInicial = usuarioPorId(entrada.asesorInicialId);

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Detalle de la entrada</h2>
        <div className="qhdn-fila">
          <Link to={RUTA_BASE}>Volver a Mis entradas</Link>
          {propia && entrada.estado === "borrador" && <button type="button" className="primario" onClick={() => navigate(`${RUTA_BASE}/${entrada.id}/editar`)}>Continuar</button>}
          {propia && (entrada.estado === "fallida" || entrada.estado === "sin_probar" || entrada.estado === "en_pruebas") && (
            <span className="qhdn-accion-con-motivo">
              <button
                type="button"
                className="primario"
                disabled={Boolean(motivoCorregir)}
                aria-describedby={motivoCorregir ? "motivo-corregir" : undefined}
                onClick={() => navigate(`${RUTA_BASE}/${entrada.id}/corregir`)}
              >
                Corregir y volver a publicar
              </button>
              {motivoCorregir && <small id="motivo-corregir" className="texto-ayuda">{motivoCorregir}</small>}
            </span>
          )}
        </div>
      </div>
      {aviso && <div className="alerta alerta-exito" role="status">{aviso}</div>}
      {!propia && <div className="alerta alerta-info">Entrada de {nombre(entrada.autorId)}. La ves en solo lectura.</div>}

      <div className="qhdn-detalle-grid">
        <section className="tarjeta" aria-labelledby="titulo-resumen">
          <h3 id="titulo-resumen" className="sr-only">Resumen</h3>
          <div className="qhdn-etiquetas">
            <EtiquetaTipo tipo={entrada.tipo} />
            <EtiquetaSistema sistema={entrada.sistema} />
            <EtiquetaEstadoQhdn estado={entrada.estado} />
          </div>
          <h4>Rutas</h4>
          <ListaRutas rutas={entrada.rutas} />
          <h4>Qué cambió</h4>
          <VisorEnriquecido valor={entrada.queCambio} />
          <h4>Acción requerida</h4>
          {entrada.acciones.length === 0 ? <p className="texto-ayuda">Sin acciones.</p> : (
            <ul className="qhdn-acciones-lectura">
              {entrada.acciones.map((a) => <li key={a.accionId}><strong>{a.nombre}</strong><VisorEnriquecido valor={a.texto} /></li>)}
            </ul>
          )}
          {entrada.tipo === "nuevo" && (
            <>
              <h4>Solo desarrollos nuevos</h4>
              <dl className="qhdn-datos">
                <dt>Cliente</dt><dd>{entrada.cliente || "—"}</dd>
                <dt>Asesor a cargo de pruebas iniciales</dt>
                <dd>{asesorInicial?.nombre ?? "—"}{asesorInicial && !asesorInicial.activo && <span className="qhdn-aviso-inline"> · Asesor inactivo</span>}</dd>
              </dl>
              <ListaAdjuntosLectura titulo="Documento de reglas de negocio" adjuntos={entrada.reglasNegocio} />
              <ListaAdjuntosLectura titulo="Video de la entrega" adjuntos={entrada.videos} />
            </>
          )}
        </section>

        <aside className="qhdn-detalle-lateral">
          <section className="tarjeta" aria-labelledby="titulo-trazabilidad">
            <h3 id="titulo-trazabilidad">Trazabilidad</h3>
            <dl className="qhdn-datos">
              <dt>Desarrollador</dt><dd>{nombre(entrada.autorId)}</dd>
              <dt>Asesores que han probado</dt><dd>{asesoresParticipantes(entrada).map(nombre).join(", ") || "Nadie aún"}</dd>
              <dt>Creada</dt><dd>{nombre(entrada.autorId)} · {fechaHora(entrada.creadaEn)}</dd>
              <dt>Última edición</dt><dd>{nombre(entrada.editadaPorId)} · {fechaHora(entrada.editadaEn)}</dd>
              <dt>Publicada</dt><dd>{entrada.publicadaPorId ? `${nombre(entrada.publicadaPorId)} · ${fechaHora(entrada.publicadaEn)}` : "—"}</dd>
              {entrada.tomadaPorId && (<><dt>En pruebas con</dt><dd>{nombre(entrada.tomadaPorId)}</dd></>)}
              {entrada.probadaEn && (<><dt>Probada</dt><dd>{fechaHora(entrada.probadaEn)}</dd></>)}
            </dl>
          </section>
          <section className="tarjeta" aria-labelledby="titulo-hallazgos-dev">
            <h3 id="titulo-hallazgos-dev">Hallazgos ({entrada.hallazgos.filter((h) => !h.anulacion).length})</h3>
            <ListaHallazgos entrada={entrada} />
          </section>
          <section className="tarjeta" aria-labelledby="titulo-historial-dev">
            <h3 id="titulo-historial-dev">Historial</h3>
            <Historial entrada={entrada} />
          </section>
          {entrada.correcciones.length > 0 && (
            <section className="tarjeta" aria-labelledby="titulo-correcciones">
              <h3 id="titulo-correcciones">Correcciones</h3>
              <ol className="qhdn-lista-simple">
                {entrada.correcciones.map((c, i) => (
                  <li key={i}>
                    <small>{fechaHora(c.fecha)} · {nombre(c.autorId)} · abre la ronda {c.ronda}</small>
                    {c.texto ? <VisorEnriquecido valor={c.texto} /> : <p className="texto-ayuda">Sin nota.</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

/** Bitácora de la entrada, de la más reciente a la más antigua. */
export function Historial({ entrada }: { entrada: Entrada }) {
  const { usuarioPorId } = useQueHayDeNuevo();
  if (entrada.historial.length === 0) return <p className="texto-ayuda">Sin eventos.</p>;
  return (
    <ol className="qhdn-historial-lista">
      {[...entrada.historial].reverse().map((h, i) => (
        <li key={i}><small>{fechaHora(h.fecha)} · {usuarioPorId(h.usuarioId)?.nombre ?? "—"}</small> {h.accion}</li>
      ))}
    </ol>
  );
}

export function ListaHallazgos({ entrada, accion }: { entrada: Entrada; accion?: (numero: number) => ReactNode }) {
  const { usuarioPorId } = useQueHayDeNuevo();
  if (entrada.hallazgos.length === 0) return <p className="texto-ayuda">Sin hallazgos registrados.</p>;
  return (
    <ol className="qhdn-hallazgos">
      {[...entrada.hallazgos].reverse().map((h) => (
        <li key={h.numero} className={h.anulacion ? "qhdn-anulado" : ""}>
          <div className="qhdn-hallazgo-cabecera">
            <strong>Hallazgo {h.numero}</strong>
            <small>Ronda {h.ronda} · {fechaHora(h.fecha)} · {usuarioPorId(h.autorId)?.nombre ?? "—"}</small>
            {accion?.(h.numero)}
          </div>
          <div className="qhdn-hallazgo-texto"><VisorEnriquecido valor={h.texto} /></div>
          {h.anulacion && (
            <p className="qhdn-anulacion">
              Anulado por {usuarioPorId(h.anulacion.autorId)?.nombre ?? "—"} · {fechaHora(h.anulacion.fecha)}: {h.anulacion.motivo}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
