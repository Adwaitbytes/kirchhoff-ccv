import { isHome, specChains } from "./chains.ts";
import { matchAll, trailingFlow, type FlowEntry, type SourceView, type TimedCredit } from "./junction.ts";
import { loop } from "./loop.ts";
import { applyCreReport } from "./status.ts";
import { toCanonical } from "./units.ts";
import {
  EngineInputError,
  Reason,
  Status,
  type BurnMintSnapshot,
  type ChainSel,
  type Credit,
  type Debit,
  type Hex,
  type LockReleaseSnapshot,
  type LoopResult,
  type TokenSpec,
} from "./types.ts";

type Observed<S> = Omit<S, "inFlightOut" | "inFlightIn" | "flowLastHour" | "priorDeficitEpochs">;

/** Balances read at the epoch's pinned blocks; in-flight and flow are derived by the backtester. */
export type ObservedSnapshot = Observed<LockReleaseSnapshot> | Observed<BurnMintSnapshot>;

export type EpochObservation = {
  /** Evaluation timestamp, seconds. */
  timestamp: bigint;
  /** Pinned (confident) head per chain. Credits above their chain's pin wait for a later epoch. */
  sources: ReadonlyMap<ChainSel, SourceView>;
  snapshot: ObservedSnapshot;
};

export type HistoryEvent =
  | { kind: "debit"; debit: Debit }
  | { kind: "credit"; credit: Credit; timestamp: bigint }
  | { kind: "epoch"; epoch: EpochObservation };

export type Breach = {
  epochId: bigint;
  reason: Reason;
  rule: "junction" | "loop";
  delta: bigint;
  /** Junction breaches identify the offending credit. */
  credit?: Credit;
};

export type DriftEvent = { epochId: bigint; reason: Reason; messageId?: Hex };

export type EpochOutcome = {
  epochId: bigint;
  /** Token status after this epoch's reports are applied. */
  status: Status;
  loop: LoopResult;
  settled: readonly Hex[];
};

export type BacktestResult = {
  epochs: readonly EpochOutcome[];
  breaches: readonly Breach[];
  drift: readonly DriftEvent[];
  finalStatus: Status;
  coverage: {
    debits: number;
    credits: number;
    settled: number;
    /** Credits still awaiting a confident debit at the end of the history. */
    pending: number;
    /** Debits not yet credited at the last epoch. */
    inFlight: number;
    epochs: number;
  };
};


export type EpochFindings = { breaches: readonly Breach[]; drift: readonly DriftEvent[] };

/**
 * The backtest state machine, fed one history event at a time: matchAll and loop once per epoch,
 * exactly as W2 would, driving the status machine with the reports W1 and W2 would write.
 */
export class Backtester {
  private readonly spec: TokenSpec;
  private openDebits: Debit[] = [];
  private pending: TimedCredit[] = [];
  private readonly consumed = new Set<string>();
  private readonly flow: FlowEntry[] = [];
  private readonly epochs: EpochOutcome[] = [];
  private readonly breaches: Breach[] = [];
  private readonly drift: DriftEvent[] = [];
  private status: Status = Status.UNKNOWN;
  private priorDeficitEpochs = 0;
  private debitCount = 0;
  private creditCount = 0;
  private settledCount = 0;
  private inFlightCount = 0;

  constructor(spec: TokenSpec) {
    this.spec = spec;
  }

  debit(debit: Debit): void {
    this.openDebits.push(debit);
    this.debitCount++;
  }

  credit(credit: Credit, timestamp: bigint): void {
    this.pending.push({ credit, timestamp });
    this.creditCount++;
  }

