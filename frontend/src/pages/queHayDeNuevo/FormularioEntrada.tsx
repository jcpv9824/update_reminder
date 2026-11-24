import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SelectorBuscable } from "../../components/SelectorBuscable";
import { useQueHayDeNuevo } from "./almacen";
import { ConstructorRutas } from "./componentes/ConstructorRuta";
import { EditorEnriquecido, VisorEnriquecido } from "./componentes/EditorEnriquecido";
import { ListaAdjuntos } from "./componentes/ListaAdjuntos";
import { Dialogo, EtiquetaSistema, EtiquetaTipo, ListaRutas } from "./componentes/Comunes";
import {
  contarErrores,
  ETIQUETAS_SISTEMA,
  ETIQUETAS_TIPO,
  ETIQUETAS_TIPO_CORTAS,
  haceCuanto,
  mensajesError,
  motivoNoPuedeCorregir,
  rutaVacia,
  validarParaPublicar,
  type ErroresFormulario,
} from "./logica";
import type { AccionRequerida, DatosFormulario, DocEnriquecido, Sistema, TipoEntrada } from "./tipos";
import { RUTA_BASE } from "./VistaDesarrollador";

/* Nueva entrada / Continuar borrador / Corregir y volver a publicar (diseño §4.2–4.4). */

const PREGUNTAS: { pregunta: string; tipo: TipoEntrada }[] = [
  { pregunta: "¿El sistema hace algo significativo que antes no hacía?", tipo: "nuevo" },
  { pregunta: "¿Cambié cómo funciona algo que ya existía?", tipo: "mejora" },
  { pregunta: "¿Cambió el resultado de una acción del usuario o de un parámetro?", tipo: "regla_negocio" },
  { pregunta: "¿Modificaste un SP de un proceso crítico?", tipo: "sp_critico" },
  { pregunta: "¿Cambié tanto una opción que habría que volver a probarla?", tipo: "rediseno" },
];

const AUTOGUARDADO_MS = 30_000;

