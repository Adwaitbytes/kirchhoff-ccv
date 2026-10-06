import { createHash, timingSafeEqual } from "node:crypto";
import { formatUnits } from "@kirchhoff/indexer/notifier";
import { DeliveryRejected, statusPageUrl, transitionText, type HolderSubscriptions } from "@kirchhoff/indexer/subscriptions";
import { TELEGRAM_CHAT_ID } from "./validate.ts";

/**
 * Telegram side of holder alerts (PRD section 3, nice-to-have 2): the Bot API client, the webhook
 * command handler (/subscribe, /unsubscribe, /status) and the status fanout that runs on the
 * long-running server. Everything is off when TELEGRAM_BOT_TOKEN is unset. The bot token is part of
 * every Bot API URL, so no URL, request or raw fetch error is ever logged or returned.
 */

export type TelegramConfig = {
  botToken?: string | undefined;
  /** Required for the webhook: X-Telegram-Bot-Api-Secret-Token header or the last path segment. */
  webhookSecret?: string | undefined;
  /** Tests inject a mock Bot API. */
  fetch?: typeof fetch;
  apiBase?: string;
};

class TelegramHttpError extends Error {
  override readonly name = "TelegramHttpError";
}

export class TelegramBot {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(botToken: string, opts: { fetch?: typeof fetch; apiBase?: string } = {}) {
    this.url = `${(opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${botToken}/sendMessage`;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Throws DeliveryRejected when Telegram refuses the chat for good (bot blocked, chat not found). */
  async sendMessage(chatId: string, text: string, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal,
      });
    } catch {
      throw new TelegramHttpError("telegram request failed");
    }
    if (res.ok) return;
    if (res.status === 403 || res.status === 400) throw new DeliveryRejected(`telegram HTTP ${res.status}`);
    throw new TelegramHttpError(`telegram HTTP ${res.status}`);
  }
}

/** Constant-time secret comparison over digests, so neither content nor length leaks. */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type BotCommand = { name: "subscribe" | "unsubscribe" | "status"; token: string | null } | { name: "help" };

/** Parses "/cmd[@bot] [token]". Returns null for anything that is not a command (plain chat). */
export function parseCommand(text: string): BotCommand | null {
  const m = /^\/([a-z]+)(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!m) return text.trim().startsWith("/") ? { name: "help" } : null;
  const name = (m[1] ?? "").toLowerCase();
  const arg = m[2] ?? null;
  if (name === "subscribe" || name === "unsubscribe" || name === "status") return { name, token: arg };
  return { name: "help" };
}

export type TokenLookup = (symbol: string) => Promise<{ symbol: string; status: string; reason: string; delta: string; decimals: number; epochId: string; stale: boolean; simulation: boolean } | null>;

export type WebhookContext = {
  subscriptions: HolderSubscriptions;
  token: TokenLookup;
  knownTokens: () => Promise<string[]>;
  webPublicUrl: string | null;
};

const HELP = [
  "KIRCHHOFF holder alerts. Commands:",
  "/subscribe <token> to get a message whenever the token's status changes",
  "/unsubscribe <token> to stop them",
  "/status <token> for the current status",
].join("\n");

/** One reply per command message. Returns null when the update needs no reply. */
export async function replyTo(update: unknown, ctx: WebhookContext): Promise<{ chatId: string; text: string } | null> {
  if (typeof update !== "object" || update === null) return null;
  const u = update as Record<string, unknown>;
  const msg = (u.message ?? u.channel_post) as Record<string, unknown> | undefined;
  if (typeof msg !== "object" || typeof msg.text !== "string") return null;
  const chat = msg.chat as Record<string, unknown> | undefined;
  if (typeof chat !== "object" || (typeof chat.id !== "number" && typeof chat.id !== "string")) return null;
  const chatId = String(chat.id);
  if (!TELEGRAM_CHAT_ID.test(chatId)) return null;
  const cmd = parseCommand(msg.text);
  if (!cmd) return null;
  if (cmd.name === "help") return { chatId, text: HELP };
  const known = await ctx.knownTokens();
  if (cmd.token === null) return { chatId, text: `Name a token, for example /${cmd.name} ${known[0] ?? "kETH"}.` };
  const t = /^[A-Za-z0-9]{1,16}$/.test(cmd.token) ? await ctx.token(cmd.token) : null;
  if (!t) return { chatId, text: `Unknown token. Protected tokens: ${known.join(", ") || "none"}.` };
  const page = statusPageUrl(ctx.webPublicUrl, t.symbol);
  switch (cmd.name) {
    case "subscribe":
      await ctx.subscriptions.subscribe(t.symbol, "telegram", chatId);
      return { chatId, text: `Subscribed to ${t.symbol}. You will get a message whenever its status changes. It is ${t.status} now.${page ? `\nStatus page: ${page}` : ""}` };
    case "unsubscribe": {
      const removed = await ctx.subscriptions.unsubscribe(t.symbol, "telegram", chatId);
      return { chatId, text: removed ? `Unsubscribed from ${t.symbol}.` : `This chat was not subscribed to ${t.symbol}.` };
    }
    case "status": {
      const lines = [
        `${t.symbol} is ${t.status} (reason ${t.reason}). Delta: ${formatUnits(t.delta, t.decimals)} ${t.symbol}. Epoch ${t.epochId}.`,
        ...(t.stale ? ["The mirror is stale; the onchain feed is the source of truth."] : []),
        ...(page ? [`Status page: ${page}`] : []),
        ...(t.simulation ? ["Testnet simulation."] : []),
      ];
      return { chatId, text: lines.join("\n") };
    }
  }
}

/** Sends every pending home-ledger status transition to each active subscriber, once. */
export class StatusFanout {
  private readonly subs: HolderSubscriptions;
  private readonly bot: TelegramBot;
  private readonly linkBase: string | null;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(subs: HolderSubscriptions, bot: TelegramBot, opts: { linkBase: string | null; intervalMs?: number }) {
    this.subs = subs;
    this.bot = bot;
    this.linkBase = opts.linkBase;
    this.intervalMs = opts.intervalMs ?? 5_000;
  }

  /** Returns the number of messages sent by this tick. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (const t of await this.subs.pending()) {
        const text = transitionText(t, statusPageUrl(this.linkBase, t.token));
        if (await this.subs.deliver(t, text, (chatId, body, signal) => this.bot.sendMessage(chatId, body, signal))) sent++;
      }
    } catch (e) {
      console.error("kirchhoff fanout: tick failed", e instanceof Error ? e.message : e);
    } finally {
      this.running = false;
    }
    return sent;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
