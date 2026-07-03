import Link from "next/link";

interface TagChipProps {
  children: React.ReactNode;
  active?: boolean;
  href?: string;
  onClick?: () => void;
  id?: string;
  className?: string;
}

const baseClasses =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold leading-none transition-colors";

/** Filter chip — solid surface chip; violet when active. Renders as Link, button, or span. */
export default function TagChip({
  children,
  active = false,
  href,
  onClick,
  id,
  className = "",
}: TagChipProps) {
  const stateClasses = active
    ? "bg-accent-violet text-white"
    : "bg-surface-3 text-txt-secondary ring-glass hover:text-white";
  const classes = `${baseClasses} ${stateClasses} ${className}`;

  if (href) {
    return (
      <Link href={href} id={id} className={classes}>
        {children}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" id={id} onClick={onClick} className={classes}>
        {children}
      </button>
    );
  }
  return (
    <span id={id} className={classes}>
      {children}
    </span>
  );
}
