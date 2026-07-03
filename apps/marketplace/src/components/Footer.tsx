const LINKS = [
  { label: "Docs", href: "https://docs.lumibase.dev" },
  { label: "Twitter", href: "https://twitter.com/lumibase" },
  { label: "Discord", href: "https://discord.gg/lumibase" },
  { label: "GitHub", href: "https://github.com/khuepm/lumibase" },
];

export default function Footer() {
  return (
    <footer className="mx-auto mt-28 flex max-w-[1140px] items-center justify-between border-t border-hairline px-6 pb-14 pt-10 text-[13px] font-medium text-txt-muted">
      <span>© 2026 LumiBase, Inc.</span>
      <span className="flex gap-[18px]">
        {LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
          >
            {link.label}
          </a>
        ))}
      </span>
    </footer>
  );
}
