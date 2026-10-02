import type { ReactNode } from "react";

/**
 * The top of every page: a short title, and at most one plain line under it saying what the page
 * holds. No pitch — the product below speaks for itself.
 */
export function PageIntro({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <section className="mb-6 sm:mb-8">
      <h1 className="text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[38px]">{title}</h1>
      {children ? <p className="mt-2.5 max-w-md text-[15px] leading-relaxed text-ink-2">{children}</p> : null}
    </section>
  );
}
