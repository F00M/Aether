import { PageIntro } from "@/components/page-intro";
import { SwapCard } from "@/components/swap/swap-card";

export default function SwapPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-12">
      <PageIntro
        title={
          <>
            One router, <span className="text-ink-3">best price.</span>
          </>
        }
      />

      <SwapCard />
    </div>
  );
}
