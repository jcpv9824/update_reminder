import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ConstructorGuiasPage from "../pages/ConstructorGuiasPage";
import type { RoleDefinition } from "../permissionModel";
import type { GuideSession } from "../types";

const authState = vi.hoisted(() => ({ roles: ["super_admin"] as string[] }));
const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  getText: vi.fn(),
  getBlob: vi.fn(),
}));
const uploadMock = vi.hoisted(() => vi.fn());

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    cargando: false,
    usuario: { id: "user_1", email: "user@empresa.com", displayName: "Usuario", roles: authState.roles },
  }),
}));
vi.mock("../api/client", () => ({
  api: apiMock,
  uploadToSignedUrl: uploadMock,
}));

function session(overrides: Partial<GuideSession> = {}): GuideSession {
  return {
    id: "guide_1",
    etag: "\"AQIDBAUGBwg=\"",
    status: "review",
    stage: "questions",
    sourceFile: { name: "proceso.mp4", mimeType: "video/mp4", sizeBytes: 100 },
    processing: null,
    transcript: { available: true, segmentCount: 2 },
    frames: [],
    draft: { available: true, version: 1, pendingVerificationCount: 1 },
    questions: [{ id: "q1", text: "¿La ruta es Configuración > Maestros?", required: true, answered: false }],
    answerRoundCount: 0,
    canFinalize: false,
    validation: null,
    failure: null,
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage(initialEntry = "/ayudas/constructor-guias") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/ayudas/constructor-guias" element={<ConstructorGuiasPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authState.roles = ["super_admin"];
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.getText.mockReset();
  apiMock.getBlob.mockReset();
  uploadMock.mockReset();
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === "/roles") return [];
    return session();
  });
  apiMock.getText.mockImplementation(async (path: string) =>
    path.endsWith("/drafts/current") ? "module_hierarchy: \"Configuración > Maestros\"" : "[00:04] Ingrese a Configuración",
  );
  apiMock.getBlob.mockResolvedValue(new Blob(["archivo"]));
  uploadMock.mockResolvedValue(undefined);
});

