import { redirect } from "next/navigation";
import { CATEGORIES } from "@/lib/api";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ cat: string }>;
}

export async function generateStaticParams() {
  return CATEGORIES.map((c) => ({ cat: c.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { cat } = await params;
  const category = CATEGORIES.find((c) => c.slug === cat);
  return {
    title: category ? `${category.label} Extensions` : "Extensions",
  };
}

export default async function CategoryPage({ params }: PageProps) {
  const { cat } = await params;
  redirect(`/extensions/?category=${cat}`);
}
