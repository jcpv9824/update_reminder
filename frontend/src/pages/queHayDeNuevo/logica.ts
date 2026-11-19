import type {
  AccionRequerida,
  DatosFormulario,
  DocEnriquecido,
  Entrada,
  EstadoEntrada,
  FiltroResultado,
  Ruta,
  Sistema,
  TipoEntrada,
  UsuarioPortal,
} from "./tipos";

/*
 * Reglas del prototipo, sin React. El backend real debe aplicar las mismas;
 * aquí solo sirven para que la interfaz se comporte como lo hará con la API.
 */

export const ETIQUETAS_TIPO: Record<TipoEntrada, string> = {
  nuevo: "Nuevo",
  mejora: "Mejora o cambio de funcionalidad",
  regla_negocio: "Regla de negocio",
  sp_critico: "SP crítico",
  rediseno: "Rediseño o refactorización",
};

export const ETIQUETAS_TIPO_CORTAS: Record<TipoEntrada, string> = {
  nuevo: "Nuevo",
  mejora: "Mejora",
  regla_negocio: "Regla de negocio",
  sp_critico: "SP crítico",
  rediseno: "Rediseño",
};

export const ETIQUETAS_SISTEMA: Record<Sistema, string> = { sag_web: "SAG Web", sag_clasico: "SAG Clásico" };

export const ETIQUETAS_ESTADO_QHDN: Record<EstadoEntrada, string> = {
  borrador: "Borrador",
  sin_probar: "Sin probar",
  en_pruebas: "En pruebas",
  fallida: "Fallida",
  probado: "Probado",
  archivada: "Archivada",
};

/** Reutiliza las clases `.estado-*` existentes del portal. */
export const CLASE_ESTADO: Record<EstadoEntrada, string> = {
  borrador: "estado-inactive",
  sin_probar: "estado-pending",
  en_pruebas: "estado-in_progress",
  fallida: "estado-failed",
  probado: "estado-completed",
  archivada: "estado-cancelled",
};

/** Nivel 1 de toda ruta: lista fija. */
export const VIAS = ["Barra de navegación", "Barra lateral"];
export const MIN_NIVELES = 3;
export const MAX_NIVELES = 5;
export const MAX_RUTAS = 10;
/** Límite de tamaño del contenido al guardar borrador (prototipo; el definitivo está en el documento 05). */
export const MAX_BYTES_CONTENIDO = 512 * 1024;

