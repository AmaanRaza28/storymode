import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeftIcon, ClapperboardIcon } from "lucide-react";
import { AuthForm } from "@/components/auth/auth-form";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col gap-5">
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back to Storymode
        </Link>
        <Card>
          <CardHeader>
            <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ClapperboardIcon aria-hidden="true" />
            </span>
            <CardTitle>Your studio is waiting</CardTitle>
            <CardDescription>Sign in to create stories and keep every branch synced.</CardDescription>
          </CardHeader>
          <CardContent>
            <AuthForm next={query.next} confirmationError={query.error === "confirmation"} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
