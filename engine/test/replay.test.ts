/**
 * Spec lifecycle step 3 on real history (3.S1, 6.LC3): replayHistory walks the event history in
 * block order, judging every credit and closing a Loop epoch at each boundary, with supplies and
 * escrow rebuilt from the transfers, and reports every BROKEN with the block it was found at.
 */
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { replayHistory, type ReplayChain, type ReplayEvent, type ReplayInput } from "../src/backtest.ts";
import { EngineInputError, Reason, Status, type ChainSel, type Credit, type Debit, type TokenSpec } from "../src/types.ts";
import { ALICE, ARB, BASE, ESCROW, HOME, MALLORY, addr, creditFor, debit, hash, makeSpec, units } from "./fixtures.ts";

const ZERO: Hex = `0x${"0".repeat(40)}`;
const ISSUER = addr(0x15);

type At = { chain: ChainSel; block: bigint; timestamp: bigint; tx: string };
const at = (chain: ChainSel, block: bigint, timestamp: bigint, tx: string): At => ({ chain, block, timestamp, tx });
const loc = (a: At, logIndex: number) => ({ chain: a.chain, block: a.block, timestamp: a.timestamp, txHash: hash(a.tx), logIndex });

const transfer = (a: At, from: Hex, to: Hex, amount: bigint, logIndex = 0): ReplayEvent => ({ ...loc(a, logIndex), kind: "transfer", from, to, amount });
const debitAt = (a: At, d: Debit, logIndex = 1): ReplayEvent => ({ ...loc(a, logIndex), kind: "debit", debit: { ...d, block: a.block, txHash: hash(a.tx) } });
const creditAt = (a: At, c: Credit, logIndex = 1): ReplayEvent => ({ ...loc(a, logIndex), kind: "credit", credit: { ...c, block: a.block, txHash: hash(a.tx) } });

/** A home lock of `amount` for `id` toward `dst`, and the matching remote mint. */
function bridged(id: string, amount: bigint, lockAt: At, mintAt: At): ReplayEvent[] {
  const d = debit({ messageId: hash(id), srcChain: HOME, dstChain: mintAt.chain, amount, recipient: ALICE });
  return [
    transfer(lockAt, ALICE, ESCROW, amount),
    debitAt(lockAt, d),
    transfer(mintAt, ZERO, ALICE, amount),
    creditAt(mintAt, creditFor({ ...d, block: lockAt.block, txHash: hash(lockAt.tx) })),
  ];
}

function windows(supplies: { home?: bigint; arb?: bigint; base?: bigint } = {}, fromBlock = 1n): ReplayChain[] {
  return [
    { chain: HOME, fromBlock, head: 100n, headTimestamp: 1_000n, supplyAtHead: supplies.home ?? units(1_000n) },
    { chain: ARB, fromBlock, head: 300n, headTimestamp: 1_001n, supplyAtHead: supplies.arb ?? 0n },
    { chain: BASE, fromBlock, head: 300n, headTimestamp: 999n, supplyAtHead: supplies.base ?? 0n },
  ];
}

function input(events: ReplayEvent[], over: Partial<ReplayInput> & { arb?: bigint; escrow?: bigint } = {}): ReplayInput {
  const { arb, escrow, ...rest } = over;
  return {
    chains: windows({ arb: arb ?? 0n }),
    escrowAtHead: [{ holder: ESCROW, balance: escrow ?? 0n }],
    reserve: null,
    events,
    schedule: { kind: "supply_change" },
    ...rest,
  };
}

