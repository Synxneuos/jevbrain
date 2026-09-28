/**
 * Jev Brain — Burn-to-Boost Lifetime Reward Multiplier Engine (2x / 3x / 5x)
 *
 * Deflationary one-time on-chain $JEVBRAIN token burn → permanent credit multiplier:
 *   Level 1 (Base)             → 1.0x (default holding)
 *   Level 2 (Titan Boost)      → 2.0x (Phase 1, LIVE: verified one-time burn)
 *   Level 3 (Apex Supercharge) → 3.0x (Phase 2, future burn event)
 *   Level 4 (Dynasty Overdrive)→ 5.0x (Phase 3, future whale burn event)
 *
 * Verification rules (strict, no fabrication):
 * 1. Transaction signature must resolve on-chain via JSON-RPC getTransaction/jsonParsed.
 * 2. Transaction must have succeeded (meta.err === null) and be confirmed.
 * 3. The claimant wallet MUST be a signing key of the transaction.
 * 4. Transaction must contain an SPL Token burn/burnChecked instruction against the
 *    official $JEVBRAIN mint (authority = claimant), OR a transferChecked of $JEVBRAIN
 *    to the dead/burn address (Incinerator-style permanent destruction).
 * 5. Summed burned amount (raw, 6 decimals) must meet or exceed the one-time burn
 *    requirement for the holder's CURRENT holding tier.
 * 6. Each transaction signature is globally single-use (UNIQUE constraint + pre-check)
 *    and each holder account advances exactly one boost level per verified receipt.
 *
 * Once applied, holder_accounts.boost_multiplier is persistent: the credit engine
 * only pays boosted rates when an on-chain burn receipt exists for that wallet.
 */

import crypto from 'node:crypto';
import {
  OFFICIAL_SOLANA_MINT,
  isValidSolanaAddress,
  getHolderEligibility,
  querySolanaRpcWithFailover,
  DEFAULT_SOLANA_RPCS
} from './holder-eligibility.js';
import { isValidSolanaSignature } from './operator-service.js';
import { dbAdapter } from './db-adapter.js';
import { rewardsStore } from './rewards-store.js';

// $JEVBRAIN uses pump.fun standard 6 decimals
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNITS_PER_UI = 1_000_000n;

// Configurable dead/burn destination addresses accepted as permanent destruction.
// (Primary verification path is the SPL Token burn instruction itself.)
export const BURN_DEAD_ADDRESSES = new Set(
  [
    (process.env.BURN_DEAD_ADDRESS || '').trim(),
    '1nc1nerator11111111111111111111111111111111',
    '11111111111111111111111111111111',
    '4y29QBtuxNewmF3ucn2xy7X8CC98biCy9zVmwXubTfut' // Canonical $JEVBRAIN ATA for 1nc1nerator
  ].filter(Boolean)
);

// ── Boost Level Ladder (extensible roadmap: 2x → 3x → 5x) ──────────────────
export const BOOST_LEVELS = {
  1: { level: 1, name: 'Base Holder', multiplier: 1.0, phase: 'Default (token holding only)' },
  2: { level: 2, name: 'Titan Boost', multiplier: 2.0, phase: 'Phase 1 — LIVE (one-time verified burn)' },
  3: { level: 3, name: 'Apex Supercharge', multiplier: 3.0, phase: 'Phase 2 — upcoming burn event' },
  4: { level: 4, name: 'Dynasty Overdrive', multiplier: 5.0, phase: 'Phase 3 — upcoming whale burn event' }
};

/** Highest boost level currently unlockable (raise to 3/5 when later phases go live). */
export const MAX_ACTIVE_BOOST_LEVEL = (() => {
  const raw = Number(process.env.MAX_ACTIVE_BOOST_LEVEL);
  const cap = Math.max(...Object.keys(BOOST_LEVELS).map(Number));
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), cap);
  return 2;
})();

// ── Tier Burn & Rate Matrix (spec §2 — 4x Supercharged: 1-hr yield every 15 mins) ────────────────
export const BOOST_TIER_MATRIX = [
  { tierLevel: 1, tierName: 'Reserve Initiate', minTokens: 1, baseRatePer15Min: 10, baseRatePerHour: 40, burnTokensRequiredUi: 100, burnOfMinBagLabel: 'entry-level fixed burn' },
  { tierLevel: 2, tierName: 'Charter Associate', minTokens: 1_000, baseRatePer15Min: 50, baseRatePerHour: 200, burnTokensRequiredUi: 250, burnOfMinBagLabel: '25% of min bag' },
  { tierLevel: 3, tierName: 'Principal Partner', minTokens: 10_000, baseRatePer15Min: 200, baseRatePerHour: 800, burnTokensRequiredUi: 2_000, burnOfMinBagLabel: '20% of min bag' },
  { tierLevel: 4, tierName: 'Syndicate Director', minTokens: 100_000, baseRatePer15Min: 750, baseRatePerHour: 3_000, burnTokensRequiredUi: 15_000, burnOfMinBagLabel: '15% of min bag' },
  { tierLevel: 5, tierName: 'Dynasty Magnate', minTokens: 1_000_000, baseRatePer15Min: 2_500, baseRatePerHour: 10_000, burnTokensRequiredUi: 100_000, burnOfMinBagLabel: '10% of min bag' }
];

