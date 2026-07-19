-- STOP! — durable data layer (Supabase / Postgres)
-- The game server writes with the SERVICE ROLE key (server-side only).
-- Clients get read access via RLS below; clients can NEVER write scores.

create extension if not exists "uuid-ossp";

-- ============ core persistence (wired to server/persist.ts today) ============
create table if not exists matches (
  id uuid primary key default uuid_generate_v4(),
  room_code text not null,
  language text not null check (language in ('en','fr','ar')),
  ruleset jsonb not null,
  rounds jsonb not null default '[]',      -- [{letter, nonce, commitHash, stoppedBy}]
  standings jsonb not null default '[]',   -- [{pid, name, score, placement}]
  ended_at timestamptz not null default now()
);
create index if not exists matches_ended_idx on matches (ended_at desc);

-- ============ accounts & social (Phase 2 — schema ready, wire when adding auth) ============
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text unique not null check (char_length(handle) between 3 and 20),
  display_name text not null,
  country text,
  locale text default 'en',
  created_at timestamptz default now()
);

create table if not exists ratings (
  user_id uuid references profiles on delete cascade,
  mode text not null default 'ranked',
  mu double precision not null default 25.0,       -- OpenSkill defaults
  sigma double precision not null default 8.333,
  rating double precision generated always as (mu - 3 * sigma) stored,
  updated_at timestamptz default now(),
  primary key (user_id, mode)
);

create table if not exists friendships (
  user_id uuid references profiles on delete cascade,
  friend_id uuid references profiles on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create table if not exists validation_cache (
  lang text not null,
  category_key text not null,
  normalized text not null,
  verdict text not null check (verdict in ('valid','invalid')),
  updated_at timestamptz default now(),
  primary key (lang, category_key, normalized)
);

create table if not exists reports (
  id uuid primary key default uuid_generate_v4(),
  reporter text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  created_at timestamptz default now()
);

-- ============ RLS: default-deny; server (service role) bypasses ============
alter table matches enable row level security;
alter table profiles enable row level security;
alter table ratings enable row level security;
alter table friendships enable row level security;
alter table validation_cache enable row level security;
alter table reports enable row level security;

create policy "matches are publicly readable"
  on matches for select using (true);

create policy "profiles readable by all"
  on profiles for select using (true);
create policy "own profile write"
  on profiles for update using (auth.uid() = id);
create policy "own profile insert"
  on profiles for insert with check (auth.uid() = id);

create policy "ratings readable by all"
  on ratings for select using (true);
-- no client write policy on ratings: only the game server updates MMR

create policy "friendships visible to both sides"
  on friendships for select using (auth.uid() in (user_id, friend_id));
create policy "request friendship"
  on friendships for insert with check (auth.uid() = user_id);
create policy "respond to friendship"
  on friendships for update using (auth.uid() in (user_id, friend_id));

create policy "reports insert by anyone signed in"
  on reports for insert with check (auth.uid() is not null);
