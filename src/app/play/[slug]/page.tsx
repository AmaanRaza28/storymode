import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StoryPlayer } from "@/components/player/story-player";
import { getStoryGameBySlug } from "@/lib/story/repository";

export const metadata: Metadata = { title: "Play The Last Signal" };

export default async function PlayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const game = await getStoryGameBySlug(slug);
  if (!game) notFound();
  return <StoryPlayer game={game} />;
}
