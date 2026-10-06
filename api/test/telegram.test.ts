import { describe, expect, it } from "vitest";
import { DeliveryRejected, statusPageUrl, transitionText, type StatusTransition } from "@kirchhoff/indexer/subscriptions";
import { ApiFailure } from "../src/errors.ts";
import { TelegramBot, parseCommand, secretMatches } from "../src/telegram.ts";
import { telegramChatId } from "../src/validate.ts";

const transition: StatusTransition = {
  subscriptionId: "1",
  chatId: "42",
  token: "kETH",
  transition: "ethereum-testnet-sepolia:0xabc:3",
  from: "CONSERVED",
  to: "BROKEN",
  reason: "DEBIT_NOT_FOUND",
  delta: (-(4n * 10n ** 18n)).toString(),
  decimals: 18,
  simulation: true,
  at: new Date(),
};

describe("telegram command parsing", () => {
  it("parses commands with and without the bot suffix and argument", () => {
    expect(parseCommand("/subscribe kETH")).toEqual({ name: "subscribe", token: "kETH" });
    expect(parseCommand("  /UNSUBSCRIBE@KirchhoffBot kETH  ")).toEqual({ name: "unsubscribe", token: "kETH" });
    expect(parseCommand("/status")).toEqual({ name: "status", token: null });
    expect(parseCommand("/start")).toEqual({ name: "help" });
    expect(parseCommand("/subscribe kETH extra words")).toEqual({ name: "help" });
    expect(parseCommand("hello there")).toBeNull();
  });
});

describe("chat id validation", () => {
  it("accepts numeric ids and @channel handles only", () => {
    for (const ok of ["123456789", "-1001234567890", "@kirchhoff_alerts"]) expect(telegramChatId(ok)).toBe(ok);
    for (const bad of ["", "0", "012", "12.5", "@abc", "@1channel", "kirchhoff", "1".repeat(21), 123, null, "@chan nel"]) {
      expect(() => telegramChatId(bad)).toThrow(ApiFailure);
    }
  });
});

describe("alert text", () => {
  it("carries status, previous status, delta and the status page link, with no em dashes", () => {
    const text = transitionText(transition, statusPageUrl("https://kirchhoff.test/", "kETH"));
    expect(text).toContain("kETH is now BROKEN (was CONSERVED)");
    expect(text).toContain("Delta: -4 kETH.");
    expect(text).toContain("Status page: https://kirchhoff.test/t/kETH");
    expect(text).toContain("Testnet simulation.");
    expect(text).not.toMatch(/—|–/);
  });
});

describe("TelegramBot", () => {
  const botWith = (status: number, calls: string[] = []): TelegramBot =>
    new TelegramBot("123:SECRET", {
      fetch: ((url: string | URL) => {
        calls.push(String(url));
        return Promise.resolve(new Response("{}", { status }));
      }) as typeof fetch,
    });

  it("posts to the Bot API sendMessage and maps refusals without leaking the token", async () => {
    const calls: string[] = [];
    await botWith(200, calls).sendMessage("42", "hi", AbortSignal.timeout(1_000));
    expect(calls).toEqual(["https://api.telegram.org/bot123:SECRET/sendMessage"]);
    const rejected = await botWith(403).sendMessage("42", "hi", AbortSignal.timeout(1_000)).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(DeliveryRejected);
    const transient = await botWith(502).sendMessage("42", "hi", AbortSignal.timeout(1_000)).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(DeliveryRejected);
    expect(String(transient)).not.toContain("SECRET");
  });

  it("compares webhook secrets exactly", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretMatches("s3cret-valuX", "s3cret-value")).toBe(false);
    expect(secretMatches(undefined, "s3cret-value")).toBe(false);
  });
});
