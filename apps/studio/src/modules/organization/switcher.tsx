import { useOrganization } from './use-organizations';

export function OrganizationSwitcher() {
  const { organizations, organization, selectOrganization } = useOrganization();
  if (organizations.length < 2 || !organization) return null;
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="sr-only">Organization</span>
      <select
        aria-label="Organization"
        value={organization.id}
        onChange={(e) => selectOrganization(e.target.value)}
        className="min-w-0 max-w-48 rounded border bg-background px-2 py-1.5 text-sm text-foreground"
      >
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  );
}
