/**
 * Jev Brain - Centralized Solana Holder Eligibility Service
 * 
 * Verifies on-chain SPL token holdings for Jev Brain (AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump),
 * handles RPC timeouts, failover endpoints, and calculates deterministic holding tiers and credit rates.
 */

export const OFFICIAL_SOLANA_MINT = (process.env.TOKEN_CONTRACT_ADDRESS || 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump').trim();
export const MINIMUM_TOKENS_REQUIRED = Number(process.env.MINIMUM_TOKENS_REQUIRED) || 1;

export const DEFAULT_SOLANA_RPCS = [
  process.env.SOLANA_RPC_URL,
  (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}` : null),
  'https://mainnet.helius-rpc.com/?api-key=6926ac08-44fb-432c-bee5-a0780e1fc338',
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com'
  // Dedupe: env often points at api.mainnet-beta.solana.com — don't retry the same
  // rate-limited endpoint twice in the failover chain.
].filter((url, idx, arr) => url && arr.indexOf(url) === idx);

// Deterministic Holding Tiers & Credit Rates (4x Supercharged: 1-hr yield now generated every 15 minutes)
export const HOLDER_TIERS = [
  {
    tierLevel: 5,
    tierName: 'Dynasty Magnate',
    minTokens: 1_000_000,
    creditRatePer15Min: 2500,
    creditRatePerHour: 10000,
    allowedModels: ['all'],
    description: 'Whale / Frontier VIP: 2,500 credits / 15m (10,000 credits/hr) + full frontier model access'
  },
  {
    tierLevel: 4,
    tierName: 'Syndicate Director',
    minTokens: 100_000,
    creditRatePer15Min: 750,
    creditRatePerHour: 3000,
    allowedModels: ['anthropic/claude-3.5-haiku', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b', 'deepseek/deepseek-chat'],
    description: 'Executive: 750 credits / 15m (3,000 credits/hr) + advanced model access'
  },
  {
    tierLevel: 3,
    tierName: 'Principal Partner',
    minTokens: 10_000,
    creditRatePer15Min: 200,
    creditRatePerHour: 800,
    allowedModels: ['openai/gpt-4o-mini', 'google/gemini-flash-1.5', 'deepseek/deepseek-chat'],
    description: 'Partner: 200 credits / 15m (800 credits/hr) + balanced model access'
  },
  {
    tierLevel: 2,
    tierName: 'Charter Associate',
    minTokens: 1_000,
    creditRatePer15Min: 50,
    creditRatePerHour: 200,
    allowedModels: ['google/gemini-flash-1.5', 'meta-llama/llama-3.1-8b-instruct', 'deepseek/deepseek-chat'],
    description: 'Associate: 50 credits / 15m (200 credits/hr) + fast open-weight model access'
  },
  {
    tierLevel: 1,
    tierName: 'Reserve Initiate',
    minTokens: 1,
    creditRatePer15Min: 10,
    creditRatePerHour: 40,
    allowedModels: ['meta-llama/llama-3.1-8b-instruct', 'google/gemini-flash-1.5'],
    description: 'Initiate: 10 credits / 15m (40 credits/hr) + fast triage model access'
  },
  {
    tierLevel: 0,
    tierName: 'Guest / Ineligible',
    minTokens: 0,
    creditRatePer15Min: 0,
    creditRatePerHour: 0,
    allowedModels: [],
    description: 'Zero verified tokens held. Holding required to unlock rewards.'
  }
];

// In-memory balance cache (60-second TTL)
const balanceCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

/**
 * Validate Solana Base58 public key format
 */
export function isValidSolanaAddress(address) {
  return typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
}

import { fetchLiveMarketData, calculateDynamicTier } from './dexscreener.js';

/**
 * Resolve tier from token balance, dynamically adjusted by live Market Cap.
 * When MC is high, required tokens are lower; when MC is low, required tokens are higher.
 */
export function resolveHolderTier(balanceUi = 0, marketData = null) {
  const amount = Number(balanceUi) || 0;
  if (marketData && marketData.marketCap) {
    const dynamic = calculateDynamicTier(amount, marketData);
    const rateMap = { 5: 10000, 4: 3000, 3: 800, 2: 200, 1: 40, 0: 0 };
    const rate15MinMap = { 5: 2500, 4: 750, 3: 200, 2: 50, 1: 10, 0: 0 };
    return {
      tierLevel: dynamic.tierId || 0,
      tierName: dynamic.tierName || 'Guest / Ineligible',
      creditRatePer15Min: rate15MinMap[dynamic.tierId] || 0,
      creditRatePerHour: rateMap[dynamic.tierId] || 0,
      allowedModels: dynamic.allowedModels || [],
      description: dynamic.description || '',
      requiredTokens: dynamic.requiredTokens || 0,
      marketCap: dynamic.marketCap
    };
  }

  for (const tier of HOLDER_TIERS) {
    if (amount >= tier.minTokens) {
      return { ...tier };
    }
  }
  return { ...HOLDER_TIERS[HOLDER_TIERS.length - 1] };
}

/**
 * Query Solana JSON-RPC with multi-endpoint failover and strict timeout
 */
export async function querySolanaRpcWithFailover(method, params, rpcEndpoints = DEFAULT_SOLANA_RPCS, options = {}) {
  let lastError = null;
  const timeoutMs = options.timeoutMs || (process.env.NODE_ENV === 'test' ? 500 : 5000);

  for (const rpcUrl of rpcEndpoints) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${rpcUrl}`);
      }

      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || `RPC Error from ${rpcUrl}`);
      }

      return { result: json.result, endpoint: rpcUrl };
    } catch (err) {
      lastError = err;
      // Proceed to next fallback RPC
    }
  }

  throw new Error(`All Solana RPC endpoints failed. Last error: ${lastError?.message || 'Unknown RPC error'}`);
}