export function tokensUiToRaw(uiTokens) {
  const n = Number(uiTokens);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid token UI amount.');
  return BigInt(Math.round(n * Number(TOKEN_UNITS_PER_UI)));
}

export function tokensRawToUi(rawTokens) {
  return Number(BigInt(rawTokens || '0')) / Number(TOKEN_UNITS_PER_UI);
}

export function getBoostLevelConfig(level) {
  const cfg = BOOST_LEVELS[Number(level)];
  if (!cfg) throw new Error(`Unknown boost level: ${level}`);
  return cfg;
}

/**
 * One-time burn requirement for a holding tier.
 * Returns null for ineligible (tier 0) wallets.
 */
export function getBurnRequirementForTier(tierLevel) {
  const row = BOOST_TIER_MATRIX.find(r => r.tierLevel === Number(tierLevel));
  if (!row) return null;
  return {
    tierLevel: row.tierLevel,
    tierName: row.tierName,
    requiredTokensUi: row.burnTokensRequiredUi,
    requiredTokensRaw: tokensUiToRaw(row.burnTokensRequiredUi).toString(),
    baseRatePer15Min: row.baseRatePer15Min,
    baseRatePerHour: row.baseRatePerHour,
    boostedRatePer15Min: Math.round(row.baseRatePer15Min * BOOST_LEVELS[2].multiplier),
    boostedRatePerHour: Math.round(row.baseRatePerHour * BOOST_LEVELS[2].multiplier),
    boostedCreditsPerDay: Math.round(row.baseRatePerHour * BOOST_LEVELS[2].multiplier * 24)
  };
}

/** Public config table for the UI (includes 2x/3x/5x preview columns). */
export function listBoostTierMatrix() {
  return BOOST_TIER_MATRIX.map(row => ({
    ...row,
    boostedRate2xPer15Min: Math.round(row.baseRatePer15Min * BOOST_LEVELS[2].multiplier),
    boostedRate2xPerHour: Math.round(row.baseRatePerHour * BOOST_LEVELS[2].multiplier),
    boostedCredits2xPerDay: Math.round(row.baseRatePerHour * BOOST_LEVELS[2].multiplier * 24),
    previewRate3xPerHour: Math.round(row.baseRatePerHour * BOOST_LEVELS[3].multiplier),
    previewRate5xPerHour: Math.round(row.baseRatePerHour * BOOST_LEVELS[4].multiplier)
  }));
}

// ── On-chain burn parsing & verification ─────────────────────────────────────

/**
 * Pure parser for a jsonParsed Solana transaction. Extracts $JEVBRAIN burn amount:
 * - SPL Token `burn` / `burnChecked` instructions (mint match + authority check)
 * - SPL Token `transferChecked` to a dead/burn address (mint match + authority check)
 * Throws when no qualifying burn is present.
 */
