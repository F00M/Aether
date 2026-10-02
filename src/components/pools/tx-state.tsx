/** Where a liquidity transaction is: one line of text is all the dialogs need to show. */
export type TxState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "done"; hash: `0x${string}`; label: string }
  | { kind: "error"; message: string };

const EXPLORER = "https://sepolia.etherscan.io";

type MaybeRpcError = { name?: string; shortMessage?: string; message?: string };

export function isUserRejection(error: unknown): boolean {
  const e = error as MaybeRpcError;
  return e?.name === "UserRejectedRequestError" || /user rejected|user denied|rejected the request/i.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""}`);
}

/** A wallet or RPC error as one sentence a person can act on. */
export function describeError(error: unknown, fallback: string): string {
  if (isUserRejection(error)) return "Rejected in the wallet. Nothing was sent.";
  const e = error as MaybeRpcError;
  return e?.shortMessage || e?.message?.split("\n")[0] || fallback;
}

export function TxNotice({ state }: { state: TxState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "working") {
    return (
      <p role="status" className="flex items-center gap-2.5 rounded-field border border-warn/25 bg-warn/8 px-3 py-2.5 text-[12.5px] font-medium text-warn">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-warn" />
        {state.label}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p role="alert" className="rounded-field border border-neg/22 bg-neg/8 px-3 py-2.5 text-[12.5px] leading-relaxed text-neg">
        {state.message}
      </p>
    );
  }
  return (
    <p role="status" className="flex items-center gap-2.5 rounded-field border border-accent/25 bg-accent-wash px-3 py-2.5 text-[12.5px] font-medium text-accent">
      <span className="size-2 shrink-0 rounded-full bg-accent" />
      <span className="flex-1">{state.label}</span>
      <a
        href={`${EXPLORER}/tx/${state.hash}`}
        target="_blank"
        rel="noreferrer"
        className="text-ink-2 underline decoration-line-2 underline-offset-2 transition-colors hover:text-ink"
      >
        View ↗
      </a>
    </p>
  );
}
