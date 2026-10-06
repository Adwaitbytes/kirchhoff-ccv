import type { Queryable } from "./db.ts";
import { formatUnits } from "./notifier.ts";

/**
 * Holder status alerts (PRD section 3, nice-to-have 2). A holder subscribes a Telegram chat to a token;
 * every home-ledger StatusChanged after the subscription became active is sent to it exactly once.
 * The idempotency key is (subscription, transition) in `token_subscription_deliveries`, claimed
 * before sending like the incident Notifier, so restarts and concurrent servers never double-send.
 */

export type SubscriptionChannel = "telegram";

export type SubscriptionRow = {
  id: string;
  token: string;
  channel: SubscriptionChannel;
  chatId: string;
  createdAt: Date;
  active: boolean;
  lastNotifiedStatus: string | null;
};

export type StatusTransition = {
  subscriptionId: string;
  chatId: string;
  token: string;
  /** chain:tx_hash:log_index of the home-chain StatusChanged event. */
  transition: string;
  from: string;
  to: string;
  reason: string;
  /** Signed Δ at the transition (the epoch in the same tx, else the token's current Δ), base units. */
  delta: string;
  decimals: number;
  simulation: boolean;
  at: Date;
};

/** A delivery the channel refused for good (chat gone, bot blocked): the subscription is deactivated. */
export class DeliveryRejected extends Error {
  override readonly name = "DeliveryRejected";
}

export type DeliverFn = (chatId: string, text: string, signal: AbortSignal) => Promise<void>;

const MAX_ATTEMPTS = 5;

type Row = { id: string; token: string; channel: SubscriptionChannel; chat_id: string; created_at: Date; active: boolean; last_notified_status: string | null };

const toRow = (r: Row): SubscriptionRow => ({ id: r.id, token: r.token, channel: r.channel, chatId: r.chat_id, createdAt: r.created_at, active: r.active, lastNotifiedStatus: r.last_notified_status });

/** The public status page for a token. */
export function statusPageUrl(base: string | null, token: string): string | null {
  return base ? `${base.replace(/\/+$/, "")}/t/${encodeURIComponent(token)}` : null;
}

/** Deterministic alert text. House style: no em dashes; demo tokens are labeled as a simulation. */
export function transitionText(t: StatusTransition, statusPage: string | null): string {
  const lines = [
    `KIRCHHOFF: ${t.token} is now ${t.to} (was ${t.from}). Reason: ${t.reason}.`,
    `Delta: ${formatUnits(t.delta, t.decimals)} ${t.token}.`,
  ];
  if (statusPage) lines.push(`Status page: ${statusPage}`);
  if (t.simulation) lines.push("Testnet simulation.");
  lines.push(`Send /unsubscribe ${t.token} to stop these alerts.`);
  return lines.join("\n");
}

export class HolderSubscriptions {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  /** Idempotent. Reactivating an inactive subscription restarts its alert window at now. */
  async subscribe(token: string, channel: SubscriptionChannel, chatId: string): Promise<SubscriptionRow> {
    const r = await this.db.query<Row>(
      `insert into token_subscriptions (token, channel, chat_id) values ($1, $2, $3)
       on conflict (token, channel, chat_id) do update
         set active = true, active_since = case when token_subscriptions.active then token_subscriptions.active_since else now() end
       returning id::text, token, channel, chat_id, created_at, active, last_notified_status`,
      [token, channel, chatId],
    );
    const row = r.rows[0];
    if (!row) throw new Error("subscription upsert returned no row");
    return toRow(row);
  }

  /** Returns the deactivated subscription, or null when there was no active one. */
  async unsubscribe(token: string, channel: SubscriptionChannel, chatId: string): Promise<SubscriptionRow | null> {
    const r = await this.db.query<Row>(
      `update token_subscriptions set active = false where token = $1 and channel = $2 and chat_id = $3 and active
       returning id::text, token, channel, chat_id, created_at, active, last_notified_status`,
      [token, channel, chatId],
    );
    const row = r.rows[0];
    return row ? toRow(row) : null;
  }

