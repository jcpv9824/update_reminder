import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectChecklistEvidence, validateChecklistEvidenceJson, checklistEvidenceLimits, readChecklistEvidenceLimits } from "../lib/checklistEvidenceValidation";

const png = () => readFileSync(resolve(process.cwd(), "../frontend/public/brand/sag-two-tone-icon.png"));
describe("Evidencias · validación binaria/JSON pura (no almacenamiento)", () => {
  it("RN-40 permite límites opcionales menores, rechaza configuración inválida y no supera techos", () => {
    expect(readChecklistEvidenceLimits({ CHECKLIST_EVIDENCE_IMAGE_MAX_BYTES: "5000000" }).image).toBe(5_000_000);
    for (const value of ["0", "-1", "1e7", "Infinity", "10000001", "text"]) expect(() => readChecklistEvidenceLimits({ CHECKLIST_EVIDENCE_IMAGE_MAX_BYTES: value })).toThrow();
    expect(readChecklistEvidenceLimits({})).toEqual(checklistEvidenceLimits);
  });
  it("RN-40 aplica límites independientes de texto y enlace sin ampliar las columnas SQL", () => {
    const url = "https://example.invalid";
    expect(validateChecklistEvidenceJson({ kind: "link", url }, { CHECKLIST_EVIDENCE_LINK_MAX_CHARS: String(url.length) })).toEqual({ kind: "link", url });
    expect(() => validateChecklistEvidenceJson({ kind: "link", url }, { CHECKLIST_EVIDENCE_LINK_MAX_CHARS: "10" })).toThrow("10 caracteres");
    expect(() => validateChecklistEvidenceJson({ kind: "text", text: "1234" }, { CHECKLIST_EVIDENCE_TEXT_MAX_CHARS: "3" })).toThrow("3 caracteres");
    expect(() => validateChecklistEvidenceJson({ kind: "text", text: "1" }, { CHECKLIST_EVIDENCE_TEXT_MAX_CHARS: "2001" })).toThrow("no es válida");
  });
  it("CA-16/19 acepta un PNG real del repositorio y deduce MIME sin confiar en el navegador", () => {
    const result = inspectChecklistEvidence("image", "captura.png", png(), "text/html");
    expect(result).toMatchObject({ kind: "image", fileName: "captura.png", contentType: "image/png", sizeBytes: png().length });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("CA-19 rechaza HTML/SVG/archivo disfrazado y PNG truncado aunque declare image/png", () => {
    for (const bytes of [Buffer.from("<html>activo</html>"), Buffer.from("<svg></svg>"), png().subarray(0, 16)]) {
      expect(() => inspectChecklistEvidence("image", "captura.png", bytes, "image/png")).toThrow();
    }
    expect(() => inspectChecklistEvidence("image", "captura.svg", Buffer.from("<svg/>"))).toThrow();
  });
  it("CA-18 aplica 25 MB a archivos, 10 MB a imágenes y 100 MB a video sin bajar el límite", () => {
    expect(checklistEvidenceLimits).toEqual({ image: 10_000_000, video: 100_000_000, file: 25_000_000 });
    expect(() => inspectChecklistEvidence("file", "grande.bin", Buffer.alloc(30_000_000))).toThrow("25 MB");
    expect(() => inspectChecklistEvidence("image", "grande.png", Buffer.alloc(10_000_001))).toThrow("10 MB");
    expect(() => inspectChecklistEvidence("video", "grande.mp4", Buffer.alloc(100_000_001))).toThrow("100 MB");
  });
  it("CA-17 admite cualquier archivo, pero lo clasifica como descarga binaria nunca HTML inline", () => {
    const result = inspectChecklistEvidence("file", "../../archivo\r\n.html", Buffer.from("<script>alert(1)</script>"), "text/html");
    expect(result.contentType).toBe("application/octet-stream"); expect(result.extension).toBe(".bin");
    expect(result.fileName).not.toMatch(/[\r\n/\\]/);
  });
  it("CA-17 rechaza video de otro tipo o sin contenedor real", () => {
    expect(() => inspectChecklistEvidence("video", "video.mp4", Buffer.from("not a video"))).toThrow();
    expect(() => inspectChecklistEvidence("video", "video.html", Buffer.from("<html>"))).toThrow();
  });
  it("RN-40 solo acepta enlaces http(s) sin credenciales/control y texto plano acotado", () => {
    expect(validateChecklistEvidenceJson({ kind: "text", text: "  Nota  " })).toEqual({ kind: "text", text: "Nota" });
    expect(validateChecklistEvidenceJson({ kind: "link", url: "https://example.invalid/ruta" })).toEqual({ kind: "link", url: "https://example.invalid/ruta" });
    for (const url of ["javascript:alert(1)", "data:text/html,x", "https://u:p@example.invalid/", "https://example.invalid/\r\nx"]) {
      expect(() => validateChecklistEvidenceJson({ kind: "link", url })).toThrow();
    }
    expect(() => validateChecklistEvidenceJson({ kind: "text", text: "x".repeat(2001) })).toThrow();
    expect(() => validateChecklistEvidenceJson({ kind: "link", url: "https://example.invalid", ownerId: "fake" })).toThrow();
  });
});
