// Parsea cadenas de acceso a base de datos del formato:
// "data12.sagerp.co,54101; Initial Catalog = X; User ID = Y; Password = Z;"

export type ParsedDbAccess = {
  serverHostPort: string;
  initialCatalog: string;
  userId: string;
  password: string;
};

export function parseDbAccessString(input: string): ParsedDbAccess {
  if (!input || !input.trim()) {
    throw new Error("La cadena de acceso a la base de datos es obligatoria.");
  }

  const segments = input
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 4) {
    throw new Error(
      "La cadena debe incluir servidor, Initial Catalog, User ID y Password."
    );
  }

  const serverHostPort = segments[0].trim();
  const values: Record<string, string> = {};

  for (const segment of segments.slice(1)) {
    const equalsIndex = segment.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = segment.slice(0, equalsIndex).trim().toLowerCase();
    const value = segment.slice(equalsIndex + 1).trim();
    values[key] = value;
  }

  const initialCatalog = values["initial catalog"];
  const userId = values["user id"];
  const password = values["password"];

  if (!serverHostPort) throw new Error("El servidor y puerto son obligatorios.");
  if (!initialCatalog) throw new Error("El Initial Catalog es obligatorio.");
  if (!userId) throw new Error("El User ID es obligatorio.");
  if (!password) throw new Error("La contraseña es obligatoria.");

  return { serverHostPort, initialCatalog, userId, password };
}
