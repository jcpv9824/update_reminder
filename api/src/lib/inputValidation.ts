const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function trimText(value: string | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : value;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function isValidHttpsDomain(value: string): boolean {
  return value.trim().toLowerCase().startsWith("https://");
}
