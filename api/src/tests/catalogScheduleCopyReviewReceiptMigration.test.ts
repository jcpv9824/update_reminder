import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const filename = "076_catalog_schedule_copy_review_receipts.sql";
const sql = () => read(`migration/sql/${filename}`);
describe("protected review receipt (076)", () => {
  it("retains the existing runtime denial, stamps the independent session, and cannot write 044", () => {
    const script = sql();
    expect(script).toContain("p.major_id=SCHEMA_ID(N'migration')");
    expect(script).toContain("p.permission_name=N'INSERT' AND p.state='D'");
    expect(script).toContain("ISNULL(IS_ROLEMEMBER(N''portal_runtime''),0)<>0");
    expect(script).toContain("transaction_isolation_level=4");
    expect(script).toContain("ORIGINAL_LOGIN() FROM inserted");
    expect(script).toContain("DATEADD(minute,10,@now)");
    expect(script).not.toMatch(/\b(GRANT|REVOKE|EXECUTE AS)\b/i);
    expect(script).not.toMatch(/INSERT\s+(?:scheduling\.catalog_schedule_operation_approvals|scheduling\.update_schedules|workflow\.|notifications\.)/i);
  });
  it("binds the immutable review to the digest, exact children, active independent approver and original operation", () => {
    const script = sql();
    expect(script).toContain("proof.reviewed_state_sha256=i.reviewed_state_sha256");
    expect(script).toContain("p.request_sha256=i.request_sha256");
    expect(script).toContain("o.assignment_mode AS assignmentMode");
    expect(script).toContain("a.assignment_kind AS lane");
    expect(script).toContain("t.physical_target_id");
    expect(script).toContain("requester.user_key<>reviewer.user_key");
    expect(script).toContain("AS manualDatabases");
    expect(script).toContain("AS licenseModules");
    expect(script).toContain("role_row.protected_role=1");
    expect(script).toContain("operation.operation_id=p.operation_id");
    expect(script).toContain("original.row_version=p.original_definition_version");
    expect(script).toContain("WHERE consumed.intent_id=p.proposal_id");
  });
  it("keeps write mode opt-in, exact-hash guarded, and the migration byte-pinned", () => {
    const sha = createHash("sha256").update(sql(), "utf8").digest("hex");
    expect(read("migration/sql/MANIFEST.sha256")).toContain(`${sha}  ${filename}`);
    const tool = read("migration/tools/Register-PortalSAGWeb-CopyProposalReview.ps1");
    expect(tool).toContain("if ($Apply)");
    expect(tool).toContain("ShouldProcess");
    expect(tool).toContain("@currentState<>@expectedState");
    expect(tool).toContain("$mode='read'");
  });
});
