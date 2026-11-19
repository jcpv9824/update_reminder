export const GUIDE_BUILDER_UI_ENABLED =
  import.meta.env.MODE === "test"
  || import.meta.env.VITE_GUIDE_BUILDER_ENABLED === "true";

/*
 * Banderas de funcionalidad del frontend.
 * Se leen de variables de Vite al compilar; en producción no se definen y quedan apagadas.
 */

/**
 * Prototipo de «Qué hay de nuevo» con datos simulados en memoria.
 * Se enciende solo con `VITE_WHATS_NEW_PROTOTYPE=true` (por ejemplo, en desarrollo).
 * Apagado: no existen sus rutas ni sus opciones de menú.
 */
export const WHATS_NEW_PROTOTYPE_ENABLED = import.meta.env.DEV && import.meta.env.VITE_WHATS_NEW_PROTOTYPE === "true";
/** Live API integration is a separate release switch, off by default. */
export const WHATS_NEW_ENABLED = import.meta.env.VITE_WHATS_NEW_ENABLED === "true";
