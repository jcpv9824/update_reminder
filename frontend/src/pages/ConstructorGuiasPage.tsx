import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, uploadToSignedUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alerta } from "../components/Comunes";
import { DraftAndQuestions } from "../components/constructorGuias/DraftAndQuestions";
import { ExtractionReview } from "../components/constructorGuias/ExtractionReview";
import { Finalize } from "../components/constructorGuias/Finalize";
import { GuideProgress } from "../components/constructorGuias/GuideProgress";
import { UploadStep } from "../components/constructorGuias/UploadStep";
import { guideCurrentStep } from "../components/constructorGuias/guideSessionUi";
import { hasPermissionForRoleIds } from "../permissionAccess";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../permissionModel";
import type {
  FinalizeGuideRequest,
  GuideSession,
  GuideUploadInitResponse,
  RegenerateGuideRequest,
} from "../types";

const ACTIVE_STATUSES = new Set<GuideSession["status"]>([
  "queued",
  "processing",
  "finalizing",
]);
const CANCELLABLE_STATUSES = new Set<GuideSession["status"]>([
  "upload_pending",
  ...ACTIVE_STATUSES,
  "review",
]);
const GUIDE_MAX_VIDEO_BYTES = 100_000_000;
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

function declaredVideoMime(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_MIME_BY_EXTENSION[extension] ?? null;
}

