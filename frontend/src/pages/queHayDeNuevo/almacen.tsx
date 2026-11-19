import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { estadoInicial } from "./datosSimulados";
import * as L from "./logica";
import type {
  AccionPredefinida,
  AccionRequerida,
  DatosFormulario,
  DocEnriquecido,
  Entrada,
  EstadoAlmacen,
  FiltroResultado,
  UsuarioPortal,
  Vision,
} from "./tipos";

/*
 * Almacén en memoria compartido por las tres visiones y la configuración.
 * Cada acción devuelve null si se aplicó o el mensaje del error de regla.
 * Cuando exista la API, estas funciones se reemplazan por mutaciones de React Query
 * con el mismo nombre y la misma respuesta de error (ver docs/que-hay-de-nuevo/07).
 */

type Resultado = string | null;

export type AccionesAlmacen = {
  cambiarUsuario: (id: string) => void;
  cambiarVision: (vision: Vision) => void;
  guardarBorrador: (id: string | null, datos: DatosFormulario) => { id: string | null; error: Resultado };
  publicar: (id: string) => Resultado;
  eliminarBorrador: (id: string) => Resultado;
  corregir: (id: string, cambios: { queCambio: DocEnriquecido | null; acciones: AccionRequerida[]; nota: DocEnriquecido | null }) => Resultado;
  tomar: (id: string) => Resultado;
  soltar: (id: string) => Resultado;
  alternarChecklist: (id: string, accionId: string) => Resultado;
  agregarNota: (id: string, texto: DocEnriquecido, esHallazgo: boolean) => Resultado;
  anularHallazgo: (id: string, numero: number, motivo: string) => Resultado;
  marcarFallida: (id: string) => Resultado;
  marcarProbado: (id: string) => Resultado;
  archivar: (id: string) => Resultado;
  actualizarTextoClientes: (id: string, cambios: Partial<Pick<Entrada, "mostrarClientes" | "tituloClientes" | "textoClientes">>) => Resultado;
  /** Simula el envío: guarda el reporte (para su enlace) y devuelve su id. No sale ningún correo. */
  enviarReporte: (filtro: FiltroResultado, entradaIds: string[], destinatarioIds: string[]) => string;
  guardarAccionesPredefinidas: (acciones: AccionPredefinida[]) => Resultado;
  cambiarPublicacionActiva: (activa: boolean) => void;
};

type ContextoAlmacen = {
  estado: EstadoAlmacen;
  usuarioActual: UsuarioPortal | undefined;
  usuarioPorId: (id: string | null | undefined) => UsuarioPortal | undefined;
  /** Último guardado del avance del asesor, para el aviso «Avance guardado automáticamente». */
  ultimoGuardado: string | null;
} & AccionesAlmacen;

const Ctx = createContext<ContextoAlmacen | null>(null);

