import { conflict } from "./http";

/** Guards legacy HTTP mutations only; dependent reads and internal reconciliation remain available. */
export const catalogOwnsOperationalMasters = (): boolean => process.env.PORTAL_CATALOG_READ_ENABLED?.trim() === "true";

export const catalogMasterReadOnly = (master: "dominios" | "bases de datos" | "licenciamiento") =>
  conflict(`El catálogo de ${master} es de solo lectura.`);
