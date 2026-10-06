/**
 * media/video/record.ts: records the 2:30 KIRCHHOFF stage demo (PRD section 15) from a REAL Kelp Replay run.
 *
 *   node media/video/record.ts --network local|testnet --take <n> [--label <text>] [--voice <say voice>|none]
 *   node media/video/record.ts --select <n>          copy takes/take-<n>.mp4 to media/video/kirchhoff-demo.mp4
 *
 * Needs the recording stack (bash media/video/stack-up.sh <network>): web in api mode on :3005, the API with
 * LAB_ENABLED=true on :8090 (its Attack Lab runs media/video/lab-attack.sh), the Judge on :8790 sinking verdicts
 * into that API. One browser page at 1920x1080 (deviceScaleFactor 1, stage mode, dark theme) is driven through the
 * PRD beats. Its screencast feeds a ring buffer; a beat records only the windows that matter and the waits between
 * them (Sepolia finality is minutes) are trimmed. Nothing is reordered or synthesized: every frame is the live UI or
 * a live explorer page, in the order it happened. Playwright recordVideo keeps the untrimmed session as the raw take.
 *
 * Output: media/video/takes/take-<n>.mp4 (H.264, 1920x1080, 30 fps, AAC voiceover when `say` is available), the
 * manifest take-<n>.json (beats, segments, every tx shown) and stills per beat in takes/work-<n>/stills/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TAKES = join(HERE, "takes");
const STACK = join(HERE, ".stack");
const ATTACK_LOG = join(STACK, "attack-latest.jsonl");
const DEMO_TSX = join(ROOT, "demo", "node_modules", ".bin", "tsx");

// Playwright is the web package's devDependency; resolve it from there instead of adding a second copy.
const requireFromWeb = createRequire(join(ROOT, "web", "package.json"));
const { chromium } = requireFromWeb("@playwright/test") as typeof import("@playwright/test");

const W = 1920;
const H = 1080;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type Network = "local" | "testnet";
type Role = "home" | "arb" | "base";

/** PRD section 15, "Recorded demo, 2 minutes 30 seconds". Voiceover lines verbatim; captions never use em dashes. */
const BEATS = [
  { id: "title", dur: 15, line: "In April, one forged message created $292M from nothing.", caption: true },
  { id: "idle", dur: 20, line: "This is kETH on three chains. Every transfer is checked by our verifier inside CCIP 2.0.", caption: true },
  { id: "attack", dur: 30, line: "Here is the Kelp attack, on a bridge with a single verifier.", caption: true },
  { id: "breach", dur: 20, line: "In the same CRE run, Kirchhoff finds a credit with no debit.", caption: true },
  { id: "ccip", dur: 25, line: "The attacker tries to spread it. Our verifier refuses to sign.", caption: true },
  { id: "guard", dur: 15, line: "He cannot move it, and nobody will lend against it.", caption: true },
  { id: "incident", dur: 15, line: "On-call gets the whole story in one screen.", caption: true },
  // The closing card already shows the tagline, so it is spoken but not captioned twice.
  { id: "closing", dur: 10, line: "Every bridge checks who signed. Kirchhoff checks if the money adds up.", caption: false },
] as const;
type BeatId = (typeof BEATS)[number]["id"];

const EXPLORER: Record<Role, string> = {
  home: "https://sepolia.etherscan.io",
  arb: "https://sepolia.arbiscan.io",
  base: "https://sepolia.basescan.org",
};
const LOCAL_RPC: Record<Role, string> = { home: "http://127.0.0.1:8545", arb: "http://127.0.0.1:8546", base: "http://127.0.0.1:8547" };
const CHAIN_NAME: Record<Role, string> = { home: "Ethereum Sepolia", arb: "Arbitrum Sepolia", base: "Base Sepolia" };

