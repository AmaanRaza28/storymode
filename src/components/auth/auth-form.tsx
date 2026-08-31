"use client";

import { useActionState } from "react";
import { FilmIcon } from "lucide-react";
import {
  signInAction,
  signUpAction,
  type AuthActionState,
} from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function FieldErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return <FieldDescription className="text-destructive">{errors[0]}</FieldDescription>;
}

export function AuthForm({ next = "/", confirmationError = false }: { next?: string; confirmationError?: boolean }) {
  const initialAuthState: AuthActionState = { status: "idle" };
  const [signInState, signIn, signInPending] = useActionState(signInAction, initialAuthState);
  const [signUpState, signUp, signUpPending] = useActionState(signUpAction, initialAuthState);

  return (
    <Tabs defaultValue="signin">
      <TabsList className="w-full">
        <TabsTrigger value="signin">Sign in</TabsTrigger>
        <TabsTrigger value="signup">Create account</TabsTrigger>
      </TabsList>
      <TabsContent value="signin" className="pt-5">
        <form action={signIn} className="flex flex-col gap-5">
          <input type="hidden" name="next" value={next} />
          <FieldGroup>
            <Field data-invalid={Boolean(signInState.fieldErrors?.email)}>
              <FieldLabel htmlFor="signin-email">Email</FieldLabel>
              <Input id="signin-email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(signInState.fieldErrors?.email)} />
              <FieldErrors errors={signInState.fieldErrors?.email} />
            </Field>
            <Field data-invalid={Boolean(signInState.fieldErrors?.password)}>
              <FieldLabel htmlFor="signin-password">Password</FieldLabel>
              <Input id="signin-password" name="password" type="password" autoComplete="current-password" required aria-invalid={Boolean(signInState.fieldErrors?.password)} />
              <FieldErrors errors={signInState.fieldErrors?.password} />
            </Field>
          </FieldGroup>
          {(signInState.message || confirmationError) && (
            <p className="text-sm text-destructive" role="alert">
              {signInState.message ?? "That confirmation link is invalid or expired."}
            </p>
          )}
          <Button type="submit" disabled={signInPending}>
            {signInPending ? <Spinner data-icon="inline-start" /> : <FilmIcon data-icon="inline-start" />}
            {signInPending ? "Signing in" : "Enter the studio"}
          </Button>
        </form>
      </TabsContent>
      <TabsContent value="signup" className="pt-5">
        <form action={signUp} className="flex flex-col gap-5">
          <input type="hidden" name="next" value={next} />
          <FieldGroup>
            <Field data-invalid={Boolean(signUpState.fieldErrors?.displayName)}>
              <FieldLabel htmlFor="signup-name">Display name</FieldLabel>
              <Input id="signup-name" name="displayName" autoComplete="name" required aria-invalid={Boolean(signUpState.fieldErrors?.displayName)} />
              <FieldErrors errors={signUpState.fieldErrors?.displayName} />
            </Field>
            <Field data-invalid={Boolean(signUpState.fieldErrors?.email)}>
              <FieldLabel htmlFor="signup-email">Email</FieldLabel>
              <Input id="signup-email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(signUpState.fieldErrors?.email)} />
              <FieldErrors errors={signUpState.fieldErrors?.email} />
            </Field>
            <Field data-invalid={Boolean(signUpState.fieldErrors?.password)}>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <Input id="signup-password" name="password" type="password" autoComplete="new-password" minLength={8} required aria-invalid={Boolean(signUpState.fieldErrors?.password)} />
              <FieldDescription>At least 8 characters.</FieldDescription>
              <FieldErrors errors={signUpState.fieldErrors?.password} />
            </Field>
          </FieldGroup>
          {signUpState.message && (
            <p className={signUpState.status === "success" ? "text-sm text-muted-foreground" : "text-sm text-destructive"} role="status">
              {signUpState.message}
            </p>
          )}
          <Button type="submit" disabled={signUpPending}>
            {signUpPending && <Spinner data-icon="inline-start" />}
            {signUpPending ? "Creating account" : "Create account"}
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}
