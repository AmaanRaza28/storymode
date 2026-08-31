"use client";

import { useActionState, useState } from "react";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { createStoryAction, type StoryActionState } from "@/app/story-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function CreateGameDialog() {
  const initialStoryActionState: StoryActionState = { status: "idle" };
  const [state, action, pending] = useActionState(createStoryAction, initialStoryActionState);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("The Last Signal");
  const [idea, setIdea] = useState(
    "A radio operator receives a transmission from a city that vanished twenty years ago.",
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="lg" />}>
        <PlusIcon data-icon="inline-start" />
        Create a story
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form action={action} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Start with a story spark</DialogTitle>
            <DialogDescription>
              We will open the visual studio with a sample branching structure you can reshape.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="game-title">Title</FieldLabel>
              <Input
                id="game-title"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="game-idea">The premise</FieldLabel>
              <Textarea
                id="game-idea"
                name="idea"
                value={idea}
                onChange={(event) => setIdea(event.target.value)}
                rows={4}
              />
              <FieldDescription>
                Include the protagonist, the inciting moment, and the central tension.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {state.message && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
              {pending ? "Building draft" : "Build the first draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
