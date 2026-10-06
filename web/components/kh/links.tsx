import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Address, ChainKey, TxRef } from "@/lib/api/types";
import { addressUrl, readContractUrl, shortHash, txRefUrl } from "@/lib/explorer";
import { CHAINS } from "@/lib/chains";
import { cn } from "@/lib/utils";

const linkBase =
  "group/link inline-flex items-center gap-0.5 rounded-sm underline decoration-transparent decoration-1 underline-offset-[3px] transition-colors hover:decoration-current focus-visible:decoration-current";

export function ExternalLink({ href, children, className, label }: { href: string; children: ReactNode; className?: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className={cn(linkBase, className)}>
      {children}
    </a>
  );
}

export function TxLink({ tx, className, showChain = false }: { tx: TxRef; className?: string; showChain?: boolean }) {
  return (
    <ExternalLink
      href={txRefUrl(tx)}
      label={`Transaction ${tx.hash} on ${CHAINS[tx.chain].name}`}
      className={cn("font-mono text-xs text-muted hover:text-fg tnum", className)}
    >
      {showChain ? <span className="mr-1 font-sans text-subtle">{CHAINS[tx.chain].short}</span> : null}
      {shortHash(tx.hash)}
      <ArrowUpRight className="size-3 opacity-50 transition-opacity group-hover/link:opacity-100" aria-hidden="true" />
    </ExternalLink>
  );
}

export function AddressLink({ chain, address, className, read = false }: { chain: ChainKey; address: Address; className?: string; read?: boolean }) {
  return (
    <ExternalLink
      href={read ? readContractUrl(chain, address) : addressUrl(chain, address)}
      label={`${read ? "Read contract" : "Address"} ${address} on ${CHAINS[chain].name}`}
      className={cn("font-mono text-xs text-muted hover:text-fg", className)}
    >
      {shortHash(address)}
      <ArrowUpRight className="size-3 opacity-50 transition-opacity group-hover/link:opacity-100" aria-hidden="true" />
    </ExternalLink>
  );
}

/**
 * A number backed by an onchain fact. Every figure in the UI goes through this so it is one
 * click from its explorer tx or contract read (PRD section 12, "Every number is verifiable").
 */
export function Verifiable({ href, label, children, className, style }: { href: string; label: string; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <a
      href={href}
      style={style}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      data-figure=""
      data-source={label}
      className={cn(
        "rounded-sm tnum underline decoration-dotted decoration-transparent decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-[color-mix(in_oklab,currentColor_55%,transparent)] focus-visible:decoration-current",
        className,
      )}
    >
      {children}
    </a>
  );
}

/** Only a real http(s) URL counts as a public source; anything else is marked, never faked as a link. */
export function publicUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//.test(url) ? url : null;
}

/**
 * A figure computed offchain (Judge latency, cell agreement): it links to the rows or metrics it
 * was computed from, or, when that source is not public, says so instead of faking a link.
 */
export function SourcedFigure({ href, label, children, className }: { href: string | null; label: string; children: ReactNode; className?: string }) {
  if (href) {
    return (
      <Verifiable href={href} label={label} className={className ?? ""}>
        {children}
      </Verifiable>
    );
  }
  return (
    <span data-figure="" data-not-public="" data-source={label} title={`${label}. Source not public`} className={className}>
      {children}
    </span>
  );
}
