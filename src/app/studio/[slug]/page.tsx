import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { StoryStudio } from "@/components/studio/story-studio";
import { getStoryGameBySlug } from "@/lib/story/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Studio" };

export default async function StudioPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login");
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?next=${encodeURIComponent(`/studio/${slug}`)}`);

  const game = await getStoryGameBySlug(slug);
  if (!game) notFound();
  return <StoryStudio initialGame={game} />;
}
