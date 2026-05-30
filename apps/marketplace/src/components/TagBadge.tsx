import type { FC } from "react";

interface TagBadgeProps {
  label: string;
  variant?: "default" | "category" | "muted";
  size?: "sm" | "md";
}

const variantClasses = {
  default:
    "bg-brand-900/60 text-brand-300 border border-brand-700/40 hover:bg-brand-800/60",
  category:
    "bg-indigo-900/60 text-indigo-300 border border-indigo-700/40 hover:bg-indigo-800/60",
  muted:
    "bg-surface-700 text-gray-400 border border-surface-600 hover:bg-surface-600",
};

const sizeClasses = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-xs",
};

const TagBadge: FC<TagBadgeProps> = ({
  label,
  variant = "default",
  size = "sm",
}) => (
  <span
    className={`inline-flex items-center rounded-full font-medium transition-colors ${variantClasses[variant]} ${sizeClasses[size]}`}
  >
    {label}
  </span>
);

export default TagBadge;
