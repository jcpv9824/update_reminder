import { useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Mail } from "lucide-react";
import { useQueHayDeNuevo } from "../almacen";
import {
  asesoresParticipantes,
  ETIQUETAS_ESTADO_QHDN,
  ETIQUETAS_SISTEMA,
  ETIQUETAS_TIPO,
  fechaHora,
  RESULTADOS_PROBADAS,
  rutaTexto,
} from "../logica";
import type { Entrada, FiltroResultado, ReporteEnviado, ResultadoRonda, UsuarioPortal } from "../tipos";
import { Dialogo } from "./Comunes";
import { VisorEnriquecido } from "./EditorEnriquecido";

/*
 * Reporte de pruebas (decisión del propietario, 2.ª ronda):
 * - solo desde la pestaña Probadas;
 * - se elige qué incluir (Todas / Solo aprobadas / Solo fallidas) y los destinatarios (usuarios del portal);
 * - el reporte es HTML: se previsualiza aquí y se «envía» por correo con un resumen y el enlace al reporte completo.
 * Prototipo: no sale ningún correo; el enlace abre el reporte guardado en memoria.
 */

export const RUTA_REPORTES = import.meta.env.DEV && window.location.pathname.startsWith("/__dev/") ? "/__dev/que-hay-de-nuevo/reportes" : "/actualizaciones/que-hay-de-nuevo/reportes";

const ETIQUETAS_RONDA: Record<ResultadoRonda, string> = {
  pendiente: "Pendiente",
  en_curso: "En curso",
  soltada: "Soltada",
  fallida: "Fallida",
  probada: "Probada",
};

const OPCIONES_INCLUIR: { id: FiltroResultado; etiqueta: string }[] = [
  { id: "ambas", etiqueta: "Todas" },
  { id: "aprobadas", etiqueta: "Solo aprobadas" },
  { id: "fallidas", etiqueta: "Solo fallidas" },
];

export function filtrarPorResultado(entradas: Entrada[], filtro: FiltroResultado) {
  return entradas.filter((e) => RESULTADOS_PROBADAS[filtro].estados.includes(e.estado));
}

export function DialogoReporte({
  abierto,
  onCerrar,
  entradas,
}: {
  abierto: boolean;
  onCerrar: () => void;
  /** Entradas de la pestaña Probadas con los filtros de la bandeja aplicados. */
  entradas: Entrada[];
}) {
  const { estado, enviarReporte } = useQueHayDeNuevo();
  const [incluir, setIncluir] = useState<FiltroResultado>("ambas");
  const [busqueda, setBusqueda] = useState("");
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [vista, setVista] = useState(false);
  const [enviado, setEnviado] = useState<ReporteEnviado | null>(null);
  const nombreGrupo = useId();
  const idBusqueda = useId();

  const incluidas = filtrarPorResultado(entradas, incluir);
  const activos = useMemo(() => estado.usuarios.filter((u) => u.activo), [estado.usuarios]);
  const q = busqueda.trim().toLowerCase();
  const visibles = activos.filter((u) => !q || u.nombre.toLowerCase().includes(q) || u.correo.toLowerCase().includes(q));
  const elegidos = activos.filter((u) => seleccion.has(u.id));

  function cerrar() {
    setVista(false);
    setEnviado(null);
    setSeleccion(new Set());
    setBusqueda("");
    onCerrar();
  }

  function alternar(id: string) {
    setSeleccion((actual) => {
      const siguiente = new Set(actual);
      if (siguiente.has(id)) siguiente.delete(id);
      else siguiente.add(id);
      return siguiente;
    });
  }

  if (!abierto) return null;

  if (enviado) {
    return (
      <Dialogo titulo="Reporte enviado" abierto onCerrar={cerrar} className="qhdn-dialogo-ancho" pie={<button type="button" className="primario" onClick={cerrar}>Listo</button>}>
        <div className="alerta alerta-exito" role="status">
          <strong>Correo enviado (simulado).</strong> En el prototipo no sale ningún correo.
        </div>
        <CorreoReporte reporte={enviado} destinatarios={elegidos} entradas={incluidas} />
      </Dialogo>
    );
  }

  if (vista) {
    return (
      <Dialogo
        titulo="Vista previa del reporte"
        abierto
        onCerrar={cerrar}
        className="qhdn-dialogo-ancho"
        pie={<button type="button" onClick={() => setVista(false)}>Volver</button>}
      >
        <CuerpoReporte entradas={incluidas} filtro={incluir} />
      </Dialogo>
    );
  }

  return (
    <Dialogo
      titulo="Enviar reporte de pruebas"
      abierto
      onCerrar={cerrar}
      className="qhdn-dialogo-ancho"
      pie={(
        <>
          <button type="button" onClick={cerrar}>Cancelar</button>
          <button type="button" onClick={() => setVista(true)} disabled={incluidas.length === 0}>Ver reporte</button>
          <button
            type="button"
            className="primario"
            disabled={elegidos.length === 0 || incluidas.length === 0}
            onClick={() => {
              const id = enviarReporte(incluir, incluidas.map((e) => e.id), elegidos.map((u) => u.id));
              setEnviado({ id, fecha: new Date().toISOString(), autorId: estado.usuarioActualId, filtro: incluir, entradaIds: incluidas.map((e) => e.id), destinatarioIds: elegidos.map((u) => u.id) });
            }}
          >
            <Mail size={14} aria-hidden="true" /> Enviar a {elegidos.length} {elegidos.length === 1 ? "persona" : "personas"}
          </button>
        </>
      )}
    >
      <fieldset className="qhdn-fieldset">
        <legend>Qué incluir</legend>
        <div className="qhdn-radios">
          {OPCIONES_INCLUIR.map((o) => (
            <label key={o.id} className="qhdn-radio">
              <input type="radio" name={nombreGrupo} checked={incluir === o.id} onChange={() => setIncluir(o.id)} />
              {o.etiqueta} ({filtrarPorResultado(entradas, o.id).length})
            </label>
          ))}
        </div>
        {incluidas.length === 0 && <p className="texto-ayuda">No hay entradas para incluir con estos filtros.</p>}
      </fieldset>

      <fieldset className="qhdn-fieldset qhdn-destinatarios">
        <legend>Destinatarios</legend>
        <label htmlFor={idBusqueda}>Buscar usuario por nombre o correo</label>
        <input id={idBusqueda} type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Nombre o correo" />
        <div className="lista-seleccion qhdn-lista-destinatarios" role="group" aria-label="Usuarios del portal">
          {visibles.length === 0 ? <p className="texto-ayuda">Sin coincidencias.</p> : visibles.map((u) => (
            <label key={u.id} className="fila-seleccion">
              <input type="checkbox" checked={seleccion.has(u.id)} onChange={() => alternar(u.id)} />
              <span>{u.nombre}<small>{u.correo}</small></span>
            </label>
          ))}
        </div>
        <p className="seleccion-resumen" aria-live="polite">{elegidos.length} seleccionados</p>
      </fieldset>
    </Dialogo>
  );
}

