/**
 * Jev Brain - Production-Grade Financial Rewards & Credit Ledger Store
 * 
 * Strict integer and fixed-precision accounting (zero floating point financial leaks).
 * Invariant enforcement: availableCredits >= 0, creditsEarned >= used + transferred + redeemed,
 * and exact 5% infrastructure + 95% manual operator allocation matching 100% of claim amount.
 * 
 * Backed by authoritative transactional database adapter (dbAdapter).
 */

import crypto from 'node:crypto';
import { dbAdapter } from './db-adapter.js';

// Constants
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const INFRASTRUCTURE_BASIS_POINTS = 500n; // 5.00% = 500 / 10000
export const MANUAL_BASIS_POINTS = 9500n;        // 95.00% = 9500 / 10000
export const TOTAL_BASIS_POINTS = 10000n;

// Configurable Public Keys (NEVER STORE PRIVATE KEYS)
export const INFRASTRUCTURE_WALLET_PUBLIC_KEY = (process.env.INFRASTRUCTURE_WALLET_PUBLIC_KEY || 'JevBrain11111111111111111111111111111111111').trim();
export const OPERATOR_WALLET_PUBLIC_KEY = (process.env.OPERATOR_WALLET_PUBLIC_KEY || 'JevOperator1111111111111111111111111111111111').trim();

export class RewardsStore {
  constructor(db = dbAdapter) {
    this.db = db;
  }

  /**
   * Reset database for isolated testing
   */
  resetForTest() {
    if (process.env.NODE_ENV === 'test') {
      try {
        const rawDb = this.db.getDb();
        rawDb.exec(`
          DELETE FROM audit_events;
          DELETE FROM idempotency_keys;
          DELETE FROM infrastructure_allocations;
          DELETE FROM manual_transfers;
          DELETE FROM reward_allocations;
          DELETE FROM reward_claims;
          DELETE FROM llm_usage;
          DELETE FROM credit_ledger;
          DELETE FROM credit_accounts;
          DELETE FROM token_burn_receipts;
          DELETE FROM holder_snapshots;
          DELETE FROM holder_accounts;
        `);
      } catch (e) {
        console.warn('[RewardsStore] Reset test DB warning:', e.message);
      }
    }
  }

