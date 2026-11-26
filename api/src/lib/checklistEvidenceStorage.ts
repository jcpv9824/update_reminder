import { prepareChecklistPrivateObject, storeChecklistPrivateObject, readChecklistPrivateObjectBuffer, deleteChecklistPrivateObject, type PrivateObjectLocator } from "./objectStorage";
export interface ChecklistEvidenceStorage {
  prepare(id: string, extension: string): PrivateObjectLocator;
  write(locator: PrivateObjectLocator, bytes: Buffer, sha256: string, contentType: string): Promise<void>;
  read(locator: PrivateObjectLocator, bytes: number, sha256: string): Promise<Buffer>;
  remove(locator: PrivateObjectLocator): Promise<boolean>;
}
export const checklistEvidenceStorage: ChecklistEvidenceStorage = { prepare: prepareChecklistPrivateObject, write: storeChecklistPrivateObject, read: readChecklistPrivateObjectBuffer, remove: deleteChecklistPrivateObject };
