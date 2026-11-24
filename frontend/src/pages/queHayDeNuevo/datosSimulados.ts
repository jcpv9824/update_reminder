import type { AccionPredefinida, DocEnriquecido, EstadoAlmacen, Entrada, EventoHistorial, UsuarioPortal } from "./tipos";
import { docDeTexto } from "./logica";

/* Datos simulados del prototipo. Ningún dato sale del navegador. */

export const USUARIOS_SIMULADOS: UsuarioPortal[] = [
  { id: "u-laura", nombre: "Laura Méndez", correo: "laura.mendez@empresa.com", areas: ["Desarrollo", "Soporte"], activo: true, accesoQhdn: true },
  { id: "u-andres", nombre: "Andrés Gómez", correo: "andres.gomez@empresa.com", areas: ["Desarrollo"], activo: true, accesoQhdn: true },
  { id: "u-camilo", nombre: "Camilo Rojas", correo: "camilo.rojas@empresa.com", areas: ["Desarrollo"], activo: true, accesoQhdn: true },
  { id: "u-felipe", nombre: "Felipe Cardona", correo: "felipe.cardona@empresa.com", areas: ["Soporte"], activo: true, accesoQhdn: true },
  { id: "u-diana", nombre: "Diana Torres", correo: "diana.torres@empresa.com", areas: ["Soporte"], activo: true, accesoQhdn: true },
  { id: "u-sofia", nombre: "Sofía Herrera", correo: "sofia.herrera@empresa.com", areas: ["Soporte"], activo: false, accesoQhdn: true },
  { id: "u-martha", nombre: "Martha Ruiz", correo: "martha.ruiz@empresa.com", areas: ["Administrativa"], activo: true, accesoQhdn: false },
  { id: "u-julian", nombre: "Julián Pérez", correo: "julian.perez@empresa.com", areas: ["Ventas"], activo: true, accesoQhdn: false },
];

export const ACCIONES_INICIALES: AccionPredefinida[] = [
  { id: "leer_reglas", nombre: "Leer las reglas de negocio", orden: 1, activa: true },
  { id: "dar_permiso", nombre: "Dar permiso a la opción", orden: 2, activa: true },
  { id: "probar_opciones", nombre: "Probar estas opciones o módulos", orden: 3, activa: true },
  { id: "otro", nombre: "Otro", orden: 4, activa: true },
];

/** Imagen de ejemplo (SVG en línea) para mostrar imágenes en el texto para clientes. */
const IMAGEN_EJEMPLO =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" viewBox="0 0 480 160"><rect width="480" height="160" rx="8" fill="#f4f5f7" stroke="#d1d3d2"/><rect x="16" y="16" width="448" height="28" rx="4" fill="#1C3664"/><text x="28" y="35" font-family="Segoe UI, sans-serif" font-size="13" fill="#fff">Traslados entre bodegas</text><rect x="16" y="60" width="200" height="24" rx="4" fill="#fff" stroke="#d1d3d2"/><rect x="232" y="60" width="200" height="24" rx="4" fill="#fff" stroke="#d1d3d2"/><rect x="16" y="104" width="120" height="30" rx="6" fill="#047857"/><text x="36" y="124" font-family="Segoe UI, sans-serif" font-size="13" fill="#fff">Confirmar</text></svg>`,
  );

function texto(...parrafos: string[]): DocEnriquecido {
  return docDeTexto(...parrafos);
}

function conMencion(antes: string, usuario: UsuarioPortal, despues: string): DocEnriquecido {
  return {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: antes },
        { type: "mencion", attrs: { id: usuario.id, etiqueta: usuario.nombre } },
        { type: "text", text: despues },
      ],
    }],
  };
}

function ruta(id: string, ...valores: string[]) {
  return { id, niveles: valores.map((valor) => ({ valor })) };
}

const base = {
  cliente: "",
  asesorInicialId: "",
  reglasNegocio: [],
  videos: [],
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
} satisfies Partial<Entrada>;

const [laura, andres, camilo, felipe, diana] = USUARIOS_SIMULADOS;

function accion(id: string, detalle: string) {
  const nombre = ACCIONES_INICIALES.find((a) => a.id === id)!.nombre;
  return { accionId: id, nombre, texto: texto(detalle) };
}

