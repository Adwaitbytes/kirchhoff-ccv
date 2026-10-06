/**
 * PRD section 10 supply rule 10.SR1: a rebasing token (`unit: shares`) is compared in shares end
 * to end. The bridge events carry both the balance and the share amount; the adapters read the
 * shares field, matchAll and the Junction Rule compare shares, and the Loop Rule balances share
 * supplies against escrowed shares. Balances, which drift with every rebase, never enter.
 */
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { adaptersForSpec, createCcipV2Adapter, createEventAdapter, createWeakbridgeAdapter, type BridgeAdapter, type Log } from "../src/adapters/index.ts";
import { backtest, type HistoryEvent } from "../src/backtest.ts";
import { parseSpec } from "../src/spec/index.ts";
import { validateSpec } from "../src/spec/validate.ts";
import { EngineInputError, Reason, Status, type BridgeEvents, type ChainSel, type Credit, type Debit, type TokenSpec } from "../src/types.ts";
import { ALICE, ARB, ESCROW, HOME, MALLORY, WB_ARB, hash, makeSpec, units } from "./fixtures.ts";

const VAULT_EVENTS: BridgeEvents = {
  debitEvent: "Sent(bytes32 indexed id, address to, uint256 amount, uint256 shares, uint64 dstChain)",
  creditEvent: "Received(bytes32 indexed id, address to, uint256 amount, uint256 shares, uint64 srcChain)",
  debitFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "dstChain", shares: "shares" },
  creditFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "srcChain", shares: "shares" },
};
const sent = parseAbiItem(`event ${VAULT_EVENTS.debitEvent}`);
const received = parseAbiItem(`event ${VAULT_EVENTS.creditEvent}`);
const FIELDS = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }] as const;

/** One-remote kETH variant whose only bridge is a shares-aware custom vault bridge. */
function sharesSpec(): TokenSpec {
  const base = makeSpec();
  const arb = base.remotes[0];
  if (arb === undefined) throw new Error("fixture");
  return {
    ...base,
    unit: "shares",
    remotes: [{ ...arb, minters: ["vault_arb"] }],
    confidence: { default: "finalized", overrides: {} },
    bridges: [
      { id: "vault", kind: "custom", contracts: { home: ESCROW, arb: WB_ARB }, events: VAULT_EVENTS, searchWindowBlocks: 100n, maxDeliverySeconds: 1200 },
    ],
  };
}

type Move = { id: Hex; to: Hex; balance: bigint; shares: bigint; remote: ChainSel; block: bigint };

function sentLog(emitter: Hex, m: Move): Log {
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: [sent], eventName: "Sent", args: { id: m.id } }) as Hex[],
    data: encodeAbiParameters(FIELDS, [m.to, m.balance, m.shares, m.remote]),
    transactionHash: hash(`sent:${m.id}`),
    blockNumber: m.block,
  };
}

function receivedLog(emitter: Hex, m: Move): Log {
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: [received], eventName: "Received", args: { id: m.id } }) as Hex[],
    data: encodeAbiParameters(FIELDS, [m.to, m.balance, m.shares, m.remote]),
    transactionHash: hash(`received:${m.id}`),
    blockNumber: m.block,
  };
}

function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined || items.length !== 1) throw new Error(`expected one item, got ${items.length.toString()}`);
  return item;
}

const adapter = (spec: TokenSpec): BridgeAdapter => only(adaptersForSpec(spec));
const debitOf = (spec: TokenSpec, log: Log, chain: ChainSel): Debit => only(adapter(spec).decodeTxDebits([log], chain));
const creditOf = (spec: TokenSpec, log: Log, chain: ChainSel): Credit => only(adapter(spec).decodeTxCredits([log], chain));

const pins = (block: bigint, timestamp: bigint) =>
  new Map([
    [HOME, { head: block, headTimestamp: timestamp }],
    [ARB, { head: block, headTimestamp: timestamp }],
  ]);

