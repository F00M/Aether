import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PoolView } from "@/components/pools/pool-view";

export const metadata: Metadata = {
  title: "Pool",
  description: "Pool price, volume and liquidity.",
};

export default async function PoolPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) notFound();

  return (
    <div className="mx-auto max-w-[1240px] px-5 py-6 lg:px-8 lg:py-10">
      <PoolView address={address as `0x${string}`} />
    </div>
  );
}