describe("ConstructorGuiasPage", () => {
  it("renderiza el flujo accesible de cuatro pasos y el contrato de carga", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Constructor de guías" })).toBeInTheDocument();
    expect(screen.getByText(/El sistema extrae el audio y las capturas/i)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Progreso de creación de la guía" }).children).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Arrastre el archivo/i })).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("Video narrado del procedimiento")).toHaveAttribute("accept", expect.stringContaining("video/mp4"));
    expect(screen.getByRole("button", { name: "Iniciar procesamiento" })).toBeDisabled();
  });

  it("rechaza un tipo no soportado antes de iniciar la API", async () => {
    renderPage();
    await userEvent.upload(
      screen.getByLabelText("Video narrado del procedimiento"),
      new File(["texto"], "instrucciones.txt", { type: "text/plain" }),
      { applyAccept: false },
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Seleccione un video MP4, M4V, MOV o WebM válido.");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("crea la sesión, carga por URL firmada y confirma el upload", async () => {
    const uploadingSession = session({
      status: "upload_pending",
      stage: "ingest",
      transcript: { available: false, segmentCount: 0 },
      draft: { available: false, version: 0, pendingVerificationCount: 0 },
      questions: [],
    });
    const queuedSession = session({
      status: "queued",
      stage: "ingest",
      processing: { progressPercent: 0, message: "Preparando audio…" },
      transcript: { available: false, segmentCount: 0 },
      draft: { available: false, version: 0, pendingVerificationCount: 0 },
      questions: [],
    });
    apiMock.post
      .mockResolvedValueOnce({
        session: uploadingSession,
        upload: { url: "https://storage.example/write", method: "PUT", headers: { "x-test": "1" }, expiresAt: "2026-07-26T11:00:00.000Z" },
      })
      .mockResolvedValueOnce(queuedSession);
    apiMock.get.mockImplementation(async (path: string) => path === "/roles" ? [] : queuedSession);
    renderPage();

    const file = new File(["video"], "procedimiento.mp4", { type: "video/mp4" });
    await userEvent.upload(screen.getByLabelText("Video narrado del procedimiento"), file);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar procesamiento" }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/guide-sessions", {
      fileName: "procedimiento.mp4",
      mimeType: "video/mp4",
      sizeBytes: file.size,
    }, { headers: { "Idempotency-Key": expect.any(String) } }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://storage.example/write",
      method: "PUT",
      file,
    })));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(
      "/guide-sessions/guide_1/upload-complete",
      undefined,
      { headers: { "Idempotency-Key": expect.stringMatching(/-complete$/), "If-Match": uploadingSession.etag } },
    ));
    expect(await screen.findByText("Procesando…")).toBeInTheDocument();
  });

  it("restaura una sesión, muestra el borrador y exige la primera ronda antes de finalizar", async () => {
    renderPage("/ayudas/constructor-guias?session=guide_1");
    expect(await screen.findByText("Borrador v1 · manual .md")).toBeInTheDocument();
    expect(await screen.findByText(/module_hierarchy/)).toBeInTheDocument();
    expect(screen.getByLabelText(/¿La ruta es Configuración/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerar con respuestas" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finalizar manual" })).toBeDisabled();
  });

  it("envía respuestas no vacías con la versión esperada", async () => {
    apiMock.post.mockResolvedValue(session({ draft: { available: true, version: 2, pendingVerificationCount: 0 }, answerRoundCount: 1 }));
    renderPage("/ayudas/constructor-guias?session=guide_1");
    const question = await screen.findByLabelText(/¿La ruta es Configuración/);
    await userEvent.type(question, "Sí, esa es la ruta.");
    fireEvent.click(screen.getByRole("button", { name: "Regenerar con respuestas" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/guide-sessions/guide_1/regenerate", {
      answers: [{ questionId: "q1", answer: "Sí, esa es la ruta." }],
    }, { headers: { "If-Match": "\"AQIDBAUGBwg=\"" } }));
  });

  it("acepta MP4, M4V, MOV y WebM y bloquea archivos mayores de 100 MB", async () => {
    renderPage();
    const input = screen.getByLabelText("Video narrado del procedimiento");
    expect(input).toHaveAttribute("accept", expect.stringContaining(".m4v"));
    expect(input).toHaveAttribute("accept", expect.stringContaining(".webm"));

    const oversized = new File(["video"], "procedimiento.webm", { type: "video/webm" });
    Object.defineProperty(oversized, "size", { value: 100_000_001 });
    await userEvent.upload(input, oversized);
    expect(screen.getByRole("alert")).toHaveTextContent("El video supera el tamaño máximo permitido de 100 MB.");
    expect(screen.getByRole("button", { name: "Iniciar procesamiento" })).toBeDisabled();
  });

  it.each([
    ["video.mp4", "video/mp4"],
    ["video.m4v", "video/x-m4v"],
    ["video.mov", "video/quicktime"],
    ["video.webm", "video/webm"],
  ])("habilita el procesamiento para %s", async (name, mimeType) => {
    renderPage();
    await userEvent.upload(
      screen.getByLabelText("Video narrado del procedimiento"),
      new File(["video"], name, { type: mimeType }),
    );
    expect(screen.getByRole("button", { name: "Iniciar procesamiento" })).toBeEnabled();
  });

  it("finaliza con draftVersion e If-Match vigentes", async () => {
    apiMock.get.mockImplementation(async (path: string) => path === "/roles" ? [] : session({
      answerRoundCount: 1,
      canFinalize: true,
      draft: { available: true, version: 3, pendingVerificationCount: 0 },
    }));
    apiMock.post.mockResolvedValue(session({
      status: "finalizing",
      stage: "finalize",
      answerRoundCount: 1,
      canFinalize: false,
      draft: { available: true, version: 3, pendingVerificationCount: 0 },
    }));
    renderPage("/ayudas/constructor-guias?session=guide_1");
    fireEvent.click(await screen.findByRole("button", { name: "Finalizar manual" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(
      "/guide-sessions/guide_1/finalize",
      { draftVersion: 3 },
      { headers: { "If-Match": "\"AQIDBAUGBwg=\"" } },
    ));
  });

  it("oculta acciones que el rol personalizado no tiene", async () => {
    authState.roles = ["guide_reader"];
    const role: RoleDefinition = {
      id: "guide_reader",
      name: "Lector de guías",
      permissions: ["help.guide_builder.view"],
      taskVisibility: { domain: "none", database: "none" },
      system: false,
      active: true,
    };
    apiMock.get.mockImplementation(async (path: string) => path === "/roles" ? [role] : session());
    renderPage("/ayudas/constructor-guias?session=guide_1");
    await screen.findByText("Borrador v1 · manual .md");
    expect(screen.queryByRole("button", { name: "Descargar transcripción" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerar con respuestas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalizar manual" })).toBeNull();
    expect(apiMock.getText).not.toHaveBeenCalledWith("/guide-sessions/guide_1/transcript");
  });

  it("muestra el error sanitizado de una sesión fallida y permite iniciar otra", async () => {
    apiMock.get.mockImplementation(async (path: string) => path === "/roles" ? [] : session({
      status: "failed",
      stage: "vision",
      failure: { code: "GUIDE_PROCESSING_FAILED", message: "No se pudo procesar el video.", retryable: true },
      draft: { available: false, version: 0, pendingVerificationCount: 0 },
      transcript: { available: false, segmentCount: 0 },
      questions: [],
    }));
    renderPage("/ayudas/constructor-guias?session=guide_1");
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo procesar el video.");
    fireEvent.click(screen.getByRole("button", { name: "Iniciar otra guía" }));
    expect(await screen.findByRole("heading", { name: "Nuevo manual desde video" })).toBeInTheDocument();
  });
});
