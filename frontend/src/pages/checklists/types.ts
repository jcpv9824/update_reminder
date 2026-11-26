/** API-20…28, CONTRATO.md. No author/owner restriction exists for templates. */
export type TemplateSummary = { id: string; name: string; currentVersion: number | null; uses: number; createdAt: string; canDelete: boolean };
export type VersionSummary = { id: string; number: number; status: "editing" | "current" | "frozen"; requiresEnvironment: boolean; uses: number; rowVersion: string };
export type TemplateDetail = TemplateSummary & { versions: VersionSummary[] };
export type Point = { id: string; position: number; title: string; detail: string | null };
export type VersionDetail = VersionSummary & { templateId: string; templateName: string; points: Point[] };
export type SaveVersion = { requiresEnvironment: boolean; points: { id?: string; title: string; detail: string | null }[]; rowVersion: string };
export type Environment = "testing" | "production" | "demo";
export type CurrentTemplate = { id: string; name: string; number: number; requiresEnvironment: boolean };
export type ChecklistSummary = { id: string; clientId: string; clientName: string; templateId: string; templateName: string; versionNumber: number; environment: Environment | null; status: "in_progress" | "completed"; ownerId: string; ownerName: string; progress: number; createdAt: string; completedAt: string | null; canEdit: boolean; canDelete: boolean };
export type RichDoc = import("@tiptap/core").JSONContent;
export type Evidence = { id: string; pointId: string; kind: "link" | "text" | "image" | "video" | "file"; status: "pending" | "saved"; url?: string; text?: string; fileName?: string; contentType?: string; sizeBytes?: number };
export type ChecklistPoint = Point & { checked: boolean; notes: RichDoc | null; evidence: Evidence[] };
export type ChecklistDetail = ChecklistSummary & { rowVersion: string; points: ChecklistPoint[]; canReopen: boolean };
export type ChecklistList = { items: ChecklistSummary[]; counts: { all: number; inProgress: number; completed: number }; total: number; page: number; pageSize: number; availableTemplates?: CurrentTemplate[] };
export type CreateChecklist = { clientId: string; templateId: string; environment?: Environment; confirmDuplicate?: boolean };
export type SaveChecklist = { points: { pointId: string; checked: boolean; notes: RichDoc | null }[]; evidence: { add: string[]; remove: string[] }; rowVersion: string };