/** Resumen que va en el cuerpo del correo, con el enlace al reporte completo. */
function CorreoReporte({ reporte, destinatarios, entradas }: { reporte: ReporteEnviado; destinatarios: UsuarioPortal[]; entradas: Entrada[] }) {
  const aprobadas = entradas.filter((e) => e.estado !== "fallida").length;
  const fallidas = entradas.length - aprobadas;
  const hallazgos = entradas.reduce((t, e) => t + e.hallazgos.filter((h) => !h.anulacion).length, 0);
  return (
    <div className="qhdn-correo">
      <p><strong>Para:</strong> {destinatarios.map((u) => `${u.nombre} <${u.correo}>`).join(", ")}</p>
      <p><strong>Asunto:</strong> Qué hay de nuevo · Reporte de pruebas ({OPCIONES_INCLUIR.find((o) => o.id === reporte.filtro)?.etiqueta})</p>
      <div className="qhdn-correo-cuerpo">
        <p>Resumen: {entradas.length} {entradas.length === 1 ? "entrada" : "entradas"} · {aprobadas} aprobadas · {fallidas} fallidas · {hallazgos} hallazgos vigentes.</p>
        <ul>
          {entradas.map((e) => (
            <li key={e.id}>{rutaTexto(e.rutas[0])} · {e.estado === "fallida" ? "Fallida" : "Aprobada"}</li>
          ))}
        </ul>
        <p>
          Para ver el reporte completo, abra el enlace:{" "}
          <Link to={`${RUTA_REPORTES}/${reporte.id}`}>Ver reporte completo</Link>
        </p>
      </div>
    </div>
  );
}

/** Página del reporte enviado: el destino del enlace del correo. */
export function ReporteGuardado() {
  const { id } = useParams();
  const { estado, usuarioPorId } = useQueHayDeNuevo();
  const reporte = estado.reportes.find((r) => r.id === id);
  if (!reporte) {
    return (
      <div className="tarjeta" role="alert">
        <p>El reporte no existe. En el prototipo, los reportes viven solo durante la sesión.</p>
        <Link to="/actualizaciones/que-hay-de-nuevo">Volver a Qué hay de nuevo</Link>
      </div>
    );
  }
  const entradas = reporte.entradaIds.map((x) => estado.entradas.find((e) => e.id === x)).filter((e): e is Entrada => Boolean(e));
  return (
    <>
      <div className="encabezado-pagina">
        <h2>Reporte de pruebas</h2>
        <Link to="/actualizaciones/que-hay-de-nuevo">Volver a Qué hay de nuevo</Link>
      </div>
      <p className="texto-ayuda">
        Enviado por {usuarioPorId(reporte.autorId)?.nombre ?? "—"} el {fechaHora(reporte.fecha)} a{" "}
        {reporte.destinatarioIds.map((d) => usuarioPorId(d)?.nombre ?? "—").join(", ")}.
      </p>
      <div className="tarjeta"><CuerpoReporte entradas={entradas} filtro={reporte.filtro} /></div>
    </>
  );
}

