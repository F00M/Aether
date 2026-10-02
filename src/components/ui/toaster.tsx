"use client";

import { useSyncExternalStore } from "react";

/**
 * One small notice per transaction, in the corner: sent, then confirmed or failed, with a link to
 * the explorer. It replaces a history page — the wallet and the explorer already keep the record.
 */
export type Toast = {
  /** The transaction hash, normally: updates with the same id change the notice in place. */
  id: string;
  status: "pending" | "success" | "error";
  title: string;
  /** What the transaction was, e.g. "1 ETH → USDC". Kept from the first notice of an id. */
  detail?: string;
  hash?: `0x${string}`;
};

const EXPLORER = "https://sepolia.etherscan.io";
// How long a finished notice stays before it leaves on its own.
const LINGER_MS = 7_000;
const NONE: Toast[] = [];

let toasts: Toast[] = NONE;
const listeners = new Set<() => void>();
// Ids that were closed: a late update for one of them must not bring it back.
const closed = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function publish(next: Toast[]) {
  toasts = next;
  listeners.forEach((listener) => listener());
}

export function dismiss(id: string) {
  closed.add(id);
  clearTimeout(timers.get(id));
  timers.delete(id);
  publish(toasts.filter((toast) => toast.id !== id));
}

/** Shows a notice, or moves the one with the same id to its next state. */
export function notify(toast: Toast) {
  if (closed.has(toast.id)) return;
  const current = toasts.find((entry) => entry.id === toast.id);
  if (current?.status === toast.status && current.title === toast.title) return;
  const merged = { ...toast, detail: current?.detail ?? toast.detail };
  publish(current ? toasts.map((entry) => (entry.id === toast.id ? merged : entry)) : [...toasts, merged]);
  if (toast.status !== "pending") {
    clearTimeout(timers.get(toast.id));
    timers.set(
      toast.id,
      setTimeout(() => dismiss(toast.id), LINGER_MS),
    );
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function Toaster() {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => NONE,
  );

  return (
    // At the top on a phone: the bottom edge is where the primary button and the dialogs' footers
    // are, and a notice there would sit on top of them. In the corner on a wider screen.
    <div aria-live="polite" className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:top-auto sm:items-end">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="animate-rise pointer-events-auto flex w-full max-w-[340px] items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pl-3.5 pr-2 shadow-pop sm:w-[340px]"
        >
          <StatusMark status={toast.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-ink">{toast.title}</p>
            {toast.detail ? <p className="nums truncate text-[12px] text-ink-2">{toast.detail}</p> : null}
          </div>
          {toast.hash ? (
            <a
              href={`${EXPLORER}/tx/${toast.hash}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-inset hover:text-ink"
            >
              View ↗
            </a>
          ) : null}
          <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss" className="shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-inset hover:text-ink">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/** The state as a shape as well as a colour: a turning ring, a tick, a cross. */
function StatusMark({ status }: { status: Toast["status"] }) {
  if (status === "pending") {
    return <span aria-hidden="true" className="size-5 shrink-0 animate-spin rounded-full border-2 border-line-2 border-t-ink" />;
  }
  const done = status === "success";
  return (
    <span aria-hidden="true" className={`flex size-5 shrink-0 items-center justify-center rounded-full text-white ${done ? "bg-accent" : "bg-neg"}`}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path d={done ? "M2.5 6.2 5 8.6l4.5-5" : "M3.5 3.5l5 5M8.5 3.5l-5 5"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
