create schema if not exists private;

create or replace function private.handle_new_user()
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
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

create or replace function public.create_story_game(p_title text, p_logline text, p_slug text)
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

create index if not exists games_creator_id_idx on public.games(creator_id);
create index if not exists story_choices_to_node_game_idx on public.story_choices(to_node_id, game_id);
create index if not exists render_jobs_game_id_idx on public.render_jobs(game_id);
create index if not exists render_jobs_requested_by_idx on public.render_jobs(requested_by);
create index if not exists game_versions_created_by_idx on public.game_versions(created_by);
create index if not exists playthroughs_game_id_idx on public.playthroughs(game_id);
create index if not exists playthroughs_player_id_idx on public.playthroughs(player_id);
create index if not exists playthroughs_current_node_idx on public.playthroughs(current_node_id);
create index if not exists play_events_node_id_idx on public.play_events(node_id);
create index if not exists play_events_choice_id_idx on public.play_events(choice_id);

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.games, public.story_nodes, public.story_choices, public.game_versions to anon, authenticated;
grant insert, update, delete on public.games, public.story_nodes, public.story_choices to authenticated;
grant insert on public.game_versions to authenticated;
grant insert, update on public.profiles to authenticated;
grant select on public.render_jobs to authenticated;
grant select, insert, update on public.playthroughs to anon, authenticated;
grant select, insert on public.play_events to anon, authenticated;
grant usage, select on sequence public.play_events_id_seq to anon, authenticated;
