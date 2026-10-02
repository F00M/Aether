import type { Metadata } from "next";

import { PageIntro } from "@/components/page-intro";
import { StatsView } from "@/components/stats/stats-view";

export const metadata: Metadata = {
  title: "Stats",
  description: "Swaps, volume and fees.",
};

export default function StatsPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-5 py-8 lg:px-8 lg:py-12">
      <PageIntro title="Stats">Swaps, volume and fees through Aether, counted on-chain.</PageIntro>

      <StatsView />
    </div>
  );
}