type Semilla = Omit<Entrada, "historial">;

/** Bitácora de ejemplo derivada de los datos de la semilla. */
function historialSemilla(e: Semilla): EventoHistorial[] {
  const eventos: EventoHistorial[] = [{ fecha: e.creadaEn, usuarioId: e.autorId, accion: "Creó el borrador" }];
  if (e.publicadaEn && e.publicadaPorId) eventos.push({ fecha: e.publicadaEn, usuarioId: e.publicadaPorId, accion: "Publicó a Soporte" });
  e.rondas.forEach((r) => {
    if (r.asesorId && r.tomadaEn) eventos.push({ fecha: r.tomadaEn, usuarioId: r.asesorId, accion: `Tomó para probar (ronda ${r.numero})` });
    if (r.asesorId && r.cerradaEn) {
      const accion = r.resultado === "soltada" ? `Soltó la prueba (ronda ${r.numero}); la prueba empieza de nuevo`
        : r.resultado === "fallida" ? `Marcó fallida (ronda ${r.numero})` : `Marcó probado (ronda ${r.numero})`;
      eventos.push({ fecha: r.cerradaEn, usuarioId: r.asesorId, accion });
    }
  });
  e.hallazgos.forEach((h) => eventos.push({ fecha: h.fecha, usuarioId: h.autorId, accion: `Registró el hallazgo ${h.numero}` }));
  return eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export function entradasIniciales(): Entrada[] {
  const semillas: Semilla[] = [
    {
      ...base,
      id: "e-101",
      idPublico: "8f0c2b7e-1d4a-4c55-9b0e-3a71c2d9e101",
      tipo: "nuevo",
      sistema: "sag_web",
      rutas: [ruta("r-101", "Barra lateral", "Inventarios", "Movimientos", "")],
      queCambio: texto("Nueva opción para programar conteos cíclicos por bodega."),
      acciones: [{ accionId: "probar_opciones", nombre: "Probar estas opciones o módulos", texto: null }],
      estado: "borrador",
      autorId: laura.id,
      creadaEn: "2026-11-17T15:10:00.000Z",
      editadaPorId: laura.id,
      editadaEn: "2026-11-17T15:40:00.000Z",
      editoresIds: [laura.id],
    },
    {
      ...base,
      id: "e-102",
      idPublico: "1b9e7c44-6a2f-4f0d-8e3b-5c6d7e8f9102",
      tipo: "mejora",
      sistema: "sag_web",
      rutas: [ruta("r-102", "Barra lateral", "Ventas", "Facturas", "Factura de venta")],
      queCambio: texto("La factura de venta ahora permite elegir la lista de precios por línea.", "El parámetro «Lista de precios por línea» está en el maestro de Parámetros de ventas."),
      acciones: [
        accion("dar_permiso", "Dar permiso a «Cambiar lista de precios por línea» en el rol Vendedor."),
        accion("probar_opciones", "Facturar con dos listas de precios distintas en la misma factura."),
      ],
      estado: "sin_probar",
      autorId: andres.id,
      creadaEn: "2026-11-14T13:00:00.000Z",
      editadaPorId: andres.id,
      editadaEn: "2026-11-14T14:00:00.000Z",
      editoresIds: [andres.id],
      publicadaPorId: andres.id,
      publicadaEn: "2026-11-14T14:00:00.000Z",
      rondas: [{ numero: 1, asesorId: null, tomadaEn: null, cerradaEn: null, resultado: "pendiente", checklist: {}, notas: [] }],
    },
    {
      ...base,
      id: "e-103",
      idPublico: "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6103",
      tipo: "regla_negocio",
      sistema: "sag_web",
      rutas: [ruta("r-103", "Barra lateral", "Contabilidad", "Cierres", "Cierre mensual")],
      queCambio: texto("El cierre mensual ya no deja cerrar si hay comprobantes en borrador del mes."),
      acciones: [
        accion("leer_reglas", "Leer la sección «Validaciones previas al cierre»."),
        accion("probar_opciones", "Intentar cerrar con un comprobante en borrador y verificar el mensaje."),
      ],
      estado: "sin_probar",
      autorId: laura.id,
      creadaEn: "2026-11-15T16:00:00.000Z",
      editadaPorId: laura.id,
      editadaEn: "2026-11-15T16:30:00.000Z",
      editoresIds: [laura.id],
      publicadaPorId: laura.id,
      publicadaEn: "2026-11-15T16:30:00.000Z",
      rondas: [{ numero: 1, asesorId: null, tomadaEn: null, cerradaEn: null, resultado: "pendiente", checklist: {}, notas: [] }],
    },
    {
      ...base,
      id: "e-104",
      idPublico: "d4e5f6a7-8b9c-4d0e-1f2a-3b4c5d6e7104",
      tipo: "nuevo",
      sistema: "sag_web",
      rutas: [
        ruta("r-104", "Barra lateral", "Compras", "Órdenes de compra", "Aprobación de órdenes"),
        ruta("r-104b", "Barra de navegación", "Mi cuenta", "Perfil", "Preferencias"),
      ],
      queCambio: conMencion("Aprobación de órdenes de compra por niveles de monto. Revisado con ", camilo, "."),
      acciones: [
        accion("leer_reglas", "Leer el documento de niveles de aprobación."),
        accion("dar_permiso", "Dar permiso a «Aprobación de órdenes» al rol Jefe de compras."),
        accion("probar_opciones", "Aprobar una orden en cada nivel de monto."),
      ],
      cliente: "Distribuidora Andina S.A.S.",
      asesorInicialId: felipe.id,
      reglasNegocio: [{ id: "a-1", clase: "enlace", nombre: "Niveles de aprobación", url: "https://intranet.empresa.com/reglas/aprobacion-ordenes" }],
      videos: [{ id: "a-2", clase: "enlace", nombre: "Video de la entrega", url: "https://videos.empresa.com/entregas/aprobacion-ordenes" }],
      estado: "en_pruebas",
      autorId: andres.id,
      creadaEn: "2026-11-10T13:00:00.000Z",
      editadaPorId: andres.id,
      editadaEn: "2026-11-10T15:00:00.000Z",
      editoresIds: [andres.id],
      publicadaPorId: andres.id,
      publicadaEn: "2026-11-10T15:00:00.000Z",
      tomadaPorId: felipe.id,
      rondas: [{
        numero: 1,
        asesorId: felipe.id,
        tomadaEn: "2026-11-12T14:00:00.000Z",
        cerradaEn: null,
        resultado: "en_curso",
        checklist: { leer_reglas: true, dar_permiso: true },
        notas: [{ id: "n-1", fecha: "2026-11-12T15:00:00.000Z", autorId: felipe.id, texto: texto("Permiso asignado al rol Jefe de compras en la base de pruebas.") }],
      }],
    },
    {
      ...base,
      id: "e-105",
      idPublico: "e5f6a7b8-9c0d-4e1f-2a3b-4c5d6e7f8105",
      tipo: "sp_critico",
      sistema: "sag_web",
      rutas: [ruta("r-105", "Barra lateral", "Nómina", "Liquidación", "Liquidación de nómina")],
      queCambio: texto("Se optimizó el SP de liquidación de nómina para empresas con más de 2.000 empleados."),
      acciones: [
        accion("probar_opciones", "Liquidar una quincena y comparar totales con la versión anterior."),
        accion("otro", "Medir el tiempo de liquidación antes y después."),
      ],
      estado: "en_pruebas",
      autorId: camilo.id,
      creadaEn: "2026-11-11T13:00:00.000Z",
      editadaPorId: camilo.id,
      editadaEn: "2026-11-11T13:30:00.000Z",
      editoresIds: [camilo.id],
      publicadaPorId: camilo.id,
      publicadaEn: "2026-11-11T13:30:00.000Z",
      tomadaPorId: laura.id,
      rondas: [{ numero: 1, asesorId: laura.id, tomadaEn: "2026-11-16T14:00:00.000Z", cerradaEn: null, resultado: "en_curso", checklist: { probar_opciones: true }, notas: [] }],
    },
    {
      ...base,
      id: "e-106",
      idPublico: "f6a7b8c9-0d1e-4f2a-3b4c-5d6e7f8a9106",
      tipo: "rediseno",
      sistema: "sag_web",
      rutas: [ruta("r-106", "Barra lateral", "Inventarios", "Consultas", "Kardex")],
      queCambio: texto("Se rediseñó la consulta de Kardex: filtros arriba, exportación a Excel y totales por bodega."),
      acciones: [accion("probar_opciones", "Consultar el Kardex de un producto con movimientos en tres bodegas y exportarlo.")],
      estado: "fallida",
      autorId: laura.id,
      creadaEn: "2026-11-03T13:00:00.000Z",
      editadaPorId: laura.id,
      editadaEn: "2026-11-03T14:00:00.000Z",
      editoresIds: [laura.id],
      publicadaPorId: laura.id,
      publicadaEn: "2026-11-03T14:00:00.000Z",
      rondas: [{ numero: 1, asesorId: diana.id, tomadaEn: "2026-11-05T14:00:00.000Z", cerradaEn: "2026-11-06T16:00:00.000Z", resultado: "fallida", checklist: {}, notas: [] }],
      hallazgos: [
        { numero: 1, ronda: 1, fecha: "2026-11-05T19:00:00.000Z", autorId: diana.id, texto: texto("La exportación a Excel no incluye la columna de costo unitario."), anulacion: null },
        { numero: 2, ronda: 1, fecha: "2026-11-06T15:30:00.000Z", autorId: diana.id, texto: texto("Los totales por bodega no cuadran cuando hay traslados del mismo día."), anulacion: null },
      ],
    },
    {
      ...base,
      id: "e-107",
      idPublico: "a7b8c9d0-1e2f-4a3b-4c5d-6e7f8a9b0107",
      tipo: "mejora",
      sistema: "sag_web",
      rutas: [ruta("r-107", "Barra lateral", "Inventarios", "Movimientos", "Traslados entre bodegas")],
      queCambio: texto("Los traslados entre bodegas ahora se confirman en un solo paso y validan existencias en línea."),
      acciones: [accion("probar_opciones", "Hacer un traslado con y sin existencias suficientes.")],
      estado: "probado",
      autorId: andres.id,
      creadaEn: "2026-10-20T13:00:00.000Z",
      editadaPorId: andres.id,
      editadaEn: "2026-10-20T14:00:00.000Z",
      editoresIds: [andres.id],
      publicadaPorId: andres.id,
      publicadaEn: "2026-10-20T14:00:00.000Z",
      probadaEn: "2026-10-28T20:00:00.000Z",
      rondas: [
        { numero: 1, asesorId: felipe.id, tomadaEn: "2026-10-21T14:00:00.000Z", cerradaEn: "2026-10-21T18:00:00.000Z", resultado: "soltada", checklist: {}, notas: [] },
        { numero: 2, asesorId: diana.id, tomadaEn: "2026-10-27T14:00:00.000Z", cerradaEn: "2026-10-28T20:00:00.000Z", resultado: "probada", checklist: { probar_opciones: true }, notas: [] },
      ],
      hallazgos: [{ numero: 1, ronda: 2, fecha: "2026-10-28T16:00:00.000Z", autorId: diana.id, texto: texto("El mensaje de existencias insuficientes tiene una tilde faltante. Menor."), anulacion: null }],
      mostrarClientes: true,
      tituloClientes: "Traslados entre bodegas en un solo paso",
      textoClientes: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Ahora confirmas el traslado en un solo paso y el sistema te avisa si no hay existencias suficientes antes de guardar." }] },
          { type: "image", attrs: { src: IMAGEN_EJEMPLO, alt: "Pantalla de traslados entre bodegas" } },
        ],
      },
    },
    {
      ...base,
      id: "e-108",
      idPublico: "b8c9d0e1-2f3a-4b4c-5d6e-7f8a9b0c1108",
      tipo: "nuevo",
      sistema: "sag_web",
      rutas: [ruta("r-108", "Barra lateral", "Ventas", "Cotizaciones", "Cotización rápida")],
      queCambio: texto("Nueva opción «Cotización rápida»: cotiza desde el catálogo sin crear el cliente primero."),
      acciones: [
        accion("dar_permiso", "Dar permiso a «Cotización rápida» al rol Vendedor."),
        accion("probar_opciones", "Crear una cotización rápida y convertirla en pedido."),
      ],
      cliente: "Comercializadora del Valle",
      asesorInicialId: diana.id,
      estado: "probado",
      autorId: camilo.id,
      creadaEn: "2026-10-01T13:00:00.000Z",
      editadaPorId: camilo.id,
      editadaEn: "2026-10-01T14:00:00.000Z",
      editoresIds: [camilo.id],
      publicadaPorId: camilo.id,
      publicadaEn: "2026-10-01T14:00:00.000Z",
      probadaEn: "2026-11-04T21:00:00.000Z",
      rondas: [{ numero: 1, asesorId: diana.id, tomadaEn: "2026-11-03T14:00:00.000Z", cerradaEn: "2026-11-04T21:00:00.000Z", resultado: "probada", checklist: { dar_permiso: true, probar_opciones: true }, notas: [] }],
      mostrarClientes: true,
      tituloClientes: "Cotiza en segundos con Cotización rápida",
      textoClientes: texto("Crea una cotización desde el catálogo sin registrar antes al cliente. Cuando el cliente acepte, conviértela en pedido con un clic."),
    },
    {
      ...base,
      id: "e-109",
      idPublico: "c9d0e1f2-3a4b-4c5d-6e7f-8a9b0c1d2109",
      tipo: "regla_negocio",
      sistema: "sag_clasico",
      rutas: [ruta("r-109", "Barra de navegación", "Cartera", "Intereses de mora")],
      queCambio: texto("Los intereses de mora se calculan desde el día siguiente al vencimiento, no desde la fecha de la factura."),
      acciones: [accion("leer_reglas", "Leer el cambio en el cálculo de intereses de mora.")],
      estado: "probado",
      autorId: andres.id,
      creadaEn: "2026-09-10T13:00:00.000Z",
      editadaPorId: andres.id,
      editadaEn: "2026-09-10T14:00:00.000Z",
      editoresIds: [andres.id],
      publicadaPorId: andres.id,
      publicadaEn: "2026-09-10T14:00:00.000Z",
      probadaEn: "2026-09-18T20:00:00.000Z",
      rondas: [{ numero: 1, asesorId: felipe.id, tomadaEn: "2026-09-15T14:00:00.000Z", cerradaEn: "2026-09-18T20:00:00.000Z", resultado: "probada", checklist: { leer_reglas: true }, notas: [] }],
    },
    {
      ...base,
      id: "e-110",
      idPublico: "d0e1f2a3-4b5c-4d6e-7f8a-9b0c1d2e3110",
      tipo: "sp_critico",
      sistema: "sag_web",
      rutas: [ruta("r-110", "Barra lateral", "Contabilidad", "Cierres", "Cierre anual")],
      queCambio: texto("Se corrigió el bloqueo del SP de cierre anual con más de un millón de movimientos."),
      acciones: [accion("probar_opciones", "Ejecutar el cierre anual en la base de pruebas grande.")],
      estado: "probado",
      autorId: camilo.id,
      creadaEn: "2026-09-01T13:00:00.000Z",
      editadaPorId: camilo.id,
      editadaEn: "2026-09-01T14:00:00.000Z",
      editoresIds: [camilo.id],
      publicadaPorId: camilo.id,
      publicadaEn: "2026-09-01T14:00:00.000Z",
      probadaEn: "2026-09-05T20:00:00.000Z",
      rondas: [{ numero: 1, asesorId: laura.id, tomadaEn: "2026-09-04T14:00:00.000Z", cerradaEn: "2026-09-05T20:00:00.000Z", resultado: "probada", checklist: { probar_opciones: true }, notas: [] }],
    },
  ];
  return semillas.map((e) => ({ ...e, historial: historialSemilla(e) }));
}

export function estadoInicial(): EstadoAlmacen {
  return {
    entradas: entradasIniciales(),
    usuarios: USUARIOS_SIMULADOS,
    usuarioActualId: laura.id,
    vision: "desarrollador",
    reportes: [],
    configuracion: {
      accionesPredefinidas: ACCIONES_INICIALES,
      publicacionActiva: true,
    },
  };
}