class RecordError extends Error {
  override readonly name = "RecordError";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (msg: string): void => {
  process.stderr.write(`[record ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

type Options = { network: Network; take: number; label: string; voice: string | null; web: string; api: string; judge: string };

function parseOptions(argv: string[]): Options | { select: number } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const select = get("select");
  if (select !== undefined) {
    const n = Number(select);
    if (!Number.isInteger(n) || n < 1) throw new RecordError("--select takes a take number");
    return { select: n };
  }
  const network = get("network") ?? "local";
  if (network !== "local" && network !== "testnet") throw new RecordError("--network must be local or testnet");
  const take = Number(get("take"));
  if (!Number.isInteger(take) || take < 1) throw new RecordError("--take <n> is required (a positive integer)");
  const voice = get("voice") ?? "Samantha";
  return {
    network,
    take,
    label: get("label") ?? (network === "local" ? "Local rehearsal" : "Testnet simulation"),
    voice: voice === "none" ? null : voice,
    web: get("web") ?? "http://localhost:3005",
    api: get("api") ?? "http://127.0.0.1:8090",
    judge: get("judge") ?? "http://127.0.0.1:8790",
  };
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/** Runs a command to completion; rejects with its stderr tail on a non-zero exit. */
function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new RecordError(`${cmd} ${args.slice(0, 3).join(" ")} exited ${code}: ${err.slice(-800)}`))));
    child.stdin.end(opts.input ?? "");
  });
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new RecordError(`${init?.method ?? "GET"} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------------------------
// Read model and attack log
// ---------------------------------------------------------------------------------------------

type TokenRow = { symbol: string; status: string; delta: string; stale: boolean; activeIncidentId: string | null };

async function token(api: string): Promise<TokenRow> {
  const res = await http<{ items: TokenRow[] }>(`${api}/v1/tokens`);
  const t = res.items.find((i) => i.symbol === "kETH");
  if (t === undefined) throw new RecordError("kETH is not in the read model");
  return t;
}

type StepEvent = { step: string; status: string; chain?: Role; txHash?: string; revertReason?: string; title?: string; at?: string; detail?: Record<string, unknown> };

function attackEvents(since: number): StepEvent[] {
  if (!existsSync(ATTACK_LOG)) return [];
  return readFileSync(ATTACK_LOG, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l): StepEvent[] => {
      try {
        const e = JSON.parse(l) as StepEvent;
        return typeof e.step === "string" && typeof e.at === "string" && Date.parse(e.at) >= since ? [e] : [];
      } catch {
        return [];
      }
    });
}

async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null, timeoutMs: number, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new RecordError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    if (Date.now() - lastLog > 60_000) {
      log(`waiting for ${what}`);
      lastLog = Date.now();
    }
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Recorder: screencast frames -> ring buffer -> constant 30 fps H.264 segments
// ---------------------------------------------------------------------------------------------

type Frame = { t: number; data: Buffer };
type Segment = { beat: BeatId; file: string; frames: number; startedAt: string; preRollMs: number; note: string };

class Recorder {
  private ring: Frame[] = [];
  private open: { ff: ChildProcess; next: number; start: number; file: string; frames: number; beat: BeatId; preRollMs: number; note: string; closed: Promise<number | null> } | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  readonly segments: Segment[] = [];
  private count = 0;

  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async attach(page: Page): Promise<void> {
    await page.screencast.start({ size: { width: W, height: H }, quality: 92, onFrame: (f) => this.onFrame(f.data) });
    this.pumpTimer = setInterval(() => this.pump(Date.now() - 120), 20);
  }

  detach(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
  }

  private onFrame(data: Buffer): void {
    this.ring.push({ t: Date.now(), data });
    // Keep ~12 s for pre-roll plus everything an open segment has not consumed; always keep the frame on screen.
    const floor = Math.min(Date.now() - 12_000, this.open?.next ?? Number.POSITIVE_INFINITY);
    let drop = 0;
    while (drop < this.ring.length - 1 && (this.ring[drop + 1]?.t ?? Infinity) <= floor) drop++;
    if (drop > 0) this.ring.splice(0, drop);
  }

  /** The frame on screen at time t: the latest frame received at or before t. */
  private frameAt(t: number): Buffer | null {
    let pick: Frame | undefined;
    for (const f of this.ring) {
      if (f.t <= t) pick = f;
      else break;
    }
    return (pick ?? this.ring[0])?.data ?? null;
  }

  private pump(until: number): void {
    const seg = this.open;
    if (!seg?.ff.stdin) return;
    while (seg.next <= until) {
      const data = this.frameAt(seg.next);
      if (data === null) return;
      seg.ff.stdin.write(data);
      seg.frames++;
      seg.next += FRAME_MS;
    }
  }

  get recording(): boolean {
    return this.open !== null;
  }

  /** Milliseconds the open segment holds so far (0 when closed). */
  openMs(): number {
    return this.open ? this.open.frames * FRAME_MS + Math.max(0, Date.now() - this.open.next) : 0;
  }

  start(beat: BeatId, note: string, preRollMs = 0): void {
    if (this.open) throw new RecordError("a segment is already recording");
    const oldest = this.ring[0]?.t ?? Date.now();
    const start = Math.max(oldest, Date.now() - preRollMs);
    const file = join(this.dir, `seg-${String(++this.count).padStart(3, "0")}-${beat}.mp4`);
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-r", String(FPS), file], { stdio: ["pipe", "ignore", "inherit"] });
    const closed = new Promise<number | null>((resolve) => ff.on("close", resolve));
    this.open = { ff, next: start, start, file, frames: 0, beat, preRollMs: Date.now() - start, note, closed };
    log(`  rec ● ${beat}: ${note}${preRollMs > 0 ? ` (pre-roll ${Math.round((Date.now() - start) / 100) / 10}s)` : ""}`);
  }

  async stop(): Promise<Segment> {
    const seg = this.open;
    if (!seg) throw new RecordError("no segment is recording");
    this.pump(Date.now());
    this.open = null;
    seg.ff.stdin?.end();
    const code = await seg.closed;
    if (code !== 0) throw new RecordError(`ffmpeg exited ${code} for ${seg.file}`);
    const out: Segment = { beat: seg.beat, file: seg.file, frames: seg.frames, startedAt: new Date(seg.start).toISOString(), preRollMs: Math.round(seg.preRollMs), note: seg.note };
    this.segments.push(out);
    log(`  rec ■ ${seg.beat}: ${(seg.frames / FPS).toFixed(1)}s`);
    return out;
  }
}

/** Beat bookkeeping: each beat has a target length; holds never run past it and finish() pads up to it. */
class Director {
  private beat: (typeof BEATS)[number] = BEATS[0];
  private recordedMs = 0;
  readonly overruns: string[] = [];

  private readonly rec: Recorder;

  constructor(rec: Recorder) {
    this.rec = rec;
  }

  enter(id: BeatId): void {
    const b = BEATS.find((x) => x.id === id);
    if (!b) throw new RecordError(`unknown beat ${id}`);
    this.beat = b;
    this.recordedMs = 0;
    log(`beat ${id} (${b.dur}s)`);
  }

  remaining(): number {
    return this.beat.dur * 1000 - (this.recordedMs + this.rec.openMs());
  }

  roll(note: string, preRollMs = 0): void {
    this.rec.start(this.beat.id, note, preRollMs);
  }

  async cut(): Promise<void> {
    const seg = await this.rec.stop();
    this.recordedMs += seg.frames * FRAME_MS;
  }

  /** Hold the shot for `ms`, but never past this beat's budget minus `reserveMs` for the shots still to come. */
  async hold(ms: number, reserveMs = 0): Promise<void> {
    await sleep(Math.min(ms, this.remaining() - reserveMs));
  }

  /** Pads the beat to its target on the current screen, then closes it. */
  async finish(note = "hold"): Promise<void> {
    if (!this.rec.recording && this.remaining() > 400) this.roll(note);
    if (this.rec.recording) {
      await sleep(this.remaining());
      await this.cut();
    }
    const over = -this.remaining();
    if (over > 600) {
      this.overruns.push(`${this.beat.id} +${(over / 1000).toFixed(1)}s`);
      log(`  beat ${this.beat.id} ran ${(over / 1000).toFixed(1)}s over its ${this.beat.dur}s budget`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// In-page HUD (every UI frame: "Testnet simulation", the take label and a live UTC clock) and the stage cursor
// ---------------------------------------------------------------------------------------------

function hudScript(cfg: { label: string; rehearsal: boolean }): string {
  return `(() => {
  if (location.pathname.endsWith("/card.html")) return;
  const cfg = ${JSON.stringify(cfg)};
  const mount = () => {
    if (document.getElementById("kh-rec-hud")) return;
    const host = document.createElement("div");
    host.id = "kh-rec-hud";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = \`<style>
      .hud { position: fixed; right: 22px; bottom: 20px; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 12px;
        border-radius: 9px; background: rgba(11,13,16,0.88); border: 1px solid rgba(251,191,36,0.38); box-shadow: 0 8px 24px -10px rgba(0,0,0,0.7);
        font: 500 14px/1 Inter, system-ui, sans-serif; color: #fbbf24; letter-spacing: 0.01em; }
      .hud svg { width: 15px; height: 15px; }
      .sep { width: 1px; height: 16px; background: rgba(154,163,175,0.35); }
      .clock { font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; color: #e7eaee; font-weight: 500; }
      .reh { color: #fda4af; font-weight: 600; }
      .cur { position: fixed; left: 0; top: 0; width: 30px; height: 30px; transform: translate(-100px,-100px); transition: transform 40ms linear; }
      .cur svg { width: 30px; height: 30px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.55)); }
      .ring { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid rgba(45,212,191,0.9); opacity: 0; }
      .ring.on { animation: ring 520ms cubic-bezier(0.22,1,0.36,1); }
      @keyframes ring { from { opacity: 1; transform: var(--at) scale(0.4); } to { opacity: 0; transform: var(--at) scale(1.4); } }
    </style>
    <div class="hud"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/></svg>Testnet simulation\${cfg.rehearsal ? '<span class="sep"></span><span class="reh">' + cfg.label + '</span>' : ''}<span class="sep"></span><span class="clock"></span></div>
    <div class="ring"></div>
    <div class="cur"><svg viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.3 L11.6 22 L14.6 20.7 L11.7 14.1 L18 14.1 Z" fill="#fff" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/></svg></div>\`;
    document.documentElement.appendChild(host);
    const clock = root.querySelector(".clock");
    const tick = () => { clock.textContent = new Date().toISOString().slice(11, 19) + " UTC"; };
    tick();
    setInterval(tick, 250);
    const cur = root.querySelector(".cur");
    const ring = root.querySelector(".ring");
    addEventListener("mousemove", (e) => { cur.style.transform = "translate(" + (e.clientX - 4) + "px," + (e.clientY - 2) + "px)"; }, { capture: true, passive: true });
    addEventListener("mousedown", (e) => {
      ring.style.setProperty("--at", "translate(" + e.clientX + "px," + e.clientY + "px)");
      ring.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
      ring.classList.remove("on"); void ring.offsetWidth; ring.classList.add("on");
    }, { capture: true, passive: true });
  };
  // After hydration, so React never sees a foreign node while it hydrates <html>.
  const later = () => setTimeout(mount, 400);
  if (document.readyState === "complete") later(); else addEventListener("load", later);
})();`;
}

// ---------------------------------------------------------------------------------------------
// Explorer shots
// ---------------------------------------------------------------------------------------------

type Shown = { beat: BeatId; chain: Role; hash: string; what: string; url: string };

type RpcTx = { from: string; to: string | null; input: string; blockNumber: string; value: string };
type RpcReceipt = { status: string; gasUsed: string; logs: unknown[]; blockNumber: string };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await http<{ result?: T; error?: { message: string } }>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.result === undefined) throw new RecordError(`${method}: ${res.error?.message ?? "no result"}`);
  return res.result;
}

function contractNames(role: Role): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, "deployments", `local-${role}.raw.json`), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v)) names.set(v.toLowerCase(), k);
  } catch {
    // No raw record: addresses are shown without names.
  }
  return names;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/**
 * Anvil has no block explorer, so a local take shows the transaction exactly as the node returns it (eth_getTransaction,
 * eth_getTransactionReceipt, the block time), labeled as the local stand-in for the Etherscan shot of a testnet take.
 */
