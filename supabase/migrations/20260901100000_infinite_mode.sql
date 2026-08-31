-- Infinite mode: stories that keep going past their authored endings.
--
-- When a player reaches a scene with nowhere left to go, the server invents the next
-- choices and mints the scene behind whichever one the player takes. Two properties
-- shape everything below.
--
-- Generated content is *canonical*, not per-playthrough: the first player down a branch
-- pays for it and everyone after replays it. A generated scene therefore lives in
-- story_nodes like any other, and the graph grows as it is played.
--
-- Generated content is *not authored* content. The studio must never see it, publishing
-- must never freeze it into a version snapshot, and an autosave must never delete it.
-- That is what the origin discriminator below is for.

create type public.content_origin as enum ('authored', 'generated');

alter table public.story_nodes
  add column origin public.content_origin not null default 'authored';

-- Only scenes the author wrote are loaded into the studio and the player's opening
-- graph, so this index carries every read of the authored story.
create index story_nodes_game_origin_idx on public.story_nodes(game_id, origin);

alter table public.games
  add column infinite_mode boolean not null default false;

/*
 * A branch the story is willing to offer, which may not have been walked yet.
 *
 * This is deliberately not a story_choices row. A choice in that table must point at a
 * destination scene, and minting a destination costs a video generation — so offering
 * three choices would mean paying for three clips the player will mostly never watch.
 * Here to_node_id stays null until someone actually takes the branch.
 */
create table public.generated_choices (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  from_node_id uuid not null,
  to_node_id uuid,
  label text not null check (char_length(label) between 1 and 160),
  hint text not null default '',
  -- Two players who reach the same scene are offered the same branches, so the dedupe
  -- key is the label as written, normalised. Generated rather than trigger-maintained
  -- so the unique index below cannot be worked around.
  label_key text generated always as (lower(btrim(label))) stored,
  created_at timestamptz not null default now(),
  unique (from_node_id, label_key),
  foreign key (from_node_id, game_id) references public.story_nodes(id, game_id) on delete cascade,
  foreign key (to_node_id, game_id) references public.story_nodes(id, game_id) on delete set null (to_node_id)
);

create index generated_choices_from_node_idx on public.generated_choices(from_node_id);
create index generated_choices_game_id_idx on public.generated_choices(game_id);
-- Marks a render as infinite mode's rather than the studio's. The spend limits count
-- only these: an author who just rendered a dozen takes in the studio must not find
-- themselves locked out of playing their own story.
alter table public.render_jobs
  add column for_infinite boolean not null default false;

-- Supports the per-player spend window checked before any generation is submitted.
create index render_jobs_infinite_spend_idx
  on public.render_jobs(requested_by, created_at desc)
  where for_infinite;

alter table public.generated_choices enable row level security;

-- Readable by anyone who can read the story; written only by the server routes under
-- the service role, which bypasses RLS. There is deliberately no insert policy: a
-- player must not be able to mint branches directly, because minting spends money.
create policy "generated choices follow game visibility" on public.generated_choices
  for select to anon, authenticated using (exists (
    select 1 from public.games
    where games.id = generated_choices.game_id
      and (games.status = 'published' or games.creator_id = (select auth.uid()))
  ));

-- A creator may prune what infinite mode grew on their own story.
create policy "creators delete generated choices" on public.generated_choices
  for delete to authenticated using (exists (
    select 1 from public.games
    where games.id = generated_choices.game_id and games.creator_id = (select auth.uid())
  ));

grant select on public.generated_choices to anon, authenticated;
grant delete on public.generated_choices to authenticated;

/*
 * save_story_game, taught to leave generated scenes alone.
 *
 * Unchanged from the previous revision except for the two origin guards. Without them
 * the studio's autosave — which sends only the authored graph — reads every generated
 * scene as a scene the author deleted, and drops the entire infinite branch on the next
 * keystroke pause.
 */
