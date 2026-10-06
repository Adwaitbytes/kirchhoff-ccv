/**
 * backtestYaml against an in-memory chain pair: the I/O shell fetches bridge logs and supply-moving
 * transfers, and the engine replays them epoch by epoch (3.S1, 6.LC3, 10.SR1).
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, pad, parseAbiItem, toEventSelector, type AbiEvent, type PublicClient } from "viem";
import { CHAINS, type ChainKey, type Hex } from "@kirchhoff/sdk";
import { backtestYaml, SpecInvalidError } from "../src/backtest.ts";

const HOME: ChainKey = "ethereum-testnet-sepolia";
const ARB: ChainKey = "ethereum-testnet-sepolia-arbitrum-1";
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const ZERO = a(0);
const CANONICAL = a(0x1001);
const ESCROW = a(0x1002);
const REMOTE = a(0x2001);
const BRIDGE_ARB = a(0x2003);
const ALICE = a(0xa11ce);
const MALLORY = a(0xbad);
const id = (n: number): Hex => pad(`0x${n.toString(16)}`, { size: 32 });

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TRANSFER_SHARES = parseAbiItem("event TransferShares(address indexed from, address indexed to, uint256 sharesValue)");
const BURNED = parseAbiItem("event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)");
const RELEASED = parseAbiItem("event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)");
const SENT = parseAbiItem("event Sent(bytes32 indexed id, address to, uint256 amount, uint256 shares, uint64 dstChain)");
const RECEIVED = parseAbiItem("event Received(bytes32 indexed id, address to, uint256 amount, uint256 shares, uint64 srcChain)");

type FakeLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };

/** One chain: logs, reads at head and block timestamps (1000 + block). */
class FakeChain {
  logs: FakeLog[] = [];
  reads = new Map<string, bigint>();
  readonly calls: string[] = [];
  readonly head: bigint;
  constructor(head: bigint) {
    this.head = head;
  }

  add(block: bigint, tx: string, address: Hex, event: AbiEvent, args: Record<string, unknown>, data: Hex): void {
    const topics = encodeEventTopics({ abi: [event], eventName: event.name, args }).filter((t): t is Hex => typeof t === "string");
    this.logs.push({ address, topics, data, blockNumber: block, transactionHash: pad(`0x${Buffer.from(tx).toString("hex")}`, { size: 32 }), logIndex: this.logs.length });
  }

  transfer(block: bigint, tx: string, token: Hex, from: Hex, to: Hex, amount: bigint, event: AbiEvent = TRANSFER): void {
    this.add(block, tx, token, event, { from, to }, encodeAbiParameters([{ type: "uint256" }], [amount]));
  }

  client(): PublicClient {
    const fake = {
      getBlock: (p: { blockTag?: string; blockNumber?: bigint }) => {
        const number = p.blockNumber ?? this.head;
        return Promise.resolve({ number, timestamp: 1000n + number });
      },
      getLogs: (p: { address: Hex | Hex[]; event?: AbiEvent; args?: { from?: Hex[]; to?: Hex[] }; fromBlock: bigint; toBlock: bigint }) => {
        const addresses = (Array.isArray(p.address) ? p.address : [p.address]).map((x) => x.toLowerCase());
        const padded = (list: Hex[] | undefined) => list?.map((x) => pad(x).toLowerCase());
        const from = padded(p.args?.from);
        const to = padded(p.args?.to);
        return Promise.resolve(
          this.logs.filter(
            (l) =>
              addresses.includes(l.address.toLowerCase()) &&
              l.blockNumber >= p.fromBlock &&
              l.blockNumber <= p.toBlock &&
              (p.event === undefined || l.topics[0] === toEventSelector(p.event)) &&
              (from === undefined || from.includes(l.topics[1] ?? "")) &&
              (to === undefined || to.includes(l.topics[2] ?? "")),
          ),
        );
      },
      readContract: (p: { address: Hex; functionName: string; args?: readonly Hex[] }) => {
        const key = [p.address.toLowerCase(), p.functionName, ...(p.args ?? []).map((x) => x.toLowerCase())].join(":");
        this.calls.push(p.functionName);
        const value = this.reads.get(key);
        return value === undefined ? Promise.reject(new Error(`no read ${key}`)) : Promise.resolve(value);
      },
    };
    // The backtest needs four PublicClient methods; the fake implements exactly those.
    return fake as unknown as PublicClient;
  }
}

function yaml(unit: "tokens" | "shares", shares = unit === "shares"): string {
  const debit = shares ? SENT : BURNED;
  const credit = shares ? RECEIVED : RELEASED;
  const sig = (e: AbiEvent): string => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed === true ? " indexed" : ""} ${i.name ?? ""}`).join(", ")})`;
  const fields = shares
    ? `
    debit_fields: { message_id: id, amount: amount, recipient: to, remote_chain: dstChain, shares: shares }
    credit_fields: { message_id: id, amount: amount, recipient: to, remote_chain: srcChain, shares: shares }`
    : "";
  return `
spec_version: 1
token: kETH
model: lock_release_home
unit: ${unit}
home: { chain: ${HOME}, canonical: "${CANONICAL}", escrow: "${ESCROW}" }
remotes:
  - { chain: ${ARB}, token: "${REMOTE}", minters: [bridge_arb] }
bridges:
  - id: bridge
    kind: custom
    contracts: { home: "${ESCROW}", arb: "${BRIDGE_ARB}" }
    debit_event: "${sig(debit)}"
    credit_event: "${sig(credit)}"${fields}
confidence: { default: finalized }
rules:
  junction: { match_window_seconds: 1200 }
  loop: { tolerance_wei: "0", breach_confirmations: 1 }
  staleness_seconds: 120
  on_stale: fail_closed
response: { on_broken: [page_issuer], replay_requires: issuer_multisig, recovery_timelock_seconds: 3600 }
`;
}

