/**
 * Display formatting. Everything here is presentation-only — never feed the
 * output back into math, always keep the raw number around.
 */

/** Price with a decimal count that adapts to magnitude (PEPE vs WBTC). */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0.00";

  const abs = Math.abs(value);
  let digits: number;
  if (abs >= 1000) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 5;
  else if (abs >= 0.0001) digits = 7;
  else digits = 9;

  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

export function formatUsd(value: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return "—";

  if (opts.compact) {
    return `$${compact(value)}`;
  }

  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

/** 1.24M / 892.4K / 12.06B — used in stat tiles and table cells. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/** Token amount — trims trailing zeros so "1.50000" reads as "1.5". */
export function formatAmount(value: number, maxDigits = 6): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";

  const abs = Math.abs(value);
  if (abs < 10 ** -maxDigits) return `<${10 ** -maxDigits}`;

  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : maxDigits;
  const fixed = value.toFixed(digits);
  const trimmed = fixed.replace(/\.?0+$/, "");
  const [whole, frac] = trimmed.split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  return frac ? `${grouped}.${frac}` : grouped;
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatSignedPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

/** Parses user keystrokes into a number without throwing on partial input. */
export function parseAmount(input: string): number {
  if (!input) return 0;
  const parsed = Number(input.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
