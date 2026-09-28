/**
 * Jev Brain - Credit Engine & Solana Reward Settlement
 * 
 * Orchestrates deterministic credit accrual, server-side LLM credit deduction,
 * peer-to-peer transfers, and SOL redemptions with strict 5% infrastructure / 95% manual allocations.
 */

import crypto from 'node:crypto';
import { rewardsStore, LAMPORTS_PER_SOL } from './rewards-store.js';
import { getHolderEligibility, isValidSolanaAddress } from './holder-eligibility.js';
import { dbAdapter } from './db-adapter.js';
import { CHAT_MAX_TOKENS } from './openrouter.js';

// Exchange rate: 100,000 credits = 1.0 SOL (1 credit = 10,000 lamports = 0.00001 SOL)
export const LAMPORTS_PER_CREDIT = 10_000n;
export const MIN_REDEMPTION_CREDITS = 100n; // 100 credits = 0.001 SOL minimum
export const MAX_REDEMPTION_CREDITS = 10_000_000n; // 100 SOL maximum per single redemption

/**
 * Deterministic Credit Emission for Solana Token Holders
 * Persists last accrual timestamp into database to survive restarts and prevent duplicate accruals.
 */
export async function accrueCreditsForHolder(walletAddress, options = {}) {
  const address = (walletAddress || '').trim();
  if (!isValidSolanaAddress(address)) {
    throw new Error('Invalid Solana wallet address.');
  }

  // Fetch persistent holder account from database if available
  let holderAccount = dbAdapter.getHolderAccount(address);
  const now = Date.now();

  let eligibility;
  if ((options.useDatabaseTier || options.fromDaemon) && holderAccount) {
    eligibility = {
      eligible: Number(holderAccount.tierLevel || 0) > 0,
      walletAddress: address,
      tier: holderAccount.tier,
      tierLevel: holderAccount.tierLevel,
      creditRatePerHour: holderAccount.creditRatePerHour,
      balanceUi: holderAccount.tokenBalanceUi,
      balanceRaw: holderAccount.tokenBalanceRaw,
      fromDb: true
    };
  } else {
    eligibility = await getHolderEligibility(address, options);
  }

  const isTestForce = process.env.NODE_ENV === 'test' && options.forceAmount !== undefined;

  if (!isTestForce && (!eligibility.eligible || eligibility.creditRatePerHour <= 0)) {
    // FIX (yield stuck): distinguish a transient on-chain verification outage from a
    // genuinely empty wallet. During an RPC outage getHolderEligibility returns
    // eligible:false + error — previously this returned "insufficient tokens" and froze
    // accrual even though the holder row holds a verified tier. Fall back to the last
    // on-chain-verified DB tier (same trust model as HolderAccrualDaemon) so yield keeps
    // accruing through RPC blips. lastAccrualAt is never advanced on failure, so no
    // elapsed time / credits are lost while paused.
    const verificationFailed = Boolean(eligibility.error);
    const dbTierUsable = holderAccount
      && Number(holderAccount.tierLevel || 0) > 0
      && Number(holderAccount.creditRatePerHour || 0) > 0;

    if (verificationFailed && dbTierUsable) {
      eligibility = {
        eligible: true,
        walletAddress: address,
        tier: holderAccount.tier,
        tierLevel: holderAccount.tierLevel,
        creditRatePerHour: holderAccount.creditRatePerHour,
        balanceUi: holderAccount.tokenBalanceUi,
        balanceRaw: holderAccount.tokenBalanceRaw,
        fromDb: true,
        usedDbFallback: true
      };
    } else {
      return {
        accrued: '0',
        reason: verificationFailed
          ? 'On-chain verification is temporarily unavailable. Accrual is paused (not lost) and resumes automatically with full catch-up once RPC recovers.'
          : 'Wallet holds insufficient $jevbrain tokens to qualify for credits.',
        eligibility,
        balance: rewardsStore.getAccountSummary(address)
      };
    }
  }

  if (!holderAccount) {
    dbAdapter.upsertHolderAccount({
      walletAddress: address,
      tokenBalanceRaw: eligibility.balanceRaw || '0',
      tokenBalanceUi: eligibility.balanceUi || 0,
      tier: eligibility.tier,
      tierLevel: eligibility.tierLevel,
      creditRatePerHour: eligibility.creditRatePerHour,
      lastVerifiedAt: new Date(now).toISOString(),
      lastAccrualAt: new Date(now).toISOString()
    });
    holderAccount = dbAdapter.getHolderAccount(address);
  } else if (!eligibility.fromDb) {
    // Keep holder tier & rate updated from live verification
    dbAdapter.upsertHolderAccount({
      ...holderAccount,
      tokenBalanceRaw: eligibility.balanceRaw || holderAccount.tokenBalanceRaw,
      tokenBalanceUi: eligibility.balanceUi || holderAccount.tokenBalanceUi,
      tier: eligibility.tier,
      tierLevel: eligibility.tierLevel,
      creditRatePerHour: eligibility.creditRatePerHour,
      lastVerifiedAt: new Date(now).toISOString()
    });
  }


  // ── Burn-to-Boost: persistent lifetime reward multiplier ──
  // holder_accounts.boost_multiplier is ONLY upgraded after a cryptographically
  // verified on-chain $JEVBRAIN burn receipt (boost-engine.js), so the system
  // "remembers" burn events and pays boosted credits exclusively to burners.
  const boostMultiplier = Number(holderAccount?.boostMultiplier || 1.0);
  const boostLevel = Number(holderAccount?.boostLevel || 1);
  const effectiveMultiplier = boostMultiplier > 0 ? boostMultiplier : 1.0;
  const baseCreditRatePerHour = Number(eligibility.creditRatePerHour) || 0;
  const effectiveRatePerHour = Math.round(baseCreditRatePerHour * effectiveMultiplier);

  const lastAccrualIso = holderAccount.lastAccrualAt || null;
  const lastAccrued = lastAccrualIso
    ? new Date(lastAccrualIso).getTime()
    : now; // B-4 FIX: New accounts start at NOW, not 1h ago — no free initial credits

  const elapsedMs = Math.max(0, now - lastAccrued);
  const elapsedHours = elapsedMs / (3600 * 1000);

  // Compute earned credits based on holding tier rate and lifetime boost multiplier
  let creditsToEarn = Math.floor(elapsedHours * effectiveRatePerHour);

  // STRICT ARBITRARY MINTING FIX: forceAmount is strictly restricted to test mode
  const isForceTest = process.env.NODE_ENV === 'test' && options.forceAmount !== undefined;
  if (isForceTest) {
    creditsToEarn = Number(options.forceAmount) || 0;
  }

  if (creditsToEarn <= 0) {
    return {
      accrued: '0',
      reason: 'Accrual interval not yet reached.',
      eligibility,
      balance: rewardsStore.getAccountSummary(address),
      boost: {
        level: Number(holderAccount?.boostLevel || 1),
        multiplier: effectiveMultiplier
      }
    };
  }

  const nowIso = new Date(now).toISOString();
  // Compute consumed time for the integer credits earned to preserve fractional remainder
  const creditedTimeMs = (effectiveRatePerHour > 0 && !isForceTest)
    ? Math.floor((creditsToEarn / effectiveRatePerHour) * 3600 * 1000)
    : elapsedMs;
  const newAccrualTs = new Date(lastAccrued + creditedTimeMs).toISOString();

  // B-4 FIX: Atomic conditional accrual — prevent double-accrual across cold starts.
  // FIX (silent credit loss): clock advance + ledger write + snapshot now commit as ONE
  // ACID transaction. Previously the clock advanced FIRST and the ledger write could
  // still throw (DB error / invariant) — the elapsed window was consumed but never
  // credited, permanently burning the user's yield. On any ledger failure the whole
  // transaction rolls back (including the clock), so the next attempt re-earns the
  // full window instead of losing it.
  const expectedAccrualTs = lastAccrualIso || holderAccount.lastAccrualAt;
  const snapshotId = `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  let entry = null;
  let racedLost = false;

  dbAdapter.transaction(() => {
    if (!isForceTest && expectedAccrualTs) {
      const updated = dbAdapter.conditionalUpdateAccrualTime(address, expectedAccrualTs, newAccrualTs);
      if (!updated) {
        // Another process already advanced the accrual timestamp — commit nothing new,
        // skip to prevent double-earning.
        racedLost = true;
        return;
      }
    } else {
      // First-time accrual or test forceAmount — use non-conditional update
      dbAdapter.updateLastAccrualTime(address, newAccrualTs);
    }

    entry = rewardsStore.recordLedgerEntry({
      walletAddress: address,
      type: 'EARN',
      amount: BigInt(creditsToEarn),
      referenceId: snapshotId,
      metadata: {
        tier: eligibility.tier,
        tierLevel: eligibility.tierLevel,
        baseRatePerHour: eligibility.creditRatePerHour,
        boostMultiplier: effectiveMultiplier,
        effectiveRatePerHour,
        tokenBalanceUi: eligibility.balanceUi,
        elapsedHours: Number(elapsedHours.toFixed(2))
      }
    }).entry;

    // Persist snapshot in the same transaction (FK to holder_accounts satisfied above)
    dbAdapter.insertHolderSnapshot({
      id: snapshotId,
      walletAddress: address,
      balanceRaw: eligibility.balanceRaw || '0',
      balanceUi: eligibility.balanceUi || 0,
      tier: eligibility.tier,
      creditRatePerHour: effectiveRatePerHour,
      creditsAccrued: creditsToEarn,
      snapshotAt: nowIso
    });
  });

  if (racedLost) {
    return {
      accrued: '0',
      reason: 'Accrual already processed by another instance.',
      eligibility,
      balance: rewardsStore.getAccountSummary(address),
      boost: {
        level: Number(holderAccount?.boostLevel || 1),
        multiplier: effectiveMultiplier
      }
    };
  }

  return {
    accrued: creditsToEarn.toString(),
    entry: {
      ...entry,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString()
    },
    account: rewardsStore.getAccountSummary(address),
    eligibility,
    boost: {
      level: Number(holderAccount?.boostLevel || 1),
      multiplier: effectiveMultiplier
    },
    effectiveRatePerHour
  };
}

/**
 * Model-based credit multiplier: frontier models burn credits at 4x rate.
 */
export function creditMultiplierForModel(model = 'auto') {
  const m = String(model || '').toLowerCase();
  const isFrontier = m.includes('claude-3') || m.includes('gpt-4o') || m.includes('sonnet');
  return isFrontier ? 4 : 1;
}

/**
 * Pre-inference credit estimate (B-9 FIX).
 * Reserves-against the worst realistic cost of one request: prompt estimate
 * (chars/4 + 100 wrapper tokens) + completion capped at CHAT_MAX_TOKENS.
 */
export function estimateLlmCreditCost({ model = 'auto', prompt = '' }) {
  const promptTokens = Math.max(1, Math.ceil((prompt || '').length / 4)) + 100;
  // Completion is hard-capped at CHAT_MAX_TOKENS upstream; estimate half the cap
  // because average completions are ~50% of the ceiling, with the partial-charge
  // fallback covering rare outliers.
  const completionEstimate = Math.ceil(CHAT_MAX_TOKENS / 2);
  const multiplier = creditMultiplierForModel(model);
  return Math.max(1, Math.ceil(((promptTokens + completionEstimate) / 25) * multiplier));
}

/**
 * Server-Side LLM Credit Deduction
 * Calculates actual token cost based on model pricing and deducts credits.
 * Safe for JSON & SSE streaming serialization (zero raw BigInt leakage).
 */
export function deductCreditsForLLM({ walletAddress, promptTokens = 0, completionTokens = 0, model = 'auto', partialAllowed = true }) {
  const address = (walletAddress || '').trim();
  const totalTokens = promptTokens + completionTokens;

  // Base consumption: 1 credit per 25 tokens (~$0.0001 per token base)
  // Frontier models (Claude 3.5 Sonnet / GPT-4o) consume at a 4x rate
  const multiplier = creditMultiplierForModel(model);
  const creditsRequired = Math.max(1, Math.ceil((totalTokens / 25) * multiplier));

  // B-9 FIX: partial-charge fallback — if the actual usage costs more than the
  // pre-flight estimate allowed, charge whatever remains instead of throwing
  // after inference has already been paid for by the platform.
  let chargeAmount = BigInt(creditsRequired);
  let partial = false;
  if (partialAllowed) {
    const summary = rewardsStore.getAccountSummary(address);
    const available = BigInt(summary.available || '0');
    if (chargeAmount > available) {
      if (available <= 0n) {
        throw new Error(`Insufficient credits: requested ${chargeAmount}, available 0.`);
      }
      chargeAmount = available;
      partial = true;
    }
  }

  const usageId = `llm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const { account, entry } = rewardsStore.recordLedgerEntry({
    walletAddress: address,
    type: 'USE',
    amount: chargeAmount,
    referenceId: usageId,
    metadata: {
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      multiplier,
      creditsRequired,
      partialCharge: partial
    }
  });

  // Record usage into llm_usage table
  try {
    dbAdapter.insertLlmUsage({
      id: usageId,
      walletAddress: address,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      creditsDeducted: chargeAmount.toString()
    });
  } catch (e) {
    console.warn('[CreditEngine] insertLlmUsage warning:', e.message);
  }

  return {
    creditsDeducted: chargeAmount.toString(),
    creditsRequired: creditsRequired.toString(),
    partialCharge: partial,
    availableCredits: account.available.toString(),
    entry: {
      ...entry,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString()
    }
  };
}

