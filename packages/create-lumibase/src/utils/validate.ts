/**
 * Validate a project name — must be a valid npm package name (simplified).
 * Returns an error string, or undefined if valid.
 */
export function validateProjectName(name: string): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Project name cannot be empty.';
  }
  if (name.length > 214) {
    return 'Project name must be 214 characters or fewer.';
  }
  if (name !== name.toLowerCase()) {
    return 'Project name must be lowercase.';
  }
  if (/[^a-z0-9@._/-]/.test(name)) {
    return 'Project name may only contain lowercase letters, numbers, hyphens, underscores, dots, @ and /.';
  }
  if (/^[._]/.test(name)) {
    return 'Project name cannot start with a dot or underscore.';
  }
  return undefined;
}
