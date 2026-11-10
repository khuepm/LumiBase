import { useOrganization } from './use-organizations';

export function OrganizationSwitcher() {
  const { organizations, organization, selectOrganization } = useOrganization();
  if (organizations.length < 2 || !organization) return null;
  return (
    <label className="order-3 flex w-full min-w-0 items-center gap-2 text-xs text-muted-foreground sm:order-none sm:w-auto">
      <span className="sr-only">Organization</span>
      <select
        aria-label="Organization"
        value={organization.id}
        onChange={(e) => selectOrganization(e.target.value)}
        className="w-full min-w-0 rounded border bg-background px-2 py-1.5 text-sm text-foreground sm:w-auto sm:max-w-48"
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