const SEL = { home: CHAINS[HOME].selector, arb: CHAINS[ARB].selector };

/** A valid 5-token lock and mint; optionally a forged 7-token release on Arbitrum burned back before the head. */
function world(forge: boolean): { home: FakeChain; arb: FakeChain } {
  const home = new FakeChain(100n);
  const arb = new FakeChain(100n);
  home.transfer(10n, "lock", CANONICAL, ALICE, ESCROW, 5n);
  home.add(10n, "lock", ESCROW, BURNED, { id: id(1), from: ALICE }, encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [ALICE, 5n, SEL.arb]));
  arb.transfer(20n, "mint", REMOTE, ZERO, ALICE, 5n);
  arb.add(20n, "mint", BRIDGE_ARB, RELEASED, { id: id(1), to: ALICE }, encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [5n, SEL.home]));
  // An unrelated holder-to-holder transfer the backtest must not fetch.
  arb.transfer(25n, "pay", REMOTE, ALICE, MALLORY, 1n);
  if (forge) {
    arb.transfer(30n, "forge", REMOTE, ZERO, MALLORY, 7n);
    arb.add(30n, "forge", BRIDGE_ARB, RELEASED, { id: id(9), to: MALLORY }, encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [7n, SEL.home]));
    arb.transfer(40n, "burn-back", REMOTE, MALLORY, ZERO, 7n);
  }
  home.reads.set(`${CANONICAL}:totalSupply`, 1_000n);
  home.reads.set(`${CANONICAL}:balanceOf:${ESCROW}`, 5n);
  arb.reads.set(`${REMOTE}:totalSupply`, 5n);
  return { home, arb };
}

const run = (w: { home: FakeChain; arb: FakeChain }, unit: "tokens" | "shares" = "tokens") =>
  backtestYaml(yaml(unit), {}, { clients: { [HOME]: w.home.client(), [ARB]: w.arb.client() }, defaultLookback: null, maxChunk: 30n });

describe("backtestYaml history replay", () => {
  it("passes a conserved history and reports per-chain coverage", async () => {
    const r = await run(world(false));
    expect(r.ok).toBe(true);
    expect(r.breaches).toEqual([]);
    expect(r.eventsReplayed).toBe(4);
    expect(r.coverage).toEqual([
      { chain: HOME, fromBlock: "0", toBlock: "100", debits: 1, credits: 0, matched: 0 },
      { chain: ARB, fromBlock: "0", toBlock: "100", debits: 0, credits: 1, matched: 1 },
    ]);
  });

  it("blocks activation on a forgery that was burned back before the head, quoting its block", async () => {
    const r = await run(world(true));
    expect(r.ok).toBe(false);
    expect(r.breaches.map((b) => [b.reason, b.tx.chain, b.tx.block, b.amount])).toEqual([
      ["LOOP_DEFICIT", ARB, "30", "7"],
      ["DEBIT_NOT_FOUND", ARB, "30", "7"],
    ]);
    expect(r.breaches[0]?.note).toMatch(/after block 30 on /);
    expect(r.breaches[1]?.note).toMatch(/at block 30 has no valid debit/);
  });

  it("replays a unit: shares token in shares: share events, share supply and share balances", async () => {
    const home = new FakeChain(100n);
    const arb = new FakeChain(100n);
    const moved = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }], [ALICE, 11n, 10n, SEL.arb]);
    home.transfer(10n, "lock", CANONICAL, ALICE, ESCROW, 10n, TRANSFER_SHARES);
    home.add(10n, "lock", ESCROW, SENT, { id: id(1) }, moved);
    arb.transfer(20n, "mint", REMOTE, ZERO, ALICE, 10n, TRANSFER_SHARES);
    // Delivered after a rebase: 12 tokens, still 10 shares.
    arb.add(20n, "mint", BRIDGE_ARB, RECEIVED, { id: id(1) }, encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }], [ALICE, 12n, 10n, SEL.home]));
    home.reads.set(`${CANONICAL}:getTotalShares`, 1_000n);
    home.reads.set(`${CANONICAL}:sharesOf:${ESCROW}`, 10n);
    arb.reads.set(`${REMOTE}:getTotalShares`, 10n);
    const r = await run({ home, arb }, "shares");
    expect(r.breaches).toEqual([]);
    expect(r.ok).toBe(true);
    expect([...home.calls, ...arb.calls].sort()).toEqual(["getTotalShares", "getTotalShares", "sharesOf"]);
  });

  it("refuses a shares spec whose bridge events carry no share amount", async () => {
    const w = world(false);
    const r = backtestYaml(yaml("shares", false), {}, { clients: { [HOME]: w.home.client(), [ARB]: w.arb.client() }, defaultLookback: null });
    await expect(r).rejects.toThrow(SpecInvalidError);
    await expect(r).rejects.toThrow(/unit shares needs a shares field/);
  });

  it("refuses a history that does not add up to the supply read at head", async () => {
    const w = world(false);
    w.arb.reads.set(`${REMOTE}:totalSupply`, 4n);
    await expect(run(w)).rejects.toThrow(SpecInvalidError);
  });
});