  /** Home-ledger transitions an active subscriber has not been sent yet (and is not out of retries). */
  async pending(sinceHours = 24, limit = 500): Promise<StatusTransition[]> {
    const r = await this.db.query<{
      subscription_id: string;
      chat_id: string;
      token: string;
      transition: string;
      from_status: string;
      to_status: string;
      reason: string;
      delta: string;
      decimals: number;
      simulation: boolean;
      block_time: Date;
    }>(
      `select s.id::text as subscription_id, s.chat_id, s.token, sc.chain || ':' || sc.tx_hash || ':' || sc.log_index as transition,
              sc.from_status, sc.to_status, sc.reason, coalesce(e.delta, t.delta)::text as delta, t.decimals, t.simulation, sc.block_time
       from token_subscriptions s
       join tokens t on t.symbol = s.token
       join status_changes sc on sc.token_symbol = s.token and sc.chain = t.home_chain
       left join lateral (select delta from epochs e where e.chain = sc.chain and e.tx_hash = sc.tx_hash and e.token_symbol = sc.token_symbol
                          order by e.log_index desc limit 1) e on true
       where s.active and s.channel = 'telegram'
         and sc.block_time >= s.active_since
         and sc.block_time > now() - make_interval(hours => $1)
         and not exists (select 1 from token_subscription_deliveries d
                         where d.subscription_id = s.id and d.transition = sc.chain || ':' || sc.tx_hash || ':' || sc.log_index
                           and (d.status = 'sent' or d.attempts >= $2))
       order by sc.block, sc.log_index, s.id
       limit $3`,
      [sinceHours, MAX_ATTEMPTS, limit],
    );
    return r.rows.map((x) => ({
      subscriptionId: x.subscription_id,
      chatId: x.chat_id,
      token: x.token,
      transition: x.transition,
      from: x.from_status,
      to: x.to_status,
      reason: x.reason,
      delta: x.delta,
      decimals: x.decimals,
      simulation: x.simulation,
      at: x.block_time,
    }));
  }

  /** Sends one transition to one subscriber at most once. Returns true when this call sent it. */
  async deliver(t: StatusTransition, text: string, send: DeliverFn, timeoutMs = 5_000): Promise<boolean> {
    // Claim the (subscription, transition) slot; only a fresh claim, a failed attempt or a stale claim may send.
    const claim = await this.db.query(
      `insert into token_subscription_deliveries (subscription_id, transition, status, attempts, claimed_at) values ($1, $2, 'sending', 1, now())
       on conflict (subscription_id, transition) do update set status = 'sending', attempts = token_subscription_deliveries.attempts + 1, claimed_at = now()
         where token_subscription_deliveries.attempts < $3
           and (token_subscription_deliveries.status = 'failed'
                or (token_subscription_deliveries.status = 'sending' and token_subscription_deliveries.claimed_at < now() - interval '2 minutes'))
       returning attempts`,
      [t.subscriptionId, t.transition, MAX_ATTEMPTS],
    );
    if (claim.rowCount === 0) return false;
    try {
      await send(t.chatId, text, AbortSignal.timeout(timeoutMs));
    } catch (e) {
      // Errors carry only the channel and status; the request URL embeds the bot token.
      const message = e instanceof Error ? e.message.slice(0, 200) : "send failed";
      await this.db.query("update token_subscription_deliveries set status = 'failed', last_error = $3 where subscription_id = $1 and transition = $2", [t.subscriptionId, t.transition, message]);
      if (e instanceof DeliveryRejected) await this.db.query("update token_subscriptions set active = false where id = $1", [t.subscriptionId]);
      console.error(`kirchhoff subscriptions: ${message} for subscription ${t.subscriptionId}`);
      return false;
    }
    await this.db.query("update token_subscription_deliveries set status = 'sent', sent_at = now(), last_error = null where subscription_id = $1 and transition = $2", [t.subscriptionId, t.transition]);
    await this.db.query("update token_subscriptions set last_notified_status = $2 where id = $1", [t.subscriptionId, t.to]);
    return true;
  }
}
