"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { Modal } from "@/components/ui/modal";
import { TokenIcon } from "@/components/ui/token-icon";
import { TOKENS } from "@/config/tokens";
import type { Token } from "@/swap/types";

const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CORE_TOKENS = new Set(["ETH", "WETH", "USDC", "UNI", "LINK", "Sepolia"]);

// Tokens with routable V4 liquidity, counted from the pool feed (block 11,760,234): UNI 57 pools,
// LINK 46, Sepolia 7 — each pairing with ETH and USDC. WETH stays out: V4 pairs against native ETH.
const V4_TOKENS = new Set(["ETH", "USDC", "UNI", "LINK", "Sepolia"]);

function tokenCategory(token: Token) {
  return CORE_TOKENS.has(token.symbol) ? "Core" : "Test tokens";
}

export function TokenSelector({
  selected,
  onSelect,
  exclude,
  onClose,
}: {
  selected: Token;
  onSelect: (token: Token) => void;
  exclude?: Token;
  onClose: () => void;
}) {
  const client = usePublicClient();
  const { address } = useAccount();
  const [search, setSearch] = useState("");
  const [customToken, setCustomToken] = useState<Token | null>(null);
  const [fetchingToken, setFetchingToken] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});

  // Balances for every listed token, in parallel.
  useEffect(() => {
    if (!address || !client) return;
    let cancelled = false;

    const fetchAll = async () => {
      const results: Record<string, string> = {};
      await Promise.allSettled(
        (TOKENS as Token[]).map(async (t) => {
          try {
            if (t.address === "ETH") {
              const native = await client.getBalance({ address });
              results[t.address] = formatUnits(native, t.decimals);
              return;
            }
            const bal = await client.readContract({
              address: t.address as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [address],
            });
            results[t.address] = formatUnits(bal as bigint, t.decimals);
          } catch {
            results[t.address] = "0";
          }
        }),
      );
      if (!cancelled) setBalances(results);
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [address, client]);

  // Paste any ERC-20 address to add it ad hoc.
  useEffect(() => {
    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(search);
    if (!isAddress || !client) {
      setCustomToken(null);
      setFetchError(null);
      return;
    }
    const known = (TOKENS as Token[]).find(
      (t) => t.address.toLowerCase() === search.toLowerCase(),
    );
    if (known) return;

    setFetchingToken(true);
    setFetchError(null);
    setCustomToken(null);

    Promise.all([
      client.readContract({ address: search as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: search as `0x${string}`, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address: search as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
    ])
      .then(([symbol, name, decimals]) => {
        setCustomToken({
          symbol: symbol as string,
          name: name as string,
          decimals: Number(decimals),
          address: search,
          chainId: 11155111,
          color: "#7645d9",
        });
      })
      .catch(() => setFetchError("Contract not found or not an ERC20"))
      .finally(() => setFetchingToken(false));
  }, [search, client]);

  const filtered = (TOKENS as Token[]).filter(
    (t) =>
      t.symbol !== exclude?.symbol &&
      (t.symbol.toLowerCase().includes(search.toLowerCase()) ||
        t.name.toLowerCase().includes(search.toLowerCase())),
  );

  const grouped = ["Core", "Test tokens"]
    .map((category) => ({
      category,
      tokens: filtered.filter((token) => tokenCategory(token) === category),
    }))
    .filter((group) => group.tokens.length > 0);

  const pick = (token: Token) => {
    onSelect(token);
    onClose();
  };

  return (
    <Modal open onClose={onClose} title="Select token">
      <div className="border-b border-line px-5 pb-4 pt-4">
        <div className="flex items-center gap-2.5 rounded-field border border-line bg-inset px-3.5 py-2.5 focus-within:border-accent focus-within:bg-surface">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="var(--color-ink-3)" strokeWidth="1.5" />
            <path
              d="M10.5 10.5 14 14"
              stroke="var(--color-ink-3)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or paste address"
            aria-label="Search tokens"
            autoComplete="off"
            className="w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-line px-5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
        <span>Token</span>
        <span>Balance</span>
      </div>

      <div>
        {fetchingToken ? (
          <p className="px-5 py-5 text-center text-[13px] text-ink-2">Fetching token info…</p>
        ) : null}

        {fetchError ? (
          <p className="border-b border-line bg-neg/8 px-5 py-3 text-[13px] text-neg">
            {fetchError}
          </p>
        ) : null}

        {customToken ? (
          <TokenRow
            token={customToken}
            selected={selected}
            balances={balances}
            onPick={pick}
          />
        ) : null}

        {grouped.map((group) => (
          <div key={group.category}>
            {/* A lone header over the whole list is noise — it earns its place
                only once the list actually splits into groups. */}
            {grouped.length > 1 ? (
              <p className="bg-inset px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {group.category}
              </p>
            ) : null}
            {group.tokens.map((token) => (
              <TokenRow
                key={token.address}
                token={token}
                selected={selected}
                balances={balances}
                onPick={pick}
              />
            ))}
          </div>
        ))}

        {!fetchingToken && !customToken && filtered.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-ink-3">No results found</p>
        ) : null}
      </div>
    </Modal>
  );
}

function TokenRow({
  token,
  selected,
  balances,
  onPick,
}: {
  token: Token;
  selected: Token;
  balances: Record<string, string>;
  onPick: (token: Token) => void;
}) {
  const isSelected = selected?.symbol === token.symbol;
  const bal = balances[token.address];
  const balFormatted = bal ? parseFloat(bal).toFixed(4) : "–";

  return (
    <button
      type="button"
      onClick={() => onPick(token)}
      className={`flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left transition-colors last:border-0 ${
        isSelected ? "bg-accent-wash" : "hover:bg-inset"
      }`}
    >
      <TokenIcon token={token} size="lg" />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[14px] font-medium">{token.symbol}</span>
          {V4_TOKENS.has(token.symbol) ? (
            <span
              className="rounded border border-line px-1 py-px text-[9px] font-semibold"
              style={{ color: "#6d45d9" }}
            >
              V4
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[12.5px] text-ink-3">{token.name}</span>
      </span>

      <span className="flex items-center gap-2">
        <span className="nums text-[13.5px]">{balFormatted}</span>
        {isSelected ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3 8l4 4 6-7"
              stroke="var(--color-accent)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
    </button>
  );
}