export const WHITELIST_ADMIN_WALLETS = new Set([
  'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn',
  (process.env.ADMIN_WALLET || '').trim()
].filter(w => w && w !== '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx'));

/**
 * Centralized Holder Eligibility Service
 * @param {string} walletAddress - Solana public key
 * @param {object} options - Optional overrides (mockBalance, tokenMint, rpcUrls, skipCache)
 */
export async function getHolderEligibility(walletAddress, options = {}) {
  const address = (walletAddress || '').trim();
  const tokenMint = (options.tokenMint || OFFICIAL_SOLANA_MINT).trim();

  if (!isValidSolanaAddress(address)) {
    return {
      eligible: false,
      walletAddress: address || null,
      tokenMint,
      balanceRaw: '0',
      balanceUi: 0,
      decimals: 6,
      tier: 'Invalid Address',
      tierLevel: 0,
      creditRatePerHour: 0,
      verifiedAt: new Date().toISOString(),
      error: 'Invalid Solana wallet address format. Must be a 32-44 character Base58 public key.'
    };
  }

  // VIP Operator & Superuser Whitelist (Grants full access without requiring token balance)
  if (WHITELIST_ADMIN_WALLETS.has(address)) {
    const tier = HOLDER_TIERS[0]; // Tier 5: Dynasty Magnate
    return {
      eligible: true,
      walletAddress: address,
      tokenMint,
      balanceRaw: '1000000000000',
      balanceUi: 1_000_000,
      balanceTokens: 1_000_000,
      decimals: 6,
      tier: 'Dynasty Magnate (VIP Whitelist)',
      tierName: 'Dynasty Magnate (VIP Whitelist)',
      tierLevel: 5,
      tierId: 5,
      creditRatePer15Min: 5000,
      creditRatePerHour: 20000,
      accrualRatePerHour: 20000,
      allowedModels: [...tier.allowedModels],
      description: 'VIP Whitelist Operator Account — Full System Access Unlocked',
      verifiedAt: new Date().toISOString(),
      rpcEndpoint: 'whitelist://vip-authority',
      isWhitelisted: true,
      isSuperAdmin: true
    };
  }

  // Handle Mock/Test overrides for deterministic test suites
  if (options.mockBalance !== undefined) {
    const balanceUi = Number(options.mockBalance) || 0;
    const tier = resolveHolderTier(balanceUi);
    return {
      eligible: balanceUi >= 1,
      walletAddress: address,
      tokenMint,
      balanceRaw: String(Math.round(balanceUi * 1_000_000)),
      balanceUi,
      balanceTokens: balanceUi,
      decimals: 6,
      tier: tier.tierName,
      tierName: tier.tierName,
      tierLevel: tier.tierLevel,
      creditRatePer15Min: tier.creditRatePer15Min || Math.round((tier.creditRatePerHour || 0) / 4),
      creditRatePerHour: tier.creditRatePerHour,
      accrualRatePerHour: tier.creditRatePerHour,
      allowedModels: tier.allowedModels,
      verifiedAt: new Date().toISOString(),
      rpcEndpoint: 'mock://test-environment'
    };
  }

  // Check for test mock override or valid cache
  const cached = balanceCache.get(`${address}:${tokenMint}`);
  if (cached?.data?.rpcEndpoint?.startsWith('mock://')) {
    return { ...cached.data };
  }
  if (!options.skipCache) {
    if (cached && (Date.now() - cached.cachedAt < CACHE_TTL_MS)) {
      return { ...cached.data, fromCache: true };
    }
  }

  // Fast-fail unmocked test addresses in test environment without RPC network timeouts
  // FIX: allow tests to opt into the real RPC path by passing explicit rpcUrls.
  // Without this the NODE_ENV=test fast-fail always short-circuited before the
  // failover loop, making verification-outage behavior untestable.
  if (process.env.NODE_ENV === 'test' && !cached && !options.rpcUrls) {
    return {
      eligible: false,
      walletAddress: address,
      tokenMint,
      balanceRaw: '0',
      balanceUi: 0,
      decimals: 6,
      tier: 'Guest / Ineligible',
      tierLevel: 0,
      creditRatePerHour: 0,
      verifiedAt: new Date().toISOString()
    };
  }

  try {
    const rpcUrls = options.rpcUrls || DEFAULT_SOLANA_RPCS;
    const { result, endpoint } = await querySolanaRpcWithFailover(
      'getTokenAccountsByOwner',
      [
        address,
        { mint: tokenMint },
        { encoding: 'jsonParsed' }
      ],
      rpcUrls,
      options
    );

    const accounts = result?.value || [];
    let totalUiAmount = 0;
    let totalRawAmount = BigInt(0);
    let decimals = 6;

    for (const acc of accounts) {
      const parsedInfo = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (parsedInfo) {
        if (typeof parsedInfo.uiAmount === 'number') {
          totalUiAmount += parsedInfo.uiAmount;
        }
        if (parsedInfo.amount) {
          totalRawAmount += BigInt(parsedInfo.amount);
        }
        if (typeof parsedInfo.decimals === 'number') {
          decimals = parsedInfo.decimals;
        }
      }
    }

    const marketData = await fetchLiveMarketData().catch(() => null);
    const tier = resolveHolderTier(totalUiAmount, marketData);
    const eligibilityData = {
      eligible: totalUiAmount >= MINIMUM_TOKENS_REQUIRED,
      walletAddress: address,
      tokenMint,
      balanceRaw: totalRawAmount.toString(),
      balanceUi: totalUiAmount,
      decimals,
      tier: tier.tierName,
      tierLevel: tier.tierLevel,
      creditRatePer15Min: tier.creditRatePer15Min || Math.round((tier.creditRatePerHour || 0) / 4),
      creditRatePerHour: tier.creditRatePerHour,
      allowedModels: tier.allowedModels,
      marketCap: marketData?.marketCap || 100000,
      tokenPriceUsd: marketData?.priceUsd || 0.0001,
      verifiedAt: new Date().toISOString(),
      rpcEndpoint: endpoint
    };

    // Store in cache
    balanceCache.set(`${address}:${tokenMint}`, {
      cachedAt: Date.now(),
      data: eligibilityData
    });

    return eligibilityData;

  } catch (err) {
    // In case of network/RPC failure, fail safely without fabricating balances
    return {
      eligible: false,
      walletAddress: address,
      tokenMint,
      balanceRaw: '0',
      balanceUi: 0,
      decimals: 6,
      tier: 'Verification Delayed',
      tierLevel: 0,
      creditRatePerHour: 0,
      verifiedAt: new Date().toISOString(),
      error: `On-chain verification error: ${err.message}`
    };
  }
}

export function setMockHolderBalance(address, balanceUi = 100000) {
  const tier = resolveHolderTier(balanceUi);
  const data = {
    eligible: balanceUi >= 1,
    walletAddress: address,
    tokenMint: OFFICIAL_SOLANA_MINT,
    balanceRaw: String(Math.round(balanceUi * 1_000_000)),
    balanceUi,
    balanceTokens: balanceUi,
    decimals: 6,
    tier: tier.tierName,
    tierName: tier.tierName,
    tierLevel: tier.tierLevel,
    creditRatePerHour: tier.creditRatePerHour,
    accrualRatePerHour: tier.creditRatePerHour,
    allowedModels: tier.allowedModels,
    verifiedAt: new Date().toISOString(),
    rpcEndpoint: 'mock://test-environment'
  };
  balanceCache.set(`${address}:${OFFICIAL_SOLANA_MINT}`, {
    cachedAt: Date.now(),
    data
  });
  return data;
}
