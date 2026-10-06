"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { OctagonX } from "lucide-react";
import type { EpochPoint } from "@/lib/api/types";
import { formatAmount, formatDateTime, formatTime, parseWei } from "@/lib/format";
import { shortHash, txRefUrl } from "@/lib/explorer";
import { usePrefs } from "@/lib/prefs";
import { StatusWord } from "@/components/kh/status";
import { Verifiable } from "@/components/kh/links";
import { CHAINS } from "@/lib/chains";
import { Skeleton } from "@/components/ui/skeleton";

interface Point {
  t: number;
  delta: number;
  epoch: EpochPoint;
}

export function DeltaHistory({ epochs, decimals, symbol, view }: { epochs: EpochPoint[]; decimals: number; symbol: string; view: "chart" | "table" }) {
  const gid = useId().replace(/:/g, "");
  const { reducedMotion, stage } = usePrefs();
  const tickSize = stage ? 13 : 11;
  const unit = 10n ** BigInt(decimals);
  const data = useMemo<Point[]>(
    () => [...epochs].reverse().map((e) => ({ t: Date.parse(e.evaluatedAt), delta: Number(parseWei(e.delta) / unit), epoch: e })),
    [epochs, unit],
  );
  // Incidents numbered oldest first; the chart, its legend and the data table share the numbers.
  const incidents = useMemo(() => {
    const seen = new Map<string, Point>();
    for (const p of data) if (p.epoch.incidentId && !seen.has(p.epoch.incidentId)) seen.set(p.epoch.incidentId, p);
    return [...seen.entries()].map(([id, p], i) => ({ id, p, n: i + 1 }));
  }, [data]);
  const incidentNumber = useMemo(() => new Map(incidents.map((x) => [x.id, x.n])), [incidents]);
  const [focused, setFocused] = useState<string | null>(null);

  const min = Math.min(0, ...data.map((d) => d.delta));
  const max = Math.max(0, ...data.map((d) => d.delta));
  const span = max - min;
  // Δ = 0 is conserved, so the color boundary sits just below the zero line; at exactly max / span the stops tie
  // and a flat zero stretch (max = 0 when Δ never goes positive) would paint in the breach color.
  const zeroOffset = span === 0 ? 1 : Math.min(1, max / span + 0.01);
  const pad = span === 0 ? 2 : span * 0.12;
  const step = span === 0 ? 1 : 10 ** Math.floor(Math.log10(span)) / 2;
  const lo = span === 0 ? -2 : Math.floor((min - pad) / step) * step;
  const hi = span === 0 ? 2 : Math.ceil((max + pad) / step) * step;
  const [hover, setHover] = useState<Point | null>(null);

  if (view === "table") {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs tnum">
          <caption className="sr-only">Δ per epoch over the last 24 hours, newest first</caption>
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-wire text-subtle">
              <th scope="col" className="py-2 pl-4 pr-3 text-left font-medium">Time (UTC)</th>
              <th scope="col" className="px-3 text-left font-medium">Epoch</th>
              <th scope="col" className="px-3 text-right font-medium">Δ ({symbol})</th>
              <th scope="col" className="px-3 text-right font-medium">Status</th>
              <th scope="col" className="py-2 pl-3 pr-4 text-left font-medium">Incident</th>
            </tr>
          </thead>
          <tbody>
            {/* The latest 200 epochs, plus every older epoch that belongs to an incident so none drops off. */}
            {epochs.filter((e, i) => i < 200 || e.incidentId !== null).map((e) => {
              const tx = e.reportTxs[0];
              const delta = parseWei(e.delta);
              return (
                <tr key={e.epochId} className="border-b border-wire/60">
                  <td className="py-1.5 pl-4 pr-3 font-mono text-muted">{formatTime(e.evaluatedAt)}</td>
                  <td className="px-3 font-mono">
                    {tx ? (
                      <Verifiable href={txRefUrl(tx)} label={`Epoch ${e.epochId}, its report transaction on ${CHAINS[tx.chain].name}`} className="text-fg">
                        {e.epochId}
                      </Verifiable>
                    ) : (
                      e.epochId
                    )}
                  </td>
                  <td className={`px-3 text-right font-mono ${delta < 0n ? "text-broken" : "text-fg"}`}>
                    {tx ? (
                      <Verifiable href={txRefUrl(tx)} label={`Δ ${formatAmount(delta, { decimals, signed: true })} ${symbol} at epoch ${e.epochId}, epoch report transaction`}>
                        {formatAmount(delta, { decimals, signed: true })}
                      </Verifiable>
                    ) : (
                      formatAmount(delta, { decimals, signed: true })
                    )}
                  </td>
                  <td className="px-3 text-right">
                    <StatusWord status={e.status} className="text-2xs" />
                  </td>
                  <td className="py-1.5 pl-3 pr-4">
                    {e.incidentId ? (
                      <Link href={`/app/incidents/${e.incidentId}`} className="whitespace-nowrap font-mono text-broken hover:underline" aria-label={`Incident ${incidentNumber.get(e.incidentId) ?? ""}, ${e.incidentId}. Open Incident Room`}>
                        #{incidentNumber.get(e.incidentId)} {shortHash(e.incidentId)}
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 px-2 pt-2" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            accessibilityLayer={false}
            data={data}
            margin={{ top: 8, right: 28, bottom: 0, left: 4 }}
            onMouseMove={(s) => {
              const i = typeof s.activeTooltipIndex === "number" ? s.activeTooltipIndex : Number(s.activeTooltipIndex);
              setHover(Number.isFinite(i) ? (data[i] ?? null) : null);
            }}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--status-conserved)" stopOpacity={0.28} />
                <stop offset={zeroOffset} stopColor="var(--status-conserved)" stopOpacity={0.04} />
                <stop offset={zeroOffset} stopColor="var(--status-broken)" stopOpacity={0.06} />
                <stop offset="1" stopColor="var(--status-broken)" stopOpacity={0.32} />
              </linearGradient>
              <linearGradient id={`stroke-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={zeroOffset} stopColor="var(--status-conserved)" />
                <stop offset={zeroOffset} stopColor="var(--status-broken)" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--line-wire)" strokeOpacity={0.6} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) => formatTime(new Date(t).toISOString()).slice(0, 5)}
              tick={{ fill: "var(--fg-subtle)", fontSize: tickSize, fontFamily: "var(--font-mono)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--line-wire)" }}
              minTickGap={48}
            />
            <YAxis
              domain={[lo, hi]}
              allowDecimals={false}
              tickCount={5}
              {...(span === 0 ? { ticks: [0] } : {})}
              tickFormatter={(v: number) => {
                const r = Math.round(v);
                return r === 0 ? "0" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(r);
              }}
              tick={{ fill: "var(--fg-subtle)", fontSize: tickSize, fontFamily: "var(--font-mono)" }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <ReferenceLine y={0} stroke="var(--line-strong)" strokeDasharray="2 4" />
            {incidents.map(({ id, p }) => (
              <ReferenceLine key={id} x={p.t} stroke="var(--status-broken)" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 3" />
            ))}
            <RTooltip cursor={{ stroke: "var(--line-strong)" }} content={() => null} />
            <Area
              type="stepAfter"
              dataKey="delta"
              stroke={`url(#stroke-${gid})`}
              strokeWidth={1.75}
              fill={`url(#fill-${gid})`}
              baseValue={0}
              isAnimationActive={!reducedMotion}
              animationDuration={500}
              dot={false}
              activeDot={{ r: 3.5, stroke: "var(--bg-panel)", strokeWidth: 2, fill: "var(--fg)" }}
            />
            {/* Dots only on the line: labels live in the legend below, so they can never collide. */}
            {incidents.map(({ id, p, n }) => (
              <ReferenceDot
                key={id}
                x={p.t}
                y={p.delta}
                ifOverflow="extendDomain"
                shape={(props: { cx?: number; cy?: number }) => (
                  <circle
                    data-incident-dot={n}
                    cx={props.cx}
                    cy={props.cy}
                    r={focused === id ? 6 : 4}
                    fill="var(--status-broken)"
                    stroke="var(--bg-panel)"
                    strokeWidth={2}
                    style={{ transition: reducedMotion ? undefined : "r 160ms ease-out" }}
                  />
                )}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex h-7 shrink-0 items-center px-4 text-xs text-muted">
        {hover ? (
          <span className="truncate font-mono tnum">
            {formatDateTime(hover.epoch.evaluatedAt)} · epoch {hover.epoch.epochId} · Δ {formatAmount(parseWei(hover.epoch.delta), { decimals, signed: true })} {symbol}
            {hover.epoch.incidentId ? ` · incident #${incidentNumber.get(hover.epoch.incidentId) ?? ""}` : ""}
          </span>
        ) : incidents.length === 0 ? (
          <span>No incidents in the last 24 hours.</span>
        ) : (
          <span>
            {incidents.length} incident{incidents.length === 1 ? "" : "s"} in the last 24 hours. Hover the chart for any epoch.
          </span>
        )}
      </div>
      {incidents.length > 0 ? (
        <ul aria-label="Incidents on the chart, oldest first" data-testid="incident-legend" className="flex max-h-[3.25rem] shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-y-auto px-4 pb-2">
          {incidents.map(({ id, p, n }) => (
            <li key={id}>
              <Link
                href={`/app/incidents/${id}`}
                data-testid="incident-marker-label"
                onMouseEnter={() => setFocused(id)}
                onMouseLeave={() => setFocused(null)}
                onFocus={() => setFocused(id)}
                onBlur={() => setFocused(null)}
                aria-label={`Incident ${n}, ${id}, opened at ${formatTime(p.epoch.evaluatedAt)} UTC. Open Incident Room`}
                title={`Incident ${shortHash(id)} at ${formatTime(p.epoch.evaluatedAt)}`}
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-broken/30 bg-broken/[0.06] px-1.5 font-mono text-2xs text-broken transition-colors hover:border-broken/60 hover:bg-broken/10"
              >
                <OctagonX className="size-3" aria-hidden="true" />
                <span className="font-semibold">#{n}</span>
                <span className="text-muted tnum">{formatTime(p.epoch.evaluatedAt).slice(0, 5)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DeltaHistorySkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-2 px-4 pb-4" aria-hidden="true">
      <Skeleton className="h-[70%] w-full rounded-md opacity-60" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}
