import type { JSONContent } from "@tiptap/core";

/* Modelo del prototipo «Qué hay de nuevo». Refleja el diseño funcional (docs/que-hay-de-nuevo/01). */

/** Valor del editor enriquecido: siempre el JSON de TipTap, nunca HTML. */
export type DocEnriquecido = JSONContent;

export type TipoEntrada = "nuevo" | "mejora" | "regla_negocio" | "sp_critico" | "rediseno";
export type Sistema = "sag_web" | "sag_clasico";
export type EstadoEntrada = "borrador" | "sin_probar" | "en_pruebas" | "fallida" | "probado" | "archivada";
export type Area = "Soporte" | "Desarrollo" | "Ventas" | "Administrativa";
export type Vision = "desarrollador" | "asesor";

export type UsuarioPortal = {
  id: string;
  nombre: string;
  correo: string;
  areas: Area[];
  activo: boolean;
  /** Tiene acceso a la opción «Qué hay de nuevo» (QA-27: aviso al enviar reportes). */
  accesoQhdn: boolean;
};

/** Decisión del propietario (3.ª ronda): las rutas siempre se escriben a mano; no hay menú de referencia. */
export type NivelRuta = { valor: string };

export type Ruta = { id: string; niveles: NivelRuta[] };

export type AccionPredefinida = { id: string; nombre: string; orden: number; activa: boolean };

export type AccionRequerida = { accionId: string; nombre: string; texto: DocEnriquecido | null };

export type Adjunto = {
  id: string;
  clase: "archivo" | "enlace";
  nombre: string;
  url: string;
  tamano?: number;
  tipoMime?: string;
};

export type Hallazgo = {
  numero: number;
  ronda: number;
  fecha: string;
  autorId: string;
  texto: DocEnriquecido;
  /** Un hallazgo nunca se borra: se anula con motivo y queda tachado (QA-26). */
  anulacion: { fecha: string; autorId: string; motivo: string } | null;
};

export type NotaPrueba = { id: string; fecha: string; autorId: string; texto: DocEnriquecido };

export type ResultadoRonda = "pendiente" | "en_curso" | "soltada" | "fallida" | "probada";

export type Ronda = {
  numero: number;
  asesorId: string | null;
  tomadaEn: string | null;
  cerradaEn: string | null;
  resultado: ResultadoRonda;
  checklist: Record<string, boolean>;
  notas: NotaPrueba[];
};

export type NotaCorreccion = { fecha: string; autorId: string; ronda: number; texto: DocEnriquecido | null };

export type Entrada = {
  id: string;
  /** Identificador aleatorio para la página pública (QA-23). */
  idPublico: string;
  tipo: TipoEntrada | null;
  sistema: Sistema | null;
  rutas: Ruta[];
  queCambio: DocEnriquecido | null;
  acciones: AccionRequerida[];
  cliente: string;
  asesorInicialId: string;
  reglasNegocio: Adjunto[];
  videos: Adjunto[];
  estado: EstadoEntrada;
  /** Autor = Desarrollador de la entrada (decisión del propietario). Nunca sale en la página pública. */
  autorId: string;
  creadaEn: string;
  editadaPorId: string;
  editadaEn: string;
  /** Quienes crearon, editaron o corrigieron la entrada: ninguno puede probarla (H-01, QA-04). */
  editoresIds: string[];
  publicadaPorId: string | null;
  publicadaEn: string | null;
  tomadaPorId: string | null;
  rondas: Ronda[];
  hallazgos: Hallazgo[];
  correcciones: NotaCorreccion[];
  /** Fecha de liberación que ve el cliente (H-08): cuándo se marcó probado. */
  probadaEn: string | null;
  archivadaEn: string | null;
  mostrarClientes: boolean;
  tituloClientes: string;
  textoClientes: DocEnriquecido | null;
  /** Bitácora de la entrada: cada acción con quién y cuándo. Solo se agrega, nunca se borra. */
  historial: EventoHistorial[];
};

export type EventoHistorial = { fecha: string; usuarioId: string; accion: string };

/** Filtro de resultado de la pestaña Probadas y del reporte. */
export type FiltroResultado = "ambas" | "aprobadas" | "fallidas";

export type ReporteEnviado = {
  id: string;
  fecha: string;
  autorId: string;
  filtro: FiltroResultado;
  entradaIds: string[];
  destinatarioIds: string[];
};

/** Lo que el formulario del desarrollador puede escribir. */
export type DatosFormulario = Pick<
  Entrada,
  "tipo" | "sistema" | "rutas" | "queCambio" | "acciones" | "cliente" | "asesorInicialId" | "reglasNegocio" | "videos"
>;

export type ConfiguracionQhdn = {
  accionesPredefinidas: AccionPredefinida[];
  publicacionActiva: boolean;
};

export type EstadoAlmacen = {
  entradas: Entrada[];
  usuarios: UsuarioPortal[];
  configuracion: ConfiguracionQhdn;
  usuarioActualId: string;
  vision: Vision;
  reportes: ReporteEnviado[];
};
