import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  {
    // The routing engine and quote hook are a verbatim port from the original
    // Vite build. Their effects deliberately setState synchronously (cancelling
    // an in-flight scan, resetting per-quote notices) and the module re-exports
    // several constants it does not itself consume.
    //
    // React's newer hook rules flag those patterns, but rewriting battle-tested
    // aggregator code to satisfy a lint rule is how the race conditions and
    // stale-pool bugs it already fixes come back. Behaviour parity wins here;
    // the rules stay on for everything written for this app.
    files: ["src/swap/**/*.js", "src/hooks/useQuote.js"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    // Same reasoning for the two components that mirror the original SwapCard /
    // TokenSelector state machines one-for-one: the reset effects and the
    // Date.now() allowance-expiry check are load-bearing, not incidental.
    files: ["src/components/swap/swap-card.tsx", "src/components/swap/token-selector.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);

export default eslintConfig;