  /** Closes one epoch and returns what it found. */
  epoch(epoch: EpochObservation): EpochFindings {
    const epochId = epoch.snapshot.epochId;
    const breaches: Breach[] = [];
    const drift: DriftEvent[] = [];
    // W2 only reads logs up to each chain's pinned block; later credits wait for a later epoch.
    const visible = (c: TimedCredit): boolean => c.credit.block <= (epoch.sources.get(c.credit.dstChain)?.head ?? -1n);
    const evaluated = this.pending.filter(visible);
    const deferred = this.pending.filter((c) => !visible(c));
    const match = matchAll(this.openDebits, evaluated, this.spec, {
      now: epoch.timestamp,
      sources: epoch.sources,
      isConsumed: (id) => this.consumed.has(id.toLowerCase()),
    });

    const stillPending: TimedCredit[] = [...deferred];
    let junctionBroken = false;
    for (const { credit, timestamp, result } of match.verdicts) {
      if (result.status === Status.BROKEN) {
        junctionBroken = true;
        breaches.push({ epochId, reason: result.reason, rule: "junction", delta: 0n, credit });
      } else if (result.status === Status.DRIFT) {
        stillPending.push({ credit, timestamp });
        drift.push({ epochId, reason: result.reason, messageId: credit.messageId });
      }
    }
    for (const id of match.settled) this.consumed.add(id.toLowerCase());
    this.settledCount += match.settled.length;
    this.flow.push(...match.settledFlow);
    this.pending = stillPending;
    this.openDebits = this.openDebits.filter((d) => !this.consumed.has(d.messageId.toLowerCase()));
    this.inFlightCount = match.inFlight.length;

    const loopResult = loop(
      {
        ...epoch.snapshot,
        inFlightOut: match.inFlightOut,
        inFlightIn: match.inFlightIn,
        flowLastHour: trailingFlow(this.flow, epoch.timestamp),
        priorDeficitEpochs: this.priorDeficitEpochs,
      },
      this.spec,
    );
    this.priorDeficitEpochs = loopResult.deficit ? this.priorDeficitEpochs + 1 : 0;

    if (loopResult.status === Status.BROKEN) {
      breaches.push({ epochId, reason: loopResult.reason, rule: "loop", delta: loopResult.delta });
    } else if (loopResult.status === Status.DRIFT) {
      drift.push({ epochId, reason: loopResult.reason });
    }

    if (junctionBroken || loopResult.status === Status.BROKEN) {
      this.status = applyCreReport(this.status, { kind: "BREACH" });
    } else {
      const epochStatus =
        loopResult.status === Status.DRIFT || stillPending.length > deferred.length ? Status.DRIFT : Status.CONSERVED;
      this.status = applyCreReport(this.status, { kind: "EPOCH", status: epochStatus });
    }
    this.epochs.push({ epochId, status: this.status, loop: loopResult, settled: match.settled });
    this.breaches.push(...breaches);
    this.drift.push(...drift);
    return { breaches, drift };
  }

  result(): BacktestResult {
    return {
      epochs: [...this.epochs],
      breaches: [...this.breaches],
      drift: [...this.drift],
      finalStatus: this.status,
      coverage: {
        debits: this.debitCount,
        credits: this.creditCount,
        settled: this.settledCount,
        pending: this.pending.length,
        inFlight: this.inFlightCount,
        epochs: this.epochs.length,
      },
    };
  }
}

/**
 * Replays an ordered event history through the Backtester. Pure: the history is the only input.
 * Used by the spec lifecycle (any BROKEN on real history blocks activation) and by the tests.
 */
export function backtest(history: readonly HistoryEvent[], spec: TokenSpec): BacktestResult {
  const b = new Backtester(spec);
  for (const event of history) {
    if (event.kind === "debit") b.debit(event.debit);
    else if (event.kind === "credit") b.credit(event.credit, event.timestamp);
    else b.epoch(event.epoch);
  }
  return b.result();
}

/** When the history replay closes an epoch (PRD section 6, spec lifecycle step 3). */
export type EpochSchedule =
  /** After every block group (one chain, one block) that moves a supply or a home escrow balance. */
  | { kind: "supply_change" }
  /** Before a chain's next event when it falls in a later `blocks`-wide window than that chain's last one. */
  | { kind: "every_blocks"; blocks: bigint };

