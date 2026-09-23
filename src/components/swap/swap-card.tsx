"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { ExecutionSteps, type ExecStep } from "@/components/swap/execution-steps";
import { RoutesPanel } from "@/components/swap/routes-panel";
import { TokenSelector } from "@/components/swap/token-selector";
import { TxStatus } from "@/components/swap/tx-status";
import { TokenIcon } from "@/components/ui/token-icon";
import { TOKENS } from "@/config/tokens";
import {
  useQuote,
  UNISWAP_API_ROUTER,
  UNIVERSAL_ROUTER,
  isEthWethPair,
  invalidateQuoteCache,
  withDeadRouteKeys,
} from "@/hooks/useQuote";
import {
  PERMIT2,
  AETHER_AGGREGATOR,
  TX_GAS_CAP,
  WETH_ADDRESS,
  MAX_UINT256,
  MAX_UINT160,
  PERMIT2_EXPIRATION,
  AUTO_SLIPPAGE_EXTRA_BPS,
  ERC20_ABI,
  PERMIT2_ABI,
  WETH_ABI,
  AETHER_AGGREGATOR_ABI,
  UNIVERSAL_ROUTER_ABI,
  quoteCanUseAether,
  findExecutableAetherParams,
  classifyFailingRoutes,
  buildSwapCalldata,
} from "@/swap/aetherBuilder";
import { EXTRA_TX_PENALTY_BPS, autoVenue, lifiExtraTxs } from "@/lib/venue";
import { fetchLifiQuote, LIFI_DIAMOND } from "@/swap/lifi";
import { fetchUniswapApiQuote, fetchUniswapApiSwap, findSplitRoutes } from "@/swap/quoteEngine";
import type { Quote, Route, Token, Venue } from "@/swap/types";

const SEPOLIA_ID = 11155111;
const NATIVE = "0x0000000000000000000000000000000000000000";
// Fly (LI.FI's Sepolia swap tool) only accepts calldata its backend signed recently. When a wrap
// or approval ran first, the quote is re-fetched if it's older than this before the swap is sent.
const LIFI_CALLDATA_MAX_AGE_MS = 25_000;
// A re-fetched LI.FI quote that pays less than this share of the one the user clicked stops the
// flow instead of silently executing a worse number.
const LIFI_REQUOTE_MIN_BPS = 9900n;

