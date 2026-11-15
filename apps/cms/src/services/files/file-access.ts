/**
 * Folder-scoped access to the files module (#701).
 *
 * The `/files` router used to be site-admin only. It now also admits members
 * whose policies grant the `files` collection, and the permission row's rule
 * is evaluated against each file — which is what makes folder scoping a plain
 * policy condition rather than a second ACL system:
 *
 *   { "folder_path": { "_starts_with": "/<folderId>/" } }   // a whole subtree
 *   { "folder": { "_in": ["<folderId>", null] } }           // one folder + root
 *   { "uploaded_by": { "_eq": "$CURRENT_USER" } }           // own uploads
 *
 * Site admins bypass the rule (same as everywhere else). A principal with no
 * `files::<action>` grant is refused exactly as before, so nothing changes for
 * a site that never writes a `files` permission.
 */
import type { PolicyRule } from '@lumibase/contracts';
import { evaluate, type MagicContext } from '../permission-dsl';
import { folderPath, type FolderRow } from './folder-tree';

export type FilesAction = 'read' | 'create' | 'update' | 'delete';

export interface FilesAccess {
  admin: boolean;
  /** Composed row rule for non-admins (`null` = unrestricted grant). */
  rule: PolicyRule | null;
  ctx: MagicContext;
}

export interface FileSubjectInput {
  folder: string | null;
  uploadedBy?: string | null;
  mime?: string;
  id?: string;
}

/**
 * The fields a `files` policy rule can test. Snake-case to match how rules
 * are written for every other collection.
 */
export function fileAccessSubject(
  file: FileSubjectInput,
  folders: readonly FolderRow[] | Map<string, FolderRow>,
): Record<string, unknown> {
  return {
    id: file.id ?? null,
    folder: file.folder ?? null,
    folder_path: folderPath(folders, file.folder ?? null),
    uploaded_by: file.uploadedBy ?? null,
    mime: file.mime ?? null,
  };
}

export function canActOnFile(
  access: FilesAccess,
  file: FileSubjectInput,
  folders: readonly FolderRow[] | Map<string, FolderRow>,
): boolean {
  if (access.admin) return true;
  return evaluate(access.rule, fileAccessSubject(file, folders), access.ctx);
}

/**
 * Whether a principal may place a file into `folder` (create / move target).
 * Evaluated as if the file already lived there, so a subtree rule confines
 * uploads and moves to that subtree too.
 */
export function canPlaceInFolder(
  access: FilesAccess,
  folder: string | null,
  folders: readonly FolderRow[] | Map<string, FolderRow>,
  uploadedBy: string | null,
): boolean {
  return canActOnFile(access, { folder, uploadedBy }, folders);
}