type Located = { chain: ChainSel; block: bigint; logIndex: number; timestamp: bigint; txHash: Hex };

/**
 * One onchain event of the replayed history. `transfer` is the token's own movement event:
 * ERC-20 `Transfer`, or `TransferShares` for a `unit: shares` token, so supply and escrow are
 * reconstructed in the unit the spec compares.
 */
export type ReplayEvent = Located &
  ({ kind: "debit"; debit: Debit } | { kind: "credit"; credit: Credit } | { kind: "transfer"; from: Hex; to: Hex; amount: bigint });

export type ReplayChain = {
  chain: ChainSel;
  /** First block of the replay window. */
  fromBlock: bigint;
  /** Confident head the window ends at, and its timestamp. */
  head: bigint;
  headTimestamp: bigint;
  /** totalSupply (getTotalShares for unit: shares) at head, in this chain's decimals. */
  supplyAtHead: bigint;
};

export type ReplayInput = {
  chains: readonly ReplayChain[];
  /** Home escrow holders (escrow adapter, CCIP lockbox) with their balance, or shares, at head. */
  escrowAtHead: readonly { holder: Hex; balance: bigint }[];
  /** Proof of Reserve answer for a reserve-backed burn-and-mint token; null otherwise. */
  reserve: bigint | null;
  /** Every debit, credit and supply-relevant transfer inside the windows, in any order. */
  events: readonly ReplayEvent[];
  schedule: EpochSchedule;
};

/** Where an epoch closed: the last block group it saw, or the confident heads for the final epoch. */
export type EpochBoundary = { chain: ChainSel; block: bigint; timestamp: bigint; txHash: Hex | null; final: boolean };

export type ReplayResult = Omit<BacktestResult, "breaches" | "drift"> & {
  breaches: readonly (Breach & { at: EpochBoundary })[];
  drift: readonly (DriftEvent & { at: EpochBoundary })[];
  /** Debits, credits and transfers replayed. */
  eventsReplayed: number;
};

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

/** One chain of the replay: its window, its spec order and how far the replay has walked it. */
type ChainState = { window: ReplayChain; rank: number; block: bigint; timestamp: bigint; supply: bigint };

type Group = { state: ChainState; block: bigint; timestamp: bigint; events: ReplayEvent[]; hasCredit: boolean; lastTx: Hex };

/** Replay order as one integer: timestamp, then credit-free groups, then spec chain rank, then block (uint64). */
const orderKey = (g: Group): bigint =>
  (((g.timestamp * 2n + (g.hasCredit ? 1n : 0n)) << 8n) + BigInt(g.state.rank)) * (1n << 64n) + g.block;

function stateOf(states: ReadonlyMap<ChainSel, ChainState>, event: ReplayEvent): ChainState {
  const state = states.get(event.chain);
  if (state === undefined || event.block < state.window.fromBlock || event.block > state.window.head) {
    throw new EngineInputError(`event at block ${event.block.toString()} on chain ${event.chain.toString()} is outside the replay window`);
  }
  const own = event.kind === "debit" ? event.debit.srcChain : event.kind === "credit" ? event.credit.dstChain : event.chain;
  if (own !== event.chain) throw new EngineInputError(`${event.kind} at block ${event.block.toString()} belongs to another chain`);
  return state;
}

/**
 * Block groups in replay order: by timestamp across chains, then groups without a credit first
 * (a credit never precedes its debit, so a same-second tie must not read as a forgery), then spec
 * chain order and block. Events inside a group keep log order.
 */