export function parseTokenBurnFromTransaction({ tx, walletAddress = null, tokenMint = OFFICIAL_SOLANA_MINT }) {
  if (!tx) throw new Error('Transaction object is required for burn verification.');
  if (tx.meta && tx.meta.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
  }
  const confirmation = tx.meta?.confirmationStatus;
  if (confirmation && !['confirmed', 'finalized'].includes(confirmation)) {
    throw new Error(`Transaction is not confirmed yet (status: ${confirmation}).`);
  }

  // Claimant wallet must be a signer of the burn transaction.
  if (walletAddress) {
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const wk = accountKeys.find(k => (typeof k === 'string' ? k : k?.pubkey) === walletAddress);
    if (!wk) throw new Error('Claimant wallet does not appear in the burn transaction.');
    if (typeof wk !== 'string' && wk.signer !== true) {
      throw new Error('Claimant wallet is not a required signer of the burn transaction.');
    }
  }

  // Flatten all accounts appearing in transaction & meta (v0 support)
  const allAccountKeys = [
    ...(tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k?.pubkey)),
    ...(tx.meta?.loadedAddresses?.writable || []),
    ...(tx.meta?.loadedAddresses?.readonly || [])
  ].filter(Boolean);

  // Dynamic discovery of dead/burn accounts
  const deadAccounts = new Set(BURN_DEAD_ADDRESSES);

  // 1. Discover dead token accounts from pre/post token balances where owner is a known dead address
  const tokenBalances = [
    ...(tx.meta?.preTokenBalances || []),
    ...(tx.meta?.postTokenBalances || [])
  ];
  for (const tb of tokenBalances) {
    if (tb.owner && (BURN_DEAD_ADDRESSES.has(tb.owner) || deadAccounts.has(tb.owner))) {
      if (typeof tb.accountIndex === 'number' && allAccountKeys[tb.accountIndex]) {
        deadAccounts.add(allAccountKeys[tb.accountIndex]);
      }
    }
  }

  const instructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...((tx.meta?.innerInstructions || []).flatMap(ii => ii.instructions || []))
  ];

  // 2. Discover dead token accounts created dynamically in the transaction (e.g. createIdempotent)
  for (const ix of instructions) {
    const info = ix?.parsed?.info;
    if (!info) continue;
    const destWallet = info.wallet || info.owner;
    if (destWallet && (BURN_DEAD_ADDRESSES.has(destWallet) || deadAccounts.has(destWallet))) {
      if (info.account) deadAccounts.add(info.account);
    }
  }

  let burnedRaw = 0n;
  let burnMethod = null;

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    const info = parsed?.info;
    if (!parsed || !info) continue;

    const program = (ix.program || '').toLowerCase();
    const programId = ix.programId || '';
    const isTokenProgram =
      ['spl-token', 'spl-token-2022'].includes(program) ||
      programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

    if (!isTokenProgram) continue;

    const readAmount = () => BigInt(info.tokenAmount?.amount ?? info.amount ?? 0);

    if (parsed.type === 'burn' || parsed.type === 'burnChecked') {
      // Token program layouts: burn → accounts[1] is the mint; parsed info carries mint directly.
      const mint = info.mint || ix.accounts?.[1] || null;
      if (tokenMint && mint && mint !== tokenMint) continue;
      if (walletAddress && info.authority && info.authority !== walletAddress) continue;
      const amount = readAmount();
      if (amount > 0n) {
        burnedRaw += amount;
        burnMethod = 'token_burn';
      }
    } else if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
      const destination = info.destination;
      if (!destination || !deadAccounts.has(destination)) continue;
      const mint = info.mint || ix.accounts?.[1] || null;
      if (tokenMint && mint && mint !== tokenMint) continue;
      if (walletAddress && info.authority && info.authority !== walletAddress) continue;
      const amount = readAmount();
      if (amount > 0n) {
        burnedRaw += amount;
        burnMethod = 'transfer_to_dead_address';
      }
    }
  }

  // 3. Fallback: On-chain net balance delta check across dead accounts
  if (burnedRaw <= 0n) {
    const preBalances = new Map();
    for (const pre of (tx.meta?.preTokenBalances || [])) {
      if (tokenMint && pre.mint !== tokenMint) continue;
      const acc = allAccountKeys[pre.accountIndex];
      const isDead = (pre.owner && deadAccounts.has(pre.owner)) || (acc && deadAccounts.has(acc));
      if (isDead) {
        preBalances.set(pre.accountIndex, BigInt(pre.uiTokenAmount?.amount || '0'));
      }
    }

    let deltaSum = 0n;
    for (const post of (tx.meta?.postTokenBalances || [])) {
      if (tokenMint && post.mint !== tokenMint) continue;
      const acc = allAccountKeys[post.accountIndex];
      const isDead = (post.owner && deadAccounts.has(post.owner)) || (acc && deadAccounts.has(acc));
      if (isDead) {
        const preAmt = preBalances.get(post.accountIndex) || 0n;
        const postAmt = BigInt(post.uiTokenAmount?.amount || '0');
        if (postAmt > preAmt) {
          deltaSum += (postAmt - preAmt);
        }
      }
    }

    if (deltaSum > 0n) {
      burnedRaw = deltaSum;
      burnMethod = 'transfer_to_dead_address';
    }
  }

  if (burnedRaw <= 0n || !burnMethod) {
    throw new Error('No verifiable $JEVBRAIN token burn instruction found in this transaction.');
  }

  return {
    burnedTokensRaw: burnedRaw.toString(),
    burnedTokensUi: tokensRawToUi(burnedRaw),
    burnMethod
  };
}

