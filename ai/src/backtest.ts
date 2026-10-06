import { parseAbi, parseAbiItem, toEventSelector, type PublicClient } from "viem";
import {
  escrowHolders,
  reasonName,
  replayHistory,
  type ChainRef,
  type EpochBoundary,
  type EpochSchedule,
  type ReplayChain,
  type ReplayEvent,
  type TokenSpec,
} from "@kirchhoff/engine";
import { adaptersForSpec, type Log } from "@kirchhoff/engine/adapters";
import { parseSpec, specHash, validateSpec } from "@kirchhoff/engine/spec";
import { CHAINS, chainBySelector, isChainKey, type Address, type BacktestResponse, type ChainKey, type Hex, type TxRef } from "@kirchhoff/sdk";

/**
 * Spec lifecycle step 3 (PRD section 6): replay the token's event history through the
 * deterministic engine, epoch by epoch (engine replayHistory). Shared by POST /specs/backtest and
 * the Copilot's backtest_spec tool. The engine decides; this module only fetches history and maps
 * the result.
 */

export type BacktestBody = Omit<BacktestResponse, "source" | "ledger" | "block" | "servedAt">;

export class SpecInvalidError extends Error {
  override readonly name = "SpecInvalidError";
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`spec invalid: ${errors.slice(0, 3).join("; ")}`);
    this.errors = errors;
  }
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC: Hex = `0x${"0".repeat(64)}`;
const isZero = (a: string | null | undefined): boolean => !a || BigInt(a) === 0n;

/**
 * The token's own movement event and its reads, in the spec's unit (PRD section 10): a rebasing
 * `unit: shares` token is replayed in shares (Lido-style TransferShares, getTotalShares, sharesOf).
 */
const UNIT_READS = {
  tokens: {
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
    amountArg: "value",
    abi: parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]),
    supply: "totalSupply",
    balance: "balanceOf",
  },
  shares: {
    event: parseAbiItem("event TransferShares(address indexed from, address indexed to, uint256 sharesValue)"),
    amountArg: "sharesValue",
    abi: parseAbi(["function getTotalShares() view returns (uint256)", "function sharesOf(address) view returns (uint256)"]),
    supply: "getTotalShares",
    balance: "sharesOf",
  },
} as const;

/** Every bridge contract the spec declares on a chain: the logs the adapters decode. */
function bridgeAddresses(spec: TokenSpec, chain: ChainRef): Address[] {
  const out = new Set<Address>();
  for (const b of spec.bridges) {
    const maps = b.kind === "ccip_v2" ? [b.pools, b.onramps, b.offramps] : [b.contracts];
    for (const m of maps) {
      const a = m[chain.alias];
      if (!isZero(a)) out.add(a?.toLowerCase() as Address);
    }
  }
  return [...out];
}

type RpcLog = { address: Hex; topics: readonly Hex[]; data: Hex; transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null };
type MinedLog = Log & { logIndex: number };

function mined(logs: readonly RpcLog[]): MinedLog[] {
  return logs.flatMap((l) =>
    l.transactionHash === null || l.blockNumber === null || l.logIndex === null
      ? []
      : [{ address: l.address, topics: l.topics, data: l.data, transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex }],
  );
}

const ranges = (from: bigint, to: bigint, chunk: bigint): [bigint, bigint][] => {
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += chunk) out.push([start, start + chunk - 1n < to ? start + chunk - 1n : to]);
  return out;
};

export type BacktestDeps = {
  clients: Partial<Record<ChainKey, PublicClient>>;
  /** Default start when the request names none: genesis on Anvil, a recent window on testnets. */
  defaultLookback: bigint | null;
  maxChunk?: bigint;
  /** Loop epoch boundaries for the replay; after every supply-moving block by default. */
  epochs?: EpochSchedule;
};

