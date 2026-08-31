import Link from "next/link";
import { ArrowRightIcon, FilmIcon, GitBranchIcon, PlayIcon, RadioTowerIcon, SparklesIcon } from "lucide-react";
import { CreateGameDialog } from "@/components/dashboard/create-game-dialog";
import { DeleteStoryDialog } from "@/components/dashboard/delete-story-dialog";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { listOwnedStories } from "@/lib/story/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const storyResult = data.user ? await listOwnedStories(data.user.id) : { stories: [] };
  const { stories } = storyResult;

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-4 py-10 sm:px-6 sm:py-16">
        <section className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="flex flex-col items-start gap-6">
            <Badge variant="secondary"><RadioTowerIcon data-icon="inline-start" />Branching stories, rendered scene by scene</Badge>
            <div className="flex max-w-2xl flex-col gap-4">
              <h1 className="text-5xl leading-[0.96] font-semibold tracking-[-0.055em] sm:text-7xl">Make stories people can step inside.</h1>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">Shape a branching narrative, direct every cinematic beat, and let your audience decide what happens next.</p>
            </div>
            {data.user ? <CreateGameDialog /> : (
              <Link href="/login" className={buttonVariants({ size: "lg" })}>
                <SparklesIcon data-icon="inline-start" />Start creating
              </Link>
            )}
          </div>
          <div className="relative min-h-[430px] overflow-hidden rounded-3xl border bg-primary shadow-2xl shadow-foreground/15 sm:min-h-[520px]">
            <div className="scene-backdrop scene-tone-signal" aria-hidden="true" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/5 to-black/20" aria-hidden="true" />
            <div className="relative flex min-h-[430px] flex-col justify-between p-7 text-white sm:min-h-[520px] sm:p-10">
              <Badge variant="secondary" className="self-start"><FilmIcon data-icon="inline-start" />Scene 04 · Decision point</Badge>
              <div className="flex max-w-xl flex-col gap-3">
                <p className="text-sm text-white/65">The audience chooses what happens next</p>
                <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">Every branch is already waiting.</h2>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <span className="rounded-xl border border-white/15 bg-black/25 p-4 text-sm backdrop-blur">Follow the signal</span>
                  <span className="rounded-xl border border-white/15 bg-black/25 p-4 text-sm backdrop-blur">Turn back before dawn</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {data.user && (
          <section className="flex flex-col gap-5" aria-labelledby="your-stories">
            <div className="flex items-end justify-between gap-4">
              <div><p className="text-sm font-medium text-muted-foreground">Synced with your account</p><h2 id="your-stories" className="text-2xl font-semibold tracking-tight">Your stories</h2></div>
              <CreateGameDialog />
            </div>
            {storyResult.error ? (
              <Card>
                <CardHeader>
                  <CardTitle>Stories unavailable</CardTitle>
                  <CardDescription>{storyResult.error}</CardDescription>
                </CardHeader>
              </Card>
            ) : stories.length ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {stories.map((story) => (
                  <Card key={story.id}>
                    <CardHeader>
                      <CardTitle>{story.title}</CardTitle><CardDescription>{story.logline}</CardDescription>
                      <CardAction><Badge variant="outline">{story.status}</Badge></CardAction>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1.5"><FilmIcon aria-hidden="true" />{story.sceneCount} scenes</span>
                        <span className="flex items-center gap-1.5"><GitBranchIcon aria-hidden="true" />Branching graph</span>
                      </div>
                    </CardContent>
                    <CardFooter className="justify-between">
                      <p className="text-xs text-muted-foreground">Updated {story.updatedAt}</p>
                      <div className="flex gap-2">
                        <DeleteStoryDialog gameId={story.id} title={story.title} />
                        {story.status === "published" && <Link href={`/play/${story.slug}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><PlayIcon data-icon="inline-start" />Play</Link>}
                        <Link href={`/studio/${story.slug}`} className={buttonVariants({ size: "sm" })}>Edit<ArrowRightIcon data-icon="inline-end" /></Link>
                      </div>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardHeader><CardTitle>Your first story starts here</CardTitle><CardDescription>Create a project and Storymode will prepare the opening scene in your private studio.</CardDescription></CardHeader>
                <CardFooter><CreateGameDialog /></CardFooter>
              </Card>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
