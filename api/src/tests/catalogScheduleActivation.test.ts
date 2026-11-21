import { describe, expect, it } from "vitest";
import { reconcileScheduleActivation, scheduleActivationAt, type ScheduledTargetEvidence } from "../lib/catalogScheduleActivation";

const due = Date.parse("2026-11-20T05:00:00Z");
const born = due - 20_000;
const planned = { startDate: "2026-11-20", createdAt: born, members: [] };
const observations = (observedAt: number, members: [string, ScheduledTargetEvidence["state"]][], complete = true) =>
  ({ complete, observedAt, targets: members.map(([linkId, state]) => ({ linkId, state })) });

describe("activation at the scheduled Bogotá date", () => {
  it("uses Bogotá midnight and gives a same-day copy its own creation boundary", () => {
    expect(scheduleActivationAt("2026-11-20", born)).toBe(due);
    expect(scheduleActivationAt("2026-11-20", due + 60_000)).toBe(due + 60_000);
    expect(() => scheduleActivationAt("2026-02-30", born)).toThrow();
  });

  it("adds eligible links while planning, hides one temporarily, then restores its same identity", () => {
    const one = reconcileScheduleActivation(planned, due - 10_000, observations(due-10_000, [["original","eligible"]]));
    const hidden = reconcileScheduleActivation(one, due - 5_000, observations(due-5_000, [["original","absent"],["new","eligible"]]));
    expect(hidden.members).toEqual([{linkId:"new",state:"eligible"},{linkId:"original",state:"absent"}]);
    const revived = reconcileScheduleActivation(hidden, due-1, observations(due-1,[["original","eligible"],["new","eligible"]]));
    expect(revived.members.filter(t=>t.state==="eligible").map(t=>t.linkId)).toEqual(["new","original"]);
  });

  it("freezes survivors at the boundary and never admits new or returning links after freezing", () => {
    const before = reconcileScheduleActivation(planned,due-10,observations(due-10,[["first","eligible"],["removed","eligible"]]));
    const frozen = reconcileScheduleActivation(before,due,observations(due,[["first","eligible"],["removed","absent"]]));
    expect(frozen).toMatchObject({phase:"frozen",frozenAt:due,members:[{linkId:"first",state:"eligible"},{linkId:"removed",state:"absent"}]});
    expect(reconcileScheduleActivation(frozen,due+10,observations(due+10,[["first","eligible"],["removed","eligible"],["late","eligible"]]))).toEqual(frozen);
  });

  it("cancels only on confirmed absence, not on failure or incomplete evidence", () => {
    const before = reconcileScheduleActivation(planned,due-5,observations(due-5,[["gone","eligible"]]));
    expect(reconcileScheduleActivation(before,due,observations(due,[["gone","absent"]])).phase).toBe("cancelled");
    expect(reconcileScheduleActivation(before,due,observations(due,[],false))).toMatchObject({
      phase:"held",frozenAt:due,members:[{linkId:"gone",state:"unverifiable"}],
    });
    expect(reconcileScheduleActivation(before,due+5,observations(due+5,[["late","eligible"]])).phase).toBe("held");
  });

  it("retains first-seen unknown and absent members in history without granting eligibility", () => {
    const unknown = reconcileScheduleActivation(planned, due,
      observations(due, [["first-unknown", "unverifiable"], ["first-absent", "absent"]]));
    expect(unknown).toMatchObject({ phase: "held", members: [
      { linkId: "first-absent", state: "absent" }, { linkId: "first-unknown", state: "unverifiable" },
    ] });
    const partial = reconcileScheduleActivation(planned, due,
      observations(due, [["available", "eligible"], ["first-unknown", "unverifiable"]]));
    expect(partial).toMatchObject({ phase: "frozen", members: [
      { linkId: "available", state: "eligible" }, { linkId: "first-unknown", state: "unverifiable" },
    ] });
  });

  it("evaluates a same-day copy from proof at that copy's own registration, independently of the original", () => {
    const copiedAt = due + 180_000;
    const copy = reconcileScheduleActivation({ ...planned, createdAt: copiedAt },copiedAt,
      observations(copiedAt,[["copy-only","eligible"]]));
    expect(copy).toMatchObject({phase:"frozen",frozenAt:copiedAt,members:[{linkId:"copy-only",state:"eligible"}]});
    expect(reconcileScheduleActivation(copy,copiedAt+3,observations(copiedAt+3,[["original","eligible"]]))).toEqual(copy);
  });

  it("rejects contradictory identities or evidence from the future", () => {
    expect(() => reconcileScheduleActivation(planned,due,observations(due,[["x","eligible"],["x","absent"]]))).toThrow();
    expect(() => reconcileScheduleActivation(planned,due,observations(due+1,[["x","eligible"]]))).toThrow();
  });
});