create or replace function public.save_story_game(
  p_game_id uuid,
  p_title text,
  p_logline text,
  p_description text,
  p_genre text,
  p_story_bible text,
  p_status public.game_status,
  p_start_node_id uuid,
  p_nodes jsonb,
  p_choices jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  previous_status public.game_status;
  next_version integer;
begin
  if owner_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_array_length(p_nodes) = 0 then
    raise exception 'A story needs at least one scene';
  end if;
  if jsonb_typeof(p_choices) <> 'array' then raise exception 'Invalid choices'; end if;

  select status into previous_status
  from public.games
  where id = p_game_id and creator_id = owner_id
  for update;
  if not found then raise exception 'Story not found'; end if;

  update public.games
  set title = left(p_title, 120),
      logline = p_logline,
      description = p_description,
      genre = p_genre,
      story_bible = jsonb_build_object('text', p_story_bible),
      start_node_id = null,
      updated_at = now()
  where id = p_game_id;

  insert into public.story_nodes (
    id, game_id, title, eyebrow, narrative, video_prompt, tone,
    duration_seconds, render_status, video_url, position_x, position_y,
    start_image_source, end_image_source, start_image_url, end_image_url,
    start_image_from_node_id
  )
  select
    (node ->> 'id')::uuid,
    p_game_id,
    node ->> 'title',
    coalesce(node ->> 'eyebrow', ''),
    coalesce(node ->> 'narrative', ''),
    coalesce(node ->> 'videoPrompt', ''),
    coalesce(node ->> 'tone', 'signal'),
    coalesce((node ->> 'durationSeconds')::integer, 5),
    coalesce((node ->> 'renderStatus')::public.render_status, 'draft'),
    nullif(node ->> 'videoUrl', ''),
    coalesce((node #>> '{position,x}')::real, 0),
    coalesce((node #>> '{position,y}')::real, 0),
    coalesce((node ->> 'startImageSource')::public.frame_source, 'none'),
    coalesce((node ->> 'endImageSource')::public.frame_source, 'none'),
    nullif(node ->> 'startImageUrl', ''),
    nullif(node ->> 'endImageUrl', ''),
    nullif(node ->> 'startImageFromNodeId', '')::uuid
  from jsonb_array_elements(p_nodes) as node
  on conflict (id) do update set
    title = excluded.title,
    eyebrow = excluded.eyebrow,
    narrative = excluded.narrative,
    video_prompt = excluded.video_prompt,
    tone = excluded.tone,
    duration_seconds = excluded.duration_seconds,
    render_status = excluded.render_status,
    video_url = excluded.video_url,
    position_x = excluded.position_x,
    position_y = excluded.position_y,
    start_image_source = excluded.start_image_source,
    end_image_source = excluded.end_image_source,
    start_image_url = excluded.start_image_url,
    end_image_url = excluded.end_image_url,
    start_image_from_node_id = excluded.start_image_from_node_id,
    updated_at = now()
  where public.story_nodes.game_id = p_game_id
    and public.story_nodes.origin = 'authored';

  delete from public.story_choices where game_id = p_game_id;
  delete from public.story_nodes
  where game_id = p_game_id
    and origin = 'authored'
    and id not in (
      select (node ->> 'id')::uuid from jsonb_array_elements(p_nodes) as node
    );

  insert into public.story_choices (
    id, game_id, from_node_id, to_node_id, label, hint, conditions, state_effects
  )
  select
    (choice ->> 'id')::uuid,
    p_game_id,
    (choice ->> 'fromNodeId')::uuid,
    (choice ->> 'toNodeId')::uuid,
    choice ->> 'label',
    coalesce(choice ->> 'hint', ''),
    coalesce(choice -> 'conditions', '{}'::jsonb),
    coalesce(choice -> 'stateEffects', '{}'::jsonb)
  from jsonb_array_elements(p_choices) as choice;

  update public.games
  set start_node_id = p_start_node_id,
      status = p_status,
      published_at = case
        when p_status = 'published' and previous_status = 'draft' then now()
        when p_status = 'draft' then null
        else published_at
      end,
      updated_at = now()
  where id = p_game_id;

  -- p_nodes/p_choices carry only the authored graph, so a version snapshot stays a
  -- record of what the author published rather than of what players have grown since.
  if p_status = 'published' and previous_status = 'draft' then
    select coalesce(max(version), 0) + 1 into next_version
    from public.game_versions where game_id = p_game_id;
    insert into public.game_versions (game_id, version, graph, created_by)
    values (
      p_game_id,
      next_version,
      jsonb_build_object('nodes', p_nodes, 'choices', p_choices, 'startNodeId', p_start_node_id),
      owner_id
    );
  end if;
end;
$$;

revoke all on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) to authenticated;

/*
 * Claim a branch for minting, exactly once.
 *
 * Two players can take the same never-walked branch at the same moment. Both would
 * happily pay fal for a scene, and one of the two clips would then be unreachable. This
 * makes the *reservation* the thing that is raced over rather than the spend: the winner
 * gets its own node id back and generates, the loser is handed the winner's node id and
 * waits for that render instead.
 *
 * security definer because the caller is a server route acting for a player, and players
 * have no write access to this table by design.
 */
create or replace function public.reserve_generated_branch(
  p_choice_id uuid,
  p_node_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  winning_node uuid;
begin
  update public.generated_choices
  set to_node_id = p_node_id
  where id = p_choice_id and to_node_id is null;

  select to_node_id into winning_node
  from public.generated_choices
  where id = p_choice_id;

  return winning_node;
end;
$$;

revoke all on function public.reserve_generated_branch(uuid, uuid) from public, anon, authenticated;
-- Only the server routes reserve branches, and they act as the service role. Without an
-- explicit grant the revoke above would strip the privilege it inherits from PUBLIC.
grant execute on function public.reserve_generated_branch(uuid, uuid) to service_role;