/**
 * Peer-to-Peer Solana Credit Transfer
 */
export function transferCredits(senderWallet, recipientWallet, creditAmount) {
  const sender = (senderWallet || '').trim();
  const recipient = (recipientWallet || '').trim();
  const amount = BigInt(creditAmount);

  if (!isValidSolanaAddress(sender)) throw new Error('Sender must be a valid Solana address.');
  if (!isValidSolanaAddress(recipient)) throw new Error('Recipient must be a valid Solana address.');
  if (amount <= 0n) throw new Error('Transfer amount must be positive.');

  return rewardsStore.transferCredits(sender, recipient, amount);
}

/**
 * Phase 1: Atomically reserve estimated credits BEFORE LLM inference.
 * Prevents concurrent double-spend / free AI loop.
 */
export function reserveCreditsForLLM({ walletAddress, estimatedCredits, model = 'auto' }) {
  const address = (walletAddress || '').trim();
  const credits = BigInt(estimatedCredits || 0);

  if (!isValidSolanaAddress(address)) {
    throw new Error('Invalid Solana wallet address for credit reservation.');
  }
  if (credits <= 0n) {
    throw new Error('Estimated credits must be greater than zero.');
  }

  const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  return dbAdapter.transaction(() => {
    const summary = rewardsStore.getAccountSummary(address);
    const available = BigInt(summary.available || '0');
    if (available < credits) {
      throw new Error(`Insufficient credits: requested reservation of ${credits}, available ${available}.`);
    }

    // Debit estimated credits immediately under AI_RESERVE to reduce available balance
    rewardsStore.recordLedgerEntry({
      walletAddress: address,
      type: 'AI_RESERVE',
      amount: credits,
      referenceId: reservationId,
      metadata: {
        model,
        estimatedCredits: credits.toString()
      }
    });

    dbAdapter.createCreditReservation({
      id: reservationId,
      walletAddress: address,
      estimatedCredits: credits,
      model,
      createdAt: new Date().toISOString()
    });

    return {
      reservationId,
      walletAddress: address,
      estimatedCredits: credits.toString(),
      remainingAvailable: rewardsStore.getAccountSummary(address).available
    };
  });
}

