import { describe, expect, it } from "vitest";
import {
  evmAddress,
  hookResponse,
  judge,
  parseHookRequest,
  protectedTransfer,
  requestMeetsConfidence,
  rfc3339Seconds,
  type ParsedMessage,
  type Read,
  type ReadPair,
  type SourceDebitLookup,
  type SpecCacheEntry,
  type StatusRead,
  type TokenEvaluation,
} from "../src/judge-core.ts";
import { tokenId } from "../src/encoding.ts";
import { Reason, Status, type Hex } from "../src/types.ts";
import { ALICE, ARB, CANONICAL, HOME, POOL_ARB, REMOTE_ARB, hash, units } from "./fixtures.ts";

const ID = hash("ccip-msg");
const SPEC_HASH = hash("spec");
const conserved: StatusRead = { ok: true, status: Status.CONSERVED, delta: 0n, epochId: 4182n, stale: false, reason: Reason.OK };
const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const both = <T>(value: T): ReadPair<T> => [ok(value), ok(value)];
const down: Read<never> = { ok: false, error: "timeout" };
const padded = (a: Hex): string => `0x${"0".repeat(24)}${a.slice(2)}`;

function token(over: Partial<TokenEvaluation> = {}): TokenEvaluation {
  return {
    symbol: "kETH",
    tokenId: tokenId("kETH"),
    amount: units(10n),
    cachedSpecHash: SPEC_HASH,
    activeSpecHash: SPEC_HASH,
    onStale: "fail_closed",
    source: [conserved, conserved],
    destination: [conserved, conserved],
    laneInSpec: true,
    frozen: both(false),
    senderTainted: both(false),
    sourceDebit: both<SourceDebitLookup>({ kind: "found", amount: units(10n) }),
    sourceFinality: { proven: true },
    incidentId: null,
    ...over,
  };
}

const run = (t: TokenEvaluation | null, budgetExceeded = false) => judge({ messageId: ID, token: t, budgetExceeded });

function request(over: Record<string, unknown> = {}, message: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "v1",
    verifier_id: "kirchhoff-1",
    message_id: ID,
    source_tx_hash: hash("tx"),
    source_block_number: 10,
    finalized_block_number: 12,
    block_depth: 2,
    message: {
      version: 1,
      source_chain_selector: ARB.toString(),
      dest_chain_selector: HOME.toString(),
      sender: padded(ALICE),
      receiver: padded(ALICE),
      finality: { mode: "finalized", block_depth: 0, safe: false },
      token_transfer: {
        version: 1,
        amount: units(10n).toString(),
        source_pool_address: padded(POOL_ARB),
        source_token_address: padded(REMOTE_ARB),
        dest_token_address: padded(CANONICAL),
        token_receiver: padded(ALICE),
        extra_data: "0x",
      },
      ...message,
    },
    ...over,
  };
}

describe("evmAddress", () => {
  it("unpads 32-byte hook addresses and accepts plain 20-byte ones", () => {
    expect(evmAddress(padded(ALICE))).toBe(ALICE);
    expect(evmAddress(ALICE.toUpperCase().replace("0X", "0x"))).toBe(ALICE);
  });
  it.each(["0x", "nothex", `0x${"1".repeat(64)}`, `0x${"0".repeat(128)}`, "0x1234"])("rejects %s", (v) => {
    expect(evmAddress(v)).toBeNull();
  });
});

