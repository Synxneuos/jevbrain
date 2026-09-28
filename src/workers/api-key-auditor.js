/**
 * Jev Brain - Automated API Key Tier & Anti-Dump Auditor
 * 
 * Periodically audits all issued Jev Brain CLI API keys against live on-chain Solana balances.
 * If a token holder sells or transfers their tokens, their API key is automatically suspended.
 * If they re-acquire tokens, their key is automatically reactivated with their live tier.
 */

import { dbAdapter } from '../core/db-adapter.js';
import { getHolderEligibility, isValidSolanaAddress, WHITELIST_ADMIN_WALLETS } from '../core/holder-eligibility.js';

export class ApiKeyAuditor {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.lastAuditAt = null;
    this.auditCount = 0;
  }

  /**
   * Start the periodic background auditor
   * @param {number} intervalMs - Poll interval in milliseconds (default 60s)
   */
  start(intervalMs = 60 * 1000) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[ApiKeyAuditor] Starting automated API key auditor daemon (every ${intervalMs / 1000}s)...`);

    // Run first audit after a short initial delay
    setTimeout(() => {
      if (this.isRunning) {
        this.runAuditCycle().catch(err => {
          console.error('[ApiKeyAuditor] Cycle error:', err.message);
        });
      }
    }, 5000);

    this.intervalId = setInterval(async () => {
      try {
        await this.runAuditCycle();
      } catch (err) {
        console.error('[ApiKeyAuditor] Background audit failed:', err.message);
      }
    }, intervalMs);

    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop background auditing
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  /**
   * Perform a single audit pass across all active / suspended keys
   */
  async runAuditCycle() {
    const allKeys = dbAdapter.getAllActiveApiKeys();
    if (!allKeys || allKeys.length === 0) return { audited: 0, suspended: 0, reactivated: 0 };

    this.auditCount++;
    this.lastAuditAt = new Date().toISOString();

    // Group keys by wallet address to minimize RPC roundtrips
    const walletKeysMap = new Map();
    for (const key of allKeys) {
      if (!walletKeysMap.has(key.wallet_address)) {
        walletKeysMap.set(key.wallet_address, []);
      }
      walletKeysMap.get(key.wallet_address).push(key);
    }

    let suspendedCount = 0;
    let reactivatedCount = 0;

    for (const [walletAddress, keys] of walletKeysMap.entries()) {
      if (!isValidSolanaAddress(walletAddress)) continue;

      if (WHITELIST_ADMIN_WALLETS.has(walletAddress)) {
        for (const key of keys) {
          if (key.status === 'suspended') {
            dbAdapter.reactivateApiKey(key.key_id, 1000000, 5);
            reactivatedCount++;
          } else {
            dbAdapter.updateApiKeyAuditInfo(key.key_id, {
              status: 'active',
              suspensionReason: null,
              tokensHeld: 1000000,
              tierId: 5
            });
          }
        }
        continue;
      }

      try {
        const eligibility = await getHolderEligibility(walletAddress, { skipCache: true });

        // FIX (false suspension): a transient RPC/verification outage returns
        // eligible:false + error — that is NOT proof the holder sold tokens.
        // Only act on a successful verification result; on error, keep the key's
        // current state untouched so legitimate holders never lose access.
        if (eligibility.error) {
          console.warn(`[ApiKeyAuditor] Skipping wallet ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)} this cycle: on-chain verification unavailable (${eligibility.error}). Key state preserved.`);
          continue;
        }

        const tokensHeld = eligibility.balanceUi || 0;
        const isEligible = eligibility.eligible && tokensHeld >= 1;

        for (const key of keys) {
          if (!isEligible) {
            // User sold or moved their tokens!
            if (key.status === 'active') {
              dbAdapter.suspendApiKey(key.key_id, 'tokens_sold_or_transferred');
              console.warn(`[ApiKeyAuditor] ⚠️ Suspended key ${key.key_id} for wallet ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}: 0 tokens held (sold/transferred).`);
              suspendedCount++;
            }
          } else {
            // User holds valid tokens
            if (key.status === 'suspended' && key.suspension_reason === 'tokens_sold_or_transferred') {
              dbAdapter.reactivateApiKey(key.key_id, tokensHeld, eligibility.tierLevel);
              console.log(`[ApiKeyAuditor] ✔ Reactivated key ${key.key_id} for wallet ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}: ${tokensHeld} tokens (Tier ${eligibility.tierLevel}).`);
              reactivatedCount++;
            } else {
              // Update tier & token metrics
              dbAdapter.updateApiKeyAuditInfo(key.key_id, {
                status: 'active',
                suspensionReason: null,
                tokensHeld,
                tierId: eligibility.tierLevel
              });
            }
          }
        }
      } catch (err) {
        // RPC network lag: do not arbitrarily suspend keys if RPC is temporarily down
        console.warn(`[ApiKeyAuditor] Audit lookup skipped for ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}: ${err.message}`);
      }
    }

    return {
      audited: allKeys.length,
      suspended: suspendedCount,
      reactivated: reactivatedCount
    };
  }

  /**
   * Synchronously audit a single API key immediately (e.g. on incoming request)
   */
  async auditSingleKey(keyRecord) {
    if (!keyRecord || !keyRecord.wallet_address) return null;
    const walletAddress = keyRecord.wallet_address;
    if (!isValidSolanaAddress(walletAddress)) return null;

    try {
      const eligibility = await getHolderEligibility(walletAddress);
      const tokensHeld = eligibility.balanceUi || 0;
      const isEligible = eligibility.eligible && tokensHeld >= 1;

      if (!isEligible) {
        dbAdapter.suspendApiKey(keyRecord.key_id, 'tokens_sold_or_transferred');
        return {
          status: 'suspended',
          tokensHeld: 0,
          tierLevel: 0,
          reason: 'tokens_sold_or_transferred'
        };
      }

      if (keyRecord.status === 'suspended') {
        dbAdapter.reactivateApiKey(keyRecord.key_id, tokensHeld, eligibility.tierLevel);
      } else {
        dbAdapter.updateApiKeyAuditInfo(keyRecord.key_id, {
          status: 'active',
          suspensionReason: null,
          tokensHeld,
          tierId: eligibility.tierLevel
        });
      }

      return {
        status: 'active',
        tokensHeld,
        tierLevel: eligibility.tierLevel,
        tierName: eligibility.tierName || eligibility.tier,
        allowedModels: eligibility.allowedModels || []
      };
    } catch {
      return null;
    }
  }
}

// Global Singleton Instance
export const apiKeyAuditor = new ApiKeyAuditor();