/** One W2 epoch: escrowed shares on home against the remote's total shares. */
function epoch(epochId: bigint, escrowShares: bigint, arbShares: bigint): HistoryEvent {
  return {
    kind: "epoch",
    epoch: {
      timestamp: 10_000n + epochId,
      sources: pins(1_000n, 10_000n),
      snapshot: {
        model: "lock_release_home",
        epochId,
        pinned: [
          { chain: HOME, block: 1_000n },
          { chain: ARB, block: 1_000n },
        ],
        supplies: [
          { chain: HOME, supply: units(1_000n) },
          { chain: ARB, supply: arbShares },
        ],
        escrow: escrowShares,
      },
    },
  };
}

describe("unit shares (10.SR1)", () => {
  const spec = sharesSpec();
  const ID = hash("rebase-1");
  // 10 shares locked on home while one share is worth 1.1 tokens; delivered after a rebase to 1.2.
  const lock: Move = { id: ID, to: ALICE, balance: units(11n), shares: units(10n), remote: ARB, block: 100n };
  const mint: Move = { ...lock, balance: units(12n), remote: HOME, block: 200n };

  it("decodes the share amount from the bridge event, never the balance", () => {
    expect(debitOf(spec, sentLog(ESCROW, lock), HOME)).toMatchObject({ messageId: ID, amount: units(10n), dstChain: ARB, recipient: ALICE });
    expect(creditOf(spec, receivedLog(WB_ARB, mint), ARB)).toMatchObject({ messageId: ID, amount: units(10n), claimedSrcChain: HOME });
  });

  it("the same events in a tokens-unit spec decode the balance", () => {
    const tokens: TokenSpec = { ...spec, unit: "tokens" };
    expect(debitOf(tokens, sentLog(ESCROW, lock), HOME).amount).toBe(units(11n));
    expect(creditOf(tokens, receivedLog(WB_ARB, mint), ARB).amount).toBe(units(12n));
  });

  it("settles a valid sequence whose balances differ across a rebase and conserves share supply", () => {
    const d = debitOf(spec, sentLog(ESCROW, lock), HOME);
    const c = creditOf(spec, receivedLog(WB_ARB, mint), ARB);
    const r = backtest([{ kind: "debit", debit: d }, { kind: "credit", credit: c, timestamp: 5_000n }, epoch(1n, units(10n), units(10n))], spec);
    expect(r.breaches).toEqual([]);
    expect(r.epochs.map((e) => e.status)).toEqual([Status.CONSERVED]);
    expect(r.epochs[0]?.loop.delta).toBe(0n);
    expect(r.coverage.settled).toBe(1);
  });

  it("flags a credit that mints more shares than were locked, even when its balance matches the debit", () => {
    const d = debitOf(spec, sentLog(ESCROW, lock), HOME);
    const forged = creditOf(spec, receivedLog(WB_ARB, { ...mint, balance: units(11n), shares: units(11n) }), ARB);
    const r = backtest([{ kind: "debit", debit: d }, { kind: "credit", credit: forged, timestamp: 5_000n }, epoch(1n, units(10n), units(11n))], spec);
    expect(r.breaches).toEqual([
      expect.objectContaining({ rule: "junction", reason: Reason.AMOUNT_MISMATCH }),
      // The rejected credit leaves its debit in flight, so the 11 minted shares sit on top of 10 in F.
      expect.objectContaining({ rule: "loop", reason: Reason.LOOP_DEFICIT, delta: -units(11n) }),
    ]);
    expect(r.finalStatus).toBe(Status.BROKEN);
  });

  it("flags a share credit with no debit as DEBIT_NOT_FOUND and the minted shares as a loop deficit", () => {
    const forged = creditOf(spec, receivedLog(WB_ARB, { ...mint, id: hash("forged"), to: MALLORY }), ARB);
    const r = backtest([{ kind: "credit", credit: forged, timestamp: 5_000n }, epoch(1n, 0n, units(10n))], spec);
    expect(r.breaches.map((b) => [b.rule, b.reason])).toEqual([
      ["junction", Reason.DEBIT_NOT_FOUND],
      ["loop", Reason.LOOP_DEFICIT],
    ]);
  });

  it("counts a locked-not-minted share debit once in F", () => {
    const d = debitOf(spec, sentLog(ESCROW, lock), HOME);
    const r = backtest([{ kind: "debit", debit: d }, epoch(1n, units(10n), 0n)], spec);
    expect(r.epochs[0]?.loop).toMatchObject({ delta: 0n, claims: units(10n), status: Status.CONSERVED });
    expect(r.coverage.inFlight).toBe(1);
  });

  it("refuses a shares-unit bridge whose events name no shares field", () => {
    const { shares: _s, ...debitFields } = VAULT_EVENTS.debitFields;
    const { shares: _c, ...creditFields } = VAULT_EVENTS.creditFields;
    const make = (events: BridgeEvents) => () => createEventAdapter({ id: "vault", spec, bridgeId: "vault", events });
    expect(make({ ...VAULT_EVENTS, debitFields })).toThrow(/unit shares needs a shares field on the debit event/);
    expect(make({ ...VAULT_EVENTS, creditFields })).toThrow(/unit shares needs a shares field on the credit event/);
    expect(make({ ...VAULT_EVENTS, debitFields: { ...VAULT_EVENTS.debitFields, shares: "to" } })).toThrow(EngineInputError);
  });

  it("refuses CCIP and the frozen WeakBridge for a shares-unit token: their events carry balances", () => {
    const kETH = makeSpec();
    expect(() => createCcipV2Adapter({ ...kETH, unit: "shares" })).toThrow(/carry balances, not shares/);
    expect(() => createWeakbridgeAdapter({ ...kETH, unit: "shares" })).toThrow(/shares field on the debit event/);
  });

  it("validation reports both before activation", async () => {
    const v = await validateSpec({ ...makeSpec(), unit: "shares" });
    expect(v.errors).toEqual(
      expect.arrayContaining([
        "bridge ccip: CCIP 2.0.0 pool events carry balances, not shares, so unit shares cannot use ccip_v2",
        "bridge weakbridge: bridge weakbridge: unit shares needs a shares field on the debit event",
      ]),
    );
    expect((await validateSpec(spec)).errors).toEqual([]);
  });

  it("parses shares field maps from YAML and keeps them out of a tokens spec", () => {
    const yaml = (shares: string) => `
spec_version: 1
token: rETH
model: lock_release_home
unit: shares
home: { chain: ethereum-testnet-sepolia, canonical: "${ESCROW}", escrow: "${ESCROW}" }
remotes:
  - { chain: ethereum-testnet-sepolia-arbitrum-1, token: "${WB_ARB}", minters: [vault_arb] }
bridges:
  - id: vault
    kind: custom
    contracts: { home: "${ESCROW}", arb: "${WB_ARB}" }
    debit_event: "${VAULT_EVENTS.debitEvent}"
    credit_event: "${VAULT_EVENTS.creditEvent}"
    debit_fields: { message_id: id, amount: amount, recipient: to, remote_chain: dstChain${shares} }
    credit_fields: { message_id: id, amount: amount, recipient: to, remote_chain: srcChain${shares} }
confidence: { default: finalized }
rules:
  junction: { match_window_seconds: 1200 }
  loop: { tolerance_wei: "0", breach_confirmations: 1 }
  staleness_seconds: 120
  on_stale: fail_closed
response: { on_broken: [page_issuer], replay_requires: issuer_multisig, recovery_timelock_seconds: 3600 }
`;
    const withShares = parseSpec(yaml(", shares: shares"));
    if (!withShares.ok) throw new Error(withShares.errors.join("\n"));
    const bridge = withShares.spec.bridges[0];
    expect(bridge?.kind === "custom" && bridge.events.creditFields.shares).toBe("shares");
    const without = parseSpec(yaml(""));
    if (!without.ok) throw new Error(without.errors.join("\n"));
    const plain = without.spec.bridges[0];
    expect(plain?.kind === "custom" && "shares" in plain.events.debitFields).toBe(false);
  });
});
