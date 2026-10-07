import { tokenId } from "@kirchhoff/engine";
import { DEPLOYMENTS_SCHEMA } from "@kirchhoff/engine/spec";
import Ajv from "ajv";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseArgs, reportMode } from "../src/cli.ts";
import { failureLine, rpcRotation, SIMULATE_ATTEMPTS } from "../src/cre.ts";
import { parseDotEnv } from "../src/env.ts";
import { toEngineDeployments, type DeploymentSet, type RawDeployment } from "../src/deployments.ts";
import { network } from "../src/networks.ts";
import { predictSafe, safeInitializer, SAFE, SAFE_SALT_NONCE, packSignatures } from "../src/safe.ts";

const ADDR = (n: number): `0x${string}` => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

describe("cli", () => {
  it("parses network, options and flags", () => {
    const args = parseArgs(["--network", "testnet", "--reports=direct", "--no-reset"], { options: ["reports"], flags: ["no-reset"] });
    expect(args.network).toBe("testnet");
    expect(reportMode(args)).toBe("direct");
    expect(args.flags.has("no-reset")).toBe(true);
  });
  it("defaults the report mode to cre", () => {
    expect(reportMode(parseArgs(["--network", "local"], { options: [], flags: [] }))).toBe("cre");
  });
  it("rejects an unknown option and a bad network", () => {
    expect(() => parseArgs(["--network", "local", "--bogus", "x"], { options: [], flags: [] })).toThrow();
    expect(() => parseArgs(["--network", "mainnet"], { options: [], flags: [] })).toThrow();
  });
});

describe("env parsing", () => {
  it("reads KEY=VALUE, strips export and quotes, ignores comments", () => {
    const parsed = parseDotEnv(['# comment', 'export A=1', 'B="two"', "C='three'", "D=0x0=weird"].join("\n"));
    expect(parsed).toMatchObject({ A: "1", B: "two", C: "three", D: "0x0=weird" });
  });
});

describe("safe", () => {
  it("predicts a deterministic, chain-independent proxy address", () => {
    const initializer = safeInitializer([ADDR(1), ADDR(2), ADDR(3)]);
    const creationCode = "0x6080" as const; // any fixed creation code yields a stable prediction
    const a = predictSafe(creationCode, initializer, SAFE_SALT_NONCE);
    const b = predictSafe(creationCode, initializer, SAFE_SALT_NONCE);
    expect(a).toBe(b);
    expect(a).not.toBe(SAFE.factory);
  });
  it("sorts packed signatures by signer address ascending", () => {
    const hi = { signer: ADDR(0xff), signature: ("0x" + "aa".repeat(65)) as `0x${string}` };
    const lo = { signer: ADDR(0x01), signature: ("0x" + "bb".repeat(65)) as `0x${string}` };
    expect(packSignatures([hi, lo])).toBe(`0x${"bb".repeat(65)}${"aa".repeat(65)}`);
  });
});

describe("deployments → engine schema", () => {
  const raw = (role: "home" | "remote", chainId: number): RawDeployment => ({
    network: "x",
    role,
    chainId,
    chainSelector: "1",
    forwarderMode: "simulation",
    tokenId: tokenId("kETH"),
    issuerSafe: ADDR(9),
    conservationLedger: ADDR(0x11),
    quarantineController: ADDR(0x12),
    conservationFeed: ADDR(0x13),
    kirchhoffGuard: ADDR(0x14),
    kirchhoffTokenPool: ADDR(0x15),
    weakBridge: ADDR(0x16),
    ccipOnRamp: ADDR(0x17),
    ccipOffRamp: ADDR(0x18),
    ...(role === "home"
      ? { kETH: ADDR(0x1a), homeEscrowAdapter: ADDR(0x1b), ccipLockBox: ADDR(0x1c), kirchhoffRegistry: ADDR(0x1d), demoLendingMarket: ADDR(0x1e) }
      : { remoteKETH: ADDR(0x1f) }),
  });

  it("produces a document the engine's own schema accepts", () => {
    const set = { home: raw("home", 11155111), arb: raw("remote", 421614), base: raw("remote", 84532) } as DeploymentSet;
    const doc = toEngineDeployments(network("testnet"), set);
    const validate = new Ajv({ allErrors: true, strict: true }).compile(DEPLOYMENTS_SCHEMA);
    expect(validate(doc)).toBe(true);
    expect(doc.chains["ethereum-testnet-sepolia"]?.registry).toBe(ADDR(0x1d));
    expect(doc.chains["ethereum-testnet-sepolia"]?.tokens.kETH?.bridges?.weakbridge).toBe(ADDR(0x1b));
    expect(doc.chains["ethereum-testnet-sepolia-arbitrum-1"]?.tokens.kETH?.bridges?.weakbridge).toBe(ADDR(0x16));
    expect(doc.chains["ethereum-testnet-sepolia-base-1"]?.ccip?.onRamp).toBe(ADDR(0x17));
  });
});

describe("networks", () => {
  it("carries the real CCIP 2.0.0 ramps for testnet", () => {
    const n = network("testnet");
    expect(n.chains.home.ccip?.onRamp).toBe("0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777");
    expect(n.chains.base.ccip?.offRamp).toBe("0xa137536A3BFd81aD6f090981268b8C2818451d41");
    expect(network("local").chains.home.ccip).toBeNull();
  });
});

describe("cre provider rotation", () => {
  const repoEnv = {
    RPC_ETH_SEPOLIA_1: "https://sepolia.gateway.tenderly.co",
    RPC_ARB_SEPOLIA_1: "https://arbitrum-sepolia.gateway.tenderly.co",
    RPC_BASE_SEPOLIA_1: "https://base-sepolia.gateway.tenderly.co",
  };

  it("never hands a retry a provider used in either of the two previous attempts", () => {
    for (const urls of Object.values(rpcRotation(repoEnv))) {
      expect(urls.length).toBeGreaterThanOrEqual(3);
      for (let r = 2; r < SIMULATE_ATTEMPTS; r++) {
        const window = [r - 2, r - 1, r].map((i) => urls[i % urls.length]);
        expect(new Set(window).size).toBe(3);
      }
    }
  });

  it("puts a keyed Alchemy endpoint first and keeps the repo providers in the rotation", () => {
    const rotation = rpcRotation({ ...repoEnv, ALCHEMY_API_KEY: "k" });
    expect(rotation.RPC_ETH_SEPOLIA_1[0]).toBe("https://eth-sepolia.g.alchemy.com/v2/k");
    expect(rotation.RPC_ARB_SEPOLIA_1).toContain(repoEnv.RPC_ARB_SEPOLIA_1);
    expect(rotation.RPC_BASE_SEPOLIA_1).toContain(repoEnv.RPC_BASE_SEPOLIA_1);
  });
});

describe("cre retry log", () => {
  it("names the simulator error, else the first failing line, else the last line", () => {
    expect(failureLine({ error: "workflow execution failed: boom", output: "" })).toBe("workflow execution failed: boom");
    expect(failureLine({ error: null, output: "Initializing...\nChecking RPC connectivity...\n429 Too Many Requests\n" })).toBe("429 Too Many Requests");
    expect(failureLine({ error: null, output: "Initializing...\nChecking RPC connectivity...\n" })).toBe("Checking RPC connectivity...");
    expect(failureLine({ error: null, output: "" })).toBe("no output");
    expect(failureLine({ error: "x".repeat(300), output: "" })).toHaveLength(243);
  });
});