export function CuerpoReporte({ entradas, filtro }: { entradas: Entrada[]; filtro: FiltroResultado }) {
  const { usuarioPorId } = useQueHayDeNuevo();
  const nombre = (id: string | null) => usuarioPorId(id)?.nombre ?? "—";
  return (
    <article className="qhdn-reporte">
      <header>
        <h2>Qué hay de nuevo · Reporte de pruebas</h2>
        <p>Incluye: {OPCIONES_INCLUIR.find((o) => o.id === filtro)?.etiqueta} · {entradas.length} {entradas.length === 1 ? "entrada" : "entradas"}</p>
      </header>
      {entradas.length === 0 && <p>No hay entradas en este reporte.</p>}
      {entradas.map((e) => {
        const rondasConHallazgos = Array.from(new Set(e.hallazgos.map((h) => h.ronda))).sort((a, b) => a - b);
        const asesores = asesoresParticipantes(e);
        return (
          <section key={e.id} className="qhdn-reporte-entrada">
            <h3>{rutaTexto(e.rutas[0])}</h3>
            <p>
              <strong>Resultado:</strong> {ETIQUETAS_ESTADO_QHDN[e.estado]} · <strong>Tipo:</strong> {e.tipo ? ETIQUETAS_TIPO[e.tipo] : "—"} ·{" "}
              <strong>Sistema:</strong> {e.sistema ? ETIQUETAS_SISTEMA[e.sistema] : "—"}
            </p>
            <p>
              <strong>Desarrollador:</strong> {nombre(e.autorId)} · <strong>Asesores que probaron:</strong>{" "}
              {asesores.length ? asesores.map(nombre).join(", ") : "—"}
            </p>
            <p><strong>Publicada:</strong> {fechaHora(e.publicadaEn)} · <strong>Aprobada:</strong> {fechaHora(e.probadaEn)}</p>
            <h4>Qué cambió</h4>
            <VisorEnriquecido valor={e.queCambio} />
            <h4>Acciones requeridas</h4>
            <ul>{e.acciones.map((a) => <li key={a.accionId}><strong>{a.nombre}:</strong> <VisorEnriquecido valor={a.texto} /></li>)}</ul>
            <h4>Hallazgos</h4>
            {e.hallazgos.length === 0 ? <p className="qhdn-sin-hallazgos">Sin hallazgos</p> : rondasConHallazgos.map((r) => (
              <div key={r}>
                <h5>Ronda {r}</h5>
                <ol>
                  {e.hallazgos.filter((h) => h.ronda === r).map((h) => (
                    <li key={h.numero} className={h.anulacion ? "qhdn-anulado" : ""}>
                      <span>N.º {h.numero} · {fechaHora(h.fecha)} · {nombre(h.autorId)}</span>
                      <VisorEnriquecido valor={h.texto} />
                      {h.anulacion && <small>Anulado: {h.anulacion.motivo}</small>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            <h4>Rondas de prueba</h4>
            <ul>
              {e.rondas.map((r) => {
                const hechos = e.acciones.filter((a) => r.checklist[a.accionId]).length;
                return (
                  <li key={r.numero}>
                    Ronda {r.numero} · {ETIQUETAS_RONDA[r.resultado]} · {r.asesorId ? nombre(r.asesorId) : "Sin asesor"} ·{" "}
                    checklist {hechos} de {e.acciones.length} · {fechaHora(r.tomadaEn)} → {fechaHora(r.cerradaEn)}
                    {r.notas.length > 0 && (
                      <ul>{r.notas.map((n) => <li key={n.id}>{fechaHora(n.fecha)} · {nombre(n.autorId)}: <VisorEnriquecido valor={n.texto} /></li>)}</ul>
                    )}
                  </li>
                );
              })}
            </ul>
            <h4>Historial</h4>
            <ol className="qhdn-historial-lista">
              {e.historial.map((h, i) => <li key={i}>{fechaHora(h.fecha)} · {nombre(h.usuarioId)} · {h.accion}</li>)}
            </ol>
          </section>
        );
      })}
    </article>
  );
}
