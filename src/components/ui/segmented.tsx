import type { CSSProperties, ReactNode } from "react";

type Option<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

/**
 * A row of mutually exclusive choices with a thumb that slides to the chosen one. `tabs` is for
 * switching what a panel shows; `group` is for a setting, where each button reports pressed.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  kind = "group",
  size = "md",
  className = "",
}: {
  options: readonly Option<T>[];
  /** null when none of the options is the current value: the thumb hides. */
  value: T | null;
  onChange: (value: T) => void;
  /** What the choice is, for assistive tech. */
  label: string;
  kind?: "tabs" | "group";
  size?: "sm" | "md";
  className?: string;
}) {
  const active = options.findIndex((option) => option.value === value);
  const text = size === "sm" ? "px-2.5 py-1.5 text-[12.5px]" : "px-3.5 py-1.5 text-[13px]";

  return (
    <div
      role={kind === "tabs" ? "tablist" : "group"}
      aria-label={label}
      className={`segmented grid rounded-xl bg-inset ${className}`}
      style={{ "--segments": options.length, "--active": Math.max(active, 0) } as CSSProperties}
    >
      <span aria-hidden="true" className={`segmented-thumb rounded-lg bg-surface shadow-card ${active < 0 ? "opacity-0" : ""}`} />
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={kind === "tabs" ? "tab" : undefined}
            aria-selected={kind === "tabs" ? chosen : undefined}
            aria-pressed={kind === "group" ? chosen : undefined}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`pressable relative z-10 flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium disabled:cursor-not-allowed disabled:opacity-50 ${text} ${
              chosen ? "text-ink" : "text-ink-2 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
