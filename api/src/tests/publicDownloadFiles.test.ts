import { describe, expect, it } from "vitest";
import { inspectPublicDownloadFile } from "../lib/publicDownloadFiles";

function mp4Bytes(): Buffer {
  return Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
}

describe("public download file validation", () => {
  it("classifies compatible MP4 and WebM uploads as videos", () => {
    expect(inspectPublicDownloadFile("demo.mp4", mp4Bytes(), "video/mp4")).toMatchObject({
      assetKind: "video",
      mimeType: "video/mp4",
      extension: ".mp4",
    });
    expect(inspectPublicDownloadFile(
      "demo.webm",
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
      "video/webm"
    )).toMatchObject({ assetKind: "video", mimeType: "video/webm" });
  });

  it("keeps existing office and text formats as documents", () => {
    expect(inspectPublicDownloadFile("manual.pdf", Buffer.from("%PDF-1.7\n"), "application/pdf")).toMatchObject({
      assetKind: "document",
      mimeType: "application/pdf",
    });
  });

  it("rejects renamed or unsupported video payloads", () => {
    expect(() => inspectPublicDownloadFile("fake.mp4", Buffer.from("not-video"), "video/mp4"))
      .toThrow(/contenido no corresponde/i);
    expect(() => inspectPublicDownloadFile("script.exe", Buffer.from("MZ"), "application/octet-stream"))
      .toThrow(/no permitido/i);
  });
});
