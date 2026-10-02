/** Keeps `parseUnits` from throwing on partial keystrokes like "1.2.3" or ".". */
export function sanitizeAmount(raw: string): string {
  // A phone's decimal keypad follows the device locale; an Indonesian one types "," for the
  // decimal point. A lone comma is read as one. Next to a "." or repeated ("1,234.5", "1,000,000")
  // commas are thousands separators and dropped.
  const lone = raw.split(",").length === 2 && !raw.includes(".");
  const cleaned = (lone ? raw.replace(",", ".") : raw).replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (!rest.length) return whole;
  return `${whole || "0"}.${rest.join("")}`;
}

/** A decimal string cut to at most `places` decimals, without trailing zeros. */
export function trimDecimals(value: string, places: number): string {
  const [whole, fraction = ""] = value.split(".");
  const kept = fraction.slice(0, places).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}