async function localReceiptPage(dir: string, role: Role, hash: string, what: string, revert: string | undefined): Promise<string> {
  const url = LOCAL_RPC[role];
  const tx = await rpc<RpcTx>(url, "eth_getTransactionByHash", [hash]);
  const rc = await rpc<RpcReceipt>(url, "eth_getTransactionReceipt", [hash]);
  const block = await rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", [rc.blockNumber, false]);
  const names = contractNames(role);
  const who = (a: string | null): string => (a === null ? "contract creation" : `${names.get(a.toLowerCase()) ?? "account"} <span class="m">${a}</span>`);
  const ok = rc.status === "0x1";
  const time = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString().replace("T", " ").slice(0, 19);
  const rows: [string, string][] = [
    ["Transaction hash", `<span class="m">${hash}</span>`],
    ["Status", ok ? '<span class="ok">Success</span>' : `<span class="bad">Reverted</span>${revert ? ` <span class="m reason">${escapeHtml(revert)}</span>` : ""}`],
    ["Block", `<span class="m">${BigInt(rc.blockNumber).toString()}</span>`],
    ["Timestamp", `<span class="m">${time} UTC</span> (block time on the local chain)`],
    ["From", who(tx.from)],
    ["To", who(tx.to)],
    ["Function selector", `<span class="m">${tx.input.slice(0, 10)}</span>`],
    ["Gas used", `<span class="m">${BigInt(rc.gasUsed).toLocaleString("en-US")}</span>`],
    ["Event logs", `<span class="m">${rc.logs.length}</span>`],
  ];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local receipt</title><style>
    *{box-sizing:border-box;margin:0}body{background:#0b0d10;color:#e7eaee;font:400 20px/1.5 Inter,system-ui,sans-serif;padding:72px 200px}
    .top{display:flex;align-items:center;gap:14px;color:#9aa3af;font-size:18px}.pill{border:1px solid #2a313b;border-radius:8px;padding:4px 10px;font-weight:600;color:#e7eaee}
    h1{font-size:40px;font-weight:600;letter-spacing:-0.02em;margin:28px 0 6px}.sub{color:#9aa3af;font-size:19px;margin-bottom:34px}
    .card{background:#12151a;border:1px solid #2a313b;border-radius:12px;padding:8px 32px}.row{display:grid;grid-template-columns:300px 1fr;gap:24px;padding:18px 0;border-bottom:1px solid #1e242c}
    .row:last-child{border-bottom:0}.k{color:#9aa3af}.m{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:18px;color:#e7eaee;word-break:break-all}
    .ok{color:#2dd4bf;font-weight:600}.bad{color:#f43f5e;font-weight:600}.reason{display:block;margin-top:6px;color:#fda4af}
  </style></head><body><div class="top"><span class="pill">Anvil</span>${CHAIN_NAME[role]} stand-in · chain ${Number(BigInt(await rpc<string>(url, "eth_chainId", [])))} · ${url.replace("http://", "")}</div>
  <h1>${escapeHtml(what)}</h1><p class="sub">Transaction receipt read from the local node. A testnet take shows this transaction on the public explorer.</p>
  <div class="card">${rows.map(([k, v]) => `<div class="row"><div class="k">${k}</div><div>${v}</div></div>`).join("")}</div></body></html>`;
  const file = join(dir, `receipt-${role}-${hash.slice(2, 10)}.html`);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

async function showExplorer(page: Page, net: Network, workDir: string, role: Role, hash: string, what: string, revert?: string): Promise<string> {
  if (net === "local") {
    const url = await localReceiptPage(workDir, role, hash, what, revert);
    await page.goto(url, { waitUntil: "load" });
    await sleep(500);
    return url;
  }
  const url = `${EXPLORER[role]}/tx/${hash}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector("#ContentPlaceHolder1_maintable, #ContentPlaceHolder1_divSummary, main", { timeout: 30_000 }).catch(() => undefined);
  const cookie = page.getByRole("button", { name: /got it/i });
  if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => undefined);
  // Etherscan centers a ~1350px column; zoom so the status line reads on a projector.
  await page.evaluate(() => {
    document.body.style.zoom = "1.3";
  });
  await sleep(1200);
  return url;
}

// ---------------------------------------------------------------------------------------------
// App screens
// ---------------------------------------------------------------------------------------------

async function openApp(page: Page, base: string, path: string, ready: string): Promise<void> {
  const sep = path.includes("?") ? "&" : "?";
  await page.goto(`${base}${path}${sep}stage=1&theme=dark`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ready, { timeout: 30_000 });
  // Skeletons resolve and the HUD mounts (0.4 s after load).
  await page.waitForLoadState("load");
  await sleep(1400);
}

// Selectors lean on data-testid, ARIA roles and visible text only, so a visual redesign does not break a take.
const VERDICTS_PANEL = ':is(section, [aria-labelledby]):has(h2:text-is("Verdicts"))';

async function glide(page: Page, x: number, y: number, ms = 700): Promise<void> {
  await page.mouse.move(x, y, { steps: Math.max(8, Math.round(ms / 16)) });
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number } | null> {
  const box = await page.locator(selector).first().boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

// ---------------------------------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------------------------------

type Manifest = {
  take: number;
  network: Network;
  label: string;
  recordedAt: string;
  durationSeconds: number;
  beats: { id: BeatId; start: number; duration: number; line: string }[];
  segments: Segment[];
  shown: Shown[];
  incidentId: string | null;
  labRunId: string | null;
  verdictReplay: unknown;
  overruns: string[];
  voice: string | null;
};

async function prepare(o: Options): Promise<void> {
  const health = await http<{ ok: boolean; lab: boolean }>(`${o.api}/healthz`);
  if (!health.lab) throw new RecordError(`the API at ${o.api} has the Attack Lab disabled; start it with media/video/stack-up.sh`);
  await http<unknown>(`${o.judge}/readyz`);
  const lab = await http<{ run: { state: string } | null }>(`${o.api}/v1/lab/status`);
  if (lab.run?.state === "running") throw new RecordError("a Kelp Replay is already running");
  let t = await token(o.api);
  if (t.status !== "CONSERVED" && t.status !== "UNKNOWN") {
    if (o.network !== "local") throw new RecordError(`kETH is ${t.status} on testnet; run demo/reset.ts --network testnet first`);
    log(`kETH is ${t.status}: demo reset on local`);
    await run("pnpm", ["--silent", "--filter", "@kirchhoff/demo", "reset", "--network", "local", "--reports", "cre"]);
  }
  // A fresh W2 epoch so the idle beat opens CONSERVED and inside the 120 s staleness window.
  log("W2 epoch (cre workflow simulate) for a fresh CONSERVED baseline");
  const epoch = await run(DEMO_TSX, [join(HERE, "engine.ts"), "epoch", o.network]);
  log(`  ${epoch.trim().slice(0, 160)}`);
  t = await waitFor("CONSERVED and fresh in the read model", async () => {
    const x = await token(o.api);
    return x.status === "CONSERVED" && !x.stale ? x : null;
  }, 60_000);
  log(`kETH ${t.status} Δ ${t.delta}`);
}

async function recordTake(o: Options): Promise<Manifest> {
  const work = join(TAKES, `work-${o.take}`);
  const raw = join(TAKES, `raw-${o.take}`);
  rmSync(work, { recursive: true, force: true });
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(join(work, "stills"), { recursive: true });
  mkdirSync(raw, { recursive: true });

  await prepare(o);

  const browser: Browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled", "--force-color-profile=srgb"] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    userAgent: UA,
    recordVideo: { dir: raw, size: { width: W, height: H } },
  });
  await context.addInitScript(hudScript({ label: o.label, rehearsal: o.network === "local" }));
  const page = await context.newPage();
  const rec = new Recorder(work);
  const d = new Director(rec);
  const shown: Shown[] = [];
  let verdictReplay: unknown = null;
  let incidentId: string | null = null;
  let labRunId: string | null = null;
  const tone = o.network === "local" ? "local" : "testnet";
  const card = (kind: "title" | "closing", footer = ""): string =>
    `${pathToFileURL(join(HERE, "pages", "card.html")).href}?kind=${kind}&tone=${tone}&label=${encodeURIComponent(o.label)}${footer ? `&footer=${encodeURIComponent(footer)}` : ""}`;

  try {
    await page.goto("about:blank");
    await rec.attach(page);

    // 0:00 Title card: black, then the Kelp headline numbers.
    d.enter("title");
    await page.goto(card("title"), { waitUntil: "load" });
    d.roll("title card");
    await d.hold(BEATS[0].dur * 1000 - 800);
    await page.evaluate(() => (window as unknown as { cardOut: () => void }).cardOut());
    await d.finish();

    // 0:15 Mission Control idle: CONSERVED, a normal transfer pulses through.
    d.enter("idle");
    await openApp(page, o.web, "/app/tokens/kETH", '[data-testid="status-pill"][data-status="CONSERVED"]');
    await page.mouse.move(W - 260, 300);
    d.roll("Mission Control, CONSERVED");
    if (o.network === "local") {
      // Flow A on Anvil: a WeakBridge round trip whose every credit has a real debit (no CCIP Router on Anvil).
      void run("pnpm", ["--silent", "--filter", "@kirchhoff/demo", "seed", "--network", "local", "--weakbridge"]).catch((e: unknown) => log(`seed failed: ${String(e)}`));
    }
    await d.hold(5000);
    const verdicts = await centerOf(page, VERDICTS_PANEL);
    if (verdicts) await glide(page, verdicts.x, verdicts.y - 120, 900);
    await d.finish();

    // 0:35 Attack Lab beside Mission Control: forge the WeakBridge message, show the release on the explorer.
    d.enter("attack");
    await openApp(page, o.web, "/lab", '[data-testid="run-kelp-replay"]:not([disabled])');
    const button = await centerOf(page, '[data-testid="run-kelp-replay"]');
    if (!button) throw new RecordError("Run Kelp Replay button not found");
    await page.mouse.move(button.x + 340, button.y + 260);
    d.roll("Attack Lab idle");
    await d.hold(2500);
    await glide(page, button.x, button.y, 900);
    await d.hold(400);
    const clickedAt = Date.now() - 2000;
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.move(button.x + 200, button.y + 420, { steps: 30 });
    const forged = page.locator('[data-testid="lab-step-forge_release"][data-state="done"]');
    await forged.waitFor({ timeout: Math.max(1000, d.remaining() - 16_000) }).catch(() => undefined);
    if (!(await forged.isVisible())) {
      await d.cut();
      await forged.waitFor({ timeout: 300_000 });
      d.roll("forged release confirmed", 2500);
    }
    const lab = await http<{ run: { id: string } | null }>(`${o.api}/v1/lab/status`);
    labRunId = lab.run?.id ?? null;
    await d.hold(4000);
    await d.cut();
    const forge = await waitFor("forged credit tx in the attack log", () => attackEvents(clickedAt).find((e) => e.step === "forge-credit" && e.status === "ok" && e.txHash) ?? null, 120_000);
    const forgeUrl = await showExplorer(page, o.network, work, "home", forge.txHash ?? "", "Forged WeakBridge credit: 116,500 kETH released with no burn");
    shown.push({ beat: "attack", chain: "home", hash: forge.txHash ?? "", what: "forged WeakBridge credit", url: forgeUrl });
    d.roll("explorer: forged release");
    await d.hold(4000, 3000);
    await d.cut();
    await openApp(page, o.web, "/lab", '[data-testid="lab-step-forge_release"]');
    await d.finish("Attack Lab after the release");

    // 1:05 Mission Control: the wire turns red (W1 in one CRE run), BREACH report txs on all three chains.
    d.enter("breach");
    await openApp(page, o.web, "/app/tokens/kETH", '[data-testid="status-pill"]');
    const brokenNow = (await token(o.api)).status !== "CONSERVED";
    if (!brokenNow) {
      await waitFor("BROKEN in the read model", async () => ((await token(o.api)).status !== "CONSERVED" ? true : null), 40 * 60_000, 150);
      d.roll("BROKEN arrives live", 3000);
    } else {
      d.roll("Mission Control, already BROKEN");
    }
    await d.hold(11_000, 9000);
    await d.cut();
    const breaches = await waitFor("BREACH writes on all three chains", () => {
      const per = new Map<Role, StepEvent>();
      for (const e of attackEvents(clickedAt)) if (e.step === "breach" && e.status === "ok" && e.chain && e.txHash && !per.has(e.chain)) per.set(e.chain, e);
      return per.size === 3 ? per : null;
    }, 10 * 60_000);
    for (const role of ["home", "arb", "base"] as const) {
      const e = breaches.get(role);
      if (!e?.txHash) continue;
      const url = await showExplorer(page, o.network, work, role, e.txHash, `BREACH report written to the ${CHAIN_NAME[role]} ConservationLedger`);
      shown.push({ beat: "breach", chain: role, hash: e.txHash, what: "BREACH report", url });
      d.roll(`explorer: BREACH on ${role}`);
      await d.hold(2800);
      await d.cut();
    }
    await d.finish();

    // 1:25 The attacker's CCIP attempt is refused; the Judge answers FAIL for the message.
    d.enter("ccip");
    await openApp(page, o.web, "/lab", '[data-testid="lab-step-ccip_refused"]');
    const ccipDone = page.locator('[data-testid="lab-step-ccip_refused"][data-state="done"]');
    if (!(await ccipDone.isVisible())) {
      await waitFor("the attacker's CCIP attempt", () => attackEvents(clickedAt).find((e) => e.step === "refuse-ccip") ?? null, 40 * 60_000);
      d.roll("CCIP attempt in the attacker console", 1500);
      await ccipDone.waitFor({ timeout: Math.max(1000, d.remaining() - 15_000) }).catch(() => undefined);
      if (!(await ccipDone.isVisible())) {
        await d.cut();
        await ccipDone.waitFor({ timeout: 10 * 60_000 });
        d.roll("CCIP refusal mined", 2500);
      }
    } else {
      d.roll("Attack Lab, CCIP refused");
    }
    const console_ = await centerOf(page, '[role="log"]');
    if (console_) await glide(page, console_.x, console_.y, 800);
    await d.hold(3500);
    // Judge replay (Fallback C): the policy-hook v1 request for this message, evaluated live by the Judge, whose verdict
    // sink writes the row the Verdict Stream shows.
    const payload = await run(DEMO_TSX, [join(HERE, "engine.ts"), "hook-payload", o.network, ATTACK_LOG]);
    verdictReplay = await http<unknown>(`${o.judge}/v1/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: payload.trim() });
    log(`  Judge: ${JSON.stringify(verdictReplay)}`);
    const verdictRow = await centerOf(page, VERDICTS_PANEL);
    if (verdictRow) await glide(page, verdictRow.x, verdictRow.y, 900);
    await d.hold(5000, 9000);
    await d.cut();
    const ccip = attackEvents(clickedAt).find((e) => e.step === "refuse-ccip" && e.status === "refused" && e.txHash);
    if (ccip?.txHash) {
      const url = await showExplorer(page, o.network, work, ccip.chain ?? "home", ccip.txHash, "Attacker CCIP transfer to Base: reverted", ccip.revertReason);
      shown.push({ beat: "ccip", chain: ccip.chain ?? "home", hash: ccip.txHash, what: `refused CCIP attempt (${ccip.revertReason ?? "reverted"})`, url });
      d.roll("explorer: refused CCIP");
      await d.hold(3800, 4000);
      await d.cut();
    }
    await openApp(page, o.web, "/app/tokens/kETH", '[data-testid="status-pill"]');
    await d.finish("Mission Control, FAIL row on top of the Verdict Stream");

    // 1:50 Guard revert and borrow() reverting CollateralBroken(); then W2 confirms the deficit.
    d.enter("guard");
    await openApp(page, o.web, "/lab", '[data-testid="lab-step-guard_and_lending"]');
    const guardDone = page.locator('[data-testid="lab-step-guard_and_lending"][data-state="done"]');
    if (!(await guardDone.isVisible())) {
      await waitFor("the Guard attempt", () => attackEvents(clickedAt).find((e) => e.step === "refuse-guard") ?? null, 40 * 60_000);
      d.roll("Guard and lending attempts", 1500);
      await guardDone.waitFor({ timeout: 6000 }).catch(() => undefined);
      if (!(await guardDone.isVisible())) {
        await d.cut();
        await guardDone.waitFor({ timeout: 10 * 60_000 });
        d.roll("borrow refusal mined", 2500);
      }
    } else {
      d.roll("Attack Lab, Guard and lending held");
    }
    await d.hold(4000, 9000);
    await d.cut();
    const borrow = attackEvents(clickedAt).find((e) => e.step === "refuse-borrow" && e.status === "refused" && e.txHash);
    if (borrow?.txHash) {
      const url = await showExplorer(page, o.network, work, borrow.chain ?? "home", borrow.txHash, "Attacker borrow() against the forged kETH: reverted", borrow.revertReason);
      shown.push({ beat: "guard", chain: borrow.chain ?? "home", hash: borrow.txHash, what: `borrow (${borrow.revertReason ?? "reverted"})`, url });
      d.roll("explorer: borrow revert");
      await d.hold(3500, 5000);
      await d.cut();
    }
    await openApp(page, o.web, "/app/tokens/kETH", '[data-testid="status-pill"]');
    const deficit = (await token(o.api)).delta.startsWith("-");
    if (!deficit) {
      await waitFor("the W2 Loop Rule deficit", async () => ((await token(o.api)).delta.startsWith("-") ? true : null), 40 * 60_000, 150);
      d.roll("Δ counts to the deficit live", 2500);
    } else {
      d.roll("Mission Control, Δ deficit");
    }
    await d.finish();

    // 2:05 Incident Room: narrative with citations, containment checklist.
    d.enter("incident");
    incidentId = (await token(o.api)).activeIncidentId;
    if (incidentId === null) throw new RecordError("no active incident in the read model");
    await openApp(page, o.web, `/app/incidents/${incidentId}`, '[data-testid="ai-narrative"]');
    // The AI narrative can take a few seconds; wait until it has real sentences in it.
    await page
      .waitForFunction(() => (document.querySelector('[data-testid="ai-narrative"]')?.textContent ?? "").length > 200, undefined, { timeout: 60_000 })
      .catch(() => undefined);
    await sleep(1000);
    const narrative = await centerOf(page, '[data-testid="ai-narrative"]');
    await page.mouse.move(narrative ? narrative.x : W * 0.7, narrative ? narrative.y : H * 0.6);
    d.roll("Incident Room");
    await d.hold(5000);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 18);
      await sleep(30);
    }
    await d.finish("Incident Room, containment");

    // 2:20 Closing card with the tagline.
    d.enter("closing");
    const footer = o.network === "local" ? "Local rehearsal on Anvil. Not for stage." : "Recorded on Ethereum Sepolia, Arbitrum Sepolia and Base Sepolia. Testnet simulation.";
    await page.goto(card("closing", footer), { waitUntil: "load" });
    d.roll("closing card");
    await d.finish();
  } finally {
    rec.detach();
    await page.screencast.stop().catch(() => undefined);
    await context.close();
    await browser.close();
  }

  const beats: Manifest["beats"] = [];
  let at = 0;
  for (const b of BEATS) {
    const dur = rec.segments.filter((s) => s.beat === b.id).reduce((n, s) => n + s.frames, 0) / FPS;
    beats.push({ id: b.id, start: at, duration: dur, line: b.line });
    at += dur;
  }
  return {
    take: o.take,
    network: o.network,
    label: o.label,
    recordedAt: new Date().toISOString(),
    durationSeconds: at,
    beats,
    segments: rec.segments,
    shown,
    incidentId,
    labRunId,
    verdictReplay,
    overruns: d.overruns,
    voice: o.voice,
  };
}

// ---------------------------------------------------------------------------------------------
// Composition: segments + captions (lower third, Inter) + voiceover -> take-<n>.mp4
// ---------------------------------------------------------------------------------------------

async function renderCaptions(work: string, m: Manifest): Promise<{ file: string; start: number; end: number }[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const out: { file: string; start: number; end: number }[] = [];
  try {
    for (const [i, b] of m.beats.entries()) {
      const spec = BEATS.find((x) => x.id === b.id);
      if (!spec?.caption) continue;
      if (/\u2014/.test(b.line)) throw new RecordError(`caption for ${b.id} contains an em dash`);
      await page.setContent(`<!doctype html><html><head><style>
        html,body{margin:0;width:${W}px;height:${H}px;background:transparent}
        .cap{position:absolute;left:50%;bottom:62px;transform:translateX(-50%);max-width:1240px;width:max-content;box-sizing:border-box;
          padding:15px 30px 17px;border-radius:14px;background:rgba(8,10,13,0.86);border:1px solid rgba(255,255,255,0.09);
          box-shadow:0 14px 40px -12px rgba(0,0,0,0.75),0 1px 0 0 rgba(255,255,255,0.05) inset;
          font:500 34px/1.32 Inter,"Inter Variable",system-ui,sans-serif;letter-spacing:-0.012em;color:#eef1f4;text-align:center;text-wrap:balance;
          -webkit-font-smoothing:antialiased}
      </style></head><body><div class="cap">${escapeHtml(b.line)}</div></body></html>`);
      await page.evaluate(() => document.fonts.ready);
      const file = join(work, `caption-${i}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      // On screen from just after the beat starts until just before it ends.
      out.push({ file, start: b.start + 0.4, end: b.start + b.duration - 0.35 });
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function voiceover(work: string, m: Manifest): Promise<{ file: string; start: number; seconds: number }[]> {
  if (m.voice === null) return [];
  try {
    await run("say", ["-v", m.voice, "-o", join(work, "probe.aiff"), "ok"]);
  } catch {
    log(`voiceover skipped: macOS say with voice "${m.voice}" is not available`);
    return [];
  }
  const out: { file: string; start: number; seconds: number }[] = [];
  for (const [i, b] of m.beats.entries()) {
    const file = join(work, `vo-${i}.aiff`);
    await run("say", ["-v", m.voice, "-r", "168", "-o", file, b.line]);
    const seconds = Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).trim());
    if (seconds > b.duration - 0.8) log(`voiceover for ${b.id} is ${seconds.toFixed(1)}s in a ${b.duration.toFixed(1)}s beat`);
    out.push({ file, start: b.start + 0.6, seconds });
  }
  return out;
}

async function compose(o: Options, m: Manifest): Promise<string> {
  const work = join(TAKES, `work-${o.take}`);
  const list = join(work, "segments.txt");
  writeFileSync(list, m.segments.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const captions = await renderCaptions(work, m);
  const vo = await voiceover(work, m);

  const args = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list];
  for (const c of captions) args.push("-loop", "1", "-t", (c.end - c.start).toFixed(3), "-i", c.file);
  for (const v of vo) args.push("-i", v.file);
  const graph: string[] = ["[0:v]setpts=PTS-STARTPTS,format=yuv420p[v0]"];
  let last = "v0";
  captions.forEach((c, i) => {
    const d = c.end - c.start;
    graph.push(`[${i + 1}:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=${(d - 0.3).toFixed(3)}:d=0.3:alpha=1,setpts=PTS-STARTPTS+${c.start.toFixed(3)}/TB[c${i}]`);
    graph.push(`[${last}][c${i}]overlay=0:0:eof_action=pass:format=auto[v${i + 1}]`);
    last = `v${i + 1}`;
  });
  graph.push(`[${last}]format=yuv420p[vout]`);
  if (vo.length > 0) {
    const base = 1 + captions.length;
    vo.forEach((v, i) => graph.push(`[${base + i}:a]aresample=48000,adelay=${Math.round(v.start * 1000)}:all=1[a${i}]`));
    graph.push(`${vo.map((_, i) => `[a${i}]`).join("")}amix=inputs=${vo.length}:normalize=0,apad[aout]`);
  }
  const out = join(TAKES, `take-${o.take}.mp4`);
  args.push("-filter_complex", graph.join(";"), "-map", "[vout]");
  if (vo.length > 0) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k");
  args.push("-t", m.durationSeconds.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", out);
  log(`composing ${out}`);
  await run("ffmpeg", args);

  // Stills for review: the start, middle and end of every beat.
  for (const b of m.beats) {
    for (const [tag, t] of [["a", b.start + 1.2], ["b", b.start + b.duration / 2], ["c", b.start + b.duration - 1]] as const) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", out, "-frames:v", "1", join(work, "stills", `${b.id}-${tag}.png`)]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  if ("select" in parsed) {
    const src = join(TAKES, `take-${parsed.select}.mp4`);
    if (!existsSync(src)) throw new RecordError(`${src} does not exist`);
    const meta = JSON.parse(readFileSync(join(TAKES, `take-${parsed.select}.json`), "utf8")) as Manifest;
    if (meta.network !== "testnet") throw new RecordError(`take ${parsed.select} is a ${meta.network} rehearsal; only a testnet take can become the stage video`);
    copyFileSync(src, join(HERE, "kirchhoff-demo.mp4"));
    log(`media/video/kirchhoff-demo.mp4 <- takes/take-${parsed.select}.mp4`);
    return;
  }
  mkdirSync(TAKES, { recursive: true });
  const manifest = await recordTake(parsed);
  writeFileSync(join(TAKES, `take-${parsed.take}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  const out = await compose(parsed, manifest);
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", out]);
  log(`done: ${out}\n${probe.trim()}`);
  if (manifest.overruns.length > 0) log(`over budget: ${manifest.overruns.join(", ")}`);
}

main().catch((e: unknown) => {
  log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
