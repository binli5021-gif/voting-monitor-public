create table if not exists public.voter_status (
  person_id text primary key,
  operator_id text not null,
  voted_at timestamptz not null default now()
);

create table if not exists public.operation_logs (
  id uuid primary key default gen_random_uuid(),
  person_id text not null,
  person_name text not null,
  action text not null check (action in ('vote', 'undo')),
  operator_id text not null,
  at timestamptz not null default now()
);

create or replace function public.change_vote(
  p_person_id text,
  p_person_name text,
  p_action text,
  p_operator_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_operator text;
begin
  if p_action = 'vote' then
    insert into public.voter_status(person_id, operator_id)
    values (p_person_id, p_operator_id)
    on conflict (person_id) do nothing;
    if not found then
      select operator_id into current_operator from public.voter_status where person_id = p_person_id;
      return jsonb_build_object('ok', false, 'operator_id', current_operator);
    end if;
    insert into public.operation_logs(person_id, person_name, action, operator_id)
    values (p_person_id, p_person_name, 'vote', p_operator_id);
    return jsonb_build_object('ok', true);
  elsif p_action = 'undo' then
    delete from public.voter_status where person_id = p_person_id;
    if not found then return jsonb_build_object('ok', false); end if;
    insert into public.operation_logs(person_id, person_name, action, operator_id)
    values (p_person_id, p_person_name, 'undo', p_operator_id);
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.change_vote(text, text, text, text) to anon, authenticated;
