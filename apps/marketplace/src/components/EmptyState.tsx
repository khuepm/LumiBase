import { PackageSearch } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  description?: string;
}

export default function EmptyState({
  title = "No extensions found",
  description = "Adjust your search or filters and try again.",
}: EmptyStateProps) {
  return (
    <div className="surface-card animate-fade-in flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-3 text-txt-faint ring-glass">
        <PackageSearch className="h-8 w-8" />
      </div>
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p className="mt-2 max-w-sm text-sm font-medium text-txt-faint">
        {description}
      </p>
    </div>
  );
}
