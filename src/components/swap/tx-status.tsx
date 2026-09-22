const TONES = {
  pending: {
    wrap: "border-warn/25 bg-warn/8",
    dot: "bg-warn",
    text: "text-warn",
    label: "Transaction pending…",
  },
  success: {
    wrap: "border-accent/25 bg-accent-wash",
    dot: "bg-accent",
    text: "text-accent",
    label: "Transaction confirmed",
  },
  error: {
    wrap: "border-neg/25 bg-neg/8",
    dot: "bg-neg",
    text: "text-neg",
    label: "Transaction failed",
  },
} as const;

export function TxStatus({
  hash,
  status,
}: {
  hash?: `0x${string}`;
  status: keyof typeof TONES | null;
}) {
  if (!hash) return null;
  const tone = TONES[status ?? "pending"];

  return (
    <div
      className={`mt-3 flex items-center gap-2.5 rounded-field border px-3 py-2.5 ${tone.wrap}`}
    >
      <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} />
      <span className={`flex-1 text-[12.5px] font-medium ${tone.text}`}>{tone.label}</span>
      <a
        href={`https://sepolia.etherscan.io/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        className="text-[12.5px] font-medium text-ink-2 underline decoration-line-2 underline-offset-2 transition-colors hover:text-ink"
      >
        View ↗
      </a>
    </div>
  );
}