/**
 * Fetch and verify a $JEVBRAIN burn transaction live through Solana JSON-RPC failover.
 */
export async function verifyTokenBurnOnChain({
  signature,
  walletAddress,
  tokenMint = OFFICIAL_SOLANA_MINT,
  rpcEndpoints = DEFAULT_SOLANA_RPCS
}) {
  const sig = (signature || '').trim();
  if (!isValidSolanaSignature(sig)) {
    throw new Error('Invalid Solana transaction signature format.');
  }

  const { result: tx } = await querySolanaRpcWithFailover(
    'getTransaction',
    [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    rpcEndpoints
  );

  if (!tx) {
    throw new Error('Burn transaction signature not found on Solana network.');
  }

  const parsed = parseTokenBurnFromTransaction({ tx, walletAddress, tokenMint });
  return {
    ...parsed,
    txSignature: sig,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ?? Math.floor(Date.now() / 1000)
  };
}

// ── Claim flow ───────────────────────────────────────────────────────────────

/**
 * Verify a one-time token burn and permanently upgrade the wallet's boost level.
 * Strictly session-bound: walletAddress must come from the authenticated session/body.
 *
 * options.mockBurnTokensUi — TEST-ONLY (NODE_ENV === 'test'): bypasses RPC lookup with a
 * simulated burn size, mirroring the existing mockBalance test pattern.
 * options.mockBalance — TEST-ONLY: forwarded to holder eligibility lookup.
 */
export async function claimBurnBoost({ walletAddress, txSignature, options = {} }) {
  const address = (walletAddress || '').trim();
  if (!isValidSolanaAddress(address)) {
    throw new Error('Valid Solana wallet address required for Burn-to-Boost claim.');
  }
  const sig = (txSignature || '').trim();
  if (!isValidSolanaSignature(sig)) {
    throw new Error('Invalid Solana burn transaction signature.');
  }

  // Global single-use guard: one on-chain burn transaction may back exactly one receipt.
  if (dbAdapter.getBurnReceiptBySignature(sig)) {
    throw new Error('This burn transaction signature has already been claimed for a boost.');
  }

  const holder = dbAdapter.getHolderAccount(address);
  const currentLevel = Number(holder?.boostLevel || 1);
  const targetLevel = currentLevel + 1;

  if (targetLevel > MAX_ACTIVE_BOOST_LEVEL) {
    const next = BOOST_LEVELS[targetLevel];
    throw new Error(
      currentLevel >= MAX_ACTIVE_BOOST_LEVEL
        ? `Wallet is already boosted to maximum active level: ${getBoostLevelConfig(currentLevel).name} (${getBoostLevelConfig(currentLevel).multiplier}x).`
        : `Boost Level ${targetLevel} (${next ? next.name : 'Unknown'}, ${next ? next.multiplier : '?'}x) is not live yet — it unlocks in a future burn event phase.`
    );
  }

  // Burn requirement is anchored to the holder's current verified holding tier.
  const isTest = process.env.NODE_ENV === 'test';
  const eligibility = await getHolderEligibility(address, {
    mockBalance: isTest && options.mockBalance !== undefined ? Number(options.mockBalance) : undefined
  });

  if (!eligibility.eligible || Number(eligibility.tierLevel || 0) < 1) {
    throw new Error('Wallet must hold verified $JEVBRAIN tokens (Tier 1+) before claiming a burn boost.');
  }

  const requirement = getBurnRequirementForTier(eligibility.tierLevel);
  if (!requirement) {
    throw new Error(`No burn requirement defined for holding tier ${eligibility.tierLevel}.`);
  }

  // On-chain cryptographic verification (or test-mode simulation).
  let verification;
  if (isTest && options.mockBurnTokensUi !== undefined) {
    const ui = Number(options.mockBurnTokensUi);
    if (!Number.isFinite(ui) || ui <= 0) throw new Error('Invalid mock burn amount.');
    verification = {
      burnedTokensRaw: tokensUiToRaw(ui).toString(),
      burnedTokensUi: ui,
      burnMethod: 'test_mock',
      txSignature: sig,
      slot: 0,
      blockTime: Math.floor(Date.now() / 1000)
    };
  } else {
    verification = await verifyTokenBurnOnChain({ signature: sig, walletAddress: address });
  }

  const burnedRaw = BigInt(verification.burnedTokensRaw);
  const requiredRaw = BigInt(requirement.requiredTokensRaw);
  if (burnedRaw < requiredRaw) {
    throw new Error(
      `Insufficient burn for ${requirement.tierName} boost: burned ${tokensRawToUi(burnedRaw)} $JEVBRAIN, ` +
      `but ${requirement.requiredTokensUi} are required at your holding tier. Burn more tokens and resubmit.`
    );
  }

  const targetCfg = getBoostLevelConfig(targetLevel);

  // Atomic: audit receipt + permanent multiplier upgrade + audit event.
  const result = dbAdapter.transaction(() => {
    // Guarantee holder + credit account rows exist (foreign key for receipts).
    rewardsStore.getOrCreateAccount(address);

    const receipt = dbAdapter.insertBurnReceipt({
      id: `burn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      walletAddress: address,
      tierAtBurn: eligibility.tierLevel,
      boostLevelUnlocked: targetCfg.level,
      multiplierAwarded: targetCfg.multiplier,
      tokensBurnedRaw: burnedRaw.toString(),
      tokensBurnedUi: verification.burnedTokensUi,
      txSignature: verification.txSignature,
      blockTime: verification.blockTime,
      burnMethod: verification.burnMethod
    });

    const updatedHolder = dbAdapter.applyBoostToHolder({
      walletAddress: address,
      boostLevel: targetCfg.level,
      boostMultiplier: targetCfg.multiplier,
      tokensBurnedRaw: burnedRaw.toString(),
      txSignature: verification.txSignature
    });

    dbAdapter.recordAuditEvent('BURN_BOOST_ACTIVATED', address, address, {
      boostLevel: targetCfg.level,
      boostName: targetCfg.name,
      multiplier: targetCfg.multiplier,
      tierAtBurn: eligibility.tierLevel,
      tokensBurnedRaw: burnedRaw.toString(),
      tokensBurnedUi: verification.burnedTokensUi,
      txSignature: verification.txSignature,
      burnMethod: verification.burnMethod
    });

    return { receipt, updatedHolder };
  });

  return {
    success: true,
    walletAddress: address,
    boostLevel: targetCfg.level,
    boostName: targetCfg.name,
    boostMultiplier: targetCfg.multiplier,
    tierAtBurn: eligibility.tierLevel,
    tierNameAtBurn: requirement.tierName,
    tokensBurned: verification.burnedTokensUi,
    tokensBurnedRaw: burnedRaw.toString(),
    requiredBurnTokens: requirement.requiredTokensUi,
    txSignature: verification.txSignature,
    blockTime: verification.blockTime,
    burnMethod: verification.burnMethod,
    boostActivatedAt: result.updatedHolder?.boostActivatedAt || null,
    baseRatePerHour: eligibility.creditRatePerHour,
    boostedRatePerHour: Math.round((eligibility.creditRatePerHour || 0) * targetCfg.multiplier),
    receipt: result.receipt
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * Boost state snapshot for a wallet (never throws on missing holder row).
 * Pass an eligibility object (already fetched) to include the live burn requirement.
 */
export function getBoostStatus(walletAddress, eligibility = null) {
  const address = (walletAddress || '').trim();
  const holder = dbAdapter.getHolderAccount(address);
  const level = Number(holder?.boostLevel || 1);
  const cfg = getBoostLevelConfig(level);
  const multiplier = Number(holder?.boostMultiplier || cfg.multiplier || 1.0);

  const nextLevel = level + 1;
  const nextCfg = BOOST_LEVELS[nextLevel] || null;

  const currentTierLevel = eligibility?.tierLevel ?? holder?.tierLevel ?? 0;
  const currentBaseRate = eligibility?.creditRatePerHour ?? holder?.creditRatePerHour ?? 0;

  return {
    walletAddress: address,
    boostLevel: level,
    boostName: cfg.name,
    boostMultiplier: multiplier,
    boostActivatedAt: holder?.boostActivatedAt || null,
    lastBurnTxHash: holder?.lastBurnTxHash || null,
    totalTokensBurned: tokensRawToUi(holder?.totalTokensBurned || '0'),
    totalTokensBurnedRaw: String(holder?.totalTokensBurned || '0'),
    maxActiveBoostLevel: MAX_ACTIVE_BOOST_LEVEL,
    nextBoost: nextCfg ? {
      level: nextCfg.level,
      name: nextCfg.name,
      multiplier: nextCfg.multiplier,
      phase: nextCfg.phase,
      live: nextCfg.level <= MAX_ACTIVE_BOOST_LEVEL && level < MAX_ACTIVE_BOOST_LEVEL
    } : null,
    requirement: currentTierLevel ? getBurnRequirementForTier(currentTierLevel) : null,
    boostedCreditRatePerHour: Math.round(currentBaseRate * multiplier),
    matrix: listBoostTierMatrix(),
    receipts: dbAdapter.getBurnReceiptsByWallet(address, 10)
  };
}



