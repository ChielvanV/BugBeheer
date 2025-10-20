-- Supabase table for bug storage (snake_case to match frontend queries)
-- Run in SQL editor in Supabase project
create table if not exists public.bugs (
  id uuid primary key,
  ticket text null,
  description text not null,
  jiraLink text null,
  impact int not null check (impact between 1 and 5),
  likelihood int not null check (likelihood between 1 and 5),
  label text null,
  completed_at bigint null,
  createdAt bigint not null,
  reference boolean not null default false
);

create index if not exists bugs_created_at_idx on public.bugs (created_at);

-- Migration helper if table already exists with camelCase:
-- alter table public.bugs rename column "jiraLink" to jira_link;
-- alter table public.bugs rename column "completedAt" to completed_at;
-- alter table public.bugs rename column "createdAt" to created_at;

-- RLS (optional)
-- alter table public.bugs enable row level security;
