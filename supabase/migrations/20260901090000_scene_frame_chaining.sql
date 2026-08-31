-- Frame chaining: a scene can open on a still and land on one, so consecutive shots
-- share a real image instead of being re-rolled from text alone.
--
-- Two ideas that look alike are kept apart on purpose:
--   * start_image_url / end_image_url are INPUTS the author chose for generation.
--   * last_frame_url is an OUTPUT, extracted from the video this scene actually
--     produced, and is what a following scene inherits.
-- Collapsing them would make "land the shot here" and "where the shot ended" the same
-- column, and re-rendering a scene would silently rewrite its own direction.

create type public.frame_source as enum ('none', 'upload', 'inherit');

alter table public.story_nodes
  -- 'inherit' is only meaningful for the start frame: a scene continues from the shot
  -- before it, never from the one after.
  add column start_image_source public.frame_source not null default 'none',
  add column end_image_source public.frame_source not null default 'none',
  add column start_image_from_node_id uuid,
  add column last_frame_url text,
  -- Which video the cached frame came from. A scene re-rendered onto a new take leaves
  -- this pointing at the old url, which is how staleness is detected without a job id.
  add column last_frame_source_video_url text;

-- Separate statement so the column is unambiguously in place before it is constrained.
alter table public.story_nodes
  add constraint story_nodes_end_image_source_check
  check (end_image_source <> 'inherit');

-- Deferred: save_story_game writes the whole graph in one statement, so a scene may
-- reference a parent that is inserted later in the same insert.
alter table public.story_nodes
  add constraint story_nodes_start_image_from_node_fk
  foreign key (start_image_from_node_id, game_id)
  references public.story_nodes(id, game_id)
  on delete set null (start_image_from_node_id)
  deferrable initially deferred;

create index if not exists story_nodes_start_image_from_node_idx
  on public.story_nodes(start_image_from_node_id);

-- Frames are fetched by fal over plain https, so the bucket has to be world-readable.
-- Writes never happen from the browser: the upload route uses the service role after
-- checking ownership, and the policies below are defence in depth.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'scene-frames',
  'scene-frames',
  true,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Objects are keyed <game_id>/<node_id>/<slot>-<uuid>.<ext>, so the first path segment
-- is what ownership is checked against.
create policy "scene frames are publicly readable" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'scene-frames');

create policy "creators write their scene frames" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'scene-frames'
    and exists (
      select 1 from public.games
      where games.id::text = (storage.foldername(name))[1]
        and games.creator_id = (select auth.uid())
    )
  );

create policy "creators replace their scene frames" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'scene-frames'
    and exists (
      select 1 from public.games
      where games.id::text = (storage.foldername(name))[1]
        and games.creator_id = (select auth.uid())
    )
  );

create policy "creators delete their scene frames" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'scene-frames'
    and exists (
      select 1 from public.games
      where games.id::text = (storage.foldername(name))[1]
        and games.creator_id = (select auth.uid())
    )
  );
