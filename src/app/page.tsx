import { SwapCard } from "@/components/swap/swap-card";

export default function SwapPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-12">
      <section className="mb-8 max-w-2xl">
        <h1 className="text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[38px]">
          One router,
          <br />
          <span className="text-ink-3">every Uniswap version.</span>
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-2">
          Aether scans every V2, V3 and V4 pool — any fee tier, including pools created minutes ago —
          splits your order across whichever pay best, compares it against LI.FI, and executes the
          route that pays you most.
        </p>
      </section>

      <SwapCard />
    </div>
  );
}