export function nuevoId(prefijo = "id"): string {
  const aleatorio = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefijo}-${aleatorio}`;
}

/* ---------- Texto enriquecido ---------- */

/** Texto plano de un documento TipTap; las menciones salen como «@Nombre». */
export function textoPlano(doc: DocEnriquecido | null | undefined): string {
  if (!doc) return "";
  const partes: string[] = [];
  const recorrer = (nodo: DocEnriquecido) => {
    if (nodo.type === "text" && nodo.text) partes.push(nodo.text);
    else if (nodo.type === "mencion") partes.push(`@${nodo.attrs?.etiqueta ?? ""}`);
    else if (nodo.type === "adjuntoArchivo") partes.push(`[${nodo.attrs?.nombre ?? "adjunto"}]`);
    else if (nodo.type === "hardBreak") partes.push(" ");
    nodo.content?.forEach(recorrer);
    if (nodo.type && ["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(nodo.type)) partes.push(" ");
  };
  recorrer(doc);
  return partes.join("").replace(/\s+/g, " ").trim();
}

export function docVacio(doc: DocEnriquecido | null | undefined): boolean {
  if (!doc) return true;
  if (textoPlano(doc).length > 0) return false;
  let tieneMedio = false;
  const recorrer = (nodo: DocEnriquecido) => {
    if (nodo.type === "image" || nodo.type === "adjuntoArchivo") tieneMedio = true;
    nodo.content?.forEach(recorrer);
  };
  recorrer(doc);
  return !tieneMedio;
}

export function docDeTexto(...parrafos: string[]): DocEnriquecido {
  return {
    type: "doc",
    content: parrafos.map((texto) => ({ type: "paragraph", content: texto ? [{ type: "text", text: texto }] : [] })),
  };
}

/**
 * QA-13: al copiar «Qué cambió» al texto para clientes se quitan las menciones
 * (no quedan nombres del equipo) y los adjuntos internos.
 */
export function quitarMenciones(doc: DocEnriquecido | null): DocEnriquecido | null {
  if (!doc) return null;
  const limpiar = (nodo: DocEnriquecido): DocEnriquecido | null => {
    if (nodo.type === "mencion" || nodo.type === "adjuntoArchivo") return null;
    if (!nodo.content) return { ...nodo };
    return { ...nodo, content: nodo.content.map(limpiar).filter((n): n is DocEnriquecido => n !== null) };
  };
  return limpiar(doc);
}

export function bytesDe(valor: unknown): number {
  return new Blob([JSON.stringify(valor ?? null)]).size;
}

/* ---------- Rutas ---------- */

export function rutaVacia(): Ruta {
  return { id: nuevoId("ruta"), niveles: [{ valor: VIAS[0] }, { valor: "" }, { valor: "" }] };
}

export function rutaTexto(ruta: Ruta | undefined): string {
  if (!ruta) return "";
  return ruta.niveles.map((n) => n.valor.trim() || "…").join(" › ");
}

/** Agrega un submenú vacío justo antes de la Opción (el último nivel). */
export function agregarSubmenu(ruta: Ruta): Ruta {
  if (ruta.niveles.length >= MAX_NIVELES) return ruta;
  const niveles = [...ruta.niveles];
  niveles.splice(niveles.length - 1, 0, { valor: "" });
  return { ...ruta, niveles };
}

/** Quita el último submenú agregado (el que está antes de la Opción). */
export function quitarSubmenu(ruta: Ruta): Ruta {
  if (ruta.niveles.length <= MIN_NIVELES) return ruta;
  const niveles = [...ruta.niveles];
  niveles.splice(niveles.length - 2, 1);
  return { ...ruta, niveles };
}

export function cambiarNivel(ruta: Ruta, indice: number, valor: string): Ruta {
  return { ...ruta, niveles: ruta.niveles.map((n, i) => (i === indice ? { valor } : n)) };
}

function claveRuta(ruta: Ruta) {
  return ruta.niveles.map((n) => n.valor.trim().toLowerCase()).join("›");
}

/* ---------- Validación del formulario ---------- */

export type ErroresFormulario = Partial<Record<
  "tipo" | "sistema" | "rutas" | "queCambio" | "acciones" | "cliente" | "asesorInicialId" | "adjuntos" | "tamano",
  string
>> & { accionesTexto?: Record<string, string> };

export function esUrlHttps(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

export function validarBorrador(datos: DatosFormulario): ErroresFormulario {
  if (bytesDe(datos) > MAX_BYTES_CONTENIDO) {
    return { tamano: "El contenido supera el tamaño permitido. Quita imágenes o texto antes de guardar." };
  }
  return {};
}

export function validarParaPublicar(datos: DatosFormulario, usuarios: UsuarioPortal[] = []): ErroresFormulario {
  const errores: ErroresFormulario = { ...validarBorrador(datos) };
  if (!datos.tipo) errores.tipo = "Elige el tipo de entrada.";
  if (!datos.sistema) errores.sistema = "Elige el sistema.";

  if (datos.rutas.length === 0) errores.rutas = "Agrega al menos una ruta.";
  else if (datos.rutas.length > MAX_RUTAS) errores.rutas = `Puedes registrar como máximo ${MAX_RUTAS} rutas.`;
  else if (datos.rutas.some((r) => r.niveles.length < MIN_NIVELES || r.niveles.length > MAX_NIVELES)) {
    errores.rutas = `Cada ruta debe tener entre ${MIN_NIVELES} y ${MAX_NIVELES} niveles.`;
  } else if (datos.rutas.some((r) => r.niveles.some((n) => !n.valor.trim()))) {
    errores.rutas = "Completa todos los niveles de cada ruta.";
  } else if (new Set(datos.rutas.map(claveRuta)).size !== datos.rutas.length) {
    errores.rutas = "Hay dos rutas idénticas. Quita la repetida.";
  }

  if (docVacio(datos.queCambio)) errores.queCambio = "Describe qué cambió.";

  if (datos.acciones.length === 0) errores.acciones = "Marca al menos una acción requerida.";
  const accionesTexto: Record<string, string> = {};
  datos.acciones.forEach((a) => {
    if (docVacio(a.texto)) accionesTexto[a.accionId] = `Escribe el detalle de «${a.nombre}».`;
  });
  if (Object.keys(accionesTexto).length > 0) errores.accionesTexto = accionesTexto;

  if (datos.tipo === "nuevo") {
    if (!datos.cliente.trim()) errores.cliente = "Escribe el cliente. Es obligatorio para publicar una entrada Nuevo.";
    const asesor = usuarios.find((u) => u.id === datos.asesorInicialId);
    if (!datos.asesorInicialId) errores.asesorInicialId = "Elige el asesor a cargo de pruebas iniciales.";
    else if (usuarios.length > 0 && (!asesor || !asesor.activo || !asesor.areas.includes("Soporte"))) {
      errores.asesorInicialId = "El asesor elegido ya no está activo en Soporte. Elige otro.";
    }
    const adjuntos = [...datos.reglasNegocio, ...datos.videos];
    if (adjuntos.some((a) => a.clase === "enlace" && !esUrlHttps(a.url))) {
      errores.adjuntos = "Los enlaces deben empezar por https://.";
    } else if (adjuntos.some((a) => a.clase === "archivo" && !a.url)) {
      errores.adjuntos = "Hay un adjunto sin archivo. Elige el archivo o quita la fila.";
    }
  }
  return errores;
}

export function contarErrores(errores: ErroresFormulario): number {
  const { accionesTexto, ...resto } = errores;
  return Object.values(resto).filter(Boolean).length + Object.keys(accionesTexto ?? {}).length;
}

/** Lista legible de errores para el resumen del formulario. */
export function mensajesError(errores: ErroresFormulario): string[] {
  const { accionesTexto, ...resto } = errores;
  return [...Object.values(resto).filter((m): m is string => Boolean(m)), ...Object.values(accionesTexto ?? {})];
}

/** Datos que solo aplican a Nuevo: si el tipo cambia, no se guardan. */
export function normalizarDatos(datos: DatosFormulario): DatosFormulario {
  if (datos.tipo === "nuevo") return datos;
  return { ...datos, cliente: "", asesorInicialId: "", reglasNegocio: [], videos: [] };
}

/* ---------- Ciclo de pruebas ---------- */

export class ErrorRegla extends Error {}

/** Agrega un evento a la bitácora de la entrada. */
export function conEvento(entrada: Entrada, usuarioId: string, accion: string, ahora: string): Entrada {
  return { ...entrada, historial: [...entrada.historial, { fecha: ahora, usuarioId, accion }] };
}

/** Todos los asesores que participaron en las pruebas (incluye rondas soltadas, fallidas y re-pruebas), en orden. */
export function asesoresParticipantes(entrada: Entrada): string[] {
  return Array.from(new Set(entrada.rondas.map((r) => r.asesorId).filter((id): id is string => Boolean(id))));
}

/** Pestaña Probadas: filtro de resultado. Las fallidas viven dentro de Probadas (decisión del propietario). */
export const RESULTADOS_PROBADAS: Record<FiltroResultado, { etiqueta: string; estados: EstadoEntrada[] }> = {
  ambas: { etiqueta: "Ambas", estados: ["probado", "archivada", "fallida"] },
  aprobadas: { etiqueta: "Sin errores", estados: ["probado", "archivada"] },
  fallidas: { etiqueta: "Fallidas", estados: ["fallida"] },
};

export function rondaActual(entrada: Entrada) {
  return entrada.rondas[entrada.rondas.length - 1];
}

export function hallazgosVigentesRondaActual(entrada: Entrada) {
  const ronda = rondaActual(entrada)?.numero;
  return entrada.hallazgos.filter((h) => h.ronda === ronda && !h.anulacion);
}

export function avanceChecklist(entrada: Entrada) {
  const ronda = rondaActual(entrada);
  const total = entrada.acciones.length;
  const hechos = entrada.acciones.filter((a) => ronda?.checklist[a.accionId]).length;
  return { hechos, total, completo: total > 0 && hechos === total };
}

export function esProbador(usuario: UsuarioPortal | undefined): boolean {
  return Boolean(usuario?.activo && usuario.areas.includes("Soporte"));
}

export function esDesarrollador(usuario: UsuarioPortal | undefined): boolean {
  return Boolean(usuario?.activo && usuario.areas.includes("Desarrollo"));
}

/** Motivo por el que el usuario no puede tomar la entrada, o null si puede (H-01, QA-04). */
export function motivoNoPuedeTomar(entrada: Entrada, usuario: UsuarioPortal | undefined): string | null {
  if (!esProbador(usuario)) return "Solo las personas con el área Soporte pueden probar entradas.";
  if (entrada.estado !== "sin_probar") return "Solo se puede tomar una entrada sin probar.";
  if (entrada.autorId === usuario!.id) return "No puedes probar una entrada que creaste.";
  if (entrada.editoresIds.includes(usuario!.id)) return "No puedes probar una entrada que editaste o corregiste.";
  return null;
}

function exigirTitular(entrada: Entrada, usuarioId: string) {
  if (entrada.estado !== "en_pruebas") throw new ErrorRegla("La entrada no está en pruebas.");
  if (entrada.tomadaPorId !== usuarioId) throw new ErrorRegla("Solo quien tomó la entrada puede cambiar su prueba.");
}

function rondasConActual(entrada: Entrada, cambio: (ronda: Entrada["rondas"][number]) => Entrada["rondas"][number]) {
  return entrada.rondas.map((r, i) => (i === entrada.rondas.length - 1 ? cambio(r) : r));
}

function rondaNueva(entrada: Entrada) {
  return { numero: (rondaActual(entrada)?.numero ?? 0) + 1, asesorId: null, tomadaEn: null, cerradaEn: null, resultado: "pendiente" as const, checklist: {}, notas: [] };
}

export function publicar(entrada: Entrada, usuario: UsuarioPortal, usuarios: UsuarioPortal[], ahora: string): Entrada {
  if (entrada.estado !== "borrador") throw new ErrorRegla("Solo se publica un borrador.");
  if (entrada.autorId !== usuario.id) throw new ErrorRegla("Solo el autor publica su entrada.");
  if (contarErrores(validarParaPublicar(entrada, usuarios)) > 0) throw new ErrorRegla("Faltan campos para publicar.");
  return conEvento({
    ...entrada,
    estado: "sin_probar",
    publicadaPorId: usuario.id,
    publicadaEn: ahora,
    editadaPorId: usuario.id,
    editadaEn: ahora,
    rondas: [rondaNueva(entrada)],
  }, usuario.id, "Publicó a Soporte", ahora);
}

export function tomar(entrada: Entrada, usuario: UsuarioPortal, ahora: string): Entrada {
  const motivo = motivoNoPuedeTomar(entrada, usuario);
  if (motivo) throw new ErrorRegla(motivo);
  return conEvento({
    ...entrada,
    estado: "en_pruebas",
    tomadaPorId: usuario.id,
    rondas: rondasConActual(entrada, (r) => ({ ...r, asesorId: usuario.id, tomadaEn: ahora, resultado: "en_curso", checklist: {}, notas: [] })),
  }, usuario.id, `Tomó para probar (ronda ${rondaActual(entrada).numero})`, ahora);
}

/** H-10: la ronda soltada queda en el historial y la siguiente empieza en blanco. El texto para clientes se conserva (QA-09). */
export function soltar(entrada: Entrada, usuarioId: string, ahora: string): Entrada {
  exigirTitular(entrada, usuarioId);
  const cerradas = rondasConActual(entrada, (r) => ({ ...r, resultado: "soltada", cerradaEn: ahora }));
  return conEvento(
    { ...entrada, estado: "sin_probar", tomadaPorId: null, rondas: [...cerradas, rondaNueva(entrada)] },
    usuarioId, `Soltó la prueba (ronda ${rondaActual(entrada).numero}); la prueba empieza de nuevo`, ahora,
  );
}

export function alternarChecklist(entrada: Entrada, usuarioId: string, accionId: string): Entrada {
  exigirTitular(entrada, usuarioId);
  return { ...entrada, rondas: rondasConActual(entrada, (r) => ({ ...r, checklist: { ...r.checklist, [accionId]: !r.checklist[accionId] } })) };
}

export function agregarNota(entrada: Entrada, usuarioId: string, texto: DocEnriquecido, esHallazgo: boolean, ahora: string): Entrada {
  exigirTitular(entrada, usuarioId);
  if (docVacio(texto)) throw new ErrorRegla("Escribe la nota antes de guardarla.");
  if (esHallazgo) {
    const numero = entrada.hallazgos.reduce((max, h) => Math.max(max, h.numero), 0) + 1;
    return conEvento({
      ...entrada,
      hallazgos: [...entrada.hallazgos, { numero, ronda: rondaActual(entrada).numero, fecha: ahora, autorId: usuarioId, texto, anulacion: null }],
    }, usuarioId, `Registró el hallazgo ${numero}`, ahora);
  }
  return { ...entrada, rondas: rondasConActual(entrada, (r) => ({ ...r, notas: [...r.notas, { id: nuevoId("nota"), fecha: ahora, autorId: usuarioId, texto }] })) };
}

/** QA-26: anular deja el hallazgo tachado con su motivo; nunca se borra. */
export function anularHallazgo(entrada: Entrada, usuarioId: string, numero: number, motivo: string, ahora: string): Entrada {
  exigirTitular(entrada, usuarioId);
  const hallazgo = entrada.hallazgos.find((h) => h.numero === numero);
  if (!hallazgo) throw new ErrorRegla("El hallazgo no existe.");
  if (hallazgo.anulacion) throw new ErrorRegla("El hallazgo ya está anulado.");
  if (hallazgo.ronda !== rondaActual(entrada).numero) throw new ErrorRegla("Solo se anulan hallazgos de la ronda actual.");
  if (!motivo.trim()) throw new ErrorRegla("Escribe el motivo de la anulación.");
  return conEvento({
    ...entrada,
    hallazgos: entrada.hallazgos.map((h) => (h.numero === numero ? { ...h, anulacion: { fecha: ahora, autorId: usuarioId, motivo: motivo.trim() } } : h)),
  }, usuarioId, `Anuló el hallazgo ${numero}: ${motivo.trim()}`, ahora);
}

export function motivoNoPuedeFallar(entrada: Entrada): string | null {
  if (hallazgosVigentesRondaActual(entrada).length === 0) return "Para marcarla fallida registra al menos un hallazgo en esta ronda.";
  return null;
}

export function motivoNoPuedeProbar(entrada: Entrada): string | null {
  const { hechos, total, completo } = avanceChecklist(entrada);
  if (!completo) return `Completa el checklist para marcarla probada (${hechos} de ${total}).`;
  return null;
}

export function marcarFallida(entrada: Entrada, usuarioId: string, ahora: string): Entrada {
  exigirTitular(entrada, usuarioId);
  const motivo = motivoNoPuedeFallar(entrada);
  if (motivo) throw new ErrorRegla(motivo);
  return conEvento(
    { ...entrada, estado: "fallida", tomadaPorId: null, rondas: rondasConActual(entrada, (r) => ({ ...r, resultado: "fallida", cerradaEn: ahora })) },
    usuarioId, `Marcó fallida (ronda ${rondaActual(entrada).numero})`, ahora,
  );
}

export function marcarProbado(entrada: Entrada, usuarioId: string, ahora: string): Entrada {
  exigirTitular(entrada, usuarioId);
  const motivo = motivoNoPuedeProbar(entrada);
  if (motivo) throw new ErrorRegla(motivo);
  return conEvento({
    ...entrada,
    estado: "probado",
    tomadaPorId: null,
    probadaEn: ahora,
    rondas: rondasConActual(entrada, (r) => ({ ...r, resultado: "probada", cerradaEn: ahora })),
  }, usuarioId, `Marcó probado (ronda ${rondaActual(entrada).numero})`, ahora);
}

export function archivar(entrada: Entrada, usuarioId: string, ahora: string): Entrada {
  if (entrada.estado !== "probado") throw new ErrorRegla("Solo se archiva una entrada probada.");
  return conEvento({ ...entrada, estado: "archivada", archivadaEn: ahora }, usuarioId, "Archivó la entrada", ahora);
}

/** QA-06 / H-11: el autor corrige en sin_probar o fallida, nunca en pruebas. */
export function motivoNoPuedeCorregir(entrada: Entrada, usuarioId: string): string | null {
  if (entrada.autorId !== usuarioId) return "Solo el autor puede corregir su entrada.";
  if (entrada.estado === "en_pruebas") return "La entrada está en pruebas. Pídele al asesor que la suelte para corregirla.";
  if (entrada.estado !== "sin_probar" && entrada.estado !== "fallida") return "Esta entrada ya no se puede corregir.";
  return null;
}

export function corregir(
  entrada: Entrada,
  usuario: UsuarioPortal,
  cambios: { queCambio: DocEnriquecido | null; acciones: AccionRequerida[]; nota: DocEnriquecido | null },
  ahora: string,
): Entrada {
  const motivo = motivoNoPuedeCorregir(entrada, usuario.id);
  if (motivo) throw new ErrorRegla(motivo);
  const errores = validarParaPublicar({ ...entrada, queCambio: cambios.queCambio, acciones: cambios.acciones });
  if (errores.queCambio || errores.acciones || errores.accionesTexto) throw new ErrorRegla("Completa «Qué cambió» y las acciones requeridas.");
  const actual = rondaActual(entrada);
  // Desde fallida se abre una ronda nueva; desde sin_probar nadie ha probado y sigue la ronda pendiente.
  const rondas = actual.resultado === "pendiente" ? entrada.rondas : [...entrada.rondas, rondaNueva(entrada)];
  return conEvento({
    ...entrada,
    estado: "sin_probar",
    queCambio: cambios.queCambio,
    acciones: cambios.acciones,
    editadaPorId: usuario.id,
    editadaEn: ahora,
    editoresIds: Array.from(new Set([...entrada.editoresIds, usuario.id])),
    correcciones: [...entrada.correcciones, { fecha: ahora, autorId: usuario.id, ronda: rondas[rondas.length - 1].numero, texto: cambios.nota }],
    rondas,
  }, usuario.id, "Corrigió y volvió a publicar", ahora);
}

/* ---------- Texto para clientes ---------- */

/** H-05: SP crítico nunca se muestra al cliente. */
export function motivoNoPuedeMostrarClientes(entrada: Entrada): string | null {
  if (entrada.tipo === "sp_critico") return "Las entradas SP crítico son cambios internos y nunca se muestran a los clientes.";
  return null;
}

/** QA-09: lo edita quien tiene la ronda activa; después de probado, un asesor que no sea autor ni editor. */
export function puedeEditarTextoClientes(entrada: Entrada, usuario: UsuarioPortal | undefined): boolean {
  if (!usuario || !esProbador(usuario)) return false;
  if (entrada.estado === "en_pruebas") return entrada.tomadaPorId === usuario.id;
  if (entrada.estado === "probado") return entrada.autorId !== usuario.id && !entrada.editoresIds.includes(usuario.id);
  return false;
}

/**
 * Qué ve la página pública: probado, mostrar activo, con título y texto, nunca SP crítico.
 * Decisión del propietario: mostrar a clientes = mostrar a TODOS los clientes, también las de tipo Nuevo.
 */
export function visibleParaClientes(entrada: Entrada): boolean {
  return entrada.estado === "probado"
    && entrada.mostrarClientes
    && entrada.tipo !== "sp_critico"
    && entrada.tituloClientes.trim().length > 0
    && !docVacio(entrada.textoClientes);
}

export const MAX_ENTRADAS_PUBLICAS = 100;

export function entradasPublicas(entradas: Entrada[], publicacionActiva: boolean): Entrada[] {
  if (!publicacionActiva) return [];
  return entradas
    .filter(visibleParaClientes)
    .sort((a, b) => (b.probadaEn ?? "").localeCompare(a.probadaEn ?? ""))
    .slice(0, MAX_ENTRADAS_PUBLICAS);
}

/** Opciones nuevas = Nuevo; Mejoras = Mejora + Regla de negocio + Rediseño (H-05). */
export function categoriaCliente(tipo: TipoEntrada | null): "nuevo" | "mejora" | null {
  if (tipo === "nuevo") return "nuevo";
  if (tipo === "mejora" || tipo === "regla_negocio" || tipo === "rediseno") return "mejora";
  return null;
}

/* ---------- Fechas ---------- */

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const NOMBRES_MESES = MESES;

/** QA-24: mes y año en la zona America/Bogota (UTC-5, sin horario de verano). */
export function partesBogota(iso: string) {
  const d = new Date(new Date(iso).getTime() - 5 * 60 * 60 * 1000);
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() };
}

export function mesAnio(iso: string | null): string {
  if (!iso) return "";
  const { anio, mes } = partesBogota(iso);
  const nombre = MESES[mes];
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} de ${anio}`;
}

