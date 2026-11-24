import { afterEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "../lib/whatsNewModel";
import type { WhatsNewActor } from "../lib/whatsNewAccess";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), snapshot: vi.fn(), upload: vi.fn(), download: vi.fn(), file: vi.fn(), audit: vi.fn(),
}));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => "pool" }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (fn: (tx: string) => unknown) => fn("tx") }));
vi.mock("../lib/whatsNewSqlRepository", () => ({ query: mocks.query }));
vi.mock("../lib/whatsNewService", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/whatsNewService")>(), reportSnapshot: mocks.snapshot,
}));
vi.mock("../lib/objectStorage", () => ({ readPrivateSeaweedFSBuffer: mocks.download, storePrivateObject: mocks.upload }));
vi.mock("../lib/contentFileSqlWriter", () => ({ ensureSqlContentFile: mocks.file }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mocks.audit }));

import { listSavedReports, readSavedReport, savePrivateReport, withdrawSavedReport } from "../lib/whatsNewSavedReports";

const makeActor = (superAdmin = false, manage = false): WhatsNewActor => ({
  id: "actor", email: "actor@example.test", displayName: "Autor",
  permissions: new Set([PERMISSIONS.view, PERMISSIONS.report, PERMISSIONS.author, ...(manage ? [PERMISSIONS.manage] : [])]),
  areas: new Set(superAdmin || manage ? [] : ["desarrollo"]), superAdmin,
});
const id = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("<html>QA</html>");
const locator = { storageProvider: "s3", storageBucket: "private-fixture", storageObjectKey: "synthetic-key" };
const input = { include: "todas" };
afterEach(() => vi.resetAllMocks());

describe("Novedades: reportes privados sin correo", () => {
  it("omite reportes retirados y restringe las consultas a autor o super_admin real", async () => {
    await expect(listSavedReports(makeActor(false, true), {})).rejects.toMatchObject({ status: 403 });
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    const developer = { ...makeActor(), permissions: new Set([PERMISSIONS.view, PERMISSIONS.author]) };
    await expect(listSavedReports(developer, {})).resolves.toMatchObject({ items: [], total: 0 });
    expect(mocks.query.mock.calls[0][1]).toContain("w.report_key IS NULL AND (@admin=1 OR u.source_id=@actor)");
    expect(mocks.query.mock.calls[0][2]).toMatchObject({ actor: "actor", admin: false });
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await listSavedReports(makeActor(true), {});
    expect(mocks.query.mock.calls[2][2]).toMatchObject({ admin: true });
  });

  it("solo lee contenido autorizado y valida locator, MIME, tamaño y huella antes de leer", async () => {
    mocks.query.mockResolvedValueOnce([]);
    await expect(readSavedReport(makeActor(), id)).rejects.toMatchObject({ status: 404 });
    expect(mocks.download).not.toHaveBeenCalled();
    mocks.query.mockResolvedValueOnce([{ provider: "s3", mime: "text/html", bytes: bytes.length,
      sha: Buffer.alloc(32), bucket: locator.storageBucket, objectKey: locator.storageObjectKey }]).mockResolvedValueOnce([{ visible: 1 }]);
    mocks.download.mockResolvedValueOnce(bytes);
    await expect(readSavedReport(makeActor(), id)).resolves.toEqual(bytes);
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining(locator), bytes.length, "00".repeat(32));
    mocks.query.mockResolvedValueOnce([{ provider: "s3", mime: "text/html", bytes: bytes.length,
      sha: Buffer.alloc(32), bucket: locator.storageBucket, objectKey: locator.storageObjectKey }]).mockResolvedValueOnce([]);
    mocks.download.mockResolvedValueOnce(bytes);
    await expect(readSavedReport(makeActor(), id)).rejects.toMatchObject({ status: 404 });
  });

  it("retira con marca y auditoría atómicas sin borrar el archivo ni tocar el outbox, y tolera repetir", async () => {
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ reportKey: 4 }]).mockResolvedValueOnce([{ report_key: 4 }])
      .mockResolvedValueOnce([{ reportKey: 4 }]).mockResolvedValueOnce([]);
    await expect(withdrawSavedReport(makeActor(), id)).rejects.toMatchObject({ status: 404 });
    await withdrawSavedReport(makeActor(true), id);
    await withdrawSavedReport(makeActor(), id);
    expect(mocks.query.mock.calls[1][2]).toMatchObject({ admin: true });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith("tx", expect.objectContaining({ entityId: id, action: "whats_new_report_withdrawn" }));
    expect(mocks.query.mock.calls.map(c => c[1]).join("\n")).not.toMatch(/notifications\.|report_recipients|DELETE\s|UPDATE\s/);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("guarda un snapshot sin destinatarios y no escribe si cambia una entrada durante la carga", async () => {
    mocks.snapshot.mockResolvedValue({ html: bytes.toString(), entryCount: 1, approvedCount: 1, failedCount: 0,
      entries: [{ id, etag: '"AAAAAAAAAAA="' }] });
    mocks.upload.mockResolvedValue(locator);
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await expect(savePrivateReport(makeActor(), input, "stale-key")).rejects.toMatchObject({ code: "version_desactualizada" });
    expect(mocks.file).not.toHaveBeenCalled();
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ reportKey: 4 }]).mockResolvedValueOnce([]);
    mocks.file.mockResolvedValueOnce(9);
    await expect(savePrivateReport(makeActor(), input, "fresh-key")).resolves.toMatchObject({ id: expect.any(String), replayed: false });
    const statements = mocks.query.mock.calls.map(c => c[1]).join("\n");
    expect(statements).toContain("@failed,0,@file");
    expect(statements).toContain("INSERT whats_new.report_entries");
    expect(statements).not.toMatch(/notifications\.|report_recipients/);
    expect(mocks.audit).toHaveBeenCalledWith("tx", expect.objectContaining({ action: "whats_new_report_saved" }));
  });
});