describe("parseHookRequest (policy hook v1)", () => {
  it("normalizes selectors from decimal strings and addresses from padded hex", () => {
    const r = parseHookRequest(request());
    expect(r).toEqual({
      ok: true,
      message: {
        messageId: ID,
        sourceTxHash: hash("tx"),
        srcChain: ARB,
        dstChain: HOME,
        sender: ALICE,
        receiver: ALICE,
        transfer: { amount: units(10n), sourceToken: REMOTE_ARB, sourcePool: POOL_ARB, destToken: CANONICAL, receiver: ALICE },
        sourceBlock: 10n,
        finalizedBlock: 12n,
        finality: { mode: "finalized", blockDepth: 0, safe: false },
        sourceBlockTimestamp: null,
        feeToken: null,
        feeAmount: null,
      },
    });
  });
  it("parses the fee token, fee amount and source block timestamp (9.H5)", () => {
    const r = parseHookRequest(
      request({
        fee_token: padded(POOL_ARB.toUpperCase().replace("0X", "0x") as Hex),
        fee_token_amount: "340282366920938463463374607431768211457",
        source_block_timestamp: "2026-10-04T12:34:56Z",
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      message: { feeToken: POOL_ARB, feeAmount: 340282366920938463463374607431768211457n, sourceBlockTimestamp: 1791117296n },
    });
  });
  it("keeps a known zero fee and reads the empty fee address as absent", () => {
    const r = parseHookRequest(request({ fee_token: "0x", fee_token_amount: "0" }));
    expect(r).toMatchObject({ ok: true, message: { feeToken: null, feeAmount: 0n } });
    const zero = parseHookRequest(request({ fee_token: `0x${"0".repeat(64)}`, fee_token_amount: null }));
    expect(zero).toMatchObject({ ok: true, message: { feeToken: `0x${"0".repeat(40)}`, feeAmount: null } });
  });
  it.each([
    [{ mode: "blockDepth", block_depth: 12, safe: false }, { mode: "blockDepth", blockDepth: 12, safe: false }],
    [{ mode: "finalized", block_depth: 0, safe: true }, { mode: "finalized", blockDepth: 0, safe: true }],
  ])("parses the finality object %j", (finality, parsed) => {
    expect(parseHookRequest(request({}, { finality }))).toMatchObject({ ok: true, message: { finality: parsed } });
  });
  it("keeps selectors above 2^63 exact", () => {
    const r = parseHookRequest(request({}, { source_chain_selector: "16015286601757825753" }));
    expect(r.ok && r.message.srcChain).toBe(16015286601757825753n);
  });
  it("treats a missing or null token_transfer as data-only", () => {
    const { token_transfer: _t, ...bare } = request().message as Record<string, unknown>;
    expect(parseHookRequest({ ...request(), message: bare })).toMatchObject({ ok: true, message: { transfer: null } });
    expect(parseHookRequest(request({}, { token_transfer: null }))).toMatchObject({ ok: true, message: { transfer: null } });
  });
  it.each([
    ["a non-object body", 7, /body/],
    ["an array body", [], /body/],
    ["another schema version", request({ schema_version: "v2" }), /schema_version/],
    ["a missing message", request({ message: "x" }), /message must/],
    ["a numeric selector", request({}, { source_chain_selector: 5 }), /source_chain_selector must be a string/],
    ["a negative selector", request({}, { dest_chain_selector: "-1" }), /uint64/],
    ["a selector above uint64", request({}, { dest_chain_selector: (1n << 64n).toString() }), /uint64/],
    ["a non-EVM sender", request({}, { sender: `0x${"1".repeat(64)}` }), /sender is not an EVM address/],
    ["a bad message id", request({ message_id: "0x12" }), /message_id/],
    ["a malformed token_transfer", request({}, { token_transfer: [] }), /token_transfer/],
    ["a non-decimal amount", request({}, { token_transfer: { amount: "1e18" } }), /amount must be a decimal/],
    ["a fractional source block", request({ source_block_number: 1.5 }), /source_block_number must be a non-negative safe integer/],
    ["a string finalized block", request({ finalized_block_number: "12" }), /finalized_block_number/],
    ["a negative finalized block", request({ finalized_block_number: -1 }), /finalized_block_number/],
    ["a missing finality", request({}, { finality: undefined }), /finality must be an object/],
    ["an unknown finality mode", request({}, { finality: { mode: "safe", block_depth: 0, safe: true } }), /finality.mode/],
    ["a finality depth above uint16", request({}, { finality: { mode: "blockDepth", block_depth: 65536, safe: false } }), /block_depth/],
    ["a fractional finality depth", request({}, { finality: { mode: "blockDepth", block_depth: 1.5, safe: false } }), /block_depth/],
    ["a non-boolean safe flag", request({}, { finality: { mode: "finalized", block_depth: 0, safe: "no" } }), /finality.safe must/],
    ["a depth in finalized mode", request({}, { finality: { mode: "finalized", block_depth: 3, safe: false } }), /0 in finalized mode/],
    ["safe with blockDepth", request({}, { finality: { mode: "blockDepth", block_depth: 3, safe: true } }), /only valid in finalized/],
    ["a numeric fee token", request({ fee_token: 7 }), /fee_token must be a string/],
    ["a non-EVM fee token", request({ fee_token: `0x${"1".repeat(64)}` }), /fee_token is not an EVM address/],
    ["a non-decimal fee", request({ fee_token_amount: "0x10" }), /fee_token_amount must be a decimal/],
    ["a timestamp without a zone", request({ source_block_timestamp: "2026-10-04T12:34:56" }), /RFC 3339/],
    ["a timestamp on February 30", request({ source_block_timestamp: "2026-02-30T00:00:00Z" }), /RFC 3339/],
  ])("rejects %s", (_label, body, pattern) => {
    const r = parseHookRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });
});

describe("rfc3339Seconds", () => {
  it.each([
    ["1970-01-01T00:00:00Z", 0n],
    ["2026-10-04T12:34:56Z", 1791117296n],
    ["2026-10-04t12:34:56.999z", 1791117296n],
    ["2026-10-04T20:34:56+08:00", 1791117296n],
    ["2026-10-04T07:04:56-05:30", 1791117296n],
    ["2024-02-29T00:00:00Z", 1709164800n],
    ["2000-03-01T00:00:00Z", 951868800n],
    ["1969-12-31T23:59:59Z", -1n],
    ["2016-12-31T23:59:60Z", 1483228800n],
  ])("%s is %i", (text, seconds) => {
    expect(rfc3339Seconds(text)).toBe(seconds);
  });
  it.each([
    "2026-10-04",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-04-00T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-06-01T24:00:00Z",
    "2026-06-01T23:60:00Z",
    "2026-06-01T23:59:61Z",
    "2026-06-01T00:00:00+24:00",
    "2026-06-01T00:00:00+05:60",
  ])("rejects %s", (text) => {
    expect(rfc3339Seconds(text)).toBeNull();
  });
});

describe("requestMeetsConfidence (step 8 finality gate)", () => {
  const parsed = (over: Record<string, unknown>, message: Record<string, unknown> = {}): ParsedMessage => {
    const r = parseHookRequest(request(over, message));
    if (!r.ok) throw new Error(r.error);
    return r.message;
  };
  const fast = { finality: { mode: "blockDepth", block_depth: 5, safe: false } };
  const safeHead = { finality: { mode: "finalized", block_depth: 0, safe: true } };
  it("is proven when the reported finalized head covers the source block, whatever the mode", () => {
    expect(requestMeetsConfidence(parsed({}, fast), "finalized")).toBe(true);
    expect(requestMeetsConfidence(parsed({ finalized_block_number: 10 }, fast), "finalized")).toBe(true);
  });
  it("a blockDepth requirement past the finalized head proves neither finalized nor safe", () => {
    const m = parsed({ finalized_block_number: 9, block_depth: 0 }, fast);
    expect(requestMeetsConfidence(m, "finalized")).toBe(false);
    expect(requestMeetsConfidence(m, "safe")).toBe(false);
    expect(requestMeetsConfidence(m, "latest")).toBe(true);
  });
  it("a safe-head requirement satisfies a safe spec but not a finalized one", () => {
    const m = parsed({ finalized_block_number: 9, block_depth: 0 }, safeHead);
    expect(requestMeetsConfidence(m, "safe")).toBe(true);
    expect(requestMeetsConfidence(m, "finalized")).toBe(false);
  });
});

describe("protectedTransfer (step 3 mapping)", () => {
  const cache: SpecCacheEntry[] = [
    { symbol: "kETH", tokenId: tokenId("kETH"), addresses: new Map([[HOME, CANONICAL], [ARB, REMOTE_ARB.toUpperCase().replace("0X", "0x") as Hex]]) },
  ];
  const parsed = (body: Record<string, unknown>): ParsedMessage => {
    const r = parseHookRequest(body);
    if (!r.ok) throw new Error(r.error);
    return r.message;
  };
  it("maps the source token on the source chain", () => {
    expect(protectedTransfer(parsed(request()), cache)).toMatchObject({ amount: units(10n), entry: { symbol: "kETH" } });
  });
  it("is null for data-only messages and unprotected tokens", () => {
    expect(protectedTransfer(parsed(request({}, { token_transfer: null })), cache)).toBeNull();
    expect(protectedTransfer(parsed(request({}, { source_chain_selector: "1" })), cache)).toBeNull();
  });
});

describe("judge: PRD section 9 steps 3 to 9 with INTERFACES.md revision 2", () => {
  it("step 9: PASS OK with the destination view", () => {
    expect(run(token())).toEqual({
      decision: "PASS",
      reason: Reason.OK,
      symbol: "kETH",
      note: "CONSERVED delta=0 epoch=4182",
      reasonString: "OK kETH CONSERVED delta=0 epoch=4182",
    });
  });

  it("step 4: PASS for a message with no protected token", () => {
    expect(run(null)).toMatchObject({ decision: "PASS", reason: Reason.OK, symbol: null, reasonString: "OK no protected token" });
  });

  it("step 3: UNKNOWN_TOKEN when the registry has no active spec", () => {
    expect(run(token({ activeSpecHash: null }))).toMatchObject({ decision: "FAIL", reason: Reason.UNKNOWN_TOKEN });
  });

  it("step 3: SPEC_MISMATCH when the cache is behind the registry, compared case-insensitively", () => {
    expect(run(token({ activeSpecHash: hash("newer") }))).toMatchObject({ decision: "FAIL", reason: Reason.SPEC_MISMATCH });
    expect(run(token({ activeSpecHash: SPEC_HASH.toUpperCase().replace("0X", "0x") as Hex })).decision).toBe("PASS");
  });

  it("an exhausted time budget is PENDING, not FAIL", () => {
    expect(run(token(), true)).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
  });

  describe("step 5: two providers per chain are PENDING when they cannot agree", () => {
    const failed: StatusRead = { ok: false, error: "timeout" };
    it.each([
      ["source error", { source: [conserved, failed] as const }, "source status read failed"],
      ["source first error", { source: [failed, conserved] as const }, "source status read failed"],
      ["destination error", { destination: [conserved, failed] as const }, "destination status read failed"],
      ["status disagreement", { source: [conserved, { ...conserved, status: Status.BROKEN }] as const }, "disagree"],
      ["staleness disagreement", { destination: [conserved, { ...conserved, stale: true }] as const }, "disagree"],
    ])("%s", (_label, over, note) => {
      const r = run(token(over));
      expect(r).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
      expect(r.note).toContain(note);
    });
  });

  describe("step 6: status", () => {
    const at = (status: Status, extra: Partial<Extract<StatusRead, { ok: true }>> = {}): StatusRead => ({ ...conserved, status, ...extra });
    it.each([
      [Status.BROKEN, Reason.TOKEN_BROKEN],
      [Status.QUARANTINED, Reason.TOKEN_QUARANTINED],
      [Status.RECOVERING, Reason.TOKEN_RECOVERING],
    ] as const)("status %i fails with %i", (status, reason) => {
      const read = at(status, { reason: Reason.DEBIT_NOT_FOUND });
      expect(run(token({ destination: [read, read] }))).toMatchObject({ decision: "FAIL", reason });
    });
    it("quotes the breach reason and incident", () => {
      const read = at(Status.BROKEN, { reason: Reason.DEBIT_NOT_FOUND });
      const r = run(token({ source: [read, read], incidentId: hash("incident") }));
      expect(r.reasonString).toBe(`TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=${hash("incident").slice(0, 6)}...`);
    });
    it("stale and UNKNOWN fail closed by default", () => {
      const stale = at(Status.CONSERVED, { stale: true });
      expect(run(token({ destination: [stale, stale] })).reason).toBe(Reason.STATUS_STALE);
      const unknown = at(Status.UNKNOWN);
      expect(run(token({ source: [unknown, unknown] })).reason).toBe(Reason.STATUS_STALE);
    });
    it("fail_open lets stale and UNKNOWN through to the next steps", () => {
      const stale = at(Status.DRIFT, { stale: true });
      const unknown = at(Status.UNKNOWN);
      const r = run(token({ onStale: "fail_open", source: [unknown, unknown], destination: [stale, stale] }));
      expect(r).toMatchObject({ decision: "PASS", note: "DRIFT delta=0 epoch=4182" });
    });
  });

  it("step 3: a lane outside the spec is a definitive SPEC_MISMATCH", () => {
    expect(run(token({ laneInSpec: false }))).toMatchObject({ decision: "FAIL", reason: Reason.SPEC_MISMATCH, note: "lane not in spec" });
  });

  it("step 7: frozen lanes and tainted senders fail TOKEN_QUARANTINED", () => {
    expect(run(token({ frozen: both(true) }))).toMatchObject({ decision: "FAIL", reason: Reason.TOKEN_QUARANTINED, note: "lanes frozen" });
    expect(run(token({ senderTainted: both(true) }))).toMatchObject({ reason: Reason.TOKEN_QUARANTINED, note: "sender tainted" });
  });

  it("step 7: an agreed flag fails even when the other flag is disputed", () => {
    expect(run(token({ frozen: [ok(true), down], senderTainted: both(true) }))).toMatchObject({ decision: "FAIL", note: "sender tainted" });
    expect(run(token({ frozen: both(true), senderTainted: [ok(false), ok(true)] }))).toMatchObject({ decision: "FAIL", note: "lanes frozen" });
  });

  it.each([
    ["frozen disagreement", { frozen: [ok(false), ok(true)] as const }, "frozen"],
    ["frozen error", { frozen: [down, ok(false)] as const }, "frozen"],
    ["taint error", { senderTainted: [ok(false), down] as const }, "senderTainted"],
    ["debit error", { sourceDebit: [ok<SourceDebitLookup>({ kind: "missing" }), down] as const }, "sourceDebit"],
    ["debit found vs missing", { sourceDebit: [ok<SourceDebitLookup>({ kind: "found", amount: 1n }), ok<SourceDebitLookup>({ kind: "missing" })] as const }, "sourceDebit"],
    ["debit missing vs found", { sourceDebit: [ok<SourceDebitLookup>({ kind: "missing" }), ok<SourceDebitLookup>({ kind: "found", amount: 1n })] as const }, "sourceDebit"],
    ["debit amounts differ", { sourceDebit: [ok<SourceDebitLookup>({ kind: "found", amount: 1n }), ok<SourceDebitLookup>({ kind: "found", amount: 2n })] as const }, "sourceDebit"],
  ])("steps 7 and 8: %s is PENDING", (_label, over, field) => {
    const r = run(token(over));
    expect(r).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
    expect(r.note).toBe(`providers disagree on ${field}, retry`);
  });

  it("step 8: a missing source debit is PENDING; a different amount is a definitive AMOUNT_MISMATCH", () => {
    expect(run(token({ sourceDebit: both<SourceDebitLookup>({ kind: "missing" }) }))).toMatchObject({
      decision: "PENDING",
      reasonString: "PENDING_ATTESTATION kETH source debit not yet visible, retry",
    });
    expect(run(token({ sourceDebit: both<SourceDebitLookup>({ kind: "found", amount: 1n }) }))).toMatchObject({
      decision: "FAIL",
      reason: Reason.AMOUNT_MISMATCH,
    });
  });

  describe("step 8: the source block must meet the spec's confidence before the debit counts", () => {
    const unproven = (head: ReadPair<bigint>): Partial<TokenEvaluation> => ({
      sourceFinality: { proven: false, confidence: "finalized", block: 100n, head },
    });
    it("is PENDING while the source head is below the block, even with a matching debit", () => {
      expect(run(token(unproven(both(99n))))).toMatchObject({
        decision: "PENDING",
        reasonString: "PENDING_ATTESTATION kETH source block 100 not yet finalized (head 99), retry",
      });
    });
    it("is PENDING when the providers disagree on the head", () => {
      expect(run(token(unproven([ok(100n), ok(101n)])))).toMatchObject({
        decision: "PENDING",
        note: "providers disagree on finalized source head, retry",
      });
      expect(run(token(unproven([down, ok(101n)]))).decision).toBe("PENDING");
    });
    it("goes on to the debit once the head reaches the block", () => {
      expect(run(token(unproven(both(100n)))).decision).toBe("PASS");
      const r = run(token({ ...unproven(both(150n)), sourceDebit: both<SourceDebitLookup>({ kind: "found", amount: 1n }) }));
      expect(r).toMatchObject({ decision: "FAIL", reason: Reason.AMOUNT_MISMATCH });
    });
    it("runs after the containment flags, which fail at once", () => {
      expect(run(token({ ...unproven(both(0n)), frozen: both(true) }))).toMatchObject({ decision: "FAIL", note: "lanes frozen" });
    });
  });

  it("caps the reason string at 256 characters", () => {
    expect(run(token({ symbol: "k".repeat(300) })).reasonString).toHaveLength(256);
  });
});

describe("hookResponse", () => {
  it("answers verdicts with HTTP 200 and PENDING with HTTP 503", () => {
    expect(hookResponse(ID, run(token()))).toEqual({
      status: 200,
      body: { decision: "PASS", reason: "OK kETH CONSERVED delta=0 epoch=4182", message_id: ID },
    });
    expect(hookResponse(ID, run(token({ frozen: both(true) }))).status).toBe(200);
    expect(hookResponse(ID, run(token(), true))).toEqual({
      status: 503,
      body: { error: "PENDING_ATTESTATION kETH time budget exceeded, retry" },
    });
  });
});
