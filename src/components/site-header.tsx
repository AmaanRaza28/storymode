import Link from "next/link";
import { ClapperboardIcon, LogOutIcon, SparklesIcon } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

interface SiteHeaderProps {
  compact?: boolean;
}

export async function SiteHeader({ compact = false }: SiteHeaderProps) {
  const supabase = await createSupabaseServerClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const user = data.user;
  const initials = user?.email?.slice(0, 2).toUpperCase() ?? "SM";
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-5">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ClapperboardIcon aria-hidden="true" />
            </span>
            <span>Storymode</span>
          </Link>
          {!compact && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              <SparklesIcon data-icon="inline-start" />
              Interactive cinema studio
            </Badge>
          )}
        </div>
        <nav className="flex items-center gap-2" aria-label="Primary navigation">
          {user ? (
            <>
              <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
              <Avatar size="sm"><AvatarFallback>{initials}</AvatarFallback></Avatar>
              <form action={signOutAction}>
                <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out">
                  <LogOutIcon />
                </Button>
              </form>
            </>
          ) : (
            <Link href="/login" className={cn(buttonVariants({ size: "sm" }))}>Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