function isUserRejection(error: unknown): boolean {
  const e = error as { name?: string; shortMessage?: string; message?: string };
  return (
    e?.name === "UserRejectedRequestError" ||
    /user rejected|user denied|rejected the request/i.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""}`)
  );
}

/** Keeps `parseUnits` from throwing on partial keystrokes like "1.2.3" or ".". */
function sanitizeAmount(raw: string): string {
  // A phone's decimal keypad follows the device locale; an Indonesian one types "," for the
  // decimal point. A lone comma is read as one. Next to a "." or repeated ("1,234.5", "1,000,000")
  // commas are thousands separators and dropped.
  const lone = raw.split(",").length === 2 && !raw.includes(".");
  const cleaned = (lone ? raw.replace(",", ".") : raw).replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (!rest.length) return whole;
  return `${whole || "0"}.${rest.join("")}`;
}

const AMOUNT_MAX_PX = 30;
const AMOUNT_MIN_PX = 16;
// Advance width of the mono face as a fraction of its font size; tabular-nums makes it uniform,
// so the width of an amount is exactly chars * ratio * fontSize.
const MONO_CHAR_RATIO = 0.6;

// The measurement needs a layout, which the server render doesn't have; useLayoutEffect would only
// warn there.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The amount fields keep full precision, which on a phone is wider than the field. Shrinking the
 * digits to fit keeps every one of them readable instead of clipping the tail. The element's own
 * width comes from flex-1, not from its text, so resizing the text can't feed back into it.
 */
function useAmountFontSize<T extends HTMLElement>(text: string) {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState(AMOUNT_MAX_PX);

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      const available = element.clientWidth;
      if (!available) return;
      const ideal = available / (Math.max(text.length, 1) * MONO_CHAR_RATIO);
      setSize(Math.max(AMOUNT_MIN_PX, Math.min(AMOUNT_MAX_PX, Math.floor(ideal))));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return [ref, size] as const;
}

export function SwapCard() {
  const { address, isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { openConnectModal } = useConnectModal();

  const [tokenIn, setTokenIn] = useState<Token>(() => (TOKENS as Token[])[0]);
  const [tokenOut, setTokenOut] = useState<Token>(() => (TOKENS as Token[])[1]);
  const [amountIn, setAmountIn] = useState("");
  const [selectorFor, setSelectorFor] = useState<"in" | "out" | null>(null);
  const [approvalStep, setApprovalStep] = useState<
    "idle" | "erc20" | "permit2" | "api-router"
  >("idle");
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [autoSlipNote, setAutoSlipNote] = useState<string | null>(null);
  // Set when a swap click discovers the displayed quote is a stale pool snapshot (price moved
  // down). Kept in its own state so the auto-clear on quote change doesn't wipe it before the
  // user can read why their swap did not execute.
  const [priceMovedNote, setPriceMovedNote] = useState<string | null>(null);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const [blockedRouteKeys, setBlockedRouteKeys] = useState<string[]>([]);
  // Set when the execute-via-API path errored (endpoint down / calldata rejected): execution and
  // approvals fall back to the aggregator for this pair+amount instead of failing the same way
  // on every click. Reset on token/amount change like the other per-quote state.
  const [apiExecBroken, setApiExecBroken] = useState(false);
  // Same idea for LI.FI: its execution failed (or it stopped quoting at click time) for this
  // pair+amount, so the selection falls back to the next best venue.
  const [lifiExecBroken, setLifiExecBroken] = useState(false);
  // The user's explicit route pick from the routes panel; null = follow the best route.
  const [pinnedVenue, setPinnedVenue] = useState<Venue | null>(null);
  const [execSteps, setExecSteps] = useState<ExecStep[] | null>(null);
  const [isExecutingLifi, setIsExecutingLifi] = useState(false);

  const activeSlippage = "0.5"; // base floor; the auto-slippage ladder widens this up to +7% at execution
  const {
    quote,
    loading: quoteLoading,
    error: quoteError,
    refresh,
  } = useQuote({
    tokenIn,
    tokenOut,
    amountIn,
    slippage: activeSlippage,
    swapper: address,
    blockedRouteKeys,
  });

  const { sendTransaction, sendTransactionAsync, data: txHash } = useSendTransaction();
  // A second sender for LI.FI's side steps (wrap / approve / unwrap), so the TxStatus banner and
  // the post-swap refresh keep tracking only the swap itself.
  const { sendTransactionAsync: sendStepTransaction } = useSendTransaction();
  const { status: receiptStatus } = useWaitForTransactionReceipt({ hash: txHash });
  const txStatus = txHash
    ? receiptStatus === "success"
      ? "success"
      : receiptStatus === "error"
        ? "error"
        : "pending"
    : null;

  const { writeContract, data: pendingTxHash } = useWriteContract();
  const { status: pendingStatus } = useWaitForTransactionReceipt({ hash: pendingTxHash });

  const isETH = tokenIn.address === "ETH";
  const isWrapMode = isEthWethPair(tokenIn, tokenOut) as boolean;
  const tokenAddress = (isETH ? WETH_ADDRESS : tokenIn.address) as `0x${string}`;

  const usesUniversalRouter = !quoteCanUseAether(quote);

  // Honest best price = winner takes execution. Every venue that can execute this trade right now
  // is compared on what the wallet receives: Aether's split, the Uniswap Trading API (its own
  // calldata → Universal Router) and LI.FI (its calldata → the Diamond, output already net of
  // LI.FI's fee). The best one executes unless the user pinned another in the routes panel.
  // Approvals must follow the winner.
  const lifiQuote = quote?.lifiQuote && !quote.lifiQuote.unavailable ? quote.lifiQuote : null;
  const venueOuts = useMemo(() => {
    const outs: Partial<Record<Venue, bigint>> = {};
    if (!quote || quote.provisional || isWrapMode) return outs;
    outs.aether = BigInt(quote.totalAmountOut);
    if (!apiExecBroken && quote.apiQuote?.raw) outs.api = BigInt(quote.apiQuote.amountOut);
    if (!lifiExecBroken && lifiQuote) outs.lifi = BigInt(lifiQuote.amountOut);
    return outs;
  }, [quote, isWrapMode, apiExecBroken, lifiExecBroken, lifiQuote]);
  const executableVenues = (Object.keys(venueOuts) as Venue[]);
  // Auto-pick waits for Aether's full scan and handicaps extra transactions (see lib/venue.ts).
  const bestVenue = autoVenue(quote, venueOuts);
  const activeVenue: Venue = pinnedVenue && venueOuts[pinnedVenue] !== undefined ? pinnedVenue : bestVenue;
  // Fast first paint is on screen and the full scan is still running.
  const refining = Boolean(quote && !quote.final && !quote.provisional && !isWrapMode);
  const lifiActive = activeVenue === "lifi";
  const apiWins = activeVenue === "api";
  const useUrApprovals = usesUniversalRouter || apiWins;
  // The API's calldata runs through the Trading API's OWN router deployment, so the Permit2
  // spender must be that router when the API wins — not our Universal Router.
  const approvalSpender = apiWins
    ? UNISWAP_API_ROUTER
    : useUrApprovals
      ? UNIVERSAL_ROUTER
      : AETHER_AGGREGATOR;
  const erc20ApprovalSpender = useUrApprovals ? PERMIT2 : AETHER_AGGREGATOR;

  const { data: tokenBalance, refetch: refetchTokenBalance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) && !isETH },
  });
  const { data: nativeBalance, refetch: refetchNativeBalance } = useBalance({
    address,
    query: { enabled: Boolean(address) && isETH },
  });
  const { data: erc20Allowance, refetch: refetchErc20Allowance } = useReadContract({
    address: isETH ? undefined : (tokenIn.address as `0x${string}`),
    abi: ERC20_ABI,
    functionName: "allowance",
    args: isETH ? undefined : [address, erc20ApprovalSpender],
    query: { enabled: Boolean(address) && !isETH && !isWrapMode },
  });
  const { data: permit2Allowance, refetch: refetchPermit2Allowance } = useReadContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: isETH ? undefined : [address, tokenIn.address, approvalSpender],
    query: { enabled: Boolean(address) && !isETH && !isWrapMode && useUrApprovals },
  });

  // The API's own forwarder pulls the token with a plain `transferFrom`, so it needs a
  // DIRECT ERC-20 allowance — a Permit2 grant does nothing for it. Read separately from
  // `erc20Allowance` (which tracks the Permit2/Aether spender) because both can be needed
  // at once: /swap decides which target it returns only when it answers.
  const { data: apiRouterAllowance, refetch: refetchApiRouterAllowance } = useReadContract({
    address: isETH ? undefined : (tokenIn.address as `0x${string}`),
    abi: ERC20_ABI,
    functionName: "allowance",
    args: isETH ? undefined : [address, UNISWAP_API_ROUTER],
    query: { enabled: Boolean(address) && !isETH && !isWrapMode && apiWins },
  });

  const wrongNetwork = isConnected && chain?.id !== SEPOLIA_ID;

  /**
   * Which grants are still missing, as separate flags so the button and the
   * approve handler agree on what to do next instead of re-deriving it.
   */
  const missing = useMemo(() => {
    const none = { erc20: false, permit2: false, apiRouter: false };
    // The LI.FI flow grants its own (exact-amount) allowance to the Diamond as one of its steps.
    if (isWrapMode || isETH || !amountIn || lifiActive) return none;

    let amountInWei: bigint;
    try {
      amountInWei = parseUnits(amountIn, tokenIn.decimals);
    } catch {
      return none;
    }

    const erc20 =
      erc20Allowance === undefined || BigInt(erc20Allowance as bigint) < amountInWei;

    let permit2 = false;
    if (useUrApprovals) {
      if (permit2Allowance === undefined) {
        permit2 = true;
      } else {
        const p2amount = Array.isArray(permit2Allowance) ? permit2Allowance[0] : permit2Allowance;
        const p2expiration = Array.isArray(permit2Allowance) ? permit2Allowance[1] : undefined;
        permit2 =
          BigInt(p2amount as bigint) < amountInWei ||
          (p2expiration !== undefined && Number(p2expiration) < Math.floor(Date.now() / 1000));
      }
    }

    const apiRouter =
      apiWins &&
      (apiRouterAllowance === undefined || BigInt(apiRouterAllowance as bigint) < amountInWei);

    return { erc20, permit2, apiRouter };
  }, [
    erc20Allowance,
    permit2Allowance,
    apiRouterAllowance,
    amountIn,
    isETH,
    isWrapMode,
    tokenIn.decimals,
    useUrApprovals,
    apiWins,
    lifiActive,
  ]);

  const needsApproval = missing.erc20 || missing.permit2 || missing.apiRouter;

  useEffect(() => {
    setPreflightError(null);
    setAutoSlipNote(null);
  }, [quote?.totalAmountOut, quote?.routes?.length]);

  useEffect(() => {
    setBlockedRouteKeys([]);
    setPriceMovedNote(null);
    setApiExecBroken(false);
    setLifiExecBroken(false);
    setPinnedVenue(null);
    setExecSteps(null);
  }, [tokenIn.address, tokenOut.address, amountIn]);

  useEffect(() => {
    if (receiptStatus !== "success") return;
    invalidateQuoteCache();
    // Refresh balances + allowance the moment the swap confirms so the displayed balance updates
    // without a manual refresh. Repeat once after a short delay in case the RPC node lags a block.
    refetchTokenBalance();
    refetchNativeBalance();
    refetchErc20Allowance();
    const timer = setTimeout(() => {
      refresh();
      refetchTokenBalance();
      refetchNativeBalance();
    }, 1200);
    return () => clearTimeout(timer);
  }, [receiptStatus, refresh, refetchTokenBalance, refetchNativeBalance, refetchErc20Allowance]);

  useEffect(() => {
    if (pendingStatus === "success") {
      if (approvalStep === "erc20" && useUrApprovals) {
        setApprovalStep("permit2");
        writeContract({
          address: PERMIT2,
          abi: PERMIT2_ABI,
          functionName: "approve",
          args: [tokenIn.address, approvalSpender, MAX_UINT160, PERMIT2_EXPIRATION],
        });
      } else if (approvalStep === "permit2" && apiWins) {
        // /swap can answer with the API's forwarder instead of the Universal Router, and
        // that one pulls the token itself — grant its direct allowance in the same run so
        // the swap isn't rejected by whichever target happens to come back.
        setApprovalStep("api-router");
        writeContract({
          address: tokenIn.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [UNISWAP_API_ROUTER, BigInt(MAX_UINT256)],
        });
      } else if (approvalStep === "erc20") {
        setApprovalStep("idle");
        setTimeout(() => refetchErc20Allowance(), 1000);
      } else if (approvalStep === "permit2") {
        setApprovalStep("idle");
        setTimeout(() => {
          refetchErc20Allowance();
          refetchPermit2Allowance();
        }, 1000);
      } else if (approvalStep === "api-router") {
        setApprovalStep("idle");
        setTimeout(() => {
          refetchErc20Allowance();
          refetchPermit2Allowance();
          refetchApiRouterAllowance();
        }, 1000);
      }
    } else if (pendingStatus === "error") {
      setApprovalStep("idle");
    }
  }, [
    pendingStatus,
    approvalStep,
    useUrApprovals,
    apiWins,
    tokenIn.address,
    approvalSpender,
    writeContract,
    refetchErc20Allowance,
    refetchPermit2Allowance,
    refetchApiRouterAllowance,
  ]);

  const handleFlip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(activeOut?.formatted || "");
    setApprovalStep("idle");
    setBlockedRouteKeys([]);
  };

  /** Grants the first allowance that is actually missing; the chain effect continues from there. */
  const handleApprove = () => {
    if (isETH) return;

    if (missing.erc20) {
      setApprovalStep("erc20");
      writeContract({
        address: tokenIn.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [erc20ApprovalSpender, BigInt(MAX_UINT256)],
      });
      return;
    }

    if (missing.permit2) {
      setApprovalStep("permit2");
      writeContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [tokenIn.address, approvalSpender, MAX_UINT160, PERMIT2_EXPIRATION],
      });
      return;
    }

    if (missing.apiRouter) {
      setApprovalStep("api-router");
      writeContract({
        address: tokenIn.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [UNISWAP_API_ROUTER, BigInt(MAX_UINT256)],
      });
    }
  };

  /**
   * Gas for the swap we're about to send, from OUR estimate (+25%, capped at the per-transaction
   * limit) instead of the wallet's. When a wallet can't estimate a transaction it falls back to a
   * fixed default — tx 0x0b111e4d… got 2,000,000 for a swap that needed ~24.6M and reverted out of
   * gas. null = not sendable at any gas a transaction may carry.
   */
  const estimateSwapGas = async (tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
    if (!publicClient || !address) return null;
    try {
      const estimate = await publicClient.estimateGas({ account: address, ...tx });
      if (estimate > TX_GAS_CAP) return null;
      const padded = (estimate * 125n) / 100n;
      return padded > TX_GAS_CAP ? TX_GAS_CAP : padded;
    } catch {
      return null;
    }
  };

  const handleSwap = async () => {
    if (!quote || !address) return;
    setPreflightError(null);
    setAutoSlipNote(null);
    setPriceMovedNote(null);
    const totalAmountIn = parseUnits(amountIn, tokenIn.decimals);

    if (isWrapMode) {
      const isWrap = tokenIn.address === "ETH";
      const data = encodeFunctionData({
        abi: WETH_ABI,
        functionName: isWrap ? "deposit" : "withdraw",
        args: isWrap ? [] : [totalAmountIn],
      });
      try {
        setIsPreflighting(true);
        await publicClient?.call({
          account: address,
          to: WETH_ADDRESS,
          value: isWrap ? totalAmountIn : 0n,
          data,
        });
      } catch {
        setPreflightError("Preflight failed: the route or token state changed");
        return;
      } finally {
        setIsPreflighting(false);
      }
      sendTransaction({ to: WETH_ADDRESS, value: isWrap ? totalAmountIn : 0n, data });
      return;
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const totalAmountOutMin = parseUnits(quote.minOutFormatted, tokenOut.decimals);
    const minOutLadder = AUTO_SLIPPAGE_EXTRA_BPS as bigint[];

    // Winner takes execution. The displayed comparison says the API pays more — verify it
    // same-instant at click time (one fresh /quote), and only if it STILL beats our split, send
    // the API's own calldata (/swap → Universal Router).
    if (apiWins) {
      let apiTx = null;
      try {
        setIsPreflighting(true);
        const freshApi = await fetchUniswapApiQuote({
          tokenIn,
          tokenOut,
          amountRaw: totalAmountIn.toString(),
          slippage: activeSlippage,
          swapper: address,
        });
        if (freshApi && BigInt(freshApi.amountOut) > BigInt(quote.totalAmountOut)) {
          apiTx = await fetchUniswapApiSwap(freshApi.raw);
          // Real preflight from the user's account — reverts surface here instead of on-chain.
          await publicClient?.call({
            account: address,
            to: apiTx.to,
            data: apiTx.data,
            value: apiTx.value,
          });
          setAutoSlipNote(
            `The Uniswap API route pays more right now (${freshApi.amountOutFormatted} ${tokenOut.symbol}), so the swap was sent through it.`,
          );
        } else if (freshApi) {
          setPriceMovedNote(
            "Re-checked at click time: the aggregator route now matches or beats the API. The quote is back in sync — press Swap again to execute through the aggregator.",
          );
          refresh({ keepCache: true });
          return;
        } else {
          throw new Error("Uniswap API quote unavailable at click time");
        }
      } catch (error) {
        console.warn("API execution path failed, falling back to aggregator:", error);
        setApiExecBroken(true);
        if (!isETH && !usesUniversalRouter) {
          // Approvals were pointed at Permit2/UR for the API path; the aggregator needs its own
          // allowance. If it's missing, the approve button (now targeting Aether) must run first.
          const aetherAllowance = await publicClient
            ?.readContract({
              address: tokenIn.address as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [address, AETHER_AGGREGATOR],
            })
            .catch(() => 0n);
          if (((aetherAllowance as bigint) ?? 0n) < totalAmountIn) {
            setPreflightError(
              "The API route could not execute, so it switched to the aggregator. Approve first (the aggregator needs its own allowance), then Swap.",
            );
            return;
          }
        }
        apiTx = null;
      } finally {
        setIsPreflighting(false);
      }
      if (apiTx) {
        const gas = await estimateSwapGas(apiTx);
        if (gas) {
          sendTransaction({ to: apiTx.to, value: apiTx.value, data: apiTx.data, gas });
          return;
        }
        // The API's calldata simulated but can't be estimated within a transaction's gas limit —
        // don't hand the wallet a transaction that will revert. The selection moves off the API;
        // the aggregator may need its own approval first, so let the next click take that path.
        setApiExecBroken(true);
        setPriceMovedNote("Gas for the Uniswap API route cannot be estimated right now. Switching to the next route — press Swap again.");
        return;
      }
      // fall through: execute via the aggregator path below
    }

    if (!usesUniversalRouter) {
      let executable;
      let usedExtraBps = 0n;

      // One ladder pass: preflight at the user's min-out first, then progressively looser levels
      // (Uniswap "Auto" style), executing at the FIRST that simulates. Always the FULL route set.
      const tryLadder = async (
        routesQuote: Quote | { routes: Route[] },
        baseMinOut: bigint,
      ) => {
        let lastError;
        for (const extraBps of minOutLadder) {
          const minOut = (baseMinOut * (10000n - extraBps)) / 10000n;
          try {
            const result = await findExecutableAetherParams({
              publicClient,
              account: address,
              quote: routesQuote,
              tokenIn,
              tokenOut,
              totalAmountIn,
              totalAmountOutMin: minOut,
              recipient: address,
              deadline,
            });
            usedExtraBps = extraBps;
            return result;
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError ?? new Error("Preflight failed");
      };

      try {
        setIsPreflighting(true);

        // Pass 1 — the displayed split, full set; only widen min-out. Preserves the aggregator
        // edge (the bridge routes that beat Uniswap) whenever the full split can execute.
        try {
          executable = await tryLadder(quote, totalAmountOutMin);
        } catch {
          // The displayed split can't execute even at +7% — on Sepolia that usually means the
          // quote is a STALE pool snapshot, not that the routes are bad. Re-quote fresh.
          invalidateQuoteCache();
          let fresh = null;
          try {
            const stableIn = tokenIn.symbol === "USDC" || tokenIn.symbol === "MUSD";
            const stableOut = tokenOut.symbol === "USDC" || tokenOut.symbol === "MUSD";
            const tradeValueUsd = stableIn
              ? parseFloat(amountIn)
              : stableOut
                ? parseFloat(quote.amountOutFormatted)
                : 0;
            const enableMixed =
              (quote.priceImpact ?? 0) > 0.02 ||
              tradeValueUsd >= 50000 ||
              quote.routes.some((route) => route.type?.startsWith("mixed"));
            fresh = await findSplitRoutes(tokenIn, tokenOut, totalAmountIn.toString(), {
              blockedRouteKeys: withDeadRouteKeys(tokenIn, tokenOut, blockedRouteKeys),
              enableMixed,
            });
          } catch {
            fresh = null;
          }

          if (!fresh?.routes?.length) {
            // Never execute a reduced subset of the displayed split — re-sync and let the user
            // click again on an honest number.
            setPriceMovedNote(
              "The quote could not be rebuilt (the RPC is slow right now). It has been refreshed — press Swap again in a moment.",
            );
            refresh({ keepCache: true });
            return;
          }

          const displayedTotal = BigInt(quote.totalAmountOut);
          const freshQuote = { routes: fresh.routes };
          // Measure what the fresh set ACTUALLY pays (min = 1): routes execute sequentially and
          // move each other's pools, so the engine's summed total overshoots at whale size.
          let measured;
          try {
            measured = await findExecutableAetherParams({
              publicClient,
              account: address,
              quote: freshQuote,
              tokenIn,
              tokenOut,
              totalAmountIn,
              totalAmountOutMin: 1n,
              recipient: address,
              deadline,
            });
          } catch (freshError) {
            // Even the CURRENT pool state can't execute this full split — some route is dead.
            // Identify the dead ones, BLOCK them, and rebuild so the WHOLE input is reallocated.
            const maxSlip = (
              parseFloat(activeSlippage) + Number(minOutLadder[minOutLadder.length - 1]) / 100
            ).toString();
            let failing: { key: string }[] = [];
            try {
              failing = await classifyFailingRoutes({
                publicClient,
                account: address,
                quote: freshQuote,
                tokenIn,
                tokenOut,
                totalAmountIn,
                recipient: address,
                deadline,
                slippage: maxSlip,
              });
            } catch {
              failing = [];
            }
            if (failing.length && failing.length < fresh.routes.length) {
              setBlockedRouteKeys((prev) => [...new Set([...prev, ...failing.map((f) => f.key)])]);
              setPriceMovedNote(
                `${failing.length} route cannot execute in the current pool state. The quote was rebuilt without it and your full ${tokenIn.symbol} is still allocated across the routes that work. Check the new number, then press Swap again.`,
              );
              return;
            }
            throw freshError;
          }

          const honestFresh = BigInt(measured.result ?? 0n);
          if (honestFresh * 10000n < displayedTotal * 9900n) {
            // The real payout moved below the number on screen — never execute silently worse.
            const freshOutNum = (Number(honestFresh) / 10 ** tokenOut.decimals).toFixed(6);
            setPriceMovedNote(
              `Pool prices moved: ${quote.amountOutFormatted} ${tokenOut.symbol} is no longer available (now ~${freshOutNum}). The quote was updated — check the new price, then press Swap again.`,
            );
            refresh({ keepCache: true });
            return;
          }
          // Executes and pays at least the displayed number: send it in this same click, with
          // the min anchored to the MEASURED payout.
          const freshMinBase =
            (honestFresh * (10000n - BigInt(Math.round(parseFloat(activeSlippage) * 100)))) / 10000n;
          executable = await tryLadder(freshQuote, freshMinBase);
        }

        if (usedExtraBps > 0n) {
          setAutoSlipNote(
            `Slippage was raised automatically by +${Number(usedExtraBps) / 100}% so the swap could execute (like Uniswap's "Auto").`,
          );
        }
      } catch (error) {
        console.error("Aether preflight failed:", error);
        invalidateQuoteCache();
        refresh();
        const err = error as { shortMessage?: string; details?: string; message?: string };
        const raw = err?.shortMessage || err?.details || err?.message || "";
        setPreflightError(
          /reverted|InsufficientOutput|CurrencyNotSettled|InvalidAmount/i.test(raw)
            ? "The swap cannot execute in the current pool state. Try again shortly — prices may have just moved."
            : raw || "Aether preflight failed",
        );
        return;
      } finally {
        setIsPreflighting(false);
      }

      const params = executable.params;
      const data = encodeFunctionData({
        abi: AETHER_AGGREGATOR_ABI,
        functionName: "execute",
        args: [params],
      });

      const value = tokenIn.address === "ETH" ? params.amountIn : 0n;
      const gas = await estimateSwapGas({ to: AETHER_AGGREGATOR, data, value });
      if (!gas) {
        // Preflight passed within the gas budget, but the node won't estimate it now — the pools
        // moved in between. Never send it on the wallet's fallback gas; re-quote instead.
        invalidateQuoteCache();
        refresh();
        setPreflightError("The route changed just before sending (gas estimation failed). The quote was updated — press Swap again.");
        return;
      }
      sendTransaction({ to: AETHER_AGGREGATOR, value, data, gas });
      return;
    }

    let built;
    let data;
    let simulated = false;
    try {
      setIsPreflighting(true);
      for (const extraBps of minOutLadder) {
        const minOut = (totalAmountOutMin * (10000n - extraBps)) / 10000n;
        built = buildSwapCalldata({
          routes: quote.routes,
          tokenIn,
          tokenOut,
          totalAmountIn,
          totalAmountOutMin: minOut,
          recipient: address,
        });
        data = encodeFunctionData({
          abi: UNIVERSAL_ROUTER_ABI,
          functionName: "execute",
          args: [built.commands, built.inputs, deadline],
        });
        try {
          await publicClient?.simulateContract({
            account: address,
            address: UNIVERSAL_ROUTER,
            abi: UNIVERSAL_ROUTER_ABI,
            functionName: "execute",
            args: [built.commands, built.inputs, deadline],
            value: built.value,
          });
          if (extraBps > 0n) {
            setAutoSlipNote(
              `Slippage was raised automatically by +${Number(extraBps) / 100}% so the swap could execute (like Uniswap's "Auto").`,
            );
          }
          simulated = true;
          break;
        } catch {
          // Try the next (slightly looser) min-out level for this small trade.
        }
      }
    } finally {
      setIsPreflighting(false);
    }

    if (!simulated) {
      invalidateQuoteCache();
      refresh();
      setPreflightError("The route changed; refreshing the quote");
      return;
    }

    const gas = await estimateSwapGas({ to: UNIVERSAL_ROUTER, value: built!.value, data: data as `0x${string}` });
    if (!gas) {
      invalidateQuoteCache();
      refresh();
      setPreflightError("The route changed just before sending (gas estimation failed). The quote was updated — press Swap again.");
      return;
    }
    sendTransaction({ to: UNIVERSAL_ROUTER, value: built!.value, data, gas });
  };

  /**
   * LI.FI execution, run as explicit steps the tracker shows one by one:
   *   wrap (native ETH in) → approve the Diamond (exact amount) → swap → unwrap (native ETH out).
   * The calldata is always fetched for THIS wallet at click time — the displayed quote may have
   * been built for the placeholder address and would pay out there.
   */
  const handleLifiSwap = async () => {
    if (!quote || !address || !publicClient) return;
    setPreflightError(null);
    setAutoSlipNote(null);
    setPriceMovedNote(null);

    const amountInWei = parseUnits(amountIn, tokenIn.decimals);
    let steps: ExecStep[] = [];
    const setStep = (id: ExecStep["id"], patch: Partial<ExecStep>) => {
      steps = steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
      setExecSteps(steps);
    };
    const waitOk = async (hash: `0x${string}`, what: string) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${what} reverted on-chain`);
    };
    let wrapped = false;

    setIsExecutingLifi(true);
    try {
      setIsPreflighting(true);
      let fresh = await fetchLifiQuote({
        tokenIn,
        tokenOut,
        amountRaw: amountInWei.toString(),
        slippage: activeSlippage,
        fromAddress: address,
      });
      setIsPreflighting(false);
      if (fresh.unavailable) {
        setLifiExecBroken(true);
        setPriceMovedNote(`LI.FI no longer has a route for this trade (${fresh.reason}). The next best route is selected — press Swap again.`);
        return;
      }
      // Auto-selected LI.FI must still win same-instant, after the same extra-transaction handicap
      // that picked it; an explicit pick is honoured as long as LI.FI still quotes.
      const aetherOut = BigInt(quote.totalAmountOut);
      const handicap = BigInt(lifiExtraTxs(fresh)) * EXTRA_TX_PENALTY_BPS;
      if (pinnedVenue !== "lifi" && (BigInt(fresh.amountOut) * (10000n - handicap)) / 10000n <= aetherOut) {
        setPriceMovedNote(
          "Re-checked at click time: Aether now matches or beats LI.FI. The quote is back in sync — press Swap again to execute through Aether.",
        );
        refresh({ keepCache: true });
        return;
      }

      const fromToken = fresh.fromToken as `0x${string}`;
      let needsApprove = false;
      if (fromToken.toLowerCase() !== NATIVE) {
        const allowance = (await publicClient.readContract({
          address: fromToken,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, LIFI_DIAMOND],
        })) as bigint;
        // A wrap is about to create the balance, so allowance is the only thing to check here.
        needsApprove = allowance < amountInWei;
      }
      const spendSymbol = fresh.wrapInput ? "WETH" : tokenIn.symbol;
      steps = [
        ...(fresh.wrapInput
          ? [{ id: "wrap" as const, label: `Wrap ${amountIn} ETH → WETH`, status: "pending" as const }]
          : []),
        ...(needsApprove
          ? [{ id: "approve" as const, label: `Approve ${amountIn} ${spendSymbol} for LI.FI`, status: "pending" as const }]
          : []),
        { id: "swap", label: `Swap ${spendSymbol} → ${fresh.unwrapOutput ? "WETH" : tokenOut.symbol} via LI.FI · ${fresh.tool}`, status: "pending" },
        ...(fresh.unwrapOutput
          ? [{ id: "unwrap" as const, label: "Unwrap WETH → ETH", status: "pending" as const }]
          : []),
      ];
      setExecSteps(steps);

      if (fresh.wrapInput) {
        setStep("wrap", { status: "active" });
        const hash = await sendStepTransaction({
          to: WETH_ADDRESS,
          value: amountInWei,
          data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit", args: [] }),
        });
        setStep("wrap", { hash });
        await waitOk(hash, "Wrap");
        wrapped = true;
        setStep("wrap", { status: "done" });
      }

      if (needsApprove) {
        setStep("approve", { status: "active" });
        const hash = await sendStepTransaction({
          to: fromToken,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [LIFI_DIAMOND, amountInWei] }),
        });
        setStep("approve", { hash });
        await waitOk(hash, "Approve");
        setStep("approve", { status: "done" });
      }

      setStep("swap", { status: "active" });
      if (Date.now() - fresh.at > LIFI_CALLDATA_MAX_AGE_MS) {
        const again = await fetchLifiQuote({
          tokenIn,
          tokenOut,
          amountRaw: amountInWei.toString(),
          slippage: activeSlippage,
          fromAddress: address,
        });
        if (again.unavailable) throw new Error(`LI.FI stopped quoting (${again.reason})`);
        if (BigInt(again.amountOut) * 10000n < BigInt(fresh.amountOut) * LIFI_REQUOTE_MIN_BPS) {
          throw new Error(
            `the LI.FI price dropped to ${again.amountOutFormatted} ${tokenOut.symbol} (was ${fresh.amountOutFormatted})`,
          );
        }
        fresh = again;
      }
      const tx = fresh.transactionRequest;
      const readWeth = () =>
        publicClient.readContract({
          address: WETH_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>;
      const wethBefore = fresh.unwrapOutput ? await readWeth() : 0n;
      // Real preflight from the user's account — reverts surface here instead of on-chain.
      try {
        await publicClient.call({ account: address, to: tx.to, data: tx.data, value: tx.value });
      } catch {
        throw new Error("LI.FI preflight failed — the route changed since the quote");
      }
      const swapHash = await sendTransactionAsync({ to: tx.to, data: tx.data, value: tx.value, gas: tx.gasLimit });
      setStep("swap", { hash: swapHash });
      await waitOk(swapHash, "Swap");
      setStep("swap", { status: "done" });

      if (fresh.unwrapOutput) {
        setStep("unwrap", { status: "active" });
        const received = (await readWeth()) - wethBefore;
        if (received > 0n) {
          const hash = await sendStepTransaction({
            to: WETH_ADDRESS,
            data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [received] }),
          });
          setStep("unwrap", { hash });
          await waitOk(hash, "Unwrap");
        }
        setStep("unwrap", { status: "done" });
      }
    } catch (error) {
      const active = steps.find((step) => step.status === "active");
      if (active) setStep(active.id, { status: "error" });
      const err = error as { shortMessage?: string; message?: string };
      const reason = isUserRejection(error)
        ? "transaction rejected in the wallet"
        : err?.shortMessage || err?.message || "execution failed";
      setPreflightError(
        `LI.FI: ${reason}.${wrapped ? " Your ETH was already wrapped into WETH — you can unwrap it through the ETH ↔ WETH pair." : ""}`,
      );
      if (!isUserRejection(error)) setLifiExecBroken(true);
    } finally {
      setIsPreflighting(false);
      setIsExecutingLifi(false);
      refetchTokenBalance();
      refetchNativeBalance();
    }
  };

  const handleSwapOrApprove = () => {
    if (!address || !quote) return;
    if (lifiActive) handleLifiSwap();
    else if (needsApproval) handleApprove();
    else handleSwap();
  };

  const isApproving = approvalStep !== "idle";

  // Aether needs one grant, the Universal Router two, and the API path a third for
  // the forwarder's direct allowance.
  const approvalTotal = apiWins ? 3 : useUrApprovals ? 2 : 1;
  const approvalIndex =
    approvalStep === "erc20" ? 1 : approvalStep === "permit2" ? 2 : 3;

  const balanceFormatted = useMemo(() => {
    if (!address) return null;
    if (isETH) {
      if (nativeBalance?.value === undefined) return null;
      return formatUnits(nativeBalance.value, tokenIn.decimals || 18);
    }
    if (tokenBalance === undefined) return null;
    return formatUnits(tokenBalance as bigint, tokenIn.decimals || 18);
  }, [tokenBalance, nativeBalance?.value, tokenIn.decimals, address, isETH]);

  const balanceLabel = useMemo(() => {
    if (!address) return "0.0000";
    if (balanceFormatted === null) return "…";
    const val = parseFloat(balanceFormatted);
    return `${Number.isNaN(val) ? "0.0000" : val.toFixed(4)} ${tokenIn.symbol}`;
  }, [balanceFormatted, tokenIn.symbol, address]);

  const approvalLabel = useMemo(() => {
    if (isETH || isWrapMode) return null;
    if (!usesUniversalRouter && erc20Allowance !== undefined) {
      const val = Number(erc20Allowance as bigint) / 10 ** tokenIn.decimals;
      return val > 1_000_000 ? "Unlimited" : `${val.toFixed(2)} ${tokenIn.symbol}`;
    }
    if (!permit2Allowance) return null;
    const [p2amount] = permit2Allowance as [bigint, number, number];
    const val = Number(p2amount) / 10 ** tokenIn.decimals;
    return val > 1_000_000 ? "Unlimited" : `${val.toFixed(2)} ${tokenIn.symbol}`;
  }, [permit2Allowance, erc20Allowance, isETH, isWrapMode, tokenIn, usesUniversalRouter]);

  const insufficientBalance = useMemo(() => {
    if (!isConnected || !amountIn || balanceFormatted === null) return false;
    const amt = parseFloat(amountIn);
    const bal = parseFloat(balanceFormatted);
    if (!Number.isFinite(amt) || !Number.isFinite(bal)) return false;
    return amt > bal;
  }, [isConnected, amountIn, balanceFormatted]);

  const buttonLabel = () => {
    if (!isConnected) return "Connect wallet";
    if (wrongNetwork) return "Switch to Sepolia";
    if (!amountIn) return "Enter an amount";
    if (insufficientBalance) return `Insufficient ${tokenIn.symbol}`;
    if (isExecutingLifi) {
      const index = (execSteps ?? []).findIndex((step) => step.status === "active");
      if (index >= 0 && execSteps) return `Step ${index + 1}/${execSteps.length}: ${execSteps[index].label}…`;
    }
    if (quoteLoading) return "Fetching best price…";
    if (isPreflighting) return "Checking route…";
    if (isApproving) return `Step ${approvalIndex}/${approvalTotal}: Approving…`;
    if (lifiActive) return lifiQuote?.wrapInput || lifiQuote?.unwrapOutput ? "Swap via LI.FI (multi-step)" : "Swap via LI.FI";
    if (needsApproval) return "Approve & Swap";
    if (isWrapMode) return tokenIn.address === "ETH" ? "Wrap" : "Unwrap";
    if (apiWins) return "Swap via Uniswap API";
    return "Swap";
  };

  const isDisabled =
    isConnected &&
    (!quote ||
      // A provisional quote has no route set — nothing to encode, so never swappable.
      quote.provisional ||
      !amountIn ||
      wrongNetwork ||
      isApproving ||
      isPreflighting ||
      isExecutingLifi ||
      insufficientBalance);

  // What the wallet receives on the venue that will execute — the output field, rate and minimum
  // follow the selection so the number on screen is never another venue's.
  const activeOut = useMemo(() => {
    if (!quote) return null;
    const amountInNum = parseFloat(amountIn);
    const fromRaw = (raw: string) => Number(raw) / 10 ** tokenOut.decimals;
    if (lifiActive && lifiQuote) {
      const out = fromRaw(lifiQuote.amountOut);
      return {
        formatted: lifiQuote.amountOutFormatted,
        min: fromRaw(lifiQuote.amountOutMin).toFixed(6),
        rate: amountInNum > 0 ? (out / amountInNum).toFixed(6) : "0",
        via: `LI.FI · ${lifiQuote.tool}`,
      };
    }
    if (apiWins && quote.apiQuote) {
      const out = fromRaw(quote.apiQuote.amountOut);
      return {
        formatted: quote.apiQuote.amountOutFormatted,
        min: (out * (1 - parseFloat(activeSlippage) / 100)).toFixed(6),
        rate: amountInNum > 0 ? (out / amountInNum).toFixed(6) : "0",
        via: "Uniswap API",
      };
    }
    return { formatted: quote.amountOutFormatted, min: quote.minOutFormatted, rate: quote.rate, via: null };
  }, [quote, lifiActive, lifiQuote, apiWins, amountIn, tokenOut.decimals]);

  const impactPct = quote ? parseFloat(quote.priceImpactPct) : 0;
  const title = isWrapMode ? (tokenIn.address === "ETH" ? "Wrap" : "Unwrap") : "Swap";

  const amountOutText = quoteLoading && !quote ? "" : (activeOut?.formatted ?? "0.0");
  const [amountInRef, amountInFontSize] = useAmountFontSize<HTMLInputElement>(amountIn || "0.0");
  const [amountOutRef, amountOutFontSize] = useAmountFontSize<HTMLSpanElement>(amountOutText);

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
      <section className="min-w-0 rounded-card border border-line bg-surface p-4 shadow-card">
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            <button
              type="button"
              onClick={() => refresh()}
              title="Refresh price"
              aria-label="Refresh price"
              className="rounded-lg border border-line p-1.5 text-ink-3 transition-colors hover:border-line-2 hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M1 4s1-3 7-3a7 7 0 0 1 7 7M15 12s-1 3-7 3a7 7 0 0 1-7-7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <polyline
                  points="1,1 1,4 4,4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <polyline
                  points="15,15 15,12 12,12"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          {wrongNetwork ? (
            <span className="rounded-md border border-neg/25 bg-neg/8 px-2 py-1 text-[11px] font-medium text-neg">
              Wrong network
            </span>
          ) : null}
        </header>

        {/* From */}
        <div className="rounded-field border border-line bg-inset px-4 pb-3.5 pt-3 focus-within:border-line-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="amount-in" className="text-[12.5px] text-ink-2">
              From
            </label>
            <div className="flex items-center gap-2">
              {approvalLabel && !isETH ? (
                <span className="nums text-[11px] font-medium text-accent">{approvalLabel}</span>
              ) : null}
              <button
                type="button"
                onClick={() => balanceFormatted && setAmountIn(balanceFormatted)}
                className="nums text-[12px] text-ink-2 transition-colors hover:text-accent"
              >
                Balance: {balanceLabel}
              </button>
            </div>
          </div>

          <div className="mt-1 flex items-center gap-3">
            <input
              id="amount-in"
              value={amountIn}
              onChange={(e) => setAmountIn(sanitizeAmount(e.target.value))}
              placeholder="0.0"
              inputMode="decimal"
              autoComplete="off"
              ref={amountInRef}
              style={{ fontSize: amountInFontSize }}
              className="amount-input min-w-0 flex-1 bg-transparent tracking-[-0.03em] outline-none placeholder:text-ink-3"
            />
            <TokenButton token={tokenIn} onClick={() => setSelectorFor("in")} />
          </div>
        </div>

        {/* Flip */}
        <div className="relative z-10 -my-2.5 flex justify-center">
          <button
            type="button"
            onClick={handleFlip}
            aria-label="Switch tokens"
            className="group flex size-9 items-center justify-center rounded-xl border border-line bg-surface text-ink-2 shadow-sm transition-colors hover:border-line-2 hover:text-ink"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="transition-transform duration-200 group-hover:rotate-180"
            >
              <path
                d="M8 2v12M5 10l3 3 3-3M5 6l3-3 3 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* To */}
        <div className="rounded-field border border-line bg-inset px-4 pb-3.5 pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] text-ink-2">To</span>
            {!isWrapMode && quote?.provisional ? (
              <span className="text-[11px] text-ink-3">Estimate · finding best route…</span>
            ) : refining && !pinnedVenue ? (
              <span className="text-[11px] text-ink-3">Executable output · refining route…</span>
            ) : activeOut?.via && !isWrapMode ? (
              <span className="text-[11px] font-medium text-accent">Executable output · via {activeOut.via}</span>
            ) : quote?.hasV4 && !isWrapMode ? (
              <span className="text-[11px] font-medium" style={{ color: "#6d45d9" }}>
                Executable output · V4 active
              </span>
            ) : !isWrapMode && quote ? (
              <span className="text-[11px] text-ink-3">Executable output</span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-3">
            <span
              ref={amountOutRef}
              style={{ fontSize: amountOutFontSize }}
              className={`amount-input min-w-0 flex-1 truncate tracking-[-0.03em] transition-colors ${
                quote?.provisional ? "text-ink-3" : ""
              }`}
            >
              {quoteLoading && !quote ? (
                <span className="skeleton skeleton-text align-middle" />
              ) : (
                amountOutText
              )}
            </span>
            <TokenButton token={tokenOut} onClick={() => setSelectorFor("out")} />
          </div>
        </div>

        {/* Details */}
        <div className="mt-3 rounded-field border border-line bg-surface px-3.5 py-3">
          {!isWrapMode ? (
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[12.5px] text-ink-2">Slippage</span>
              <span
                title="Adjusted automatically so the swap succeeds at the best price (max 7%)"
                className="flex items-center gap-1.5 text-[12.5px] font-medium text-accent"
              >
                <span className="size-1.5 rounded-full bg-accent" />
                Auto
              </span>
            </div>
          ) : null}

          {quote ? (
            <dl className="space-y-1.5 text-[12.5px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-2">Rate</dt>
                <dd className="nums text-right">
                  1 {tokenIn.symbol} = {activeOut?.rate ?? quote.rate} {tokenOut.symbol}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-2">
                  {isWrapMode ? "You receive" : "Min executable received"}
                </dt>
                <dd className="nums text-right">
                  {activeOut?.min ?? quote.minOutFormatted} {tokenOut.symbol}
                </dd>
              </div>
              {lifiActive && lifiQuote ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-2">Fee LI.FI</dt>
                  <dd className="nums text-right text-ink-2">
                    {(lifiQuote.feePct * 100).toFixed(2)}% · already deducted
                  </dd>
                </div>
              ) : null}
              {isWrapMode ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-2">Price impact</dt>
                  <dd className="nums text-accent">0.00%</dd>
                </div>
              ) : null}
              {!isWrapMode && impactPct > 0.1 ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-2">Price impact</dt>
                  <dd className={`nums ${impactPct > 3 ? "text-neg" : "text-warn"}`}>
                    -{quote.priceImpactPct}%
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>

        {quoteError ? <Notice tone="neg">{quoteError}</Notice> : null}

        {quote?.apiBetterTooMuch && !apiWins ? (
          <Notice tone="warn">
            API reference is higher, but the swap will use the executable output above. Do not
            treat the API number as the final received amount.
          </Notice>
        ) : null}

        {!isWrapMode && quote && impactPct > 3 ? (
          <Notice tone="neg">
            This is only the best executable route found. The price impact is high, so consider a
            smaller amount or wait for deeper liquidity.
          </Notice>
        ) : null}

        {preflightError ? <Notice tone="warn">{preflightError}</Notice> : null}
        {priceMovedNote ? <Notice tone="warn">{priceMovedNote}</Notice> : null}

        {autoSlipNote ? (
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-2">{autoSlipNote}</p>
        ) : null}

        <button
          type="button"
          onClick={isConnected ? handleSwapOrApprove : () => openConnectModal?.()}
          disabled={isDisabled}
          className={`mt-3 h-[52px] w-full rounded-field text-[15px] font-medium transition-colors ${
            isDisabled
              ? "cursor-not-allowed bg-inset-2 text-ink-3"
              : "bg-ink text-white hover:bg-ink/88"
          }`}
        >
          {buttonLabel()}
        </button>

        <ExecutionSteps steps={execSteps} />
        <TxStatus hash={txHash} status={txStatus} />
      </section>

      {!isWrapMode ? (
        <RoutesPanel
          quote={quote}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          quoteLoading={quoteLoading || refining}
          amountIn={amountIn}
          activeVenue={activeVenue}
          pinnedVenue={pinnedVenue && venueOuts[pinnedVenue] !== undefined ? pinnedVenue : null}
          executableVenues={executableVenues}
          onSelectVenue={(venue) => {
            setPinnedVenue(venue);
            setPreflightError(null);
            setPriceMovedNote(null);
          }}
        />
      ) : null}

      {selectorFor ? (
        <TokenSelector
          selected={selectorFor === "in" ? tokenIn : tokenOut}
          exclude={selectorFor === "in" ? tokenOut : tokenIn}
          onSelect={(t) => {
            if (selectorFor === "in") setTokenIn(t);
            else setTokenOut(t);
            setApprovalStep("idle");
          }}
          onClose={() => setSelectorFor(null)}
        />
      ) : null}
    </div>
  );
}

function TokenButton({ token, onClick }: { token: Token; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-line bg-surface pl-1.5 pr-3 text-[15px] font-medium transition-colors hover:border-line-2"
    >
      <TokenIcon token={token} size="lg" />
      {token.symbol}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path
          d="M2.5 4 5 6.5 7.5 4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function Notice({ tone, children }: { tone: "neg" | "warn"; children: React.ReactNode }) {
  const cls =
    tone === "neg"
      ? "border-neg/22 bg-neg/8 text-neg"
      : "border-warn/25 bg-warn/8 text-warn";
  return (
    <p className={`mt-2.5 rounded-field border px-3.5 py-2.5 text-[12.5px] leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}
