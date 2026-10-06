/**
 * media/video/engine.ts (TESTNET SIMULATION): the two demo-engine calls the recording needs, reusing demo/src as is.
 * Run with the demo package's tsx so demo/src resolves its own dependencies:
 *
 *   demo/node_modules/.bin/tsx media/video/engine.ts epoch <local|testnet>
 *       One W2 Loop Ledger epoch through `cre workflow simulate --broadcast` (fresh CONSERVED epoch before a take).
 *   demo/node_modules/.bin/tsx media/video/engine.ts hook-payload <local|testnet> <attack-jsonl>
 *       The policy-hook v1 request for the attacker's refused CCIP transfer, built by demo/src/attack.ts hookPayload
 *       from the run's own step events, so the Judge can evaluate it while the take is still recording.
 *
 * Prints one JSON line on stdout; progress goes to stderr.
 */
import { readFileSync } from "node:fs";
import { hookPayload, type ReleaseResult } from "../../demo/src/attack.ts";
import { loadContext } from "../../demo/src/context.ts";
import { runWorkflow, settle } from "../../demo/src/engine-run.ts";
import type { NetworkName } from "../../demo/src/networks.ts";

type Hex = `0x${string}`;
type StepLine = { step?: string; status?: string; txHash?: string; detail?: Record<string, unknown> };

function networkArg(v: string | undefined): NetworkName {
  if (v !== "local" && v !== "testnet") throw new Error(`network must be local or testnet, got ${v ?? "nothing"}`);
  return v;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX20 = /^0x[0-9a-fA-F]{40}$/;

function hex32(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !HEX32.test(v)) throw new Error(`${what} missing from the attack log`);
  return v as Hex;
}

async function epoch(net: NetworkName): Promise<void> {
  const ctx = await loadContext(net);
  // Anvil: mine past the finalized pin. Testnets: W2 reads whatever is final now, no wait (demo/src/attack.ts baselineEpoch).
  if (net === "local") await settle(ctx);
  const run = await runWorkflow(ctx, "w2-loop", 0);
  process.stdout.write(`${JSON.stringify({ result: run.result.result, writes: run.writes })}\n`);
}

async function payload(net: NetworkName, logPath: string): Promise<void> {
  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as StepLine);
  const forged = lines.find((l) => l.step === "forge-credit" && l.status === "ok");
  const refused = lines.find((l) => l.step === "refuse-ccip" && l.status === "refused");
  if (forged === undefined || refused === undefined) throw new Error("the attack log has no forged credit or no refused CCIP attempt yet");
  const attacker = forged.detail?.attacker;
  if (typeof attacker !== "string" || !HEX20.test(attacker)) throw new Error("attacker missing from the attack log");
  const forgedId = hex32(forged.detail?.forgedId, "forgedId");
  const releaseHash = hex32(forged.txHash, "forged credit tx");
  const refusalHash = hex32(refused.txHash, "refused CCIP tx");

  const ctx = await loadContext(net);
  const home = ctx.chains.home.client;
  const releaseReceipt = await home.getTransactionReceipt({ hash: releaseHash });
  const refusalReceipt = await home.getTransactionReceipt({ hash: refusalHash });
  const amount = BigInt(String(lines.find((l) => l.step === "forge-credit" && l.status === "started")?.detail?.amount ?? "0"));
  if (amount === 0n) throw new Error("forged amount missing from the attack log");
  // hookPayload reads only these fields of the release.
  const release = { attacker: attacker as Hex, amount, forgedId, tx: { hash: releaseHash, receipt: releaseReceipt } } as unknown as ReleaseResult;
  const body = hookPayload(ctx, release, { hash: refusalHash, blockNumber: refusalReceipt.blockNumber });
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

const [cmd, net, arg] = process.argv.slice(2);
try {
  if (cmd === "epoch") await epoch(networkArg(net));
  else if (cmd === "hook-payload") await payload(networkArg(net), arg ?? "");
  else throw new Error("usage: engine.ts epoch <network> | hook-payload <network> <attack-jsonl>");
  process.exit(0);
} catch (e) {
  process.stderr.write(`engine.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
