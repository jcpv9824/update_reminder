import { describe, expect, it, vi } from "vitest";
import { readEntry, readEntries, type Db, type query } from "../lib/whatsNewSqlRepository";

describe("Qué hay de nuevo batch reads", () => {
  it("reads full normalized history in thirteen requests independent of entry count", async () => {
    const ids = ["a", "b"];
    const execute = vi.fn(async (_db: unknown, statement: string) => statement.startsWith("SELECT e.*") ? ids.map((id, index) => ({
      entry_key: index + 1, source_id: id, entry_number: index + 1, status: "probado", entry_type: "mejora", system_code: "sag_web",
      developer_id: "dev", developer_name: "Desarrollo", row_version: Buffer.from("0000000000000001", "hex"),
      what_changed_json: null, client_name_text: null, current_revision_no: 1, current_round_no: 1, last_finding_no: 0, open_findings_count: 0,
      created_at: new Date("2026-11-01Z"), updated_at: new Date("2026-11-01Z"), result_at: new Date("2026-11-01Z"), release_month: "2026-11",
    })) : statement.includes("FROM whats_new.entry_participants p") ? ids.map((id, index) => ({
      entry_key: index + 1, id: `participant-${id}`, displayName: `Participant ${id}`, role: "asesor", internal_sentinel: "PRIVATE",
    })) : statement.includes("FROM whats_new.round_notes n") ? [
      { entry_key: 1, source_id: "note-a", round_id: "round-a", body_json: '{"type":"doc"}', created_by_id: "a", created_at: new Date("2026-11-01Z") },
      { entry_key: 2, source_id: "note-b", round_id: "round-b", body_json: '{"type":"doc"}', created_by_id: "b", created_at: new Date("2026-11-01Z") },
    ] : statement.includes("FROM whats_new.test_rounds r") && statement.startsWith("SELECT r.*") ? ids.map((id, index) => ({
      entry_key: index + 1, source_id: `round-${id}`, round_no: 1, revision_no: 1, holder_id: id, holder_name: id, status: "probada",
      row_version: Buffer.from("0000000000000001", "hex"), taken_at: new Date("2026-11-01Z"), closed_at: new Date("2026-11-02Z"),
    })) : []);
    const result = await readEntries({} as Db, ids, execute as typeof query);
    expect(result.map((e) => e.id)).toEqual(ids); expect(execute).toHaveBeenCalledTimes(13);
    expect(result[0].rounds[0].notes.map((n) => n.id)).toEqual(["note-a"]);
    expect(result[1].rounds[0].notes.map((n) => n.id)).toEqual(["note-b"]);
    expect(result[0].participants).toEqual([{ id: "participant-a", displayName: "Participant a", role: "asesor" }]);
    expect(result[1].participants).toEqual([{ id: "participant-b", displayName: "Participant b", role: "asesor" }]);
    for (const call of execute.mock.calls) {
      expect(call[1]).not.toMatch(/@(?:id|key)\b/);
      expect(call[1]).toContain("OPENJSON(@ids)");
    }
    const singleLoad = vi.fn(async (db: unknown, statement: string) => (await execute(db, statement)).filter((r) => r.entry_key === 1));
    const single = await readEntry({} as Db, "a", false, singleLoad as typeof query);
    expect(single!.detail.participants.every((p) => Object.keys(p).sort().join(",") === "displayName,id,role")).toBe(true);
    expect(single!.state.asesorParticipantIds).toEqual(["participant-a"]);
  });
  it("rejects more than 200 entries before any database request", async () => {
    const execute = vi.fn();
    await expect(readEntries({} as Db, Array(201).fill("x"), execute)).rejects.toThrow("Filtre por mes");
    expect(execute).not.toHaveBeenCalled();
  });
});
