// Tradable token list.
//
// This only controls what the picker offers. Bridge corridors are discovered by
// autoHubs.js from live pools, so a token missing here is still routed through.
//
// Order matters: SwapCard seeds TOKENS[0] -> TOKENS[1] as the default pair.
export const TOKENS = [
  {
    symbol: 'ETH',
    name: 'Ether',
    address: 'ETH',
    decimals: 18,
    chainId: 11155111,
    color: '#627EEA',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    chainId: 11155111,
    color: '#3E73C4',
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    decimals: 18,
    chainId: 11155111,
    color: '#FF0080',
  },
  {
    symbol: 'UNI',
    name: 'Uniswap',
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    decimals: 18,
    chainId: 11155111,
    color: '#FF007A',
  },
  {
    symbol: 'LINK',
    name: 'ChainLink Token',
    address: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
    decimals: 18,
    chainId: 11155111,
    color: '#2D4DE0',
  },
  {
    symbol: 'Sepolia',
    name: 'Sepolia',
    address: '0x95c815AD169527CD940E2d2905BC293bc2156fC4',
    decimals: 18,
    chainId: 11155111,
    color: '#54BA77',
  },
]

export function getToken(symbolOrAddress) {
  return TOKENS.find(
    t => t.symbol === symbolOrAddress || t.address.toLowerCase() === symbolOrAddress.toLowerCase()
  )
}