export function FormularioEntrada({ modo }: { modo: "nueva" | "editar" | "corregir" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { estado, usuarioActual, usuarioPorId, guardarBorrador, publicar, corregir, eliminarBorrador } = useQueHayDeNuevo();
  const existente = id ? estado.entradas.find((e) => e.id === id) : undefined;

  const [datos, setDatos] = useState<DatosFormulario>(() => (existente
    ? {
      tipo: existente.tipo,
      sistema: existente.sistema,
      rutas: existente.rutas,
      queCambio: existente.queCambio,
      acciones: existente.acciones,
      cliente: existente.cliente,
      asesorInicialId: existente.asesorInicialId,
      reglasNegocio: existente.reglasNegocio,
      videos: existente.videos,
    }
    : {
      tipo: null, sistema: "sag_web", rutas: [rutaVacia()], queCambio: null, acciones: [], cliente: "", asesorInicialId: "",
      reglasNegocio: [], videos: [],
    }));
  const [entradaId, setEntradaId] = useState<string | null>(existente?.id ?? null);
  const [nota, setNota] = useState<DocEnriquecido | null>(null);
  const [errores, setErrores] = useState<ErroresFormulario | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [sucio, setSucio] = useState(false);
  const [guardadoEn, setGuardadoEn] = useState<string | null>(existente?.estado === "borrador" ? existente.editadaEn : null);
  const [, setReloj] = useState(0);
  const [confirmarEliminar, setConfirmarEliminar] = useState(false);
  const resumenRef = useRef<HTMLDivElement>(null);
  const datosRef = useRef(datos);
  datosRef.current = datos;
  const ids = {
    tipo: useId(), sistema: useId(), rutas: useId(), rutasError: useId(), queCambio: useId(), queCambioError: useId(),
    acciones: useId(), cliente: useId(), clienteAyuda: useId(), asesor: useId(), nota: useId(), autoguardado: useId(),
  };

  const corrigiendo = modo === "corregir";
  const accionesPredefinidas = useMemo(
    () => [...estado.configuracion.accionesPredefinidas].sort((a, b) => a.orden - b.orden),
    [estado.configuracion.accionesPredefinidas],
  );
  const asesores = useMemo(
    () => estado.usuarios
      .filter((u) => u.activo && u.areas.includes("Soporte") && u.id !== usuarioActual?.id)
      .map((u) => ({ id: u.id, etiqueta: u.nombre, subtitulo: u.correo })),
    [estado.usuarios, usuarioActual?.id],
  );

  const actualizar = useCallback((cambio: Partial<DatosFormulario>) => {
    setDatos((d) => ({ ...d, ...cambio }));
    setSucio(true);
  }, []);

  // Si ya se intentó publicar, los errores se recalculan en vivo mientras se corrigen.
  useEffect(() => {
    if (errores && !corrigiendo) setErrores(validarParaPublicar(datos, estado.usuarios));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datos]);

  const guardar = useCallback((silencioso: boolean) => {
    if (corrigiendo) return true;
    const r = guardarBorrador(entradaId, datosRef.current);
    if (r.error) {
      setErrorGeneral(r.error);
      return false;
    }
    // No se cambia la URL al autoguardar: cambiarla remontaría el formulario y movería el foco.
    if (!entradaId && r.id) setEntradaId(r.id);
    setSucio(false);
    setGuardadoEn(new Date().toISOString());
    if (!silencioso) setErrorGeneral(null);
    return true;
  }, [corrigiendo, entradaId, guardarBorrador]);

  // Autoguardado cada 30 s si hay cambios, y reloj del aviso «Guardado hace 1 min».
  useEffect(() => {
    if (corrigiendo) return undefined;
    const t = setInterval(() => {
      setReloj((n) => n + 1);
      if (sucio) guardar(true);
    }, AUTOGUARDADO_MS);
    return () => clearInterval(t);
  }, [corrigiendo, sucio, guardar]);

  if (id && !existente) {
    return <div className="tarjeta" role="alert"><p>La entrada no existe.</p><Link to={RUTA_BASE}>Volver a Mis entradas</Link></div>;
  }
  if (existente && existente.autorId !== usuarioActual?.id) {
    return <div className="tarjeta" role="alert"><p>Solo el autor puede editar esta entrada.</p><Link to={`${RUTA_BASE}/${existente.id}`}>Ver detalle</Link></div>;
  }
  if (modo === "editar" && existente && existente.estado !== "borrador") {
    return <div className="tarjeta" role="alert"><p>Esta entrada ya se publicó y es de solo lectura.</p><Link to={`${RUTA_BASE}/${existente.id}`}>Ver detalle</Link></div>;
  }
  const motivoCorregir = corrigiendo && existente && usuarioActual ? motivoNoPuedeCorregir(existente, usuarioActual.id) : null;
  if (motivoCorregir) {
    return <div className="tarjeta" role="alert"><p>{motivoCorregir}</p><Link to={`${RUTA_BASE}/${existente!.id}`}>Ver detalle</Link></div>;
  }

  function alSalirDeCampo() {
    if (sucio && !corrigiendo) guardar(true);
  }

  function mostrarErrores(e: ErroresFormulario) {
    setErrores(e);
    requestAnimationFrame(() => resumenRef.current?.focus());
  }

  function alPublicar() {
    setErrorGeneral(null);
    if (corrigiendo) {
      const e = validarParaPublicar({ ...datos }, estado.usuarios);
      const relevantes: ErroresFormulario = { queCambio: e.queCambio, acciones: e.acciones, accionesTexto: e.accionesTexto };
      if (contarErrores(relevantes) > 0) return mostrarErrores(relevantes);
      const error = corregir(existente!.id, { queCambio: datos.queCambio, acciones: datos.acciones, nota });
      if (error) return setErrorGeneral(error);
      navigate(`${RUTA_BASE}/${existente!.id}`, { state: { aviso: "La entrada volvió a Soporte con una nueva ronda de pruebas." } });
      return;
    }
    const e = validarParaPublicar(datos, estado.usuarios);
    if (contarErrores(e) > 0) return mostrarErrores(e);
    const r = guardarBorrador(entradaId, datos);
    if (r.error || !r.id) return setErrorGeneral(r.error ?? "No se pudo guardar.");
    const error = publicar(r.id);
    if (error) {
      setEntradaId(r.id);
      return setErrorGeneral(error);
    }
    navigate(`${RUTA_BASE}/${r.id}`, { state: { aviso: "Entrada publicada a Soporte. Quedó en Sin probar." } });
  }

  function alternarAccion(accionId: string, nombre: string, marcada: boolean) {
    const acciones: AccionRequerida[] = marcada
      ? [...datos.acciones, { accionId, nombre, texto: null }]
      : datos.acciones.filter((a) => a.accionId !== accionId);
    actualizar({ acciones });
  }

  function cambiarSistema(sistema: Sistema) {
    actualizar({ sistema });
  }

  const titulo = corrigiendo ? "Corregir y volver a publicar" : entradaId ? "Continuar borrador" : "Nueva entrada";
  const listaErrores = errores ? mensajesError(errores) : [];
  const vistaPrevia = (
    <div className="qhdn-vista-previa">
      <div className="qhdn-etiquetas"><EtiquetaTipo tipo={datos.tipo} /><EtiquetaSistema sistema={datos.sistema} /></div>
      <ListaRutas rutas={datos.rutas} />
      <h5>Qué cambió</h5>
      <VisorEnriquecido valor={datos.queCambio} />
      <h5>Mi checklist</h5>
      {datos.acciones.length === 0 ? <p className="texto-ayuda">Sin acciones requeridas.</p> : (
        <ul className="qhdn-checklist qhdn-checklist-previa">
          {datos.acciones.map((a) => (
            <li key={a.accionId}><input type="checkbox" disabled aria-label={a.nombre} /> <span><strong>{a.nombre}</strong><VisorEnriquecido valor={a.texto} /></span></li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      <div className="encabezado-pagina">
        <h2>{titulo}</h2>
        <Link to={existente && existente.estado !== "borrador" ? `${RUTA_BASE}/${existente.id}` : RUTA_BASE} onClick={() => { if (sucio) guardar(true); }}>
          Volver
        </Link>
      </div>

      {errorGeneral && <div className="alerta alerta-error" role="alert">{errorGeneral}</div>}
      {listaErrores.length > 0 && (
        <div ref={resumenRef} tabIndex={-1} className="alerta alerta-error qhdn-resumen-errores" role="alert" aria-labelledby="titulo-errores">
          <strong id="titulo-errores">Para {corrigiendo ? "volver a publicar" : "publicar"} falta:</strong>
          <ul>{listaErrores.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}

      <div className="qhdn-formulario-grid">
        <form className="tarjeta qhdn-formulario" onSubmit={(e) => e.preventDefault()} onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) alSalirDeCampo();
          else if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) alSalirDeCampo();
        }} noValidate>
          {corrigiendo ? (
            <section className="qhdn-seccion">
              <p className="alerta alerta-info">Al corregir solo cambias «Qué cambió» y «Acción requerida». La entrada vuelve a Sin probar con una nueva ronda y la historia anterior se conserva.</p>
              {vistaPreviaSoloLectura(datos)}
            </section>
          ) : (
            <>
              <fieldset className="qhdn-fieldset" aria-describedby={errores?.tipo ? `${ids.tipo}-e` : undefined}>
                <legend>1. Tipo <span className="qhdn-obligatorio" aria-hidden="true">*</span></legend>
                <div className="qhdn-radios">
                  {(Object.keys(ETIQUETAS_TIPO) as TipoEntrada[]).map((t) => (
                    <label key={t} className="qhdn-radio">
                      <input type="radio" name={ids.tipo} value={t} checked={datos.tipo === t} onChange={() => actualizar({ tipo: t })} aria-invalid={errores?.tipo ? true : undefined} />
                      {ETIQUETAS_TIPO[t]}
                    </label>
                  ))}
                </div>
                {errores?.tipo && <p id={`${ids.tipo}-e`} className="qhdn-error-campo">{errores.tipo}</p>}
              </fieldset>

              <fieldset className="qhdn-fieldset">
                <legend>2. Sistema <span className="qhdn-obligatorio" aria-hidden="true">*</span></legend>
                <div className="qhdn-radios">
                  {(Object.keys(ETIQUETAS_SISTEMA) as Sistema[]).map((s) => (
                    <label key={s} className="qhdn-radio">
                      <input type="radio" name={ids.sistema} value={s} checked={datos.sistema === s} onChange={() => cambiarSistema(s)} />
                      {ETIQUETAS_SISTEMA[s]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <dl className="qhdn-datos">
                <dt>Desarrollador</dt>
                <dd>{usuarioPorId(existente?.autorId ?? usuarioActual?.id)?.nombre ?? "—"} <small className="texto-ayuda">· siempre es quien crea la entrada</small></dd>
              </dl>

              <fieldset className="qhdn-fieldset">
                <legend id={ids.rutas}>3. Ruta <span className="qhdn-obligatorio" aria-hidden="true">*</span></legend>
                <p className="texto-ayuda">Escribe la ruta tal como aparece en el sistema: vía, submenús y opción.</p>
                <ConstructorRutas
                  rutas={datos.rutas}
                  onChange={(rutas) => actualizar({ rutas })}
                  error={errores?.rutas}
                  idError={ids.rutasError}
                />
                {errores?.rutas && <p id={ids.rutasError} className="qhdn-error-campo">{errores.rutas}</p>}
              </fieldset>
            </>
          )}

          <div className="qhdn-campo">
            <span id={ids.queCambio} className="qhdn-etiqueta">4. Qué cambió <span className="qhdn-obligatorio" aria-hidden="true">*</span></span>
            <p id={`${ids.queCambio}-ayuda`} className="texto-ayuda">Usa el lenguaje del usuario. Si es un parámetro, escribe su nombre y en qué maestro está.</p>
            <EditorEnriquecido
              valor={datos.queCambio}
              onChange={(queCambio) => actualizar({ queCambio })}
              onBlur={alSalirDeCampo}
              tamano="mediano"
              etiquetaId={ids.queCambio}
              descripcionId={errores?.queCambio ? ids.queCambioError : `${ids.queCambio}-ayuda`}
              invalido={Boolean(errores?.queCambio)}
              usuariosMencion={estado.usuarios}
              nombreBarra="Qué cambió"
              placeholder="Describe el cambio como lo vería el usuario…"
            />
            {errores?.queCambio && <p id={ids.queCambioError} className="qhdn-error-campo">{errores.queCambio}</p>}
          </div>

          <fieldset className="qhdn-fieldset">
            <legend id={ids.acciones}>5. Acción requerida <span className="qhdn-obligatorio" aria-hidden="true">*</span></legend>
            <p className="texto-ayuda">Marca al menos una. Cada una abre su propio detalle obligatorio.</p>
            {accionesPredefinidas.filter((a) => a.activa || datos.acciones.some((x) => x.accionId === a.id)).map((a) => {
              const elegida = datos.acciones.find((x) => x.accionId === a.id);
              const idEtiqueta = `${ids.acciones}-${a.id}`;
              const error = errores?.accionesTexto?.[a.id];
              return (
                <div key={a.id} className="qhdn-accion">
                  <label className="qhdn-check">
                    <input type="checkbox" checked={Boolean(elegida)} onChange={(e) => alternarAccion(a.id, a.nombre, e.target.checked)} />
                    {a.nombre}
                  </label>
                  {elegida && (
                    <div className="qhdn-accion-editor">
                      <span id={idEtiqueta} className="sr-only">Detalle de {a.nombre}</span>
                      <EditorEnriquecido
                        valor={elegida.texto}
                        onChange={(texto) => actualizar({ acciones: datos.acciones.map((x) => (x.accionId === a.id ? { ...x, texto } : x)) })}
                        onBlur={alSalirDeCampo}
                        tamano="compacto"
                        etiquetaId={idEtiqueta}
                        invalido={Boolean(error)}
                        descripcionId={error ? `${idEtiqueta}-e` : undefined}
                        usuariosMencion={estado.usuarios}
                        nombreBarra={a.nombre}
                        placeholder="Qué debe hacer Soporte…"
                      />
                      {error && <p id={`${idEtiqueta}-e`} className="qhdn-error-campo">{error}</p>}
                    </div>
                  )}
                </div>
              );
            })}
            {errores?.acciones && <p className="qhdn-error-campo">{errores.acciones}</p>}
          </fieldset>

          {!corrigiendo && datos.tipo === "nuevo" && (
            <section className="qhdn-seccion-nuevo" aria-labelledby="titulo-solo-nuevos">
              <h3 id="titulo-solo-nuevos">Solo desarrollos nuevos</h3>
              <div className="qhdn-campo">
                <label htmlFor={ids.cliente}>6. Cliente <span className="qhdn-obligatorio" aria-hidden="true">*</span></label>
                <input
                  id={ids.cliente}
                  value={datos.cliente}
                  maxLength={150}
                  onChange={(e) => actualizar({ cliente: e.target.value })}
                  aria-invalid={errores?.cliente ? true : undefined}
                  aria-describedby={errores?.cliente ? `${ids.cliente}-e` : ids.clienteAyuda}
                  placeholder="Escribe el nombre del cliente"
                />
                <p id={ids.clienteAyuda} className="texto-ayuda">
                  Aún no hay lista de clientes activos en SAG Web: escribe el nombre a mano. Puedes guardar el borrador sin cliente; para publicar es obligatorio.
                </p>
                {errores?.cliente && <p id={`${ids.cliente}-e`} className="qhdn-error-campo">{errores.cliente}</p>}
              </div>
              <div className="qhdn-campo">
                <label className="qhdn-label-selector">
                  <span>7. Asesor a cargo de pruebas iniciales <span className="qhdn-obligatorio" aria-hidden="true">*</span></span>
                  <SelectorBuscable
                    opciones={asesores}
                    valor={datos.asesorInicialId}
                    onChange={(asesorInicialId) => actualizar({ asesorInicialId })}
                    placeholder="Busca un asesor de Soporte"
                    permiteVacio
                    textoVacio="(sin asesor)"
                  />
                </label>
                <p className="texto-ayuda">Solo usuarios activos con el área Soporte. Tiene prioridad, no exclusividad: cualquier asesor puede tomar la entrada.</p>
                {errores?.asesorInicialId && <p className="qhdn-error-campo">{errores.asesorInicialId}</p>}
              </div>
              <ListaAdjuntos
                titulo="8. Documento de reglas de negocio"
                adjuntos={datos.reglasNegocio}
                onChange={(reglasNegocio) => actualizar({ reglasNegocio })}
                acepta=".doc,.docx,.pdf,.xls,.xlsx"
                ayudaArchivo="Word, PDF o Excel. Máximo 20 MB."
                maxBytes={20 * 1024 * 1024}
              />
              <ListaAdjuntos
                titulo="9. Video de la entrega"
                adjuntos={datos.videos}
                onChange={(videos) => actualizar({ videos })}
                acepta="video/mp4,video/webm"
                ayudaArchivo="MP4 o WebM. Máximo 200 MB."
                maxBytes={200 * 1024 * 1024}
              />
              {errores?.adjuntos && <p className="qhdn-error-campo">{errores.adjuntos}</p>}
            </section>
          )}

          {corrigiendo && (
            <div className="qhdn-campo">
              <span id={ids.nota} className="qhdn-etiqueta">Nota de corrección <small>(opcional)</small></span>
              <EditorEnriquecido valor={nota} onChange={setNota} tamano="mediano" etiquetaId={ids.nota} usuariosMencion={estado.usuarios} nombreBarra="Nota de corrección" placeholder="Qué corregiste y por qué…" />
            </div>
          )}

          <div className="qhdn-pie-formulario">
            {!corrigiendo && (
              <span id={ids.autoguardado} className="estado-guardado" role="status" aria-live="polite">
                {sucio ? "Cambios sin guardar · se guardan solos cada 30 s o al salir de un campo" : guardadoEn ? `Guardado ${haceCuanto(guardadoEn)}` : "Sin cambios"}
              </span>
            )}
            <div className="acciones-formulario">
              {!corrigiendo && entradaId && (
                <button type="button" className="peligro" onClick={() => setConfirmarEliminar(true)}>
                  Eliminar borrador
                </button>
              )}
              {!corrigiendo && <button type="button" onClick={() => guardar(false)}>Guardar borrador</button>}
              <button type="button" className="primario" onClick={alPublicar}>{corrigiendo ? "Volver a publicar" : "Publicar a Soporte"}</button>
            </div>
          </div>
        </form>

        <Dialogo
          titulo="Eliminar borrador"
          abierto={confirmarEliminar}
          onCerrar={() => setConfirmarEliminar(false)}
          pie={(
            <>
              <button type="button" data-autofoco onClick={() => setConfirmarEliminar(false)}>Cancelar</button>
              <button type="button" className="peligro" onClick={() => {
                const error = entradaId ? eliminarBorrador(entradaId) : null;
                setConfirmarEliminar(false);
                if (error) setErrorGeneral(error);
                else navigate(RUTA_BASE, { state: { aviso: "Borrador eliminado." } });
              }}>Eliminar borrador</button>
            </>
          )}
        >
          <p>El borrador se eliminará. Esta acción no se puede deshacer desde el portal.</p>
        </Dialogo>

        <aside className="qhdn-panel-lateral" aria-label="Ayuda para decidir">
          {!corrigiendo && (
            <section className="tarjeta" aria-labelledby="titulo-va">
              <h3 id="titulo-va">¿Va en el Qué hay de nuevo?</h3>
              <ul className="qhdn-preguntas">
                {PREGUNTAS.map((p) => (
                  <li key={p.tipo}>
                    <span>{p.pregunta}</span>
                    <button type="button" className={datos.tipo === p.tipo ? "activo" : ""} aria-pressed={datos.tipo === p.tipo} onClick={() => actualizar({ tipo: p.tipo })}>
                      Sí: {ETIQUETAS_TIPO_CORTAS[p.tipo]}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="texto-ayuda"><strong>No va:</strong> corrección de errores, cambios internos o cambios pequeños de diseño.</p>
            </section>
          )}
          <section className="tarjeta" aria-labelledby="titulo-previa">
            <h3 id="titulo-previa">Vista previa para Soporte</h3>
            {vistaPrevia}
          </section>
        </aside>
      </div>
    </>
  );
}

function vistaPreviaSoloLectura(datos: DatosFormulario) {
  return (
    <dl className="qhdn-datos">
      <dt>Tipo</dt><dd>{datos.tipo ? ETIQUETAS_TIPO[datos.tipo] : "—"}</dd>
      <dt>Sistema</dt><dd>{datos.sistema ? ETIQUETAS_SISTEMA[datos.sistema] : "—"}</dd>
      <dt>Rutas</dt><dd><ListaRutas rutas={datos.rutas} /></dd>
      {datos.tipo === "nuevo" && (<><dt>Cliente</dt><dd>{datos.cliente || "—"}</dd></>)}
    </dl>
  );
}