export async function backtestYaml(yaml: string, fromBlock: Partial<Record<ChainKey, bigint>>, deps: BacktestDeps): Promise<BacktestBody> {
  const started = Date.now();
  const parsed = parseSpec(yaml);
  if (!parsed.ok) throw new SpecInvalidError(parsed.errors);
  const spec = parsed.spec;
  let adapters: ReturnType<typeof adaptersForSpec>;
  try {
    adapters = adaptersForSpec(spec);
  } catch (e) {
    throw new SpecInvalidError([e instanceof Error ? e.message : String(e)]);
  }
  const unit = UNIT_READS[spec.unit];
  const holders = escrowHolders(spec).filter((h) => !isZero(h)).map((h) => h.toLowerCase() as Address);
  const chains = [
    { ref: spec.home.chain, token: spec.home.canonical },
    ...spec.remotes.map((r) => ({ ref: r.chain, token: r.token })),
  ];
  const events: ReplayEvent[] = [];
  const windows: ReplayChain[] = [];
  const escrowAtHead: { holder: Hex; balance: bigint }[] = [];
  const coverage: BacktestBody["coverage"] = [];
  const txRefs = new Map<string, TxRef>();
  const debitIds = new Set<string>();
  const creditIds = new Map<ChainKey, Set<string>>();
  for (const { ref, token } of chains) {
    const name = ref.name;
    if (!isChainKey(name)) throw new SpecInvalidError([`chain ${name} is not supported`]);
    if (isZero(token)) throw new SpecInvalidError([`${name} token address is a placeholder`]);
    const client = deps.clients[name];
    if (!client) throw new SpecInvalidError([`no RPC configured for ${name}`]);
    const selector = CHAINS[name].selector;
    const headBlock = await client.getBlock({ blockTag: "latest" });
    const head = headBlock.number;
    const from = fromBlock[name] ?? (deps.defaultLookback === null ? 0n : head > deps.defaultLookback ? head - deps.defaultLookback : 0n);
    const chunk = deps.maxChunk ?? 2_000n;
    const isHomeChain = ref.selector === spec.home.chain.selector;
    const watch = isHomeChain ? [ZERO, ...holders] : [ZERO];
    const times = new Map<bigint, bigint>();
    const timeOf = async (block: bigint): Promise<bigint> => {
      const known = times.get(block);
      if (known !== undefined) return known;
      const ts = (await client.getBlock({ blockNumber: block })).timestamp;
      times.set(block, ts);
      return ts;
    };
    const tokenAddress = token.toLowerCase() as Address;
    const bridges = bridgeAddresses(spec, ref);
    let debits = 0;
    let credits = 0;
    for (const [start, end] of ranges(from, head, chunk)) {
      const bridgeLogs = bridges.length === 0 ? [] : mined(await client.getLogs({ address: bridges, fromBlock: start, toBlock: end }));
      // Only supply and escrow moves matter to the Loop Rule: transfers from or to zero or an escrow holder.
      const [outgoing, incoming] = await Promise.all([
        client.getLogs({ address: tokenAddress, event: unit.event, args: { from: watch }, fromBlock: start, toBlock: end }),
        client.getLogs({ address: tokenAddress, event: unit.event, args: { to: watch }, fromBlock: start, toBlock: end }),
      ]);
      const seen = new Set<string>();
      for (const l of mined([...outgoing, ...incoming])) {
        const key = `${l.transactionHash}:${l.logIndex.toString()}`;
        if (seen.has(key) || l.topics.length !== 3) continue;
        seen.add(key);
        const amount = BigInt(l.data);
        const fromTopic = l.topics[1] ?? ZERO_TOPIC;
        const toTopic = l.topics[2] ?? ZERO_TOPIC;
        const at = { chain: selector, block: l.blockNumber, logIndex: l.logIndex, timestamp: await timeOf(l.blockNumber), txHash: l.transactionHash };
        events.push({ ...at, kind: "transfer", from: `0x${fromTopic.slice(26)}`, to: `0x${toTopic.slice(26)}`, amount });
      }
      const byTx = new Map<Hex, MinedLog[]>();
      for (const l of bridgeLogs) byTx.set(l.transactionHash, [...(byTx.get(l.transactionHash) ?? []), l]);
      for (const [txHash, txLogs] of byTx) {
        txLogs.sort((x, y) => x.logIndex - y.logIndex);
        const first = txLogs[0];
        if (first === undefined) continue;
        const at = { chain: selector, block: first.blockNumber, logIndex: first.logIndex, timestamp: await timeOf(first.blockNumber), txHash };
        for (const adapter of adapters) {
          for (const debit of adapter.decodeTxDebits(txLogs, selector)) {
            debits++;
            debitIds.add(debit.messageId.toLowerCase());
            events.push({ ...at, kind: "debit", debit });
          }
          for (const credit of adapter.decodeTxCredits(txLogs, selector)) {
            credits++;
            const set = creditIds.get(name) ?? new Set<string>();
            set.add(credit.messageId.toLowerCase());
            creditIds.set(name, set);
            events.push({ ...at, kind: "credit", credit });
          }
        }
        txRefs.set(txHash.toLowerCase(), { chain: name, hash: txHash, block: first.blockNumber.toString(), timestamp: new Date(Number(at.timestamp) * 1000).toISOString() });
      }
    }
    const supplyAtHead = await client.readContract({ address: tokenAddress, abi: unit.abi, functionName: unit.supply, blockNumber: head });
    if (isHomeChain) {
      for (const holder of holders) {
        const balance = await client.readContract({ address: tokenAddress, abi: unit.abi, functionName: unit.balance, args: [holder], blockNumber: head });
        escrowAtHead.push({ holder, balance });
      }
    }
    windows.push({ chain: selector, fromBlock: from, head, headTimestamp: headBlock.timestamp, supplyAtHead });
    coverage.push({ chain: name, fromBlock: from.toString(), toBlock: head.toString(), debits, credits, matched: 0 });
  }
  for (const cov of coverage) {
    const ids = creditIds.get(cov.chain) ?? new Set<string>();
    cov.matched = [...ids].filter((id) => debitIds.has(id)).length;
  }

  let result: ReturnType<typeof replayHistory>;
  try {
    result = replayHistory({ chains: windows, escrowAtHead, reserve: null, events, schedule: deps.epochs ?? { kind: "supply_change" } }, spec);
  } catch (e) {
    // An inconsistent history (a transfer outside the window, a supply that does not add up) is a backtest failure, not a pass.
    throw new SpecInvalidError([`history replay failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const chainKeyOf = (sel: bigint): ChainKey => chainBySelector(sel)?.key ?? (spec.home.chain.name as ChainKey);
  const refAt = (b: EpochBoundary): TxRef =>
    (b.txHash === null ? undefined : txRefs.get(b.txHash.toLowerCase())) ?? {
      chain: chainKeyOf(b.chain),
      hash: b.txHash ?? ZERO_TOPIC,
      block: b.block.toString(),
      timestamp: new Date(Number(b.timestamp) * 1000).toISOString(),
    };
  const label = (sel: bigint): string => chainBySelector(sel)?.label ?? sel.toString();
  const where = (b: EpochBoundary): string => (b.final ? "at the pinned heads" : `after block ${b.block.toString()} on ${label(b.chain)}`);
  return {
    specHash: specHash(spec),
    // Any BROKEN anywhere in the replayed history blocks activation (6.LC3), not only one visible at head.
    ok: result.breaches.length === 0,
    eventsReplayed: result.eventsReplayed,
    durationMs: Date.now() - started,
    coverage,
    breaches: result.breaches.map((b) => ({
      reason: reasonName(b.reason),
      tx: b.credit ? (txRefs.get(b.credit.txHash.toLowerCase()) ?? refAt(b.at)) : refAt(b.at),
      amount: (b.credit ? b.credit.amount : b.delta < 0n ? -b.delta : b.delta).toString(),
      note:
        b.rule === "junction" && b.credit
          ? `credit on ${label(b.credit.dstChain)} for message ${b.credit.messageId.slice(0, 10)} at block ${b.credit.block.toString()} has no valid debit`
          : `Loop Rule delta ${b.delta.toString()} at epoch ${b.epochId.toString()}, ${where(b.at)}`,
    })),
    driftEvents: result.drift.map((d) => ({
      reason: reasonName(d.reason),
      tx: refAt(d.at),
      note: d.messageId ? `message ${d.messageId.slice(0, 10)} inside its match window ${where(d.at)}` : `soft rule tripped ${where(d.at)}`,
    })),
  };
}

/**
 * Pre-validation that keeps the engine pure: every custom bridge address must be the contract that
 * actually emits the spec's debit/credit events on its chain. If the declared address emitted none
 * of them while another contract on that chain did, the spec points at the wrong contract (for
 * example the home WeakBridge instead of the HomeEscrowAdapter, which emits on home).
 */
export async function checkBridgeEmitters(spec: TokenSpec, clients: Partial<Record<ChainKey, PublicClient>>, lookback: bigint | null): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chainOfAlias = new Map<string, string>([[spec.home.chain.alias, spec.home.chain.name], ...spec.remotes.map((r) => [r.chain.alias, r.chain.name] as [string, string])]);
  for (const b of spec.bridges) {
    if (b.kind !== "custom") continue;
    const topics: Hex[] = [toEventSelector(b.events.debitEvent), toEventSelector(b.events.creditEvent)];
    for (const [alias, declared] of Object.entries(b.contracts)) {
      const chain = chainOfAlias.get(alias);
      const client = chain && isChainKey(chain) ? clients[chain] : undefined;
      if (!client || isZero(declared)) continue;
      const head = await client.getBlockNumber();
      const floor = lookback === null ? 0n : head > lookback ? head - lookback : 0n;
      const counts = new Map<string, number>();
      for (let to = head; to >= floor; to -= 10_000n) {
        const from = to - 9_999n > floor ? to - 9_999n : floor;
        const logs = (await client
          .request({ method: "eth_getLogs", params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topics] }] })
          .catch(() => null)) as { address: string; topics: Hex[] }[] | null;
        if (logs === null) {
          // Topic-only queries are refused by some providers; fall back to a softer check.
          warnings.push(`bridge ${b.id} ${alias}: could not scan emitters on ${chain}`);
          break;
        }
        for (const l of logs) if (l.topics[0] && topics.includes(l.topics[0])) counts.set(l.address.toLowerCase(), (counts.get(l.address.toLowerCase()) ?? 0) + 1);
        if (from === floor) break;
      }
      const own = counts.get(declared.toLowerCase()) ?? 0;
      const others = [...counts].filter(([a]) => a !== declared.toLowerCase()).sort((x, y) => y[1] - x[1]);
      if (own === 0 && others.length > 0) {
        const [addr, n] = others[0] ?? ["", 0];
        errors.push(`bridge ${b.id} ${alias}: ${declared} never emitted its declared debit/credit events on ${chain}; ${addr} did (${n} events), so the spec points at the wrong contract`);
      } else if (own === 0) {
        warnings.push(`bridge ${b.id} ${alias}: no ${b.events.debitEvent.split("(")[0] ?? "debit"}/${b.events.creditEvent.split("(")[0] ?? "credit"} events seen on ${chain} yet, emitter unconfirmed`);
      }
    }
  }
  return { errors, warnings };
}

/** validate_spec: JSON Schema plus engine semantic checks (bytecode read over RPC) plus the emitter pre-validation. */
export async function validateYaml(
  yaml: string,
  clients: Partial<Record<ChainKey, PublicClient>>,
  options: { emitterLookback?: bigint | null } = {},
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const parsed = parseSpec(yaml);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const engine = await validateSpec(parsed.spec, async (chain, address) => {
    const client = isChainKey(chain.name) ? clients[chain.name] : undefined;
    if (!client) return false;
    const code = await client.getCode({ address }).catch(() => undefined);
    return code !== undefined && code !== "0x";
  });
  const emitters = await checkBridgeEmitters(parsed.spec, clients, options.emitterLookback ?? null);
  const errors = [...engine.errors, ...emitters.errors];
  return { ok: errors.length === 0, errors, warnings: [...engine.warnings, ...emitters.warnings] };
}
