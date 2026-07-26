import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type FetchLike = typeof fetch;

function apiKey(): string {
  const value = process.env.OPENAI_API_KEY?.trim();
  if (!value) throw Object.assign(new Error("OPENAI_API_KEY no está configurado."), { code: "openai_not_configured" });
  return value;
}

async function checkedJson(response: Response): Promise<Record<string, any>> {
  const body = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    const code = typeof body.error?.code === "string" ? body.error.code : `openai_http_${response.status}`;
    throw Object.assign(new Error("El proveedor de IA rechazó la operación."), { code, status: response.status });
  }
  return body;
}

export async function transcribeGuideAudio(
  audioPath: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ text: string; segments: Array<{ start: number; end: number; text: string }>; requestIdHash?: string }> {
  const bytes = await readFile(audioPath);
  if (bytes.length > 25_000_000) {
    throw Object.assign(new Error("El audio supera el límite de 25 MB para transcripción."), { code: "audio_too_large" });
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), "audio.m4a");
  form.append("model", process.env.GUIDE_TRANSCRIPTION_MODEL?.trim() || "whisper-1");
  form.append("language", "es");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = await checkedJson(response);
  return {
    text: String(body.text ?? ""),
    segments: Array.isArray(body.segments)
      ? body.segments.map((segment: any) => ({
          start: Number(segment.start ?? 0),
          end: Number(segment.end ?? 0),
          text: String(segment.text ?? ""),
        }))
      : [],
    requestIdHash: response.headers.get("x-request-id")
      ? createHash("sha256").update(response.headers.get("x-request-id")!, "utf8").digest("hex")
      : undefined,
  };
}

export async function createGuideStructuredResponse<T>(input: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  safetyIdentifier: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}, fetchImpl: FetchLike = fetch): Promise<{ output: T; usage: Record<string, number>; requestIdHash?: string }> {
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      store: false,
      safety_identifier: createHash("sha256").update(input.safetyIdentifier, "utf8").digest("hex"),
      reasoning: { effort: input.reasoningEffort ?? "low" },
      input: [
        { role: "system", content: [{ type: "input_text", text: input.system }] },
        { role: "user", content: [{ type: "input_text", text: input.user }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: input.schemaName,
          strict: true,
          schema: input.schema,
        },
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await checkedJson(response);
  const text = typeof body.output_text === "string"
    ? body.output_text
    : body.output
      ?.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .find((item: any) => item?.type === "output_text")
      ?.text;
  if (typeof text !== "string") throw Object.assign(new Error("La respuesta de IA no contiene JSON estructurado."), { code: "openai_invalid_output" });
  return {
    output: JSON.parse(text) as T,
    usage: {
      inputTokens: Number(body.usage?.input_tokens ?? 0),
      outputTokens: Number(body.usage?.output_tokens ?? 0),
      reasoningTokens: Number(body.usage?.output_tokens_details?.reasoning_tokens ?? 0),
      cachedInputTokens: Number(body.usage?.input_tokens_details?.cached_tokens ?? 0),
    },
    requestIdHash: response.headers.get("x-request-id")
      ? createHash("sha256").update(response.headers.get("x-request-id")!, "utf8").digest("hex")
      : undefined,
  };
}