export function fechaHora(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota" }).format(new Date(iso));
}

export function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeZone: "America/Bogota" }).format(new Date(iso));
}

export function haceCuanto(iso: string, ahora = Date.now()): string {
  const minutos = Math.floor((ahora - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return "hace un momento";
  if (minutos === 1) return "hace 1 min";
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  return horas === 1 ? "hace 1 hora" : `hace ${horas} horas`;
}

/* ---------- Filtro de fechas de la página pública ---------- */

export type FiltroFechaPublica = "mes_actual" | "ultimos_3" | "ultimo_anio" | "todo" | "rango";

/** Índice de mes absoluto (año*12+mes) en hora de Bogotá. */
function indiceMes(iso: string) {
  const { anio, mes } = partesBogota(iso);
  return anio * 12 + mes;
}

/**
 * La fecha de liberación es el mes en que la entrada quedó probada (H-08).
 * Mes actual: este mes. Últimos 3 meses: este mes y los dos anteriores. Último año: este mes y los 11 anteriores.
 * Rango: entre las fechas «desde» y «hasta» (AAAA-MM-DD, inclusivas, hora de Bogotá).
 */
export function cumpleFiltroFecha(
  probadaEn: string | null,
  filtro: FiltroFechaPublica,
  ahora: string,
  rango: { desde?: string; hasta?: string } = {},
): boolean {
  if (filtro === "todo") return true;
  if (!probadaEn) return false;
  if (filtro === "rango") {
    const dia = new Date(new Date(probadaEn).getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return (!rango.desde || dia >= rango.desde) && (!rango.hasta || dia <= rango.hasta);
  }
  const diferencia = indiceMes(ahora) - indiceMes(probadaEn);
  const meses = filtro === "mes_actual" ? 1 : filtro === "ultimos_3" ? 3 : 12;
  return diferencia >= 0 && diferencia < meses;
}
