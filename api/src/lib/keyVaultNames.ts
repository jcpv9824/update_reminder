// Sanitiza un valor para usarlo como nombre de secreto en Azure Key Vault.
// Reglas: solo letras, números y guiones. Sin guiones repetidos ni a los extremos.
// Longitud máxima 127 caracteres.
export function toKeyVaultSecretName(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 127);
}
