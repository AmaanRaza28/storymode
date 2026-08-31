-- save_story_game learns the author-set frame fields.
--
-- last_frame_url and last_frame_source_video_url are deliberately absent: they are
-- derived from a finished render and written by the frames route under the service
-- role. Listing them here would let an autosave carrying a stale client copy overwrite
-- a frame that was just extracted.

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

revoke all on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_story_game(uuid, text, text, text, text, text, public.game_status, uuid, jsonb, jsonb) to authenticated;
