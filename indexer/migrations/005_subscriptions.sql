-- Holder alerts (PRD section 3, nice-to-have 2): a holder subscribes a Telegram chat to a token's status.
-- Unsubscribing deactivates the row; active_since bounds which transitions a (re)subscribed chat is told about.
create table if not exists token_subscriptions (
  id                    bigint generated always as identity primary key,
  token                 text not null references tokens (symbol) on delete cascade,
  channel               text not null check (channel in ('telegram')),
  chat_id               text not null,
  created_at            timestamptz not null default now(),
  active                boolean not null default true,
  active_since          timestamptz not null default now(),
  last_notified_status  text,
  unique (token, channel, chat_id)
);
create index if not exists token_subscriptions_active on token_subscriptions (token) where active;

-- Fanout idempotency: one message per (subscription, status transition), ever. The transition key is
-- the home-chain StatusChanged event id (chain:tx_hash:log_index).
create table if not exists token_subscription_deliveries (
  subscription_id  bigint not null references token_subscriptions (id) on delete cascade,
  transition       text not null,
  status           text not null check (status in ('sending', 'sent', 'failed')),
  attempts         integer not null default 0,
  last_error       text,
  claimed_at       timestamptz not null default now(),
  sent_at          timestamptz,
  primary key (subscription_id, transition)
);