export function ProveedorQueHayDeNuevo({ children, inicial }: { children: ReactNode; inicial?: EstadoAlmacen }) {
  const [estado, setEstado] = useState<EstadoAlmacen>(() => inicial ?? estadoInicial());
  const [ultimoGuardado, setUltimoGuardado] = useState<string | null>(null);
  const estadoRef = useRef(estado);
  estadoRef.current = estado;

  const ahora = () => new Date().toISOString();
  const usuarioActualDe = (e: EstadoAlmacen) => e.usuarios.find((u) => u.id === e.usuarioActualId);

  /** Aplica una transición pura sobre una entrada y convierte los errores de regla en mensajes. */
  const transicion = useCallback((id: string, fn: (entrada: Entrada, usuario: UsuarioPortal, e: EstadoAlmacen) => Entrada, avance = false): Resultado => {
    const actual = estadoRef.current;
    const entrada = actual.entradas.find((x) => x.id === id);
    const usuario = usuarioActualDe(actual);
    if (!entrada) return "La entrada ya no existe.";
    if (!usuario) return "No hay usuario activo.";
    try {
      const siguiente = fn(entrada, usuario, actual);
      const nuevo = { ...actual, entradas: actual.entradas.map((x) => (x.id === id ? siguiente : x)) };
      estadoRef.current = nuevo;
      setEstado(nuevo);
      if (avance) setUltimoGuardado(ahora());
      return null;
    } catch (error) {
      if (error instanceof L.ErrorRegla) return error.message;
      throw error;
    }
  }, []);

  const acciones = useMemo<AccionesAlmacen>(() => ({
    cambiarUsuario: (id) => setEstado((e) => {
      const usuario = e.usuarios.find((u) => u.id === id);
      const dev = Boolean(usuario?.areas.includes("Desarrollo"));
      const soporte = Boolean(usuario?.areas.includes("Soporte"));
      const vision: Vision = dev && !soporte ? "desarrollador" : soporte && !dev ? "asesor" : e.vision;
      return { ...e, usuarioActualId: id, vision };
    }),
    cambiarVision: (vision) => setEstado((e) => ({ ...e, vision })),

    guardarBorrador: (id, datos) => {
      const actual = estadoRef.current;
      const usuario = usuarioActualDe(actual);
      if (!usuario || !L.esDesarrollador(usuario)) return { id, error: "Solo las personas con el área Desarrollo crean entradas." };
      const errores = L.validarBorrador(datos);
      if (errores.tamano) return { id, error: errores.tamano };
      const limpio = L.normalizarDatos(datos);
      const momento = ahora();
      let nuevoId = id;
      let entradas: Entrada[];
      if (id) {
        const existente = actual.entradas.find((x) => x.id === id);
        if (!existente || existente.estado !== "borrador") return { id, error: "Solo se edita un borrador." };
        if (existente.autorId !== usuario.id) return { id, error: "Solo el autor edita su entrada." };
        entradas = actual.entradas.map((x) => (x.id === id ? { ...x, ...limpio, editadaPorId: usuario.id, editadaEn: momento } : x));
      } else {
        nuevoId = L.nuevoId("e");
        entradas = [{
          ...limpio,
          id: nuevoId,
          idPublico: L.nuevoId("pub").slice(4),
          estado: "borrador",
          autorId: usuario.id,
          creadaEn: momento,
          editadaPorId: usuario.id,
          editadaEn: momento,
          editoresIds: [usuario.id],
          publicadaPorId: null,
          publicadaEn: null,
          tomadaPorId: null,
          rondas: [],
          hallazgos: [],
          correcciones: [],
          probadaEn: null,
          archivadaEn: null,
          mostrarClientes: false,
          tituloClientes: "",
          textoClientes: null,
          historial: [{ fecha: momento, usuarioId: usuario.id, accion: "Creó el borrador" }],
        }, ...actual.entradas];
      }
      const nuevo = { ...actual, entradas };
      estadoRef.current = nuevo;
      setEstado(nuevo);
      return { id: nuevoId, error: null };
    },

    publicar: (id) => transicion(id, (entrada, usuario, e) => L.publicar(entrada, usuario, e.usuarios, ahora())),

    eliminarBorrador: (id) => {
      const actual = estadoRef.current;
      const entrada = actual.entradas.find((x) => x.id === id);
      if (!entrada || entrada.estado !== "borrador") return "Solo se elimina un borrador.";
      if (entrada.autorId !== actual.usuarioActualId) return "Solo el autor elimina su borrador.";
      const nuevo = { ...actual, entradas: actual.entradas.filter((x) => x.id !== id) };
      estadoRef.current = nuevo;
      setEstado(nuevo);
      return null;
    },

    corregir: (id, cambios) => transicion(id, (entrada, usuario) => L.corregir(entrada, usuario, cambios, ahora())),
    tomar: (id) => transicion(id, (entrada, usuario) => L.tomar(entrada, usuario, ahora()), true),
    soltar: (id) => transicion(id, (entrada, usuario) => L.soltar(entrada, usuario.id, ahora()), true),
    alternarChecklist: (id, accionId) => transicion(id, (entrada, usuario) => L.alternarChecklist(entrada, usuario.id, accionId), true),
    agregarNota: (id, texto, esHallazgo) => transicion(id, (entrada, usuario) => L.agregarNota(entrada, usuario.id, texto, esHallazgo, ahora()), true),
    anularHallazgo: (id, numero, motivo) => transicion(id, (entrada, usuario) => L.anularHallazgo(entrada, usuario.id, numero, motivo, ahora()), true),
    marcarFallida: (id) => transicion(id, (entrada, usuario) => L.marcarFallida(entrada, usuario.id, ahora()), true),
    marcarProbado: (id) => transicion(id, (entrada, usuario) => L.marcarProbado(entrada, usuario.id, ahora()), true),
    archivar: (id) => transicion(id, (entrada, usuario) => L.archivar(entrada, usuario.id, ahora())),

    actualizarTextoClientes: (id, cambios) => transicion(id, (entrada, usuario) => {
      if (!L.puedeEditarTextoClientes(entrada, usuario)) throw new L.ErrorRegla("No puedes editar el texto para clientes de esta entrada.");
      if (cambios.mostrarClientes && L.motivoNoPuedeMostrarClientes(entrada)) throw new L.ErrorRegla(L.motivoNoPuedeMostrarClientes(entrada)!);
      let siguiente = { ...entrada, ...cambios };
      if (cambios.mostrarClientes !== undefined && cambios.mostrarClientes !== entrada.mostrarClientes) {
        siguiente = L.conEvento(siguiente, usuario.id, cambios.mostrarClientes ? "Activó «Mostrar a los clientes»" : "Desactivó «Mostrar a los clientes»", ahora());
      }
      // H-04 y QA-13: al activar por primera vez se parte de una copia de «Qué cambió» sin menciones.
      if (cambios.mostrarClientes && !entrada.textoClientes) siguiente.textoClientes = L.quitarMenciones(entrada.queCambio);
      return siguiente;
    }, true),

    enviarReporte: (filtro, entradaIds, destinatarioIds) => {
      const id = L.nuevoId("reporte");
      setEstado((e) => ({
        ...e,
        reportes: [{ id, fecha: ahora(), autorId: e.usuarioActualId, filtro, entradaIds, destinatarioIds }, ...e.reportes],
      }));
      return id;
    },

    guardarAccionesPredefinidas: (lista) => {
      if (!lista.some((a) => a.activa)) return "Debe quedar al menos una acción activa.";
      if (lista.some((a) => !a.nombre.trim())) return "Cada acción necesita un nombre.";
      const nombres = lista.map((a) => a.nombre.trim().toLowerCase());
      if (new Set(nombres).size !== nombres.length) return "Hay dos acciones con el mismo nombre.";
      setEstado((e) => ({ ...e, configuracion: { ...e.configuracion, accionesPredefinidas: lista.map((a, i) => ({ ...a, nombre: a.nombre.trim(), orden: i + 1 })) } }));
      return null;
    },
    cambiarPublicacionActiva: (activa) => setEstado((e) => ({ ...e, configuracion: { ...e.configuracion, publicacionActiva: activa } })),
  }), [transicion]);

  const valor = useMemo<ContextoAlmacen>(() => ({
    estado,
    usuarioActual: usuarioActualDe(estado),
    usuarioPorId: (id) => (id ? estado.usuarios.find((u) => u.id === id) : undefined),
    ultimoGuardado,
    ...acciones,
  }), [estado, acciones, ultimoGuardado]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useQueHayDeNuevo() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ProveedorQueHayDeNuevo no inicializado.");
  return ctx;
}
