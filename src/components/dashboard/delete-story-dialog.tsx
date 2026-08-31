"use client";

import { useActionState, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { deleteStoryAction, type StoryActionState } from "@/app/story-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

interface DeleteStoryDialogProps {
  gameId: string;
  title: string;
}

const initialState: StoryActionState = { status: "idle" };

export function DeleteStoryDialog({ gameId, title }: DeleteStoryDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(deleteStoryAction, initialState);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" aria-label={`Delete ${title}`} />}
      >
        <Trash2Icon data-icon="inline-start" />
        Delete
      </DialogTrigger>
      <DialogContent>
        <form action={action}>
          <input type="hidden" name="gameId" value={gameId} />
          <DialogHeader>
            <DialogTitle>Delete “{title}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the story, its scenes, branches, renders, and play history.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {state.status === "error" && state.message && (
            <p className="mt-4 text-sm text-destructive" role="alert">{state.message}</p>
          )}
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              {pending ? "Deleting" : "Delete story"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
