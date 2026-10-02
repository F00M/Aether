"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";

import { feeLabel, formatTokenAmount, orientationOf } from "@/components/pools/pool-format";
import { TxNotice, describeError, type TxState } from "@/components/pools/tx-state";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { notify } from "@/components/ui/toaster";
import { TokenIcon } from "@/components/ui/token-icon";
import { buildCollectCall, buildRemoveCall, deadlineIn, poolHasWeth, withTolerance, type Position } from "@/swap/liquidity";
import { WETH } from "@/swap/quoteConfig";
import type { Token } from "@/swap/types";
import { amountsForLiquidity, sqrtRatioAtTick } from "@/swap/v3Math";

const SEPOLIA_ID = 11155111;
const TOLERANCE_BPS = 100n;
const SHARES = [25, 50, 75, 100] as const;

const isWeth = (token: Token) => token.address.toLowerCase() === WETH.toLowerCase();

/**
 * Withdraws part or all of a position. Whatever share is withdrawn, the fees waiting on the
 * position are collected in full in the same transaction. `feesOnly` leaves the liquidity alone.
 */
export function RemoveLiquidityModal({ position, feesOnly = false, onClose }: { position: Position; feesOnly?: boolean; onClose: () => void }) {
  const { address, chain } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const { pool } = position;
  const orientation = orientationOf(pool);
  const [share, setShare] = useState<(typeof SHARES)[number]>(100);
  const [receiveEth, setReceiveEth] = useState(true);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });

  const liquidity = feesOnly ? 0n : (position.liquidity * BigInt(share)) / 100n;
  const withdrawn = amountsForLiquidity(pool.sqrtPriceX96, sqrtRatioAtTick(position.tickLower), sqrtRatioAtTick(position.tickUpper), liquidity);
  const asEth = receiveEth && poolHasWeth(pool);
  const symbolOf = (token: Token) => (asEth && isWeth(token) ? "ETH" : token.symbol);
  const wrongNetwork = Boolean(address) && chain?.id !== SEPOLIA_ID;
  const nothing = feesOnly ? position.fees0 === 0n && position.fees1 === 0n : liquidity === 0n && position.fees0 === 0n && position.fees1 === 0n;
  const busy = tx.kind === "working";

  const submit = async () => {
    if (!address || !publicClient) return;
    try {
      if (wrongNetwork) {
        setTx({ kind: "working", label: "Switch to Sepolia in your wallet…" });
        await switchChainAsync({ chainId: SEPOLIA_ID });
        setTx({ kind: "idle" });
        return;
      }
      setTx({ kind: "working", label: feesOnly ? "Checking…" : "Checking the withdrawal…" });
      const call = feesOnly
        ? buildCollectCall({ position, recipient: address, receiveEth: asEth })
        : buildRemoveCall({
            position,
            liquidity,
            amount0Min: withTolerance(withdrawn.amount0, TOLERANCE_BPS),
            amount1Min: withTolerance(withdrawn.amount1, TOLERANCE_BPS),
            recipient: address,
            deadline: deadlineIn(1200),
            receiveEth: asEth,
            // The NFT can only be deleted once it holds nothing at all.
            burn: share === 100,
          });
      try {
        await publicClient.call({ account: address, to: call.to, data: call.data, value: call.value });
      } catch {
        throw new Error("This would fail right now — the pool price has probably moved. Close this, reopen it for a fresh price, and try again.");
      }
      setTx({ kind: "working", label: "Confirm in your wallet…" });
      const hash = await sendTransactionAsync({ to: call.to, data: call.data, value: call.value });
      setTx({ kind: "working", label: feesOnly ? "Collecting fees…" : "Removing liquidity…" });
      const pair = `${orientation.base.symbol} / ${orientation.quote.symbol}`;
      notify({ id: hash, hash, status: "pending", title: feesOnly ? "Collect submitted" : "Withdrawal submitted", detail: pair });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const confirmed = feesOnly ? "Fees collected" : share === 100 ? "Position closed" : "Liquidity removed";
      notify({ id: hash, hash, status: receipt.status === "success" ? "success" : "error", title: receipt.status === "success" ? confirmed : "Transaction failed" });
      if (receipt.status !== "success") throw new Error("The transaction reverted on-chain");
      queryClient.invalidateQueries({ queryKey: ["aether-pools"] });
      queryClient.invalidateQueries({ queryKey: ["aether-pool"] });
      queryClient.invalidateQueries({ queryKey: ["aether-positions"] });
      // The notice carries the result; the dialog has nothing left to say.
      onClose();
    } catch (error) {
      setTx({ kind: "error", message: describeError(error, "The transaction could not be sent.") });
    }
  };

  const rows: { token: Token; withdrawn: bigint; fees: bigint }[] = [
    { token: pool.token0, withdrawn: withdrawn.amount0, fees: position.fees0 },
    { token: pool.token1, withdrawn: withdrawn.amount1, fees: position.fees1 },
  ];
  const disabled = busy || (!wrongNetwork && nothing);

  return (
    <Modal
      open
      onClose={onClose}
      title={feesOnly ? "Collect fees" : "Remove liquidity"}
      footer={
        <div className="space-y-2.5">
          <TxNotice state={tx} />
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            className={`pressable h-[48px] w-full rounded-field text-[15px] font-medium ${
              disabled ? "cursor-not-allowed bg-inset-2 text-ink-3" : "bg-ink text-white hover:bg-ink/88"
            }`}
          >
            {wrongNetwork ? "Switch to Sepolia" : nothing ? "Nothing to collect" : feesOnly ? "Collect fees" : share === 100 ? "Remove all & close position" : `Remove ${share}%`}
          </button>
        </div>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center">
            <TokenIcon token={orientation.base} size="md" />
            <TokenIcon token={orientation.quote} size="md" className="-ml-1.5 rounded-full ring-2 ring-surface" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            {orientation.base.symbol} / {orientation.quote.symbol}
          </span>
          <span className="rounded-md bg-inset px-2 py-0.5 text-[11.5px] font-medium text-ink-2">{feeLabel(pool.fee)}</span>
          <span className="nums ml-auto text-[12px] text-ink-3">#{position.tokenId.toString()}</span>
        </div>

        {feesOnly ? null : (
          <section>
            <h3 className="text-[12.5px] font-medium text-ink-2">Amount to remove</h3>
            <Segmented
              label="Share of the position to remove"
              className="mt-2"
              value={String(share)}
              onChange={(value) => setShare(Number(value) as (typeof SHARES)[number])}
              options={SHARES.map((value) => ({ value: String(value), label: value === 100 ? "All" : `${value}%`, disabled: busy }))}
            />
          </section>
        )}

        <section>
          <h3 className="text-[12.5px] font-medium text-ink-2">You receive</h3>
          <dl className="mt-2 divide-y divide-line rounded-field border border-line bg-inset px-3.5">
            {rows.map(({ token, withdrawn: out, fees }) => (
              <div key={token.address} className="flex items-center justify-between gap-3 py-2.5">
                <dt className="flex items-center gap-2 text-[14px] font-medium">
                  <TokenIcon token={token} size="sm" />
                  {symbolOf(token)}
                </dt>
                <dd className="text-right">
                  <span className="nums block text-[15px] text-ink">{formatTokenAmount(out + fees, token.decimals)}</span>
                  {feesOnly ? null : (
                    <span className="nums block text-[11.5px] text-ink-3">
                      {formatTokenAmount(out, token.decimals)} liquidity + {formatTokenAmount(fees, token.decimals)} fees
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {poolHasWeth(pool) ? (
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
              <input
                type="checkbox"
                checked={receiveEth}
                onChange={(event) => setReceiveEth(event.target.checked)}
                disabled={busy}
                className="size-3.5 accent-accent"
              />
              Receive ETH instead of WETH
            </label>
          ) : null}
        </section>

        {feesOnly ? null : (
          <p className="text-[12px] leading-relaxed text-ink-3">
            The amounts follow the pool price, so they can differ slightly when the transaction lands; it reverts if
            they come out more than {Number(TOLERANCE_BPS) / 100}% lower. Unclaimed fees are always collected in full.
          </p>
        )}
      </div>
    </Modal>
  );
}
