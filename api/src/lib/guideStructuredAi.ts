import { createHash } from "node:crypto";

type FetchLike = typeof fetch;

function boundedSignal(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function apiKey(): string {
  const value = process.env.OPENAI_API_KEY?.trim();
  if (!value) {
    throw Object.assign(new Error("El proveedor de IA no está configurado."), {
      code: "openai_not_configured",
    });
  }
  return value;
}

function boundedOutputTokens(requested: number): number {
  if (!Number.isInteger(requested)) return 4_000;
  return Math.max(256, Math.min(8_000, requested));
}

export async function createBoundedGuideResponse<T>(input: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  safetyIdentifier: string;
  images?: Array<{ mimeType: "image/jpeg" | "image/png" | "image/webp"; bytes: Buffer }>;
  maxOutputTokens: number;
  signal?: AbortSignal;
}, fetchImpl: FetchLike = fetch): Promise<{
  output: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
  };
  requestIdHash?: string;
}> {
  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: input.user }];
  for (const image of (input.images ?? []).slice(0, 1)) {
    if (image.bytes.length > 5_000_000) {
      throw Object.assign(new Error("La captura supera el límite visual permitido."), {
        code: "guide_frame_too_large",
      });
    }
    userContent.push({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      detail: "low",
    });
  }
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
      max_output_tokens: boundedOutputTokens(input.maxOutputTokens),
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: [{ type: "input_text", text: input.system }] },
        { role: "user", content: userContent },
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
    signal: boundedSignal(input.signal, 180_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    const code = typeof body.error?.code === "string" ? body.error.code : `openai_http_${response.status}`;
    throw Object.assign(new Error("El proveedor de IA rechazó la operación."), {
      code,
      status: response.status,
    });
  }
  if (body.status === "incomplete" || body.error) {
    throw Object.assign(new Error("El proveedor de IA no completó la operación."), {
      code: "openai_incomplete",
    });
  }
  const outputText = typeof body.output_text === "string"
    ? body.output_text
    : body.output
      ?.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .find((item: any) => item?.type === "output_text")
      ?.text;
  if (typeof outputText !== "string") {
    throw Object.assign(new Error("La respuesta de IA no contiene JSON estructurado."), {
      code: "openai_invalid_output",
    });
  }
  let output: T;
  try {
    output = JSON.parse(outputText) as T;
  } catch {
    throw Object.assign(new Error("La respuesta de IA no contiene JSON válido."), {
      code: "openai_invalid_output",
    });
  }
  return {
    output,
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
