import { GLYPHS } from "@/components/ui/token-glyphs";
import { TOKENS } from "@/config/tokens";

export type TokenLike = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  color: string;
};

const SIZES = { sm: 20, md: 26, lg: 34 } as const;

/**
 * Real artwork for the listed tokens; a coloured monogram stands in for anything
 * pasted into the picker by address, which has no artwork of its own.
 */
export function TokenIcon({
  token,
  size = "md",
  className = "",
}: {
  token: TokenLike;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  // Artwork goes by address, not by symbol: anyone can deploy a token that calls itself "USDC",
  // and it must not show up wearing the real one's logo.
  const listed = TOKENS.find((entry) => entry.symbol === token.symbol);
  const Glyph = listed && listed.address.toLowerCase() === token.address.toLowerCase() ? GLYPHS[token.symbol] : undefined;

  if (Glyph) {
    return (
      <span className={`inline-flex shrink-0 ${className}`} style={{ width: px, height: px }}>
        <Glyph size={px} />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: px, height: px, backgroundColor: token.color }}
      aria-hidden="true"
    >
      <span
        className="font-semibold leading-none text-white"
        style={{ fontSize: px * 0.46 }}
      >
        {token.symbol.replace(/^W/, "").charAt(0)}
      </span>
    </span>
  );
}
