-- The demo shop. It is small on purpose: one user table, one coupon table, and
-- the redemptions that record who used what.
--
-- NOTE: `redemptions` deliberately has no unique constraint on
-- (user_id, coupon_id). That missing constraint is the bug this fixture exists
-- to demonstrate: the application checks for an existing redemption and then
-- inserts, and nothing at the storage layer stops two concurrent inserts from
-- both succeeding.

create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  percent_off integer not null check (percent_off between 1 and 100),
  created_at timestamptz not null default now()
);

create table redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  coupon_id uuid not null references coupons (id) on delete cascade,
  redeemed_at timestamptz not null default now()
);

create index redemptions_by_user on redemptions (user_id);