function groupsInOrder(events: readonly ReplayEvent[], states: ReadonlyMap<ChainSel, ChainState>): Group[] {
  const groups = new Map<string, Group>();
  for (const event of events) {
    const state = stateOf(states, event);
    const key = `${event.chain.toString()}:${event.block.toString()}`;
    const group = groups.get(key) ?? {
      state,
      block: event.block,
      timestamp: event.timestamp,
      events: [],
      hasCredit: false,
      lastTx: event.txHash,
    };
    if (group.timestamp !== event.timestamp) throw new EngineInputError(`block ${event.block.toString()} has two timestamps`);
    group.events.push(event);
    group.hasCredit ||= event.kind === "credit";
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  for (const g of ordered) {
    g.events.sort((x, y) => x.logIndex - y.logIndex);
    for (const e of g.events) g.lastTx = e.txHash;
  }
  // Keys are distinct: two groups on one chain differ in block.
  return ordered.sort((x, y) => (orderKey(x) < orderKey(y) ? -1 : 1));
}

/**
 * Supply bookkeeping for the replay, in the spec's unit. It starts at the window's opening state,
 * which is the head reading minus every replayed change, so no archive read is needed and the
 * final epoch reproduces the head reading exactly.
 */
class Ledger {
  escrow = 0n;
  /** I_net: issuer mints minus burns on the home chain outside bridge transactions, canonical units. */
  issuance = 0n;
  private readonly spec: TokenSpec;
  private readonly holders: ReadonlySet<string>;
  private readonly bridgeTxs: ReadonlySet<string>;

  constructor(spec: TokenSpec, holders: ReadonlySet<string>, bridgeTxs: ReadonlySet<string>) {
    this.spec = spec;
    this.holders = holders;
    this.bridgeTxs = bridgeTxs;
  }

  /** Applies (sign 1) or reverts (sign -1) one transfer; true when it moved a supply or the escrow. */
  apply(event: Extract<ReplayEvent, { kind: "transfer" }>, state: ChainState, sign: 1n | -1n): boolean {
    const from = event.from.toLowerCase();
    const to = event.to.toLowerCase();
    const minted = (from === ZERO_ADDRESS ? 1n : 0n) - (to === ZERO_ADDRESS ? 1n : 0n);
    const change = sign * minted * event.amount;
    state.supply += change;
    if (!isHome(this.spec, event.chain)) return minted !== 0n;
    if (!this.bridgeTxs.has(event.txHash.toLowerCase())) this.issuance += change;
    const escrowed = (this.holders.has(to) ? 1n : 0n) - (this.holders.has(from) ? 1n : 0n);
    this.escrow += sign * escrowed * event.amount;
    return minted !== 0n || this.holders.has(to) || this.holders.has(from);
  }
}

/**
 * Spec lifecycle step 3 on real history (6.LC3): walks the token's events in block order, runs the
 * Junction Rule on every credit and the Loop Rule at each epoch boundary of `schedule`, with every
 * chain's supply and the home escrow reconstructed from the replayed transfers, then closes a
 * final epoch at the confident heads. Every BROKEN is reported with the boundary it was found at.
 * Pure: the input is the only source.
 *
 * A mid-history epoch pins each chain at its last replayed block and treats that chain as final
 * only for credits strictly older than that block, so a source chain the replay has not walked up
 * to a credit's time yet reads as DRIFT (match window permitting), never as a forgery. A
 * burn-and-mint window that does not start at deployment is assumed to open conserved: I_net
 * starts at the opening supply.
 */
export function replayHistory(input: ReplayInput, spec: TokenSpec): ReplayResult {
  const states = new Map<ChainSel, ChainState>();
  for (const [rank, chain] of specChains(spec).entries()) {
    const window = input.chains.find((c) => c.chain === chain.selector);
    if (window === undefined) throw new EngineInputError(`replay has no window for chain ${chain.name}`);
    states.set(chain.selector, { window, rank, block: window.fromBlock - 1n, timestamp: 0n, supply: window.supplyAtHead });
  }
  const schedule = input.schedule;
  if (schedule.kind === "every_blocks" && schedule.blocks <= 0n) throw new EngineInputError("every_blocks epochs need a positive block count");
  const groups = groupsInOrder(input.events, states);
  // Transaction hashes are unique across chains, so a bare hash identifies a bridge transaction.
  const bridgeTxs = new Set(input.events.filter((e) => e.kind !== "transfer").map((e) => e.txHash.toLowerCase()));
  const holders = new Set(input.escrowAtHead.map((h) => h.holder.toLowerCase()));

  const ledger = new Ledger(spec, holders, bridgeTxs);
  ledger.escrow = input.escrowAtHead.reduce((sum, h) => sum + h.balance, 0n);
  for (const g of groups) for (const e of g.events) if (e.kind === "transfer") ledger.apply(e, g.state, -1n);
  const chains = [...states.values()];
  if (chains.some((c) => c.supply < 0n) || ledger.escrow < 0n) {
    throw new EngineInputError("replayed transfers exceed the supply or escrow read at head: the history is incomplete");
  }
  ledger.issuance = chains.reduce((sum, c) => sum + toCanonical(spec, c.window.chain, c.supply), 0n);

  const tester = new Backtester(spec);
  const breaches: (Breach & { at: EpochBoundary })[] = [];
  const drift: (DriftEvent & { at: EpochBoundary })[] = [];
  let epochs = 0n;
  const close = (at: EpochBoundary, sources: ReadonlyMap<ChainSel, SourceView>): void => {
    epochs++;
    const pinned = [...sources].map(([chain, s]) => ({ chain, block: s.head }));
    const supplies = chains.map((c) => ({ chain: c.window.chain, supply: c.supply }));
    const snapshot: ObservedSnapshot =
      spec.model === "lock_release_home"
        ? { model: "lock_release_home", epochId: epochs, pinned, supplies, escrow: ledger.escrow }
        : { model: "burn_mint_multi", epochId: epochs, pinned, supplies, issuanceNet: ledger.issuance, reserve: input.reserve };
    const found = tester.epoch({ timestamp: at.timestamp, sources, snapshot });
    breaches.push(...found.breaches.map((b) => ({ ...b, at })));
    drift.push(...found.drift.map((d) => ({ ...d, at })));
  };
  const midSources = (): Map<ChainSel, SourceView> =>
    new Map([...states].map(([chain, s]) => [chain, { head: s.block, headTimestamp: s.timestamp - 1n }]));
  const boundaryOf = (g: Group): EpochBoundary => ({ chain: g.state.window.chain, block: g.block, timestamp: g.timestamp, txHash: g.lastTx, final: false });

  let last: Group | null = null;
  for (const group of groups) {
    const { state } = group;
    if (schedule.kind === "every_blocks" && last !== null && group.block / schedule.blocks > state.block / schedule.blocks) {
      close(boundaryOf(last), midSources());
    }
    let moved = false;
    for (const event of group.events) {
      if (event.kind === "debit") tester.debit(event.debit);
      else if (event.kind === "credit") tester.credit(event.credit, event.timestamp);
      else moved = ledger.apply(event, state, 1n) || moved;
    }
    state.block = group.block;
    state.timestamp = group.timestamp;
    last = group;
    if (schedule.kind === "supply_change" && moved) close(boundaryOf(group), midSources());
  }

  const home = spec.home.chain.selector;
  const heads = chains.map((s) => s.window);
  close(
    {
      chain: home,
      block: heads.reduce((b, w) => (w.chain === home ? w.head : b), 0n),
      timestamp: heads.reduce((t, w) => (w.headTimestamp > t ? w.headTimestamp : t), 0n),
      txHash: null,
      final: true,
    },
    new Map(heads.map((w) => [w.chain, { head: w.head, headTimestamp: w.headTimestamp }])),
  );
  return { ...tester.result(), breaches, drift, eventsReplayed: input.events.length };
}
