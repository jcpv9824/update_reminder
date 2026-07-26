import type { GuideSession } from "../../types";

export function guideCurrentStep(
  session: Pick<GuideSession, "status" | "stage">,
): 1 | 2 | 3 | 4 {
  if (session.status === "upload_pending") return 1;
  if (session.status === "completed" || session.status === "finalizing") return 4;
  if (session.status === "review") return 3;

  if (session.stage === "questions" || session.stage === "reprocess") return 3;
  if (session.stage === "finalize" || session.stage === "completed") return 4;
  return 2;
}
