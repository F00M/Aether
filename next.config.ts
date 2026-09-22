import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Uniswap Trading API and LI.FI are reached through route handlers in
  // src/app/api (uniswap/[endpoint], lifi/quote), which add the API keys on the
  // server. The old `/uniswap-api/*` rewrite forwarded a key the browser had to
  // hold, so it was removed.

  turbopack: {
    // There's an unrelated package-lock.json further up the filesystem, which
    // makes Next infer the wrong workspace root. Pin it to this project.
    root: __dirname,
  },
};

export default nextConfig;
