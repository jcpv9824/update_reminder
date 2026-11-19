import { useEffect, useId, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useQueHayDeNuevo } from "./almacen";
import {
  Dialogo,
  EtiquetaEstadoQhdn,
  EtiquetaSistema,
  EtiquetaTipo,
  ListaAdjuntosLectura,
  ListaRutas,
} from "./componentes/Comunes";
import { EditorEnriquecido, VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { DialogoReporte } from "./componentes/Reportes";
import {
  asesoresParticipantes,
  avanceChecklist,
  docVacio,
  ETIQUETAS_SISTEMA,
  ETIQUETAS_TIPO,
  fechaCorta,
  fechaHora,
  haceCuanto,
  motivoNoPuedeFallar,
  motivoNoPuedeMostrarClientes,
  motivoNoPuedeProbar,
  motivoNoPuedeTomar,
  NOMBRES_MESES,
  partesBogota,
  puedeEditarTextoClientes,
  RESULTADOS_PROBADAS,
  rondaActual,
  rutaTexto,
  textoPlano,
  visibleParaClientes,
} from "./logica";
import type { DocEnriquecido, Entrada, EstadoEntrada, FiltroResultado, Sistema, TipoEntrada } from "./tipos";
import { Historial, ListaHallazgos } from "./VistaDesarrollador";

/* Visión Asesor · Bandeja de pruebas (diseño §5). */

type PestanaAsesor = "sin_probar" | "en_pruebas" | "probadas";

/* Decisión del propietario: no hay pestaña Fallidas; las fallidas viven en Probadas con un filtro de resultado. */
const PESTANAS: { id: PestanaAsesor; etiqueta: string; estados: EstadoEntrada[] }[] = [
  { id: "sin_probar", etiqueta: "Sin probar", estados: ["sin_probar"] },
  { id: "en_pruebas", etiqueta: "En pruebas", estados: ["en_pruebas"] },
  // QA-10: las archivadas siguen visibles para reportes, dentro de Probadas.
  { id: "probadas", etiqueta: "Probadas", estados: RESULTADOS_PROBADAS.ambas.estados },
];

export function BandejaPruebas() {
  const { estado, usuarioActual, usuarioPorId } = useQueHayDeNuevo();
  const [pestana, setPestana] = useState<PestanaAsesor>("sin_probar");
  const [seleccionId, setSeleccionId] = useState<string | null>(null);
  const [tipo, setTipo] = useState<TipoEntrada | "">("");
  const [sistema, setSistema] = useState<Sistema | "">("");
  const [mes, setMes] = useState("");
  const [anio, setAnio] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [asignadasAMi, setAsignadasAMi] = useState(false);
  const [resultado, setResultado] = useState<FiltroResultado>("ambas");
  const [reporteTab, setReporteTab] = useState(false);
  const ids = { tipo: useId(), sistema: useId(), mes: useId(), anio: useId(), busqueda: useId(), asignadas: useId(), resultado: useId() };
  const nombre = (id: string | null) => usuarioPorId(id)?.nombre ?? "—";

  const publicadas = useMemo(() => estado.entradas.filter((e) => e.estado !== "borrador"), [estado.entradas]);
  const anios = useMemo(
    () => Array.from(new Set(publicadas.map((e) => partesBogota(e.publicadaEn ?? e.creadaEn).anio))).sort((a, b) => b - a),
    [publicadas],
  );
  const q = busqueda.trim().toLowerCase();
  const filtradas = publicadas
    .filter((e) => !tipo || e.tipo === tipo)
    .filter((e) => !sistema || e.sistema === sistema)
    .filter((e) => {
      const p = partesBogota(e.publicadaEn ?? e.creadaEn);
      return (!mes || p.mes === Number(mes)) && (!anio || p.anio === Number(anio));
    })
    .filter((e) => !asignadasAMi || e.asesorInicialId === usuarioActual?.id)
    .filter((e) => !q || e.rutas.some((r) => rutaTexto(r).toLowerCase().includes(q)) || textoPlano(e.queCambio).toLowerCase().includes(q))
    .sort((a, b) => (b.publicadaEn ?? "").localeCompare(a.publicadaEn ?? ""));

  const pestanaActual = PESTANAS.find((p) => p.id === pestana)!;
  const todasEnPestana = filtradas.filter((e) => pestanaActual.estados.includes(e.estado));
  const enPestana = pestana === "probadas" ? todasEnPestana.filter((e) => RESULTADOS_PROBADAS[resultado].estados.includes(e.estado)) : todasEnPestana;
  const seleccionada = estado.entradas.find((e) => e.id === seleccionId) ?? null;

  // Si la entrada seleccionada cambia de estado, la bandeja la sigue a su nueva pestaña.
  useEffect(() => {
    if (!seleccionada) return;
    const destino = PESTANAS.find((p) => p.estados.includes(seleccionada.estado));
    if (destino && destino.id !== pestana) setPestana(destino.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seleccionada?.estado]);

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Qué hay de nuevo · Bandeja de pruebas</h2>
        {pestana === "probadas" && (
          <button type="button" onClick={() => setReporteTab(true)} disabled={todasEnPestana.length === 0}>
            <FileText size={14} aria-hidden="true" /> Enviar reporte
          </button>
        )}
      </div>

      <div className="barra-filtros" role="search" aria-label="Filtrar bandeja">
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
          <label htmlFor={ids.mes}>Mes</label>
          <select id={ids.mes} value={mes} onChange={(e) => setMes(e.target.value)}>
            <option value="">Todos</option>
            {NOMBRES_MESES.map((m, i) => <option key={m} value={i}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.anio}>Año</label>
          <select id={ids.anio} value={anio} onChange={(e) => setAnio(e.target.value)}>
            <option value="">Todos</option>
            {anios.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={ids.busqueda}>Buscar por ruta o texto</label>
          <input id={ids.busqueda} type="search" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Ruta o texto" />
        </div>
        <label className="qhdn-check qhdn-filtro-check" htmlFor={ids.asignadas}>
          <input id={ids.asignadas} type="checkbox" checked={asignadasAMi} onChange={(e) => setAsignadasAMi(e.target.checked)} />
          Asignadas a mí
        </label>
      </div>

      <div className="pestanas" role="tablist" aria-label="Estado de las pruebas">
        {PESTANAS.map((p) => {
          const cuenta = filtradas.filter((e) => p.estados.includes(e.estado)).length;
          return (
            <button key={p.id} type="button" role="tab" aria-selected={pestana === p.id} className={pestana === p.id ? "activo" : ""} onClick={() => { setPestana(p.id); setSeleccionId(null); }}>
              {p.etiqueta} <span className="qhdn-conteo">{cuenta}</span>
            </button>
          );
        })}
      </div>

      {pestana === "probadas" && (
        <div className="qhdn-filtro-resultado">
          <label htmlFor={ids.resultado}>Resultado</label>
          <select id={ids.resultado} value={resultado} onChange={(e) => { setResultado(e.target.value as FiltroResultado); setSeleccionId(null); }}>
            {(Object.keys(RESULTADOS_PROBADAS) as FiltroResultado[]).map((r) => <option key={r} value={r}>{RESULTADOS_PROBADAS[r].etiqueta}</option>)}
          </select>
        </div>
      )}

      <div className="qhdn-bandeja" role="tabpanel" aria-label={pestanaActual.etiqueta}>
        <ul className="qhdn-bandeja-lista" aria-label={`Entradas ${pestanaActual.etiqueta.toLowerCase()}`}>
          {enPestana.length === 0 ? (
            <li className="vacio">No hay entradas en «{pestanaActual.etiqueta}» con estos filtros.</li>
          ) : enPestana.map((e) => {
            const { hechos, total } = avanceChecklist(e);
            return (
              <li key={e.id}>
                <button type="button" className={`qhdn-item-bandeja${seleccionId === e.id ? " activo" : ""}`} aria-current={seleccionId === e.id ? "true" : undefined} onClick={() => setSeleccionId(e.id)}>
                  <span className="qhdn-etiquetas"><EtiquetaTipo tipo={e.tipo} /><EtiquetaSistema sistema={e.sistema} />{pestana === "probadas" && <EtiquetaEstadoQhdn estado={e.estado} />}</span>
                  <strong>{rutaTexto(e.rutas[0])}</strong>
                  <span className="qhdn-item-resumen">{textoPlano(e.queCambio)}</span>
                  <small>
                    {nombre(e.autorId)} · {fechaCorta(e.publicadaEn)}
                    {e.estado === "en_pruebas" && ` · ${nombre(e.tomadaPorId)} · ${hechos} de ${total}`}
                    {e.asesorInicialId && ` · Asignada a ${nombre(e.asesorInicialId)}`}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="qhdn-bandeja-detalle">
          {seleccionada ? <DetalleAsesor key={seleccionada.id} entrada={seleccionada} /> : (
            <div className="tarjeta qhdn-ayuda-vacia">
              <h3>Cómo probar una entrada</h3>
              <ol>
                <li>Revisa una entrada sin probar.</li>
                <li>Tómala para probar.</li>
                <li>Registra hallazgos y márcala.</li>
              </ol>
            </div>
          )}
        </div>
      </div>

      <DialogoReporte abierto={reporteTab} onCerrar={() => setReporteTab(false)} entradas={pestana === "probadas" ? todasEnPestana : []} />
    </>
  );
}

function DetalleAsesor({ entrada }: { entrada: Entrada }) {
  const q = useQueHayDeNuevo();
  const { usuarioActual, usuarioPorId, ultimoGuardado } = q;
  const [mensaje, setMensaje] = useState<{ tipo: "error" | "exito"; texto: string } | null>(null);
  const [nota, setNota] = useState<DocEnriquecido | null>(null);
  const [confirmarSoltar, setConfirmarSoltar] = useState(false);
  const [anulando, setAnulando] = useState<number | null>(null);
  const [motivoAnular, setMotivoAnular] = useState("");
  const idNota = useId();
  const idMotivo = useId();
  const nombre = (id: string | null) => usuarioPorId(id)?.nombre ?? "—";

  const titular = entrada.estado === "en_pruebas" && entrada.tomadaPorId === usuarioActual?.id;
  const motivoTomar = motivoNoPuedeTomar(entrada, usuarioActual);
  const motivoFallar = motivoNoPuedeFallar(entrada);
  const motivoProbar = motivoNoPuedeProbar(entrada);
  const { hechos, total } = avanceChecklist(entrada);
  const ronda = rondaActual(entrada);
  const propia = entrada.autorId === usuarioActual?.id || entrada.editoresIds.includes(usuarioActual?.id ?? "");

  function ejecutar(error: string | null, exito: string) {
    setMensaje(error ? { tipo: "error", texto: error } : { tipo: "exito", texto: exito });
    return !error;
  }

  return (
    <article className="tarjeta qhdn-detalle-asesor" aria-labelledby={`titulo-${entrada.id}`}>
      <header className="qhdn-detalle-cabecera">
        <div className="qhdn-etiquetas">
          <EtiquetaTipo tipo={entrada.tipo} />
          <EtiquetaSistema sistema={entrada.sistema} />
          <EtiquetaEstadoQhdn estado={entrada.estado} />
          {entrada.asesorInicialId && (
            <span className="qhdn-asignada">
              Asignada a {nombre(entrada.asesorInicialId)}{usuarioPorId(entrada.asesorInicialId)?.activo === false ? " (inactivo)" : ""}
            </span>
          )}
        </div>
        <h3 id={`titulo-${entrada.id}`}>{rutaTexto(entrada.rutas[0])}</h3>
        <p className="texto-ayuda">Publicada {fechaHora(entrada.publicadaEn)} · ronda {ronda?.numero ?? 1}</p>
        <dl className="qhdn-datos">
          <dt>Desarrollador</dt><dd>{nombre(entrada.autorId)}</dd>
          <dt>Asesores que han probado</dt><dd>{asesoresParticipantes(entrada).map(nombre).join(", ") || "Nadie aún"}</dd>
        </dl>
      </header>

      {mensaje && <div className={`alerta alerta-${mensaje.tipo}`} role={mensaje.tipo === "error" ? "alert" : "status"}>{mensaje.texto}</div>}
      {entrada.estado === "en_pruebas" && !titular && <div className="alerta alerta-info">La tiene {nombre(entrada.tomadaPorId)}. La ves en solo lectura.</div>}
      {entrada.estado === "sin_probar" && propia && <div className="alerta alerta-info">{motivoTomar}</div>}

      <div className="qhdn-acciones-asesor" role="group" aria-label="Acciones de prueba">
        {entrada.estado === "sin_probar" && (
          <span className="qhdn-accion-con-motivo">
            <button type="button" className="primario" disabled={Boolean(motivoTomar)} aria-describedby={motivoTomar ? `${idNota}-tomar` : undefined}
              onClick={() => ejecutar(q.tomar(entrada.id), "Tomaste la entrada. Empieza la prueba.")}>
              Tomar para probar
            </button>
            {motivoTomar && !propia && <small id={`${idNota}-tomar`} className="texto-ayuda">{motivoTomar}</small>}
            {motivoTomar && propia && <span id={`${idNota}-tomar`} className="sr-only">{motivoTomar}</span>}
          </span>
        )}
        {titular && (
          <>
            <button type="button" onClick={() => setConfirmarSoltar(true)}>Soltar</button>
            <span className="qhdn-accion-con-motivo">
              <button type="button" className="peligro" disabled={Boolean(motivoFallar)} aria-describedby={motivoFallar ? `${idNota}-fallar` : undefined}
                onClick={() => ejecutar(q.marcarFallida(entrada.id), "La entrada quedó como fallida. El desarrollador la verá en Mis entradas.")}>
                Marcar fallida
              </button>
              {motivoFallar && <small id={`${idNota}-fallar`} className="texto-ayuda">{motivoFallar}</small>}
            </span>
            <span className="qhdn-accion-con-motivo">
              <button type="button" className="exito" disabled={Boolean(motivoProbar)} aria-describedby={motivoProbar ? `${idNota}-probar` : undefined}
                onClick={() => ejecutar(q.marcarProbado(entrada.id), "La entrada quedó probada.")}>
                Marcar probado
              </button>
              {motivoProbar && <small id={`${idNota}-probar`} className="texto-ayuda">{motivoProbar}</small>}
            </span>
          </>
        )}
        {entrada.estado === "probado" && (
          <button type="button" onClick={() => ejecutar(q.archivar(entrada.id), "Entrada archivada. Ya no sale en la página de clientes.")}>Archivar</button>
        )}
      </div>
      {titular && ultimoGuardado && <p className="estado-guardado estado-guardado-guardado" role="status">Avance guardado automáticamente · {haceCuanto(ultimoGuardado)}</p>}

      <h4>Rutas</h4>
      <ListaRutas rutas={entrada.rutas} />
      <h4>Qué cambió</h4>
      <VisorEnriquecido valor={entrada.queCambio} />

      <section aria-labelledby={`checklist-${entrada.id}`}>
        <h4 id={`checklist-${entrada.id}`}>Mi checklist <span className="qhdn-conteo">{hechos} de {total}</span></h4>
        <progress className="qhdn-progreso" max={total || 1} value={hechos} aria-label={`Avance del checklist: ${hechos} de ${total}`} />
        <ul className="qhdn-checklist">
          {entrada.acciones.map((a) => (
            <li key={a.accionId}>
              <input
                id={`chk-${entrada.id}-${a.accionId}`}
                type="checkbox"
                checked={Boolean(ronda?.checklist[a.accionId])}
                disabled={!titular}
                onChange={() => { const e = q.alternarChecklist(entrada.id, a.accionId); if (e) setMensaje({ tipo: "error", texto: e }); }}
              />
              <label htmlFor={`chk-${entrada.id}-${a.accionId}`}><strong>{a.nombre}</strong></label>
              <div className="qhdn-checklist-texto"><VisorEnriquecido valor={a.texto} /></div>
            </li>
          ))}
        </ul>
      </section>

      {(entrada.reglasNegocio.length > 0 || entrada.videos.length > 0) && (
        <section aria-label="Referencias">
          <h4>Referencias</h4>
          <ListaAdjuntosLectura titulo="Reglas de negocio" adjuntos={entrada.reglasNegocio} />
          <ListaAdjuntosLectura titulo="Video de la entrega" adjuntos={entrada.videos} />
        </section>
      )}

      <section aria-labelledby={`hallazgos-${entrada.id}`}>
        <h4 id={`hallazgos-${entrada.id}`}>Hallazgos registrados</h4>
        <ListaHallazgos
          entrada={entrada}
          accion={(numero) => {
            const h = entrada.hallazgos.find((x) => x.numero === numero)!;
            if (!titular || h.anulacion || h.ronda !== ronda?.numero) return null;
            return <button type="button" className="qhdn-boton-enlace" onClick={() => { setAnulando(numero); setMotivoAnular(""); }}>Anular</button>;
          }}
        />
      </section>

      <section aria-labelledby={idNota}>
        <h4 id={idNota}>Notas de prueba y hallazgo</h4>
        {ronda && ronda.notas.length > 0 && (
          <ol className="qhdn-lista-simple">
            {ronda.notas.map((n) => <li key={n.id}><small>{fechaHora(n.fecha)} · {nombre(n.autorId)}</small><VisorEnriquecido valor={n.texto} /></li>)}
          </ol>
        )}
        {titular ? (
          <>
            <EditorEnriquecido valor={nota} onChange={setNota} tamano="mediano" etiquetaId={idNota} usuariosMencion={q.estado.usuarios} nombreBarra="la nota" placeholder="Qué probaste, qué encontraste…" />
            <div className="qhdn-fila qhdn-fila-derecha">
              <button type="button" disabled={docVacio(nota)} onClick={() => { if (ejecutar(q.agregarNota(entrada.id, nota!, false), "Nota guardada.")) setNota(null); }}>Guardar como nota</button>
              <button type="button" className="advertencia" disabled={docVacio(nota)} onClick={() => { if (ejecutar(q.agregarNota(entrada.id, nota!, true), "Hallazgo registrado.")) setNota(null); }}>Registrar hallazgo</button>
            </div>
          </>
        ) : (ronda?.notas.length ?? 0) === 0 && <p className="texto-ayuda">Sin notas en esta ronda.</p>}
      </section>

      <BloqueClientes entrada={entrada} />

      <details className="acordeon qhdn-historial">
        <summary>Historial de la entrada ({entrada.historial.length} eventos)</summary>
        <div className="acordeon-contenido"><Historial entrada={entrada} /></div>
      </details>

      <details className="acordeon qhdn-historial">
        <summary>Rondas de prueba ({entrada.rondas.length})</summary>
        <div className="acordeon-contenido">
          <ol className="qhdn-lista-simple">
            {entrada.rondas.map((r) => (
              <li key={r.numero}>
                Ronda {r.numero} · {r.resultado === "soltada" ? "Soltada" : r.resultado === "en_curso" ? "En curso" : r.resultado === "pendiente" ? "Pendiente" : r.resultado === "fallida" ? "Fallida" : "Probada"}
                {r.asesorId && ` · ${nombre(r.asesorId)}`} · checklist {entrada.acciones.filter((a) => r.checklist[a.accionId]).length} de {entrada.acciones.length}
                {r.notas.length > 0 && ` · ${r.notas.length} notas`}
              </li>
            ))}
          </ol>
        </div>
      </details>

      <Dialogo
        titulo="Soltar la entrada"
        abierto={confirmarSoltar}
        onCerrar={() => setConfirmarSoltar(false)}
        pie={(
          <>
            <button type="button" data-autofoco onClick={() => setConfirmarSoltar(false)}>Cancelar</button>
            <button type="button" className="peligro" onClick={() => { setConfirmarSoltar(false); ejecutar(q.soltar(entrada.id), "Soltaste la entrada. Volvió a Sin probar y la prueba empezará de nuevo."); }}>Soltar</button>
          </>
        )}
      >
        <p>La entrada vuelve a Sin probar y <strong>la prueba empieza de nuevo</strong> cuando alguien la tome. Tu ronda queda en el historial como «soltada», con su checklist y sus notas. El texto para clientes se conserva.</p>
      </Dialogo>

      <Dialogo
        titulo={`Anular hallazgo ${anulando ?? ""}`}
        abierto={anulando !== null}
        onCerrar={() => setAnulando(null)}
        pie={(
          <>
            <button type="button" onClick={() => setAnulando(null)}>Cancelar</button>
            <button type="button" className="peligro" disabled={!motivoAnular.trim()} onClick={() => {
              if (ejecutar(q.anularHallazgo(entrada.id, anulando!, motivoAnular), `Hallazgo ${anulando} anulado.`)) setAnulando(null);
            }}>Anular hallazgo</button>
          </>
        )}
      >
        <p>El hallazgo no se borra: queda tachado con el motivo.</p>
        <label htmlFor={idMotivo}>Motivo de la anulación</label>
        <textarea id={idMotivo} data-autofoco rows={3} value={motivoAnular} maxLength={500} onChange={(e) => setMotivoAnular(e.target.value)} />
      </Dialogo>

    </article>
  );
}

function BloqueClientes({ entrada }: { entrada: Entrada }) {
  const { usuarioActual, actualizarTextoClientes } = useQueHayDeNuevo();
  const [error, setError] = useState<string | null>(null);
  const idSwitch = useId();
  const idTitulo = useId();
  const idTexto = useId();
  const motivo = motivoNoPuedeMostrarClientes(entrada);
  const editable = puedeEditarTextoClientes(entrada, usuarioActual);
  const cambiar = (c: Parameters<typeof actualizarTextoClientes>[1]) => setError(actualizarTextoClientes(entrada.id, c));

  let estadoVisible: string;
  if (motivo) estadoVisible = motivo;
  else if (!entrada.mostrarClientes) estadoVisible = "No se muestra a los clientes.";
  else if (!entrada.tituloClientes.trim() || docVacio(entrada.textoClientes)) estadoVisible = "No es pública: falta el título o el texto para clientes.";
  else if (visibleParaClientes(entrada)) estadoVisible = "Visible para todos los clientes en la página de Novedades.";
  else if (entrada.estado === "archivada") estadoVisible = "Archivada: ya no sale en la página de Novedades.";
  else estadoVisible = "Saldrá en la página de Novedades cuando quede probada.";

  return (
    <section className="qhdn-bloque-clientes" aria-labelledby={`${idSwitch}-t`}>
      <h4 id={`${idSwitch}-t`}>Para clientes</h4>
      <div className="qhdn-switch-fila">
        <input
          id={idSwitch}
          type="checkbox"
          role="switch"
          checked={entrada.mostrarClientes}
          disabled={Boolean(motivo) || !editable}
          aria-describedby={`${idSwitch}-estado`}
          onChange={(e) => cambiar({ mostrarClientes: e.target.checked })}
        />
        <label htmlFor={idSwitch}>Mostrar esta novedad a los clientes</label>
      </div>
      <p id={`${idSwitch}-estado`} className="texto-ayuda" aria-live="polite">
        {estadoVisible}
        {!motivo && !editable && " Solo lo cambia quien tiene la prueba o, ya probada, un asesor que no sea autor ni editor."}
      </p>
      {error && <p className="qhdn-error-campo" role="alert">{error}</p>}
      {entrada.mostrarClientes && !motivo && (
        <div className="qhdn-texto-clientes">
          <p className="texto-ayuda">Se muestra a todos los clientes. La página pública nunca muestra el cliente, el desarrollador, los asesores, las reglas de negocio ni los videos.</p>
          <label htmlFor={idTitulo}>Título para clientes</label>
          <input id={idTitulo} value={entrada.tituloClientes} maxLength={120} disabled={!editable} onChange={(e) => cambiar({ tituloClientes: e.target.value })} placeholder="Ej.: Traslados en un solo paso" />
          <span id={idTexto} className="qhdn-etiqueta">Texto para clientes</span>
          <p className="texto-ayuda">Palabras simples. Parte de una copia de «Qué cambió» sin menciones del equipo.</p>
          {editable
            ? <EditorEnriquecido valor={entrada.textoClientes} onChange={(textoClientes) => cambiar({ textoClientes })} tamano="compacto" etiquetaId={idTexto} nombreBarra="Texto para clientes" />
            : <VisorEnriquecido valor={entrada.textoClientes} />}
        </div>
      )}
    </section>
  );
}