/**
 * Phase 2: Settle reservation with actual token usage after LLM inference.
 * Reconciles estimated vs actual cost, refunding unused credits immediately.
 */
export function settleCreditReservation({ reservationId, promptTokens = 0, completionTokens = 0, model = 'auto' }) {
  const resId = (reservationId || '').trim();
  if (!resId) throw new Error('reservationId is required to settle reservation.');

  return dbAdapter.transaction(() => {
    const reservation = dbAdapter.getCreditReservation(resId);
    if (!reservation) throw new Error(`Reservation '${resId}' not found.`);
    if (reservation.status !== 'ACTIVE') {
      return { alreadySettled: true, reservation };
    }

    const address = reservation.wallet_address;
    const reservedCredits = BigInt(reservation.estimated_credits);

    // Calculate actual cost
    const totalTokens = promptTokens + completionTokens;
    const multiplier = creditMultiplierForModel(model || reservation.model);
    const actualCost = BigInt(Math.max(1, Math.ceil((totalTokens / 25) * multiplier)));

    let finalCharge = actualCost;
    if (finalCharge > reservedCredits) {
      // If inference exceeded pre-reservation, attempt to debit the remainder if available
      const summary = rewardsStore.getAccountSummary(address);
      const available = BigInt(summary.available || '0');
      const extra = finalCharge - reservedCredits;
      if (available >= extra) {
        rewardsStore.recordLedgerEntry({
          walletAddress: address,
          type: 'USE',
          amount: extra,
          referenceId: `${resId}_extra`,
          metadata: { reason: 'inference_over_estimate_debit', extra: extra.toString() }
        });
      } else {
        finalCharge = reservedCredits + available;
        if (available > 0n) {
          rewardsStore.recordLedgerEntry({
            walletAddress: address,
            type: 'USE',
            amount: available,
            referenceId: `${resId}_extra_partial`,
            metadata: { reason: 'inference_over_estimate_partial_debit' }
          });
        }
      }
    } else if (reservedCredits > finalCharge) {
      // Refund the difference
      const refund = reservedCredits - finalCharge;
      rewardsStore.recordLedgerEntry({
        walletAddress: address,
        type: 'ADJUSTMENT',
        amount: refund,
        referenceId: resId,
        metadata: {
          isCredit: true,
          reason: 'ai_reservation_refund',
          reserved: reservedCredits.toString(),
          actual: finalCharge.toString(),
          refunded: refund.toString()
        }
      });
    }

    // Mark reservation as SETTLED
    dbAdapter.updateCreditReservation({
      id: resId,
      actualCredits: finalCharge,
      status: 'SETTLED',
      settledAt: new Date().toISOString()
    });

    const remainingAvail = rewardsStore.getAccountSummary(address).available;
    return {
      reservationId: resId,
      walletAddress: address,
      reservedCredits: reservedCredits.toString(),
      actualCreditsCharged: finalCharge.toString(),
      refundedCredits: (reservedCredits > finalCharge ? reservedCredits - finalCharge : 0n).toString(),
      remainingAvailable: remainingAvail,
      creditsDeducted: finalCharge.toString(),
      availableCredits: remainingAvail,
      entry: {
        amount: finalCharge.toString(),
        balanceAfter: remainingAvail
      }
    };
  });
}