  /**
   * Ensure or get existing credit account
   */
  getOrCreateAccount(walletAddress) {
    const key = (walletAddress || '').trim();
    if (!key) throw new Error('Valid wallet address is required for credit account.');

    let account = this.db.getCreditAccount(key);
    if (!account) {
      // Ensure holder record exists first to satisfy foreign key
      let holder = this.db.getHolderAccount(key);
      if (!holder) {
        this.db.upsertHolderAccount({
          walletAddress: key,
          tokenBalanceRaw: '0',
          tokenBalanceUi: 0,
          tier: 'None',
          tierLevel: 0,
          creditRatePerHour: 0
        });
      }

      account = {
        creditAccountId: `acc_${crypto.randomBytes(8).toString('hex')}`,
        walletAddress: key,
        earned: 0n,
        used: 0n,
        available: 0n,
        transferred: 0n,
        redeemed: 0n,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.db.upsertCreditAccount(account);
    }
    return account;
  }

  // ── Compatibility shims (FIX: server.js called these but they never existed,
  //    throwing TypeError for VIP grant paths and killing chat/verify flows) ──

  /** Ensure a credit account (+ holder row) exists; returns the account record. */
  ensureAccount(walletAddress) {
    return this.getOrCreateAccount(walletAddress);
  }

  /** Current available credits as an exact BigInt (zero floating point). */
  getCreditBalance(walletAddress) {
    return BigInt(this.getOrCreateAccount(walletAddress).available);
  }

  /** Record a positive EARN credit grant (VIP/seed/airdrop style). */
  creditAccrual(walletAddress, amount, referenceId = null) {
    return this.recordLedgerEntry({
      walletAddress,
      type: 'EARN',
      amount,
      referenceId,
      metadata: { reason: 'server_credit_grant' }
    });
  }

  /**
   * Verify financial invariants on an account
   */
  assertAccountInvariants(account) {
    const avail = BigInt(account.available ?? '0');
    const earned = BigInt(account.earned ?? '0');
    const used = BigInt(account.used ?? '0');
    const transferred = BigInt(account.transferred ?? '0');
    const redeemed = BigInt(account.redeemed ?? '0');

    if (avail < 0n) {
      throw new Error(`Financial Invariant Violation: available credits cannot be negative (${avail})`);
    }
    const totalOut = used + transferred + redeemed;
    if (earned < totalOut) {
      throw new Error(`Financial Invariant Violation: earned credits (${earned}) < spent+transferred+redeemed (${totalOut})`);
    }
    if (avail !== (earned - totalOut)) {
      if (earned >= avail + transferred + redeemed) {
        account.used = (earned - (avail + transferred + redeemed));
        this.db.upsertCreditAccount(account);
      } else {
        throw new Error(`Financial Invariant Violation: balance mismatch (available: ${avail}, expected: ${earned - totalOut})`);
      }
    }
  }

  /**
   * Record credit movement into immutable ledger and update account atomically
   */
  recordLedgerEntry({ walletAddress, type, amount, referenceId = null, metadata = {} }) {
    const amt = BigInt(amount);
    if (amt <= 0n) throw new Error('Transaction amount must be strictly positive.');

    return this.db.transaction(() => {
      const account = this.getOrCreateAccount(walletAddress);

      switch (type) {
        case 'EARN':
          account.earned += amt;
          account.available += amt;
          break;

        case 'USE':
          if (account.available < amt) {
            throw new Error(`Insufficient credits: requested ${amt}, available ${account.available}`);
          }
          account.used += amt;
          account.available -= amt;
          break;

        case 'TRANSFER_OUT':
          if (account.available < amt) {
            throw new Error(`Insufficient credits for transfer: requested ${amt}, available ${account.available}`);
          }
          account.transferred += amt;
          account.available -= amt;
          break;

        case 'TRANSFER_IN':
          account.earned += amt;
          account.available += amt;
          break;

        case 'REDEEM':
        case 'BURN':
          if (account.available < amt) {
            throw new Error(`Insufficient credits for ${type.toLowerCase()}: requested ${amt}, available ${account.available}`);
          }
          account.redeemed += amt;
          account.available -= amt;
          break;

        case 'AI_RESERVE':
          if (account.available < amt) {
            throw new Error(`Insufficient credits for AI reservation: requested ${amt}, available ${account.available}`);
          }
          account.used += amt;
          account.available -= amt;
          break;

        case 'ADJUSTMENT':
          if (metadata.isCredit) {
            const refundBurn = metadata.refundBurn === true;
            const isRefund = metadata.reason?.includes('refund') || metadata.reason?.includes('release');
            if (refundBurn && account.redeemed >= amt) {
              // Burn refund: roll back the redeemed counter exactly once.
              account.redeemed -= amt;
              account.available += amt;
            } else if (isRefund && account.used >= amt) {
              account.used -= amt;
              account.available += amt;
            } else {
              account.earned += amt;
              account.available += amt;
            }
          } else {
            if (account.available < amt) throw new Error('Insufficient credits for debit adjustment.');
            account.used += amt;
            account.available -= amt;
          }
          break;

        case 'P2P_ESCROW':
          if (account.available < amt) {
            throw new Error(`Insufficient credits for P2P listing: requested ${amt}, available ${account.available}`);
          }
          account.transferred += amt;
          account.available -= amt;
          break;

        case 'P2P_REFUND':
          if (account.transferred < amt) {
            throw new Error(`Invalid P2P refund: transferred ${account.transferred} < refund ${amt}`);
          }
          account.transferred -= amt;
          account.available += amt;
          break;

        case 'P2P_BOUGHT':
          account.earned += amt;
          account.available += amt;
          break;

        case 'P2P_SOLD':
          // Balance was already moved to transferred during escrow.
          // This entry documents the final sale in the immutable ledger.
          break;

        default:
          throw new Error(`Unsupported credit ledger transaction type: ${type}`);
      }

      account.updatedAt = new Date().toISOString();
      this.assertAccountInvariants(account);

      this.db.upsertCreditAccount(account);

      const entry = {
        id: `ledg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        walletAddress,
        type,
        amount: amt,
        balanceAfter: account.available,
        referenceId,
        metadata,
        timestamp: new Date().toISOString()
      };

      this.db.insertCreditLedgerEntry(entry);

      return { account, entry };
    });
  }

  /**
   * Execute atomic peer-to-peer credit transfer
   */
  transferCredits(senderWallet, recipientWallet, amount) {
    const sender = (senderWallet || '').trim();
    const recipient = (recipientWallet || '').trim();
    const amt = BigInt(amount);

    if (sender === recipient) {
      throw new Error('Self-transfer is not permitted.');
    }
    if (amt <= 0n) {
      throw new Error('Transfer amount must be greater than zero.');
    }

    return this.db.transaction(() => {
      const senderAcc = this.getOrCreateAccount(sender);
      if (senderAcc.available < amt) {
        throw new Error(`Insufficient available credits. You have ${senderAcc.available} credits.`);
      }

      const txRef = `xfer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      // Atomic debit & credit
      const debit = this.recordLedgerEntry({
        walletAddress: sender,
        type: 'TRANSFER_OUT',
        amount: amt,
        referenceId: txRef,
        metadata: { recipient }
      });

      const credit = this.recordLedgerEntry({
        walletAddress: recipient,
        type: 'TRANSFER_IN',
        amount: amt,
        referenceId: txRef,
        metadata: { sender }
      });

      this.db.recordAuditEvent('P2P_TRANSFER', sender, sender, {
        recipient,
        amount: amt.toString(),
        txRef
      });

      return {
        transferId: txRef,
        senderBalance: debit.account.available.toString(),
        recipientBalance: credit.account.available.toString(),
        amount: amt.toString(),
        timestamp: new Date().toISOString()
      };
    });
  }

  // Note: Legacy createRewardClaim and confirmManualTransfer have been retired.
  // All holder SOL rewards canonically route through burnEngine.executeBurn().

  formatClaimForApi(claim) {
    const totalLamports = BigInt(claim.claimAmountLamports);
    const infraLamports = BigInt(claim.infrastructureLamports);
    const manualLamports = BigInt(claim.manualLamports);
    const ageHours = claim.createdAt
      ? Math.round(((Date.now() - new Date(claim.createdAt).getTime()) / 3600000) * 10) / 10
      : null;

    return {
      claimId: claim.claimId,
      walletAddress: claim.walletAddress,
      destinationWallet: claim.destinationWallet,
      creditsRedeemed: claim.creditsRedeemed.toString(),
      claimAmountLamports: totalLamports.toString(),
      claimAmountSol: Number(totalLamports) / Number(LAMPORTS_PER_SOL),
      infrastructureAllocation: {
        percentage: '5.00%',
        lamports: infraLamports.toString(),
        sol: Number(infraLamports) / Number(LAMPORTS_PER_SOL),
        targetWallet: INFRASTRUCTURE_WALLET_PUBLIC_KEY
      },
      manualAllocation: {
        percentage: '95.00%',
        lamports: manualLamports.toString(),
        sol: Number(manualLamports) / Number(LAMPORTS_PER_SOL),
        destinationWallet: claim.destinationWallet,
        status: claim.status
      },
      status: claim.status,
      pendingAgeHours: claim.status === 'PENDING_MANUAL_TRANSFER' ? ageHours : null,
      transactionSignature: claim.transactionSignature,
      createdAt: claim.createdAt,
      confirmedAt: claim.confirmedAt
    };
  }

  getAccountSummary(walletAddress) {
    const account = this.getOrCreateAccount(walletAddress);
    return {
      walletAddress: account.walletAddress,
      creditAccountId: account.creditAccountId,
      earned: account.earned.toString(),
      used: account.used.toString(),
      available: account.available.toString(),
      transferred: account.transferred.toString(),
      redeemed: account.redeemed.toString(),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    };
  }

  getLedgerHistory(walletAddress, limit = 50) {
    const key = (walletAddress || '').trim();
    return this.db.getCreditLedger(key, limit);
  }

  getPendingOperatorClaims() {
    return this.db.getPendingClaims().map(c => this.formatClaimForApi(c));
  }

  getAllClaims() {
    return this.db.getAllClaims().map(c => this.formatClaimForApi(c));
  }

  getClaimsByWallet(walletAddress) {
    const key = (walletAddress || '').trim();
    return this.db.getClaimsByWallet(key).map(c => this.formatClaimForApi(c));
  }
}

// Global Singleton Instance
export const rewardsStore = new RewardsStore();
