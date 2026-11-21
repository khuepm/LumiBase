"use client";

import { usePathname } from "next/navigation";
import CosmicBackground from "@/components/CosmicBackground";

/**
 * The starfield behind every page except home, which draws its own storybook
 * scene. Kept in the root layout so /pricing, /license and the legal pages keep
 * their backdrop.
 */
export default function SiteBackground() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return <CosmicBackground />;
}
