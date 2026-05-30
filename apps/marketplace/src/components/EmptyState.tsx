import { PackageSearch } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  description?: string;
}

export default function EmptyState({
  title = "No extensions found",
  description = "Try adjusting your search or filters to find what you're looking for.",
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-surface-600 bg-surface-900/40 px-6 py-16 text-center animate-fade-in">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-700 text-gray-500">
        <PackageSearch className="h-8 w-8" />
      </div>
      <h3 className="mt-4 text-base font-semibold text-gray-200">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-gray-500">{description}</p>
    </div>
  );
}
