import { spawn, type SpawnOptions } from "node:child_process";

type SpawnLike = typeof spawn;

async function runFixedProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  spawnImpl: SpawnLike = spawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawnImpl(executable, args, options);
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-32_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("El proceso multimedia superó el tiempo permitido."), { code: "media_timeout" }));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`El proceso multimedia falló (${code}).`), {
        code: "media_failed",
        diagnostic: stderr,
      }));
    });
  });
}

function binary(name: "ffmpeg" | "ffprobe"): string {
  const configured = process.env[name === "ffmpeg" ? "GUIDE_FFMPEG_PATH" : "GUIDE_FFPROBE_PATH"]?.trim();
  if (!configured) {
    throw Object.assign(new Error(`${name} no está configurado para el trabajador de guías.`), { code: "media_host_unproven" });
  }
  return configured;
}

export type GuideVideoProbe = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
};

export async function probeGuideVideo(
  inputPath: string,
  spawnImpl: SpawnLike = spawn,
): Promise<GuideVideoProbe> {
  const output = await runFixedProcess(binary("ffprobe"), [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate:format=duration",
    "-of", "json",
    inputPath,
  ], 30_000, spawnImpl);
  const parsed = JSON.parse(output) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const durationSeconds = Number(parsed.format?.duration);
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const frameRate = denominator ? numerator / denominator : 0;
  if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 900) {
    throw Object.assign(new Error("El video no tiene una duración válida o supera 15 minutos."), { code: "invalid_duration" });
  }
  if (!stream.width || !stream.height || stream.width > 3840 || stream.height > 2160 || frameRate > 60) {
    throw Object.assign(new Error("La resolución o frecuencia del video supera el límite permitido."), { code: "invalid_video_shape" });
  }
  const allowedCodecs = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);
  if (!stream.codec_name || !allowedCodecs.has(stream.codec_name.toLowerCase())) {
    throw Object.assign(new Error("El codec de video no está permitido."), { code: "invalid_video_codec" });
  }
  return {
    durationSeconds,
    width: stream.width,
    height: stream.height,
    frameRate,
    videoCodec: stream.codec_name ?? "unknown",
  };
}

export async function extractGuideAudio(
  inputPath: string,
  outputPath: string,
  spawnImpl: SpawnLike = spawn,
): Promise<void> {
  await runFixedProcess(binary("ffmpeg"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "aac", "-b:a", "48k", outputPath,
  ], 5 * 60_000, spawnImpl);
}

export async function extractGuideFrames(
  inputPath: string,
  scenePattern: string,
  intervalPattern: string,
  spawnImpl: SpawnLike = spawn,
): Promise<void> {
  await runFixedProcess(binary("ffmpeg"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath, "-vf", "select=gt(scene\\,0.30),scale=1280:-2", "-vsync", "vfr",
    "-frames:v", "100", scenePattern,
  ], 5 * 60_000, spawnImpl);
  await runFixedProcess(binary("ffmpeg"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath, "-vf", "fps=1/10,scale=1280:-2", "-frames:v", "100", intervalPattern,
  ], 5 * 60_000, spawnImpl);
}