describe("replayHistory", () => {
  const spec = makeSpec();

  it("conserves a valid history epoch by epoch, ending at the heads", () => {
    const events = bridged("m1", units(5n), at(HOME, 10n, 10n, "lock1"), at(ARB, 20n, 20n, "mint1"));
    const r = replayHistory(input(events, { arb: units(5n), escrow: units(5n) }), spec);
    expect(r.breaches).toEqual([]);
    expect(r.epochs.map((e) => [e.loop.delta, e.status])).toEqual([
      [0n, Status.CONSERVED],
      [0n, Status.CONSERVED],
      [0n, Status.CONSERVED],
    ]);
    expect(r.coverage).toMatchObject({ debits: 1, credits: 1, settled: 1, pending: 0, epochs: 3 });
    expect(r.eventsReplayed).toBe(4);
  });

  it("reports a mid-history forgery at its block, then the loop recovers while the token stays BROKEN", () => {
    const forged = creditFor(debit({ messageId: hash("forged"), srcChain: HOME, dstChain: ARB, amount: units(7n), recipient: MALLORY }));
    const forgery = at(ARB, 30n, 30n, "forge");
    const donation = at(HOME, 40n, 40n, "donate");
    const events = [
      ...bridged("m1", units(5n), at(HOME, 10n, 10n, "lock1"), at(ARB, 20n, 20n, "mint1")),
      transfer(forgery, ZERO, MALLORY, units(7n)),
      creditAt(forgery, forged),
      // Recovery: the issuer tops the escrow up by the forged amount.
      transfer(donation, ISSUER, ESCROW, units(7n)),
    ];
    const r = replayHistory(input(events, { arb: units(12n), escrow: units(12n) }), spec);
    expect(r.breaches).toEqual([
      expect.objectContaining({ rule: "loop", reason: Reason.LOOP_DEFICIT, delta: -units(7n), at: { chain: ARB, block: 30n, timestamp: 30n, txHash: hash("forge"), final: false } }),
      // The source is final past the forged credit's time once the replay walks home to block 40.
      expect.objectContaining({ rule: "junction", reason: Reason.DEBIT_NOT_FOUND, credit: expect.objectContaining({ block: 30n }) as unknown, at: expect.objectContaining({ chain: HOME, block: 40n }) as unknown }),
    ]);
    expect(r.drift).toEqual([expect.objectContaining({ reason: Reason.PENDING_ATTESTATION, at: expect.objectContaining({ block: 30n }) as unknown })]);
    expect(r.epochs.map((e) => [e.loop.status, e.status])).toEqual([
      [Status.CONSERVED, Status.CONSERVED],
      [Status.CONSERVED, Status.CONSERVED],
      [Status.BROKEN, Status.BROKEN],
      [Status.CONSERVED, Status.BROKEN],
      [Status.CONSERVED, Status.BROKEN],
    ]);
    expect(r.finalStatus).toBe(Status.BROKEN);
  });

  it("catches a forgery the head alone cannot see: burned back before the head", () => {
    const forged = creditFor(debit({ messageId: hash("forged"), srcChain: HOME, dstChain: ARB, amount: units(3n), recipient: MALLORY }));
    const forgery = at(ARB, 30n, 30n, "forge");
    const events = [transfer(forgery, ZERO, MALLORY, units(3n)), creditAt(forgery, forged), transfer(at(ARB, 50n, 50n, "burn"), MALLORY, ZERO, units(3n))];
    const r = replayHistory(input(events), spec);
    // The head-only epoch sees no deficit; the forged credit itself is judged at the final epoch.
    expect(r.breaches.map((b) => [b.rule, b.reason, b.at.block, b.at.final])).toEqual([
      ["loop", Reason.LOOP_DEFICIT, 30n, false],
      ["junction", Reason.DEBIT_NOT_FOUND, 100n, true],
    ]);
    expect(r.epochs.at(-1)?.loop.delta).toBe(0n);
  });

  it("orders same-second blocks debits first, then by spec chain and block, whatever the input order", () => {
    const d = debit({ messageId: hash("tie"), srcChain: HOME, dstChain: ARB, amount: units(2n), recipient: ALICE });
    const lock = at(HOME, 60n, 60n, "lock");
    const mint = at(ARB, 61n, 60n, "mint");
    const events = [
      transfer(mint, ZERO, ALICE, units(2n)),
      creditAt(mint, creditFor({ ...d, block: 60n, txHash: hash("lock") })),
      transfer(at(ARB, 62n, 60n, "move"), ALICE, MALLORY, 1n),
      transfer(at(BASE, 7n, 60n, "base"), ALICE, MALLORY, 1n),
      transfer(lock, ALICE, ESCROW, units(2n)),
      debitAt(lock, d, 3),
    ];
    const r = replayHistory(input(events, { arb: units(2n), escrow: units(2n) }), spec);
    expect(r.breaches).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.coverage.settled).toBe(1);
  });

  it("settles a remote burn released from the home escrow, ignoring plain transfers", () => {
    const out = bridged("m1", units(5n), at(HOME, 10n, 10n, "lock1"), at(ARB, 20n, 20n, "mint1"));
    const d = debit({ messageId: hash("back"), srcChain: ARB, dstChain: HOME, amount: units(2n), recipient: ALICE });
    const burn = at(ARB, 30n, 30n, "burn");
    const release = at(HOME, 40n, 40n, "release");
    const events = [
      ...out,
      transfer(burn, ALICE, ZERO, units(2n)),
      debitAt(burn, d),
      transfer(release, ESCROW, ALICE, units(2n)),
      creditAt(release, creditFor({ ...d, block: 30n, txHash: hash("burn") })),
      transfer(at(HOME, 45n, 45n, "pay"), ALICE, MALLORY, units(1n)),
    ];
    const r = replayHistory(input(events, { arb: units(3n), escrow: units(3n) }), spec);
    expect(r.breaches).toEqual([]);
    expect(r.coverage.settled).toBe(2);
    // The plain home transfer moves no supply or escrow, so it closes no epoch of its own.
    expect(r.epochs.map((e) => e.loop.backing)).toEqual([units(5n), units(5n), units(5n), units(3n), units(3n)]);
  });

  it("closes epochs every N blocks per chain when asked", () => {
    const events = bridged("m1", units(5n), at(HOME, 10n, 10n, "lock1"), at(ARB, 20n, 20n, "mint1"));
    events.push(transfer(at(ARB, 25n, 25n, "same-window"), ALICE, MALLORY, 1n));
    const r = replayHistory(input(events, { arb: units(5n), escrow: units(5n), schedule: { kind: "every_blocks", blocks: 16n } }), spec);
    // home 10 (window 0), arb 20 crosses into window 1 and closes it, arb 25 stays in window 1, then the heads.
    expect(r.epochs).toHaveLength(2);
    expect(r.breaches).toEqual([]);
  });

  it("rebuilds the opening state from the head reading when the window starts after deployment", () => {
    const events = bridged("m2", units(1n), at(HOME, 210n, 210n, "lock2"), at(ARB, 220n, 220n, "mint2"));
    const chains = windows({ arb: units(9n) }, 200n).map((c) => (c.chain === HOME ? { ...c, head: 250n } : c));
    const r = replayHistory(input(events, { chains, escrowAtHead: [{ holder: ESCROW, balance: units(9n) }] }), spec);
    expect(r.breaches).toEqual([]);
    expect(r.epochs.map((e) => e.loop.backing)).toEqual([units(9n), units(9n), units(9n)]);
  });

  it("counts issuer mints on home as I_net for burn-and-mint and flags an unbacked remote mint", () => {
    const bm: TokenSpec = makeSpec({ model: "burn_mint_multi" });
    const issue = at(HOME, 5n, 5n, "issue");
    const remote = at(ARB, 8n, 8n, "unbacked");
    const events = [transfer(issue, ZERO, ISSUER, units(10n)), transfer(remote, ZERO, MALLORY, units(1n))];
    const chains = windows({ home: units(10n), arb: units(1n) });
    const r = replayHistory(input(events, { chains, escrowAtHead: [] }), bm);
    expect(r.epochs.map((e) => [e.loop.backing, e.loop.status])).toEqual([
      [units(10n), Status.CONSERVED],
      [units(10n), Status.BROKEN],
      [units(10n), Status.BROKEN],
    ]);
  });

  it("keeps bridge mints on home out of I_net", () => {
    const bm: TokenSpec = makeSpec({ model: "burn_mint_multi" });
    const d = debit({ messageId: hash("back"), srcChain: ARB, dstChain: HOME, amount: units(1n), recipient: ALICE });
    const burn = at(ARB, 8n, 8n, "burn");
    const mint = at(HOME, 9n, 9n, "mint");
    const events = [
      transfer(burn, ALICE, ZERO, units(1n)),
      debitAt(burn, d),
      transfer(mint, ZERO, ALICE, units(1n)),
      creditAt(mint, creditFor({ ...d, block: 8n, txHash: hash("burn") })),
    ];
    const r = replayHistory(input(events, { chains: windows({ home: units(1n), arb: 0n }), escrowAtHead: [] }), bm);
    expect(r.breaches).toEqual([]);
    expect(r.epochs.map((e) => e.loop.backing)).toEqual([units(1n), units(1n), units(1n)]);
  });

  it.each([
    ["a chain without a window", input([], { chains: windows().slice(0, 2) }), /no window for chain ethereum-testnet-sepolia-base-1/],
    ["an event past the head", input([transfer(at(HOME, 101n, 1n, "x"), ALICE, ESCROW, 1n)]), /outside the replay window/],
    ["an event before the window", input([transfer(at(HOME, 0n, 1n, "x"), ALICE, ESCROW, 1n)]), /outside the replay window/],
    ["an event on an unknown chain", input([transfer(at(7n, 1n, 1n, "x"), ALICE, ESCROW, 1n)]), /outside the replay window/],
    ["a debit filed under another chain", input([debitAt(at(ARB, 1n, 1n, "x"), debit({ messageId: hash("d") }))]), /debit at block 1 belongs to another chain/],
    ["a credit filed under another chain", input([creditAt(at(HOME, 1n, 1n, "x"), creditFor(debit({ messageId: hash("c") })))]), /credit at block 1 belongs/],
    ["one block with two timestamps", input([transfer(at(HOME, 1n, 1n, "x"), ALICE, ESCROW, 1n), transfer(at(HOME, 1n, 2n, "y"), ALICE, ESCROW, 1n)]), /two timestamps/],
    ["a zero epoch width", input([], { schedule: { kind: "every_blocks", blocks: 0n } }), /positive block count/],
    ["a history missing a supply event", input([transfer(at(ARB, 5n, 5n, "x"), ZERO, ALICE, 1n)]), /history is incomplete/],
    ["a history missing an escrow event", input([transfer(at(HOME, 5n, 5n, "x"), ALICE, ESCROW, 1n)]), /history is incomplete/],
  ])("refuses %s", (_label, bad, pattern) => {
    expect(() => replayHistory(bad, spec)).toThrow(EngineInputError);
    expect(() => replayHistory(bad, spec)).toThrow(pattern);
  });
});
