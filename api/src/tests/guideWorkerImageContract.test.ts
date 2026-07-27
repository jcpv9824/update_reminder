import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("guide worker image contract", () => {
  it("pins the runtime supply chain and starts closed as a non-root one-shot worker", async () => {
    const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile.guide-worker"), "utf8");

    expect(dockerfile).toMatch(
      /node:24\.18\.0-bookworm-slim@sha256:[a-f0-9]{64}/,
    );
    expect(dockerfile).toContain("FFMPEG_VERSION=7:5.1.9-0+deb12u1");
    expect(dockerfile).toContain('"ffmpeg=${FFMPEG_VERSION}"');
    expect(dockerfile).toContain("GUIDE_WORKER_ENABLED=false");
    expect(dockerfile).toContain("GUIDE_WORKER_PROCESSOR_CERTIFIED=false");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["node", "dist/src/workers/guideWorkerHost.js"]',
    );
  });

  it("does not register the media worker as an Azure Function timer", async () => {
    const index = await readFile(resolve(process.cwd(), "src/index.ts"), "utf8");
    expect(index).not.toContain("processGuideJobs");
  });
});
