import { z } from "zod";

// SQL Server assigns source_id as UNIQUEIDENTIFIER DEFAULT NEWSEQUENTIALID().
// That type guarantees the GUID shape, not RFC UUID version/variant bits.
export const catalogSourceIdSchema = z.guid().length(36)
  .refine(id => id !== "00000000-0000-0000-0000-000000000000")
  .transform(id => id.toLowerCase());
