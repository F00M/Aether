"use client";

export type ExecStep = {
  id: "wrap" | "approve" | "swap" | "unwrap";
  label: string;
  status: "pending" | "active" | "done" | "error";
  hash?: `0x${string}`;
};

/**
 * LI.FI-style execution tracker: one row per on-chain step of a multi-transaction route
 * (wrap → approve → swap → unwrap), each with its own status and explorer link.
 */
export function ExecutionSteps({ steps }: { steps: ExecStep[] | null }) {
  if (!steps?.length) return null;
  const done = steps.filter((step) => step.status === "done").length;

  return (
    <div className="mt-3 rounded-field border border-line bg-surface px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between text-[12px]">
        <span className="font-semibold">Executing via LI.FI</span>
        <span className="nums text-ink-3">
          {done}/{steps.length} steps
        </span>
      </div>
      <ol className="relative flex flex-col gap-2.5">
        {steps.map((step, i) => (
          <li key={step.id} className="relative flex items-center gap-2.5 text-[12.5px]">
            {i < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={`absolute left-[8.5px] top-[19px] h-[calc(100%-6px)] w-px ${
                  step.status === "done" ? "bg-accent/50" : "bg-line"
                }`}
              />
            ) : null}
            <StepIcon status={step.status} />
            <span
              className={`min-w-0 flex-1 ${
                step.status === "pending" ? "text-ink-3" : step.status === "error" ? "text-neg" : "text-ink"
              }`}
            >
              {step.label}
            </span>
            {step.hash ? (
              <a
                href={`https://sepolia.etherscan.io/tx/${step.hash}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[11.5px] font-medium text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink"
              >
                Tx ↗
              </a>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepIcon({ status }: { status: ExecStep["status"] }) {
  if (status === "done") {
    return (
      <span className="relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.2 5 8.5 9.5 3.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-neg">
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative z-10 size-[18px] shrink-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent bg-surface motion-reduce:animate-none" />
    );
  }
  return <span className="relative z-10 size-[18px] shrink-0 rounded-full border-2 border-line bg-surface" />;
}
