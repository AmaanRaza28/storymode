create extension if not exists pgcrypto;

create type public.game_status as enum ('draft', 'published');
create type public.render_status as enum ('draft', 'queued', 'rendering', 'ready', 'failed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 2 and 40),
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  slug text unique not null,
  title text not null check (char_length(title) between 1 and 120),
  logline text not null default '',
  description text not null default '',
  genre text not null default '',
  status public.game_status not null default 'draft',
  start_node_id uuid,
  story_bible jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.story_nodes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  title text not null,
  eyebrow text not null default '',
  narrative text not null default '',
  video_prompt text not null default '',
  tone text not null default 'signal',
  duration_seconds integer not null default 5 check (duration_seconds between 5 and 15),
  render_status public.render_status not null default 'draft',
  start_image_url text,
  end_image_url text,
  video_url text,
  position_x real not null default 0,
  position_y real not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, game_id)
);

alter table public.games
  add constraint games_start_node_fk
  foreign key (start_node_id, id) references public.story_nodes(id, game_id) on delete set null (start_node_id);

create table public.story_choices (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  from_node_id uuid not null,
  to_node_id uuid not null,
  label text not null,
  hint text not null default '',
  conditions jsonb not null default '{}'::jsonb,
  state_effects jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (from_node_id, to_node_id),
  foreign key (from_node_id, game_id) references public.story_nodes(id, game_id) on delete cascade,
  foreign key (to_node_id, game_id) references public.story_nodes(id, game_id) on delete cascade
);

create table public.game_versions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  version integer not null check (version > 0),
  graph jsonb not null,
  created_by uuid not null references public.profiles(id) on delete cascade,
  published_at timestamptz not null default now(),
  unique (game_id, version)
);

create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  node_id uuid not null,
  requested_by uuid references public.profiles(id) on delete set null,
  provider text not null,
  model text not null,
  provider_request_id text unique,
  status public.render_status not null default 'queued',
  attempt integer not null default 1,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (node_id, game_id) references public.story_nodes(id, game_id) on delete cascade
);

