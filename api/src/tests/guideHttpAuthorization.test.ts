import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  handlers: new Map<string, (request: HttpRequest) => Promise<HttpResponseInit>>(),
  authenticated: true,
  profile: {
    id: "user-1",
    email: "user-1@example.test",
    displayName: "User One",
    roles: ["guide-user"],
    allowedActions: ["view", "cancel"] as string[],
    viewAll: false,
  },
  session: {
    id: "guide_session_1",
    ownerId: "user-1",
    originalVideoName: "guide.mp4",
    declaredMimeType: "video/mp4",
    declaredByteCount: 1024,
    status: "review",
    currentStage: "questions",
    latestDraftNo: 1,
    answeredRoundCount: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    rowVersion: "\"AQIDBAUGBwg=\"",
  },
  readSessions: vi.fn(),
  readSession: vi.fn(),
  readQuestions: vi.fn(),
  readFrames: vi.fn(),
  readArtifactSummary: vi.fn(),
  readArtifact: vi.fn(),
  cancelSession: vi.fn(),
  createSession: vi.fn(),
  createUpload: vi.fn(),
  createObjectUrl: vi.fn(),
}));

vi.mock("@azure/functions", () => ({
  app: {
    http: (
      name: string,
      config: { handler: (request: HttpRequest) => Promise<HttpResponseInit> },
    ) => testState.handlers.set(name, config.handler),
  },
}));

vi.mock("../lib/auth", () => ({
  requireUser: vi.fn(async () => {
    if (!testState.authenticated) {
      throw Object.assign(new Error("No autenticado."), { status: 403 });
    }
    return { id: testState.profile.id };
  }),
  loadUserProfile: vi.fn(async () => testState.profile),
}));

vi.mock("../lib/roleDefinitionStore", () => ({
  loadRoleDefinitions: vi.fn(async () => []),
}));

vi.mock("../lib/managementAccess", () => ({
  canUseGuideBuilder: vi.fn((
    user: typeof testState.profile,
    action: string,
  ) => action === "view_all" ? user.viewAll : user.allowedActions.includes(action)),
}));

vi.mock("../lib/guideBuilderSqlRepository", () => ({
  appendSqlGuideAnswerRound: vi.fn(),
  cancelSqlGuideSession: testState.cancelSession,
  completeSqlGuideUpload: vi.fn(),
  createSqlGuideSession: testState.createSession,
  queueSqlGuideFinalization: vi.fn(),
  readSqlGuideArtifact: testState.readArtifact,
  readSqlGuideArtifactSummary: testState.readArtifactSummary,
  readSqlGuideQuestions: testState.readQuestions,
  readSqlGuideFrames: testState.readFrames,
  readSqlGuideSession: testState.readSession,
  readSqlGuideSessions: testState.readSessions,
}));

vi.mock("../lib/objectStorage", () => ({
  createPrivateObjectUpload: testState.createUpload,
  createPrivateObjectUrl: testState.createObjectUrl,
  statPrivateObject: vi.fn(),
}));

function request(
  id = "guide_session_1",
  extras: Partial<HttpRequest> = {},
): HttpRequest {
  return {
    method: "GET",
    params: { id },
    headers: new Headers(),
    query: new URLSearchParams(),
    json: async () => ({}),
    ...extras,
  } as HttpRequest;
}

function handler(name: string) {
  const registered = testState.handlers.get(name);
  if (!registered) throw new Error(`Handler ${name} was not registered.`);
  return registered;
}

beforeAll(async () => {
  process.env.GUIDE_BUILDER_ENABLED = "true";
  await import("../functions/guideSessions");
});

beforeEach(() => {
  testState.authenticated = true;
  testState.profile.id = "user-1";
  testState.profile.allowedActions = ["view", "cancel"];
  testState.profile.viewAll = false;
  testState.session.ownerId = "user-1";
  testState.readSession.mockResolvedValue(testState.session);
  testState.readSessions.mockResolvedValue({ items: [testState.session], total: 1 });
  testState.readQuestions.mockResolvedValue([]);
  testState.readFrames.mockResolvedValue([]);
  testState.readArtifactSummary.mockResolvedValue({
    transcriptAvailable: false,
    transcriptSegmentCount: 0,
    draftAvailable: true,
    draftVersion: 1,
    finalAvailable: false,
  });
  testState.readArtifact.mockResolvedValue(null);
  testState.createUpload.mockResolvedValue({
    locator: {
      storageProvider: "azure_blob",
      storageContainer: "private",
      storageBlobName: "guides/uploads/replay.mp4",
    },
    url: "https://storage.invalid/write-token",
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    expiresAt: "2026-07-27T00:10:00.000Z",
  });
  vi.clearAllMocks();
});

describe("guide HTTP authorization boundary", () => {
  it("rejects unauthenticated and permission-denied detail requests", async () => {
    testState.authenticated = false;
    await expect(handler("guideSessionDetail")(request())).resolves.toMatchObject({ status: 403 });

    testState.authenticated = true;
    testState.profile.allowedActions = [];
    await expect(handler("guideSessionDetail")(request())).resolves.toMatchObject({ status: 403 });
  });

  it("scopes collection reads to the owner unless view_all is granted", async () => {
    await expect(handler("guideSessionsCollection")(request())).resolves.toMatchObject({ status: 200 });
    expect(testState.readSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerId: "user-1",
      viewAll: false,
    }));

    testState.profile.viewAll = true;
    await handler("guideSessionsCollection")(request());
    expect(testState.readSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerId: "user-1",
      viewAll: true,
    }));
  });

  it("returns not found for another owner's detail, questions, artifacts, and mutations", async () => {
    testState.session.ownerId = "user-2";

    await expect(handler("guideSessionDetail")(request())).resolves.toMatchObject({ status: 404 });
    await expect(handler("guideSessionQuestions")(request())).resolves.toMatchObject({ status: 404 });
    await expect(handler("guideSessionDraft")(request())).resolves.toMatchObject({ status: 404 });
    await expect(handler("guideSessionCancel")(request())).resolves.toMatchObject({ status: 404 });

    expect(testState.readQuestions).not.toHaveBeenCalled();
    expect(testState.readArtifact).not.toHaveBeenCalled();
    expect(testState.createObjectUrl).not.toHaveBeenCalled();
    expect(testState.cancelSession).not.toHaveBeenCalled();
  });

  it("allows a view_all user to cross the owner boundary", async () => {
    testState.session.ownerId = "user-2";
    testState.profile.viewAll = true;

    await expect(handler("guideSessionDetail")(request())).resolves.toMatchObject({ status: 200 });
    await expect(handler("guideSessionQuestions")(request())).resolves.toMatchObject({ status: 200 });
  });

  it("never returns a new upload authorization for an idempotent replay", async () => {
    testState.profile.allowedActions = ["create"];
    testState.createSession.mockResolvedValue({
      created: false,
      session: { ...testState.session, status: "upload_pending", currentStage: "ingest" },
    });
    const response = await handler("guideSessionsCollection")(request("guide_session_1", {
      method: "POST",
      headers: new Headers({ "idempotency-key": "replayed-create" }),
      json: async () => ({
        fileName: "guide.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
      }),
    }));

    expect(response).toMatchObject({ status: 409 });
    expect(response.jsonBody).not.toHaveProperty("upload");
  });
});
