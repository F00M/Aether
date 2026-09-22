import { GLYPHS } from "@/components/ui/token-glyphs";

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
  const Glyph = GLYPHS[token.symbol];

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