function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `guide-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ConstructorGuiasPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const uploadAbort = useRef<AbortController | null>(null);

  const usuario = auth.cargando ? null : auth.usuario;
  const { data: roleResponse } = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<RoleDefinition[]>("/roles"),
    enabled: !!usuario,
  });
  const roleDefinitions = Array.isArray(roleResponse) && roleResponse.length > 0
    ? roleResponse
    : DEFAULT_ROLE_DEFINITIONS;
  const has = (action: string) => hasPermissionForRoleIds(
    usuario?.roles ?? [],
    `help.guide_builder.${action}`,
    roleDefinitions,
  );

  const sessionQuery = useQuery({
    queryKey: ["guide-session", sessionId],
    queryFn: () => api.get<GuideSession>(`/guide-sessions/${sessionId}`),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const session = query.state.data as GuideSession | undefined;
      return session && ACTIVE_STATUSES.has(session.status) ? 2_000 : false;
    },
  });
  const session = sessionQuery.data;

  const transcriptQuery = useQuery({
    queryKey: ["guide-session", sessionId, "transcript"],
    queryFn: () => api.getText(`/guide-sessions/${sessionId}/transcript`),
    enabled: !!sessionId && !!session?.transcript.available && has("download_transcript"),
  });
  const draftQuery = useQuery({
    queryKey: ["guide-session", sessionId, "draft", session?.draft.version ?? 0],
    queryFn: () => api.getText(`/guide-sessions/${sessionId}/drafts/current`),
    enabled: !!sessionId && !!session?.draft.available,
  });

  const regenerate = useMutation({
    mutationFn: (body: RegenerateGuideRequest) => api.post<GuideSession>(
      `/guide-sessions/${sessionId}/regenerate`,
      body,
      { headers: { "If-Match": session?.etag ?? "" } },
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData(["guide-session", sessionId], updated);
      queryClient.invalidateQueries({ queryKey: ["guide-session", sessionId, "draft"] });
      setAnswers({});
      setAnnouncement(`Borrador v${updated.draft.version} generado con las respuestas.`);
      setError(null);
    },
    onError: (cause: any) => setError(cause?.message ?? "No se pudo regenerar el borrador."),
  });
  const finalize = useMutation({
    mutationFn: (body: FinalizeGuideRequest) => api.post<GuideSession>(
      `/guide-sessions/${sessionId}/finalize`,
      body,
      { headers: { "If-Match": session?.etag ?? "" } },
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData(["guide-session", sessionId], updated);
      setAnnouncement("El manual se finalizó correctamente.");
      setError(null);
    },
    onError: (cause: any) => setError(cause?.message ?? "No se pudo finalizar el manual."),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<GuideSession>(
      `/guide-sessions/${sessionId}/cancel`,
      undefined,
      { headers: { "If-Match": session?.etag ?? "" } },
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData(["guide-session", sessionId], updated);
      setAnnouncement("El procesamiento fue cancelado.");
      setError(null);
    },
    onError: (cause: any) => setError(cause?.message ?? "No se pudo cancelar el procesamiento."),
  });

  async function startUpload() {
    const declaredMimeType = selectedFile ? declaredVideoMime(selectedFile) : null;
    if (!selectedFile || !declaredMimeType) {
      setError("Seleccione un video MP4, M4V, MOV o WebM válido.");
      return;
    }
    if (selectedFile.size > GUIDE_MAX_VIDEO_BYTES) {
      setError("El video supera el tamaño máximo permitido de 100 MB.");
      return;
    }
    setError(null);
    setUploading(true);
    setUploadProgress(0);
    const controller = new AbortController();
    uploadAbort.current = controller;
    const initIdempotencyKey = newIdempotencyKey();
    try {
      const initialized = await api.post<GuideUploadInitResponse>("/guide-sessions", {
        fileName: selectedFile.name,
        mimeType: declaredMimeType,
        sizeBytes: selectedFile.size,
      }, { headers: { "Idempotency-Key": initIdempotencyKey } });
      queryClient.setQueryData(["guide-session", initialized.session.id], initialized.session);
      setSearchParams({ session: initialized.session.id }, { replace: true });
      await uploadToSignedUrl({
        ...initialized.upload,
        file: selectedFile,
        signal: controller.signal,
        onProgress: setUploadProgress,
      });
      const updated = await api.post<GuideSession>(
        `/guide-sessions/${initialized.session.id}/upload-complete`,
        undefined,
        { headers: { "Idempotency-Key": `${initIdempotencyKey}-complete`, "If-Match": initialized.session.etag } },
      );
      queryClient.setQueryData(["guide-session", initialized.session.id], updated);
      setUploadProgress(100);
      setAnnouncement("Video cargado. El procesamiento ha comenzado.");
    } catch (cause: any) {
      if (cause?.name !== "AbortError") {
        setError(cause?.message ?? "No se pudo iniciar el procesamiento.");
      }
    } finally {
      uploadAbort.current = null;
      setUploading(false);
    }
  }

  function chooseFile(file: File | null) {
    setError(null);
    if (file && !declaredVideoMime(file)) {
      setSelectedFile(null);
      setError("Seleccione un video MP4, M4V, MOV o WebM válido.");
      return;
    }
    if (file && file.size > GUIDE_MAX_VIDEO_BYTES) {
      setSelectedFile(null);
      setError("El video supera el tamaño máximo permitido de 100 MB.");
      return;
    }
    setSelectedFile(file);
  }

  async function download(path: string, name: string) {
    try {
      downloadBlob(await api.getBlob(path), name);
    } catch (cause: any) {
      setError(cause?.message ?? "No se pudo descargar el archivo.");
    }
  }

  function cancelCurrent() {
    if (uploading) uploadAbort.current?.abort();
    if (sessionId && session && CANCELLABLE_STATUSES.has(session.status) && has("cancel")) {
      cancel.mutate();
      return;
    }
    setSelectedFile(null);
    setUploadProgress(null);
  }

  function startAnotherGuide() {
    setSearchParams({}, { replace: true });
    setSelectedFile(null);
    setUploadProgress(null);
    setAnswers({});
    setError(null);
  }

  const nonEmptyAnswers = useMemo(
    () => Object.entries(answers)
      .filter(([, answer]) => answer.trim())
      .map(([questionId, answer]) => ({ questionId, answer: answer.trim() })),
    [answers],
  );
  const currentStep = session ? guideCurrentStep(session) : 1;
  const processing = session?.processing;
  const showExtraction = !!session && currentStep >= 2;
  const showDraft = !!session && currentStep >= 3 && session.draft.available;
  const showFinal = session?.status === "completed";

  return (
    <>
      <div className="encabezado-pagina">
        <h2>Constructor de guías</h2>
      </div>
      <div className="alerta alerta-info">
        Suba un video narrado del procedimiento en SAG Web. El sistema extrae el audio y las capturas, y arma un borrador de manual.
      </div>
      <GuideProgress currentStep={currentStep} />
      <div className="sr-only" aria-live="polite">{announcement}</div>
      {error ? <div className="alerta alerta-error" role="alert">{error}</div> : null}
      {sessionQuery.isError ? <Alerta tipo="error">No se pudo cargar la sesión de la guía.</Alerta> : null}
      {session?.status === "failed" && session.failure ? (
        <div className="alerta alerta-error" role="alert">
          <p>{session.failure.message}</p>
          {has("create") ? <button type="button" onClick={startAnotherGuide}>Iniciar otra guía</button> : null}
        </div>
      ) : null}
      {session?.status === "cancelled" ? (
        <div className="alerta alerta-info">
          El procesamiento fue cancelado.
          {has("create") ? <button type="button" onClick={startAnotherGuide}>Iniciar otra guía</button> : null}
        </div>
      ) : null}

      {(!session || currentStep === 1) ? (
        <UploadStep
          selectedFile={selectedFile}
          uploading={uploading}
          uploadProgress={uploadProgress}
          canCreate={has("create")}
          onSelect={chooseFile}
          onStart={startUpload}
          onCancel={cancelCurrent}
        />
      ) : null}

      {processing && ACTIVE_STATUSES.has(session?.status ?? "queued") ? (
        <section className="tarjeta constructor-guias-procesamiento" aria-live="polite" aria-labelledby="constructor-guias-procesando">
          <h3 id="constructor-guias-procesando">Procesando…</h3>
          <p>{processing.message}</p>
          {processing.progressPercent !== null ? <progress max={100} value={processing.progressPercent} /> : null}
          {session && CANCELLABLE_STATUSES.has(session.status) && has("cancel") ? (
            <button type="button" onClick={cancelCurrent} disabled={cancel.isPending}>Cancelar</button>
          ) : null}
        </section>
      ) : null}

      {showExtraction ? (
        <ExtractionReview
          sessionId={sessionId}
          transcript={transcriptQuery.data ?? ""}
          frames={session.frames}
          canDownloadTranscript={has("download_transcript")}
          onDownloadTranscript={() => download(`/guide-sessions/${sessionId}/transcript`, `transcripcion-${sessionId}.txt`)}
        />
      ) : null}

      {showDraft ? (
        <DraftAndQuestions
          draft={draftQuery.data ?? ""}
          draftVersion={session.draft.version}
          questions={session.questions}
          answers={answers}
          pendingCount={session.draft.pendingVerificationCount}
          canRegenerate={has("regenerate")}
          showFinalize={has("finalize")}
          canFinalize={has("finalize") && session.canFinalize}
          regenerating={regenerate.isPending}
          finalizing={finalize.isPending}
          onAnswer={(questionId, answer) => setAnswers((current) => ({ ...current, [questionId]: answer }))}
          onRegenerate={() => regenerate.mutate({
            answers: nonEmptyAnswers,
          })}
          onFinalize={() => finalize.mutate({ draftVersion: session.draft.version })}
        />
      ) : null}

      {showFinal ? (
        <Finalize
          checks={session.validation?.checks ?? []}
          canDownload={has("download_manual")}
          onDownload={() => download(`/guide-sessions/${sessionId}/manual`, `manual-${sessionId}.md`)}
        />
      ) : null}
    </>
  );
}
