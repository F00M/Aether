import type { Metadata } from "next";

import { PageIntro } from "@/components/page-intro";
import { PoolsView } from "@/components/pools/pools-view";

export const metadata: Metadata = {
  title: "Pools",
  description: "Liquidity pools on Sepolia.",
};

export default function PoolsPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-12">
      <PageIntro title="Pools">Add liquidity to a Uniswap V3 pool and earn fees on every swap.</PageIntro>

      <PoolsView />
    </div>
  );
}