/**
 * Release an active reservation without charge (e.g. on LLM failure or cache hit).
 */
export function releaseCreditReservation({ reservationId, reason = 'cancelled' }) {
  const resId = (reservationId || '').trim();
  if (!resId) return null;

  return dbAdapter.transaction(() => {
    const reservation = dbAdapter.getCreditReservation(resId);
    if (!reservation || reservation.status !== 'ACTIVE') return null;

    const address = reservation.wallet_address;
    const reservedCredits = BigInt(reservation.estimated_credits);

    // 100% refund of the hold
    rewardsStore.recordLedgerEntry({
      walletAddress: address,
      type: 'ADJUSTMENT',
      amount: reservedCredits,
      referenceId: resId,
      metadata: {
        isCredit: true,
        reason: `ai_reservation_release_${reason}`,
        reservationId: resId
      }
    });

    dbAdapter.updateCreditReservation({
      id: resId,
      actualCredits: 0n,
      status: 'RELEASED',
      settledAt: new Date().toISOString()
    });

    return { released: true, reservationId: resId, refunded: reservedCredits.toString() };
  });
}

/**
 * Continuous crash recovery: release any reservation stuck in ACTIVE older than ttlMs
 */
export function reconcileStaleReservations(ttlMs = 300000) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const stale = dbAdapter.getStaleReservations(cutoff);
  let count = 0;
  for (const r of stale) {
    try {
      releaseCreditReservation({ reservationId: r.id, reason: 'crash_or_timeout' });
      count++;
    } catch (e) {
      console.warn(`[CreditEngine] Failed to release stale reservation ${r.id}:`, e.message);
    }
  }
  return { reconciledReservations: count };
}
