-- Run once in the Supabase SQL editor. No browser access to share metadata.
create table if not exists public.quickdrop_shares (
  id text primary key check (id ~ '^[0-9]{4}$'),
  request_id text not null unique,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.quickdrop_shares enable row level security;
revoke all on public.quickdrop_shares from anon, authenticated;
grant all on public.quickdrop_shares to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quickdrop-files', 'quickdrop-files', false, 5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Read-only aggregate; callable only by the server's service role.
create or replace function public.quickdrop_storage_stats()
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object('storedBytes', coalesce(sum((metadata->>'size')::bigint), 0))
  from storage.objects where bucket_id = 'quickdrop-files';
$$;
revoke all on function public.quickdrop_storage_stats() from public, anon, authenticated;
grant execute on function public.quickdrop_storage_stats() to service_role;
