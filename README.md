# Storymode

Storymode is an MVP for creating and playing branching cinematic stories. Creators build a graph of scenes, direct each generated shot, and publish a version that an audience can play through.

Billing is intentionally not part of this milestone.

## Included

- Email/password authentication with cookie-based Supabase SSR sessions
- Authenticated dashboard backed by Supabase
- Transactional story creation and graph saving through Postgres functions
- React Flow scene editor with connectable branches
- Editable story copy and MiniMax H3 Max prompts
- Public playback for published stories and owner previews for drafts
- Authenticated, server-only fal.ai queue submission
- Signed fal webhook verification, early-event reconciliation, and idempotent completion handling
- Immutable graph snapshots whenever a draft is published
- Row Level Security and explicit Data API grants

There is no local story fixture or browser persistence. Supabase is the source of truth.

## Configure Supabase

1. Create a Supabase project.
2. Run [`supabase/migrations/0001_storymode.sql`](supabase/migrations/0001_storymode.sql) in the SQL editor or through your migration workflow.
3. Confirm that the `public` schema is exposed under **Project Settings → Data API**. New Supabase projects may require explicit Data API exposure in addition to the grants included in the migration.
4. Add `http://localhost:3000/auth/callback` as an allowed Auth redirect URL for local development.
5. Copy `.env.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

The service-role key is used only by render-job and webhook server routes. It must never be exposed through a `NEXT_PUBLIC_` variable.

## Configure fal.ai

Add the server-side credential:

```bash
FAL_KEY=
```

Render submission uses these endpoints:

- `minimax/h3-max/text-to-video`
- `minimax/h3-max/image-to-video`

fal completion events are received at `POST /api/webhooks/fal`. The route verifies the Ed25519 signature and timestamp before writing to the database.

For local webhook testing, `NEXT_PUBLIC_APP_URL` must be a public tunnel URL. `FAL_WEBHOOK_SKIP_VERIFY=true` is available only outside production.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, confirm the email if confirmation is enabled, and create the first story.

## Architecture notes

- Supabase RLS is the final authorization boundary. Server Actions also revalidate the user before every mutation.
- Graph saves run in one Postgres transaction through `save_story_game`, preventing partially updated graphs.
- Publishing inserts an immutable `game_versions` snapshot.
- fal output URLs are stored on completion. Before a public launch, copy completed media to a storage bucket you control with a background worker.
- Story state is deterministic application data. The video model renders scenes; it does not decide canonical story outcomes.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm build
```
