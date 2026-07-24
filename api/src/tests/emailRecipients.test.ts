import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  users: [] as UserRecord[],
}));

vi.mock("../lib/securityUsersSqlRepository", () => ({
  readSqlPublicUsers: vi.fn(async () => mocks.users),
}));

import { resolveEmailsByRoles } from "../lib/emailRecipients";

function user(id: string, roles: string[], email = `${id}@example.com`): UserRecord {
  return {
    id,
    email,
    displayName: id,
    roles,
    active: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  } as UserRecord;
}

describe("email recipient role resolution", () => {
  beforeEach(() => {
    mocks.users = [];
  });

  it("resolves super_admin recipients from both new and legacy admin role ids", async () => {
    mocks.users = [
      user("legacy_admin", ["admin"], "legacy@example.com"),
      user("super_admin", ["super_admin"], "super@example.com"),
      user("viewer", ["viewer"], "viewer@example.com"),
    ];

    await expect(resolveEmailsByRoles(["super_admin"])).resolves.toEqual([
      "legacy@example.com",
      "super@example.com",
    ]);
  });
});