create table public.webhook_events (
  provider_request_id text primary key,
  webhook_request_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.playthroughs (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid references public.profiles(id) on delete set null,
  current_node_id uuid,
  state jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (current_node_id, game_id) references public.story_nodes(id, game_id) on delete set null (current_node_id)
);

create table public.play_events (
  id bigint generated always as identity primary key,
  playthrough_id uuid not null references public.playthroughs(id) on delete cascade,
  node_id uuid references public.story_nodes(id) on delete set null,
  choice_id uuid references public.story_choices(id) on delete set null,
  event_type text not null,
  created_at timestamptz not null default now()
);

create schema if not exists private;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    'storyteller-' || left(new.id::text, 12),
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

create function public.create_story_game(p_title text, p_logline text, p_slug text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_id uuid := (select auth.uid());
  new_game_id uuid;
  opening_node_id uuid;
begin
  if owner_id is null then raise exception 'Authentication required'; end if;

  insert into public.profiles (id, username)
  values (owner_id, 'storyteller-' || left(owner_id::text, 12))
  on conflict (id) do nothing;

  insert into public.games (creator_id, slug, title, logline, description)
  values (owner_id, p_slug, p_title, p_logline, p_logline)
  returning id into new_game_id;

  insert into public.story_nodes (
    game_id, title, eyebrow, narrative, video_prompt, position_x, position_y
  ) values (
    new_game_id,
    'Opening scene',
    'Chapter 01',
    p_logline,
    'Describe the establishing shot, action, camera, lighting, dialogue, and sound.',
    80,
    180
  ) returning id into opening_node_id;

  update public.games set start_node_id = opening_node_id where id = new_game_id;
  return new_game_id;
end;
$$;

create function public.save_story_game(
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
    duration_seconds, render_status, video_url, position_x, position_y
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
    coalesce((node #>> '{position,y}')::real, 0)
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
    updated_at = now()
  where public.story_nodes.game_id = p_game_id;

  delete from public.story_choices where game_id = p_game_id;
  delete from public.story_nodes
  where game_id = p_game_id
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

revoke all on function public.create_story_game(text, text, text) from public, anon;
revoke all on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.create_story_game(text, text, text) to authenticated;
grant execute on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) to authenticated;

create index story_nodes_game_id_idx on public.story_nodes(game_id);
create index games_creator_id_idx on public.games(creator_id);
create index story_choices_game_id_idx on public.story_choices(game_id);
create index story_choices_from_node_idx on public.story_choices(from_node_id);
create index story_choices_to_node_game_idx on public.story_choices(to_node_id, game_id);
create index render_jobs_node_id_idx on public.render_jobs(node_id);
create index render_jobs_game_id_idx on public.render_jobs(game_id);
create index render_jobs_requested_by_idx on public.render_jobs(requested_by);
create index game_versions_game_id_idx on public.game_versions(game_id, version desc);
create index game_versions_created_by_idx on public.game_versions(created_by);
create index playthroughs_game_id_idx on public.playthroughs(game_id);
create index playthroughs_player_id_idx on public.playthroughs(player_id);
create index playthroughs_current_node_idx on public.playthroughs(current_node_id);
create index play_events_playthrough_idx on public.play_events(playthrough_id, created_at);
create index play_events_node_id_idx on public.play_events(node_id);
create index play_events_choice_id_idx on public.play_events(choice_id);

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.story_nodes enable row level security;
alter table public.story_choices enable row level security;
alter table public.render_jobs enable row level security;
alter table public.game_versions enable row level security;
alter table public.webhook_events enable row level security;
alter table public.playthroughs enable row level security;
alter table public.play_events enable row level security;

create policy "profiles are publicly readable" on public.profiles for select to anon, authenticated using (true);
create policy "users update their profile" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "users create their profile" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "published games and owned drafts are readable" on public.games
  for select to anon, authenticated using (status = 'published' or creator_id = (select auth.uid()));
create policy "creators insert games" on public.games
  for insert to authenticated with check (creator_id = (select auth.uid()));
create policy "creators update games" on public.games
  for update to authenticated using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy "creators delete games" on public.games
  for delete to authenticated using (creator_id = (select auth.uid()));

create policy "nodes follow game visibility" on public.story_nodes
  for select to anon, authenticated using (exists (
    select 1 from public.games
    where games.id = story_nodes.game_id
      and (games.status = 'published' or games.creator_id = (select auth.uid()))
  ));
create policy "creators manage nodes" on public.story_nodes
  for all to authenticated using (exists (
    select 1 from public.games where games.id = story_nodes.game_id and games.creator_id = (select auth.uid())
  )) with check (exists (
    select 1 from public.games where games.id = story_nodes.game_id and games.creator_id = (select auth.uid())
  ));

create policy "choices follow game visibility" on public.story_choices
  for select to anon, authenticated using (exists (
    select 1 from public.games
    where games.id = story_choices.game_id
      and (games.status = 'published' or games.creator_id = (select auth.uid()))
  ));
create policy "creators manage choices" on public.story_choices
  for all to authenticated using (exists (
    select 1 from public.games where games.id = story_choices.game_id and games.creator_id = (select auth.uid())
  )) with check (exists (
    select 1 from public.games where games.id = story_choices.game_id and games.creator_id = (select auth.uid())
  ));

create policy "requesters read render jobs" on public.render_jobs
  for select to authenticated using (requested_by = (select auth.uid()));

create policy "published versions and owned versions are readable" on public.game_versions
  for select to anon, authenticated using (exists (
    select 1 from public.games
    where games.id = game_versions.game_id
      and (games.status = 'published' or games.creator_id = (select auth.uid()))
  ));
create policy "creators create versions" on public.game_versions
  for insert to authenticated with check (exists (
    select 1 from public.games where games.id = game_versions.game_id and games.creator_id = (select auth.uid())
  ));

create policy "players read their playthroughs" on public.playthroughs
  for select to authenticated using (player_id = (select auth.uid()));
create policy "players create playthroughs" on public.playthroughs
  for insert to anon, authenticated with check (player_id is null or player_id = (select auth.uid()));
create policy "players update their playthroughs" on public.playthroughs
  for update to authenticated using (player_id = (select auth.uid())) with check (player_id = (select auth.uid()));

create policy "players read their events" on public.play_events
  for select to authenticated using (exists (
    select 1 from public.playthroughs
    where playthroughs.id = play_events.playthrough_id and playthroughs.player_id = (select auth.uid())
  ));
create policy "players create their events" on public.play_events
  for insert to anon, authenticated with check (exists (
    select 1 from public.playthroughs
    where playthroughs.id = play_events.playthrough_id
      and (playthroughs.player_id is null or playthroughs.player_id = (select auth.uid()))
  ));

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.games, public.story_nodes, public.story_choices, public.game_versions to anon, authenticated;
grant insert, update, delete on public.games, public.story_nodes, public.story_choices to authenticated;
grant insert on public.game_versions to authenticated;
grant insert, update on public.profiles to authenticated;
grant select on public.render_jobs to authenticated;
grant select, insert, update on public.playthroughs to anon, authenticated;
grant select, insert on public.play_events to anon, authenticated;
grant usage, select on sequence public.play_events_id_seq to anon, authenticated;
