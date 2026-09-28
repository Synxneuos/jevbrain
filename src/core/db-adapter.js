/**
 * Jev Brain - Authoritative Transactional Database Adapter
 * 
 * Supports:
 * 1. Native transactional SQLite (node:sqlite DatabaseSync) for local daemon, staging, and unit tests.
 * 2. Supabase / PostgreSQL schema compatibility for production.
 * 
 * Guarantees:
 * - ACID transactions with rollback on failure.
 * - Strict per-wallet data isolation.
 * - Exact string/BigInt financial arithmetic (zero precision loss).
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isServerless = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

/**
 * Data directory resolution (financial state lives here — never lose it):
 * 1. DATABASE_PATH env can override the exact DB file directly.
 * 2. JEV_DATA_DIR env explicitly pins the persistent data directory.
 * 3. RAILWAY_VOLUME_MOUNT_PATH (auto-set by Railway when a Volume is attached).
 * 4. Serverless → /tmp (inherently ephemeral; warnings emitted below).
 * 5. Local daemon → ./data next to the repo.
 */
function resolveDataDir() {
  if (process.env.DATABASE_PATH) return path.dirname(process.env.DATABASE_PATH);
  if (process.env.JEV_DATA_DIR) return process.env.JEV_DATA_DIR;
  const railwayVolume = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  if (railwayVolume) return railwayVolume;

  // Auto-detect persistent volume mounted at /data on Linux / Docker / Railway containers
  if (process.platform !== 'win32' && fs.existsSync('/data')) {
    try {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data';
    } catch {}
  }

  if (isServerless) return '/tmp/jev-data';
  return path.join(__dirname, '..', '..', 'data');
}
export const DATA_DIR = resolveDataDir();

// True when the database file lives on explicitly configured/persistent storage
export const PERSISTENT_STORAGE = Boolean(
  process.env.DATABASE_PATH ||
  process.env.JEV_DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (DATA_DIR === '/data' && process.platform !== 'win32' && fs.existsSync('/data'))
);

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const DEFAULT_DB_PATH = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : path.join(DATA_DIR, 'jev-brain.db');

export class DatabaseAdapter {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = process.env.DATABASE_PATH || dbPath;
    this.db = null;
    this.inTransaction = false;
    this.init();
  }

  init() {
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.setupSchema();
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[DBAdapter] Database file: ${this.dbPath}`);
        if (!PERSISTENT_STORAGE && (process.env.RAILWAY || process.env.RENDER || process.env.FLY_APP_NAME || process.env.NODE_ENV === 'production')) {
          console.warn(
            '[DBAdapter] ⚠⚠ WARNING: database is on EPHEMERAL container storage! ' +
            'All holder credits, ledger entries and CLI API keys WILL BE WIPED on every redeploy/restart. ' +
            'Fix: attach a persistent volume (Railway: create a Volume, mount path e.g. /data) — it is auto-detected ' +
            'via RAILWAY_VOLUME_MOUNT_PATH — or set DATABASE_PATH/JEV_DATA_DIR to a mounted path.'
          );
        }
      }
    } catch (err) {
      console.error('[DBAdapter] Init error:', err);
    }
  }

  getDb() {
    if (!this.db) {
      this.init();
    }
    return this.db;
  }

  setupSchema() {
    const db = this.db;
    if (!db) return;

    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      -- 1. HOLDER ACCOUNTS
      CREATE TABLE IF NOT EXISTS holder_accounts (
        wallet_address TEXT PRIMARY KEY,
        token_balance_raw TEXT NOT NULL DEFAULT '0',
        token_balance_ui REAL NOT NULL DEFAULT 0.0,
        tier TEXT NOT NULL DEFAULT 'None',
        tier_level INTEGER NOT NULL DEFAULT 0,
        credit_rate_per_hour INTEGER NOT NULL DEFAULT 0,
        boost_level INTEGER NOT NULL DEFAULT 1,
        boost_multiplier REAL NOT NULL DEFAULT 1.0,
        total_tokens_burned TEXT NOT NULL DEFAULT '0',
        boost_activated_at TEXT DEFAULT NULL,
        last_burn_tx_hash TEXT DEFAULT NULL,
        last_verified_at TEXT NOT NULL,
        last_accrual_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 2. HOLDER SNAPSHOTS
      CREATE TABLE IF NOT EXISTS holder_snapshots (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        balance_raw TEXT NOT NULL,
        balance_ui REAL NOT NULL,
        tier TEXT NOT NULL,
        credit_rate_per_hour INTEGER NOT NULL,
        credits_accrued INTEGER NOT NULL DEFAULT 0,
        snapshot_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES holder_accounts(wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_holder_snapshots_wallet ON holder_snapshots(wallet_address, snapshot_at);

      -- 3. CREDIT ACCOUNTS
      CREATE TABLE IF NOT EXISTS credit_accounts (
        wallet_address TEXT PRIMARY KEY,
        credit_account_id TEXT UNIQUE NOT NULL,
        earned TEXT NOT NULL DEFAULT '0',
        used TEXT NOT NULL DEFAULT '0',
        available TEXT NOT NULL DEFAULT '0',
        transferred TEXT NOT NULL DEFAULT '0',
        redeemed TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES holder_accounts(wallet_address) ON DELETE CASCADE
      );

      -- 4. CREDIT LEDGER
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        type TEXT NOT NULL,
        amount TEXT NOT NULL,
        balance_after TEXT NOT NULL,
        reference_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES credit_accounts(wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_wallet ON credit_ledger(wallet_address, created_at);
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_ref ON credit_ledger(reference_id);

      -- 5. LLM USAGE
      CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        credits_deducted TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES credit_accounts(wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_wallet ON llm_usage(wallet_address, created_at);

      -- 6. REWARD CLAIMS
      CREATE TABLE IF NOT EXISTS reward_claims (
        claim_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        destination_wallet TEXT NOT NULL,
        credits_redeemed TEXT NOT NULL,
        claim_amount_lamports TEXT NOT NULL,
        infrastructure_lamports TEXT NOT NULL,
        manual_lamports TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_MANUAL_TRANSFER',
        idempotency_key TEXT UNIQUE NOT NULL,
        transaction_signature TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES credit_accounts(wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reward_claims_wallet ON reward_claims(wallet_address, created_at);
      CREATE INDEX IF NOT EXISTS idx_reward_claims_sig ON reward_claims(transaction_signature);

      -- 7. REWARD ALLOCATIONS
      CREATE TABLE IF NOT EXISTS reward_allocations (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        type TEXT NOT NULL,
        basis_points INTEGER NOT NULL,
        amount_lamports TEXT NOT NULL,
        target_wallet TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (claim_id) REFERENCES reward_claims(claim_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reward_allocations_claim ON reward_allocations(claim_id);

      -- 8. MANUAL TRANSFERS
      CREATE TABLE IF NOT EXISTS manual_transfers (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        recipient_wallet TEXT NOT NULL,
        amount_lamports TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        operator_wallet TEXT NOT NULL,
        transaction_signature TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (claim_id) REFERENCES reward_claims(claim_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_manual_transfers_claim ON manual_transfers(claim_id);
      CREATE INDEX IF NOT EXISTS idx_manual_transfers_status ON manual_transfers(status);

      -- 9. INFRASTRUCTURE ALLOCATIONS
      CREATE TABLE IF NOT EXISTS infrastructure_allocations (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        infrastructure_wallet TEXT NOT NULL,
        amount_lamports TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (claim_id) REFERENCES reward_claims(claim_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_infra_alloc_claim ON infrastructure_allocations(claim_id);

      -- 10. IDEMPOTENCY KEYS
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      -- 11. AUDIT EVENTS
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        wallet_address TEXT,
        actor_wallet TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_wallet ON audit_events(wallet_address, created_at);

      -- 12. FEE HARVEST HISTORY (15-min Fee Splitter)
      CREATE TABLE IF NOT EXISTS fee_harvest_history (
        id TEXT PRIMARY KEY,
        claimer_wallet TEXT NOT NULL,
        treasury_wallet TEXT NOT NULL,
        total_claimed_lamports TEXT NOT NULL,
        treasury_sent_lamports TEXT NOT NULL,
        pool_retained_lamports TEXT NOT NULL,
        tx_signature TEXT,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fee_harvest_created ON fee_harvest_history(created_at);

      -- 12b. PROCESSED CLAIM SIGNATURES (Strict Claim-First Invariant)
      CREATE TABLE IF NOT EXISTS processed_claim_signatures (
        signature TEXT PRIMARY KEY,
        claimed_lamports TEXT NOT NULL,
        treasury_sent_lamports TEXT NOT NULL,
        sweep_tx_signature TEXT,
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_claims_sig ON processed_claim_signatures(signature);

      -- 13. REWARD POOL STATE (Dynamic 5% Pool Tracker)
      CREATE TABLE IF NOT EXISTS reward_pool_state (
        pool_id TEXT PRIMARY KEY,
        total_harvested_lamports TEXT NOT NULL DEFAULT '0',
        total_treasury_lamports TEXT NOT NULL DEFAULT '0',
        total_pool_lamports TEXT NOT NULL DEFAULT '0',
        available_pool_lamports TEXT NOT NULL DEFAULT '0',
        total_credits_burned TEXT NOT NULL DEFAULT '0',
        current_epoch INTEGER NOT NULL DEFAULT 1,
        epoch_pool_lamports TEXT NOT NULL DEFAULT '0',
        epoch_credits_burned TEXT NOT NULL DEFAULT '0',
        last_harvest_at TEXT,
        updated_at TEXT NOT NULL
      );

      -- 14. CREDIT BURNS (Proportional SOL Reward Claims)
      CREATE TABLE IF NOT EXISTS credit_burns (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        destination_wallet TEXT NOT NULL,
        credits_burned TEXT NOT NULL,
        reward_lamports TEXT NOT NULL,
        reward_sol REAL NOT NULL,
        market_cap_usd REAL NOT NULL,
        tx_signature TEXT,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credit_burns_wallet ON credit_burns(wallet_address, created_at);

      -- 15. FEE HARVEST INTERVALS (Distributed & Process-Level Exactly-Once Lock)
      CREATE TABLE IF NOT EXISTS fee_harvest_intervals (
        interval_id TEXT PRIMARY KEY,
        interval_slot INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
        harvest_id TEXT,
        tx_signature TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harvest_intervals_slot ON fee_harvest_intervals(interval_slot);

      -- 16. CREDIT RESERVATIONS (Two-Phase AI Reservation Protocol)
      CREATE TABLE IF NOT EXISTS credit_reservations (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        estimated_credits TEXT NOT NULL,
        actual_credits TEXT NOT NULL DEFAULT '0',
        model TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'SETTLED', 'RELEASED', 'EXPIRED')),
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_credit_reservations_wallet ON credit_reservations(wallet_address, status);
      CREATE INDEX IF NOT EXISTS idx_credit_reservations_status ON credit_reservations(status, created_at);

      -- 17. API KEYS (Holder-Gated Jev Brain CLI Access)
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id TEXT PRIMARY KEY,
        api_key TEXT UNIQUE NOT NULL,
        wallet_address TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default CLI Key',
        is_revoked INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        suspension_reason TEXT,
        last_verified_tokens REAL DEFAULT 0,
        last_verified_tier INTEGER DEFAULT 0,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_lookup ON api_keys(api_key, is_revoked);
      CREATE INDEX IF NOT EXISTS idx_api_keys_wallet ON api_keys(wallet_address);

      -- 18. TOKEN BURN RECEIPTS (Burn-to-Boost: one-time burn → permanent lifetime multiplier audit trail)
      CREATE TABLE IF NOT EXISTS token_burn_receipts (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        tier_at_burn INTEGER NOT NULL,
        boost_level_unlocked INTEGER NOT NULL,
        multiplier_awarded REAL NOT NULL,
        tokens_burned_raw TEXT NOT NULL,
        tokens_burned_ui REAL NOT NULL,
        tx_signature TEXT UNIQUE NOT NULL,
        block_time INTEGER NOT NULL,
        burn_method TEXT NOT NULL DEFAULT 'token_burn',
        created_at TEXT NOT NULL,
        FOREIGN KEY (wallet_address) REFERENCES holder_accounts(wallet_address) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_burn_receipts_wallet ON token_burn_receipts(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_burn_receipts_sig ON token_burn_receipts(tx_signature);

      -- 19. P2P CREDIT ORDERS (Burning Day Market)
      CREATE TABLE IF NOT EXISTS p2p_credit_orders (
        order_id TEXT PRIMARY KEY,
        seller_wallet TEXT NOT NULL,
        credits_amount INTEGER NOT NULL,
        price_sol REAL NOT NULL,
        price_lamports TEXT NOT NULL,
        tokens_to_burn_raw TEXT NOT NULL,
        tokens_to_burn_ui REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, PURCHASE_PENDING, JEV_BURN_CONFIRMED, SOL_PAYOUT_SUBMITTED, COMPLETED, FILLED, CANCELLED, RECOVERY_REQUIRED
        buyer_wallet TEXT DEFAULT NULL,
        tx_signature TEXT DEFAULT NULL UNIQUE,
        jev_burn_signature TEXT DEFAULT NULL UNIQUE,
        sol_payout_signature TEXT DEFAULT NULL UNIQUE,
        created_at TEXT NOT NULL,
        filled_at TEXT DEFAULT NULL,
        cancelled_at TEXT DEFAULT NULL,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (seller_wallet) REFERENCES holder_accounts(wallet_address)
      );
      CREATE INDEX IF NOT EXISTS idx_p2p_orders_status ON p2p_credit_orders(status);
      CREATE INDEX IF NOT EXISTS idx_p2p_orders_seller ON p2p_credit_orders(seller_wallet);
      CREATE INDEX IF NOT EXISTS idx_p2p_orders_sig ON p2p_credit_orders(tx_signature);

      -- 20. WALLET DOCKETS (Stable public Live Audit numbering: exactly one docket per wallet)
      CREATE TABLE IF NOT EXISTS wallet_dockets (
        docket_number INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // Durable SQLite synchronous setting
    try { db.exec('PRAGMA synchronous = NORMAL;'); } catch {}

    // Migrations for api_keys status, live tier auditing & expiration
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`); } catch {}
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN suspension_reason TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN last_verified_tokens REAL DEFAULT 0;`); } catch {}
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN last_verified_tier INTEGER DEFAULT 0;`); } catch {}
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN last_verified_at TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT DEFAULT NULL;`); } catch {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);`); } catch {}

    // Migration: add idempotency_key and payment state machine columns to credit_burns
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN idempotency_key TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN signed_tx_raw TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN last_valid_block_height INTEGER;`); } catch {}
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN blockhash TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN state_history TEXT;`); } catch {}
    try { db.exec(`ALTER TABLE credit_burns ADD COLUMN updated_at TEXT;`); } catch {}

    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_burns_idemp ON credit_burns(idempotency_key, wallet_address);`);
    } catch (e) {
      console.warn('[DBAdapter] idempotency index warning:', e.message);
    }

    // Migration: Burn-to-Boost lifetime multiplier state on holder_accounts (auto-upgrade existing DBs)
    try { db.exec(`ALTER TABLE holder_accounts ADD COLUMN boost_level INTEGER NOT NULL DEFAULT 1;`); } catch {}
    try { db.exec(`ALTER TABLE holder_accounts ADD COLUMN boost_multiplier REAL NOT NULL DEFAULT 1.0;`); } catch {}
    try { db.exec(`ALTER TABLE holder_accounts ADD COLUMN total_tokens_burned TEXT NOT NULL DEFAULT '0';`); } catch {}
    try { db.exec(`ALTER TABLE holder_accounts ADD COLUMN boost_activated_at TEXT DEFAULT NULL;`); } catch {}
    try { db.exec(`ALTER TABLE holder_accounts ADD COLUMN last_burn_tx_hash TEXT DEFAULT NULL;`); } catch {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_holder_accounts_boost ON holder_accounts(boost_level);`); } catch {}

    // Migration: P2P credit orders dual-signature columns and indexes
    try { db.exec(`ALTER TABLE p2p_credit_orders ADD COLUMN jev_burn_signature TEXT DEFAULT NULL;`); } catch {}
    try { db.exec(`ALTER TABLE p2p_credit_orders ADD COLUMN sol_payout_signature TEXT DEFAULT NULL;`); } catch {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_p2p_orders_jev_sig ON p2p_credit_orders(jev_burn_signature);`); } catch {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_p2p_orders_sol_sig ON p2p_credit_orders(sol_payout_signature);`); } catch {}

    // Auto-seed VIP Operator accounts, credit balances, and API keys for whitelisted operator wallets
    try {
      const vipWallets = [
        { wallet: 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn', key: 'jev_live_vip_HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn', id: 'key_operator_vip_HqHQ' }
      ];
      const now = new Date().toISOString();
      for (const item of vipWallets) {
        // 1. Ensure holder account exists
        const existingHolder = db.prepare('SELECT wallet_address FROM holder_accounts WHERE wallet_address = ?').get(item.wallet);
        if (!existingHolder) {
          db.prepare(`
            INSERT INTO holder_accounts (
              wallet_address, token_balance_raw, token_balance_ui, tier,
              tier_level, credit_rate_per_hour, boost_level, boost_multiplier,
              last_verified_at, last_accrual_at, created_at, updated_at
            ) VALUES (?, '1000000000000', 1000000.0, 'Dynasty Magnate (VIP Whitelist)', 5, 20000, 1, 1.0, ?, ?, ?, ?)
          `).run(item.wallet, now, now, now, now);
        }

        // 2. Ensure credit account has at least 100,000 credits
        const existingCredit = db.prepare('SELECT wallet_address, available FROM credit_accounts WHERE wallet_address = ?').get(item.wallet);
        if (!existingCredit) {
          db.prepare(`
            INSERT INTO credit_accounts (
              wallet_address, credit_account_id, earned, used, available, transferred, redeemed, created_at, updated_at
            ) VALUES (?, ?, '100000', '0', '100000', '0', '0', ?, ?)
          `).run(item.wallet, 'acc_vip_' + item.wallet.slice(0, 4), now, now);
        } else if (BigInt(existingCredit.available || '0') < 10000n) {
          db.prepare(`
            UPDATE credit_accounts
            SET available = '100000', earned = '100000', updated_at = ?
            WHERE wallet_address = ?
          `).run(now, item.wallet);
        }

        // 3. Ensure API Key exists
        const existing = db.prepare('SELECT key_id FROM api_keys WHERE api_key = ?').get(item.key);
        if (!existing) {
          db.prepare(`
            INSERT INTO api_keys (
              key_id, api_key, wallet_address, name, is_revoked, status,
              last_verified_tokens, last_verified_tier, last_verified_at, created_at, expires_at
            ) VALUES (?, ?, ?, ?, 0, 'active', 1000000, 5, ?, ?, NULL)
          `).run(item.id, item.key, item.wallet, 'VIP Operator Master Key', now, now);
        }
      }

      // One-time restitution migration for wallets whose credits were reset during container transitions
      const historicalRestores = [
        // VIP Operator Authority
        { wallet: 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn', earned: '105000', available: '104837', tier: 'Dynasty Magnate (VIP Whitelist)', tierLevel: 5, rate: 20000, tokens: 1000000, boostLevel: 2, boostMultiplier: 2.0 },
        
        // Tier 5 Dynasty Magnates
        { wallet: 'GX3We1me16U7snFAqe76MzsWB7HEbWd1TDvU7eFYg2Tp', earned: '65000', available: '60000', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 2347995 },
        { wallet: '4Cvc576jwTPK9woCqd9ftXmqbgcrcTxQ5oFLaowQsunh', earned: '20000', available: '15000', tier: 'Dynasty Magnate', tierLevel: 5, rate: 5000, tokens: 1000000 },
        { wallet: '4kvs7cudiFUnVejw1NpdkjbrP4VwrZyZJLeRgUukiZ1z', earned: '20000', available: '15000', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: '3dzrdCWcGfZqKMb81MU8AquEFAt6A19LT3cKqML4GJA5', earned: '5000', available: '4998', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: 'DHftECifqwfUV2dZxwTfTuUk5bN3XqYr6g5vubJMLM5o', earned: '5000', available: '4999', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: 'Fui9eus9GYiDjW1JnyoVChqbJqbuxopaXWLYA7uRMSfC', earned: '5000', available: '4999', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: 'CmZdzesZ5hXkh1smgGHoY82PJaueiENAqAjrkSG4F6qK', earned: '5000', available: '4999', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: 't3YnwgATHoj5PwBdtcQV3voHSH8YaJmKW6hNawkeXeb', earned: '5000', available: '4999', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: '9oV2QVtvJUsi9oJbv3jUFyFTfECjxDuzQLJFp3Z9ZxdN', earned: '5000', available: '5000', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: '7rTUfy6UA1aEY8BQqjap3zusfJgCpi6MMGVLXr25iDnd', earned: '5000', available: '5000', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: '4fzUKK7YAitPfmh4SEfskjJA9U8TTQVEjD18o9QpFpxc', earned: '2500', available: '2500', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },
        { wallet: 'FWLXDCVxSeq7Eii7ZeEKtFS5MvxDcPR6rUacBYTBvKXL', earned: '2500', available: '2500', tier: 'Dynasty Magnate', tierLevel: 5, rate: 2500, tokens: 1000000 },

        // Tier 4 / Tier 3 Partners
        { wallet: '9siTM4oZLisiKjPzQoew2ueh7r645qE4HCS5GphyyNB3', earned: '10000', available: '10000', tier: 'Principal Partner', tierLevel: 3, rate: 400, tokens: 50000 },
        { wallet: '8N9ipGELjrmcdfbKaSHDfT5KKuj2MiSe9grwnEqpKDUH', earned: '10000', available: '10000', tier: 'Principal Partner', tierLevel: 3, rate: 400, tokens: 50000 },
        { wallet: 'CGvSD1FQsGvhPzje9JFrJGUVqYvwm87NAArqkrLcPR25', earned: '10000', available: '9000', tier: 'Principal Partner', tierLevel: 3, rate: 400, tokens: 50000 },
        { wallet: 'AAjR76KK2Q3FD4PWbmbty7Dvaz7p8tMqDJZDDSDAfS3v', earned: '10000', available: '9000', tier: 'Principal Partner', tierLevel: 3, rate: 400, tokens: 50000 },
        { wallet: 'EcshaLzyX4aVz2LFd2wjjLyU4nDbc53qZeVabcBkTegi', earned: '10000', available: '9000', tier: 'Principal Partner', tierLevel: 3, rate: 400, tokens: 50000 },
        { wallet: '5MGTP4Ax1P2vqFstoGHSuYT5EE7RTakRioS2biyw6iSR', earned: '2500', available: '2500', tier: 'Principal Partner', tierLevel: 3, rate: 200, tokens: 10000 },

        // Tier 2 Associates & Boosters
        { wallet: '4WAi1p5b1XSm5Cm8kEmyfVCkydPzFQ3yDEYX3KxPzx9n', earned: '5000', available: '5000', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 51514 },
        { wallet: 'Bb48nYbh9kfzG5nvAqidUxipWPTcz2iPkUZCEmZguZNc', earned: '5000', available: '4998', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 5000 },
        { wallet: 'HivzpgbR7x4S4TUfgyef4GezdE1wwNxAUHhkhUCJJAXy', earned: '2000', available: '1500', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000 },
        { wallet: 'DvBP4xHR3DBsyGoMcRjFmk8BgU9DTK6VHXFe5LH5Rf1B', earned: '2000', available: '1500', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000 },
        { wallet: '9PU4hoAZbhoof7tbPfJ272N2UCQsa818CGcMErajdJ2W', earned: '2000', available: '1500', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000 },
        { wallet: 'HdKtZ3fmrhcJjiP9CGpfnFcQkrPTVmkhU1LnLfEdMNwC', earned: '1000', available: '1000', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000, boostLevel: 2, boostMultiplier: 2.0 },
        { wallet: 'GC2XvZc7yECEwraCdqMCFVoJgsVBk5waGLbLKRiydVho', earned: '1000', available: '1000', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000, boostLevel: 2, boostMultiplier: 2.0 },
        { wallet: 'JUVRz4ZhqAp6qV5KZfsPNwEo7mmiXyjgm4azksBPGDv', earned: '500', available: '500', tier: 'Charter Associate', tierLevel: 2, rate: 100, tokens: 5000 },
        { wallet: 'SN6MmYai4GDkVYszcFEnMtY52pWYBhsoj4oafadFBhu', earned: '500', available: '500', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 2500 },
        { wallet: 'E3rNCCQjHKSZtUGxupFY7vDtKXBeA7Va9XTWkxykMTpK', earned: '500', available: '500', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 2500 },
        { wallet: '2yTMCSKa5obXfagEwqM69DXSfmBoX2WLViAqyPx9vRd3', earned: '500', available: '500', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 2500 },

        // Tier 1 Early Supporters
        { wallet: 'ET2Dpvq4tARcfRYmukgRYZFTdrkCueA6KWaBw1MLGev5', earned: '200', available: '200', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000 },
        { wallet: 'EaPx5yS3BiyzqUWXtPPbXZ9LhaQm2Bx9GdAYLENMZR5w', earned: '200', available: '200', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000, boostLevel: 2, boostMultiplier: 2.0 },
        { wallet: '8DjMbATWfdDXxvUohQq4tJcS19qwkR2opZPo8A5MW3Jr', earned: '200', available: '200', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000, boostLevel: 2, boostMultiplier: 2.0 },
        { wallet: '7QutNzMeDhgWfE6QELfgsTg3AyUgBUiBuBPvHa9xgzP1', earned: '100', available: '100', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000 },
        { wallet: '65vY8cmEmrriDPxMwW3X6cPw2aHUD7iXSBQe6LAqhMLH', earned: '100', available: '100', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000 },
        { wallet: 'D9Dsp1wP7M1RPAGMwiwZjZss9vxsr6WnPSZqsJtUTmRZ', earned: '100', available: '100', tier: 'Charter Associate', tierLevel: 2, rate: 50, tokens: 1000 }
      ];

      for (const rec of historicalRestores) {
        const existingHolder = db.prepare('SELECT wallet_address, token_balance_ui FROM holder_accounts WHERE wallet_address = ?').get(rec.wallet);
        if (!existingHolder) {
          db.prepare(`
            INSERT INTO holder_accounts (
              wallet_address, token_balance_raw, token_balance_ui, tier,
              tier_level, credit_rate_per_hour, boost_level, boost_multiplier,
              last_verified_at, last_accrual_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            rec.wallet,
            (BigInt(rec.tokens) * 1000000n).toString(),
            rec.tokens,
            rec.tier,
            rec.tierLevel,
            rec.rate,
            rec.boostLevel || 1,
            rec.boostMultiplier || 1.0,
            now,
            now,
            now,
            now
          );
        } else {
          db.prepare(`
            UPDATE holder_accounts
            SET token_balance_ui = CASE WHEN token_balance_ui < ? THEN ? ELSE token_balance_ui END,
                tier = CASE WHEN token_balance_ui < ? THEN ? ELSE tier END,
                tier_level = CASE WHEN token_balance_ui < ? THEN ? ELSE tier_level END,
                credit_rate_per_hour = CASE WHEN credit_rate_per_hour < ? THEN ? ELSE credit_rate_per_hour END,
                boost_level = CASE WHEN ? > boost_level THEN ? ELSE boost_level END,
                boost_multiplier = CASE WHEN ? > boost_multiplier THEN ? ELSE boost_multiplier END,
                updated_at = ?
            WHERE wallet_address = ?
          `).run(
            rec.tokens, rec.tokens,
            rec.tokens, rec.tier,
            rec.tokens, rec.tierLevel,
            rec.rate, rec.rate,
            rec.boostLevel || 1, rec.boostLevel || 1,
            rec.boostMultiplier || 1.0, rec.boostMultiplier || 1.0,
            now, rec.wallet
          );
        }

        const usedAmt = BigInt(rec.earned) >= BigInt(rec.available)
          ? (BigInt(rec.earned) - BigInt(rec.available)).toString()
          : '0';

        const existingCredit = db.prepare('SELECT wallet_address, available FROM credit_accounts WHERE wallet_address = ?').get(rec.wallet);
        if (!existingCredit) {
          db.prepare(`
            INSERT INTO credit_accounts (
              wallet_address, credit_account_id, earned, used, available, transferred, redeemed, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, '0', '0', ?, ?)
          `).run(rec.wallet, 'acc_restored_' + rec.wallet.slice(0, 6), rec.earned, usedAmt, rec.available, now, now);
        } else if (BigInt(existingCredit.available || '0') < BigInt(rec.available)) {
          db.prepare(`
            UPDATE credit_accounts
            SET available = ?, used = ?, earned = CASE WHEN CAST(earned AS INTEGER) < CAST(? AS INTEGER) THEN ? ELSE earned END, updated_at = ?
            WHERE wallet_address = ?
          `).run(rec.available, usedAmt, rec.earned, rec.earned, now, rec.wallet);
        }
      }

      // Ensure ZERO mock or synthetic seed orders exist in SQLite for Burning Day P2P Market
      try {
        db.prepare("DELETE FROM p2p_credit_orders WHERE order_id LIKE 'p2p_ord_seed_%'").run();
      } catch {}

      // Security Revocation: Purge all VIP privileges, API keys, and free credits for compromised wallet 2yHe...
      try {
        db.exec(`
          DELETE FROM api_keys WHERE wallet_address = '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx' OR key_id = 'key_operator_vip_2yHe';
          UPDATE holder_accounts SET tier = 'Revoked (Compromised Key)', tier_level = 0, credit_rate_per_hour = 0, boost_level = 1, boost_multiplier = 1.0 WHERE wallet_address = '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx';
          UPDATE credit_accounts SET available = '0', earned = CAST(used AS INTEGER) + CAST(transferred AS INTEGER) + CAST(redeemed AS INTEGER) WHERE wallet_address = '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx';
        `);
      } catch {}

      // 4x Credit Emission Supercharge Migration (1-hr yield now generated every 15 minutes):
      // Automatically upgrade all existing holder_accounts to the 4x credit_rate_per_hour
      try {
        db.exec(`
          UPDATE holder_accounts SET credit_rate_per_hour = 40 WHERE tier_level = 1 AND credit_rate_per_hour < 40;
          UPDATE holder_accounts SET credit_rate_per_hour = 200 WHERE tier_level = 2 AND credit_rate_per_hour < 200;
          UPDATE holder_accounts SET credit_rate_per_hour = 800 WHERE tier_level = 3 AND credit_rate_per_hour < 800;
          UPDATE holder_accounts SET credit_rate_per_hour = 3000 WHERE tier_level = 4 AND credit_rate_per_hour < 3000;
          UPDATE holder_accounts SET credit_rate_per_hour = 10000 WHERE tier_level = 5 AND credit_rate_per_hour < 10000;
          UPDATE holder_accounts SET credit_rate_per_hour = 20000 WHERE tier LIKE '%VIP Whitelist%' AND credit_rate_per_hour < 20000;
        `);
      } catch {}

      // Auto-reconcile any accounts with invariant discrepancies from past manual seeding
      db.prepare(`
        UPDATE credit_accounts
        SET used = (CAST(earned AS INTEGER) - (CAST(available AS INTEGER) + CAST(transferred AS INTEGER) + CAST(redeemed AS INTEGER)))
        WHERE CAST(earned AS INTEGER) >= (CAST(available AS INTEGER) + CAST(transferred AS INTEGER) + CAST(redeemed AS INTEGER))
          AND CAST(available AS INTEGER) != (CAST(earned AS INTEGER) - (CAST(used AS INTEGER) + CAST(transferred AS INTEGER) + CAST(redeemed AS INTEGER)))
      `).run();
    } catch {}
  }

  /**
   * Execute callback within an ACID database transaction
   */
  transaction(fn) {
    const db = this.getDb();
    if (this.inTransaction) {
      // Nested transaction: execute within current transaction
      return fn(this);
    }
    this.inTransaction = true;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(this);
      db.exec('COMMIT');
      this.inTransaction = false;
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      this.inTransaction = false;
      throw err;
    }
  }

  // ── HOLDER ACCOUNTS ────────────────────────────────────────────────────────

  getHolderAccount(walletAddress) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM holder_accounts WHERE wallet_address = ?').get(walletAddress);
    if (!row) return null;
    return {
      walletAddress: row.wallet_address,
      tokenBalanceRaw: row.token_balance_raw,
      tokenBalanceUi: Number(row.token_balance_ui),
      tier: row.tier,
      tierLevel: Number(row.tier_level),
      creditRatePerHour: Number(row.credit_rate_per_hour),
      lastVerifiedAt: row.last_verified_at,
      lastAccrualAt: row.last_accrual_at,
      boostLevel: Number(row.boost_level ?? 1),
      boostMultiplier: Number(row.boost_multiplier ?? 1.0),
      totalTokensBurned: String(row.total_tokens_burned ?? '0'),
      boostActivatedAt: row.boost_activated_at ?? null,
      lastBurnTxHash: row.last_burn_tx_hash ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  getAllHolderAccounts() {
    const db = this.getDb();
    const rows = db.prepare('SELECT * FROM holder_accounts').all();
    return rows.map(row => ({
      walletAddress: row.wallet_address,
      tokenBalanceRaw: row.token_balance_raw,
      tokenBalanceUi: Number(row.token_balance_ui),
      tier: row.tier,
      tierLevel: Number(row.tier_level),
      creditRatePerHour: Number(row.credit_rate_per_hour),
      lastVerifiedAt: row.last_verified_at,
      lastAccrualAt: row.last_accrual_at,
      boostLevel: Number(row.boost_level ?? 1),
      boostMultiplier: Number(row.boost_multiplier ?? 1.0),
      totalTokensBurned: String(row.total_tokens_burned ?? '0'),
      boostActivatedAt: row.boost_activated_at ?? null,
      lastBurnTxHash: row.last_burn_tx_hash ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  upsertHolderAccount(account) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const existing = this.getHolderAccount(account.walletAddress);

    // CRITICAL: Preserve existing last_accrual_at unless explicitly specified.
    // Overwriting with 'now' would wipe out unearned elapsed hours!
    const lastAccrual = account.lastAccrualAt || existing?.lastAccrualAt || now;
    const createdAt = account.createdAt || existing?.createdAt || now;

    db.prepare(`
      INSERT INTO holder_accounts (
        wallet_address, token_balance_raw, token_balance_ui, tier,
        tier_level, credit_rate_per_hour, last_verified_at, last_accrual_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        token_balance_raw = excluded.token_balance_raw,
        token_balance_ui = excluded.token_balance_ui,
        tier = excluded.tier,
        tier_level = excluded.tier_level,
        credit_rate_per_hour = excluded.credit_rate_per_hour,
        last_verified_at = excluded.last_verified_at,
        last_accrual_at = excluded.last_accrual_at,
        updated_at = excluded.updated_at
    `).run(
      account.walletAddress,
      (account.tokenBalanceRaw || '0').toString(),
      Number(account.tokenBalanceUi || 0),
      account.tier || 'None',
      Number(account.tierLevel || 0),
      Number(account.creditRatePerHour || 0),
      account.lastVerifiedAt || now,
      lastAccrual,
      createdAt,
      now
    );
  }

  updateLastAccrualTime(walletAddress, timestampIso) {
    const db = this.getDb();
    db.prepare(`
      UPDATE holder_accounts
      SET last_accrual_at = ?, updated_at = ?
      WHERE wallet_address = ?
    `).run(timestampIso, new Date().toISOString(), walletAddress);
  }

  /**
   * B-4 FIX: Atomic conditional accrual update.
   * Only updates last_accrual_at if it still equals the expectedTimestamp.
   * Returns true if the update was applied, false if another process already advanced it.
   */
  conditionalUpdateAccrualTime(walletAddress, expectedTimestamp, newTimestamp) {
    const db = this.getDb();
    const result = db.prepare(`
      UPDATE holder_accounts
      SET last_accrual_at = ?, updated_at = ?
      WHERE wallet_address = ? AND last_accrual_at = ?
    `).run(newTimestamp, new Date().toISOString(), walletAddress, expectedTimestamp);
    return result.changes > 0;
  }

  insertHolderSnapshot(snapshot) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO holder_snapshots (
        id, wallet_address, balance_raw, balance_ui, tier,
        credit_rate_per_hour, credits_accrued, snapshot_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.walletAddress,
      snapshot.balanceRaw.toString(),
      Number(snapshot.balanceUi || 0),
      snapshot.tier,
      Number(snapshot.creditRatePerHour || 0),
      Number(snapshot.creditsAccrued || 0),
      snapshot.snapshotAt || now,
      now
    );
  }

  // ── BURN-TO-BOOST (token_burn_receipts + permanent holder boost state) ─────

  insertBurnReceipt(receipt) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_burn_receipts (
        id, wallet_address, tier_at_burn, boost_level_unlocked, multiplier_awarded,
        tokens_burned_raw, tokens_burned_ui, tx_signature, block_time, burn_method, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.walletAddress,
      Number(receipt.tierAtBurn || 0),
      Number(receipt.boostLevelUnlocked || 1),
      Number(receipt.multiplierAwarded || 1.0),
      String(receipt.tokensBurnedRaw || '0'),
      Number(receipt.tokensBurnedUi || 0),
      String(receipt.txSignature),
      Number(receipt.blockTime || 0),
      receipt.burnMethod || 'token_burn',
      receipt.createdAt || now
    );
    return this.getBurnReceipt(receipt.id);
  }

  getBurnReceipt(id) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM token_burn_receipts WHERE id = ?').get(id);
    return row ? this.mapBurnReceiptRow(row) : null;
  }

  getBurnReceiptBySignature(signature) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM token_burn_receipts WHERE tx_signature = ?').get(String(signature || '').trim());
    return row ? this.mapBurnReceiptRow(row) : null;
  }

  getBurnReceiptsByWallet(walletAddress, limit = 10) {
    const db = this.getDb();
    const rows = db.prepare(
      'SELECT * FROM token_burn_receipts WHERE wallet_address = ? ORDER BY created_at DESC LIMIT ?'
    ).all(walletAddress, Number(limit) || 10);
    return rows.map(r => this.mapBurnReceiptRow(r));
  }

  mapBurnReceiptRow(row) {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      tierAtBurn: Number(row.tier_at_burn),
      boostLevelUnlocked: Number(row.boost_level_unlocked),
      multiplierAwarded: Number(row.multiplier_awarded),
      tokensBurnedRaw: String(row.tokens_burned_raw),
      tokensBurnedUi: Number(row.tokens_burned_ui),
      txSignature: row.tx_signature,
      blockTime: Number(row.block_time),
      burnMethod: row.burn_method || 'token_burn',
      createdAt: row.created_at
    };
  }

  /**
   * Permanently upgrade a holder's lifetime boost state (Burn-to-Boost).
   * Accumulates total_tokens_burned with exact BigInt-safe arithmetic and stamps
   * the activation timestamp + originating burn transaction signature.
   */
  applyBoostToHolder({ walletAddress, boostLevel, boostMultiplier, tokensBurnedRaw, txSignature }) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const holder = this.getHolderAccount(walletAddress);
    const previousRaw = BigInt(holder?.totalTokensBurned || '0');
    const newTotalRaw = (previousRaw + BigInt(tokensBurnedRaw || '0')).toString();

    db.prepare(`
      UPDATE holder_accounts
      SET boost_level = ?,
          boost_multiplier = ?,
          total_tokens_burned = ?,
          boost_activated_at = ?,
          last_burn_tx_hash = ?,
          updated_at = ?
      WHERE wallet_address = ?
    `).run(
      Number(boostLevel || 1),
      Number(boostMultiplier || 1.0),
      newTotalRaw,
      holder?.boostActivatedAt || now,
      String(txSignature || holder?.lastBurnTxHash || ''),
      now,
      walletAddress
    );
    return this.getHolderAccount(walletAddress);
  }

  // ── CREDIT ACCOUNTS ────────────────────────────────────────────────────────

  getCreditAccount(walletAddress) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM credit_accounts WHERE wallet_address = ?').get(walletAddress);
    if (!row) return null;
    return {
      walletAddress: row.wallet_address,
      creditAccountId: row.credit_account_id,
      earned: BigInt(row.earned || '0'),
      used: BigInt(row.used || '0'),
      available: BigInt(row.available || '0'),
      transferred: BigInt(row.transferred || '0'),
      redeemed: BigInt(row.redeemed || '0'),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  upsertCreditAccount(account) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO credit_accounts (
        wallet_address, credit_account_id, earned, used, available, transferred, redeemed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        earned = excluded.earned,
        used = excluded.used,
        available = excluded.available,
        transferred = excluded.transferred,
        redeemed = excluded.redeemed,
        updated_at = excluded.updated_at
    `).run(
      account.walletAddress,
      account.creditAccountId,
      account.earned.toString(),
      account.used.toString(),
      account.available.toString(),
      account.transferred.toString(),
      account.redeemed.toString(),
      account.createdAt || now,
      now
    );
  }

  // ── CREDIT LEDGER ──────────────────────────────────────────────────────────

  insertCreditLedgerEntry(entry) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO credit_ledger (
        id, wallet_address, type, amount, balance_after, reference_id, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.walletAddress,
      entry.type,
      entry.amount.toString(),
      entry.balanceAfter.toString(),
      entry.referenceId || null,
      JSON.stringify(entry.metadata || {}),
      entry.timestamp || new Date().toISOString()
    );
  }

  getCreditLedger(walletAddress, limit = 50) {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM credit_ledger
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(walletAddress, limit);

    return rows.map(r => ({
      id: r.id,
      walletAddress: r.wallet_address,
      type: r.type,
      amount: r.amount,
      balanceAfter: r.balance_after,
      referenceId: r.reference_id,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      timestamp: r.created_at
    }));
  }

  // ── LLM USAGE ──────────────────────────────────────────────────────────────

  insertLlmUsage(usage) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO llm_usage (
        id, wallet_address, model, prompt_tokens, completion_tokens, total_tokens, credits_deducted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.id,
      usage.walletAddress,
      usage.model,
      Number(usage.promptTokens || 0),
      Number(usage.completionTokens || 0),
      Number(usage.totalTokens || 0),
      usage.creditsDeducted.toString(),
      usage.createdAt || new Date().toISOString()
    );
  }

  // ── REWARD CLAIMS & ALLOCATIONS ───────────────────────────────────────────

  insertRewardClaim(claim) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO reward_claims (
        claim_id, wallet_address, destination_wallet, credits_redeemed,
        claim_amount_lamports, infrastructure_lamports, manual_lamports,
        status, idempotency_key, transaction_signature, confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.claimId,
      claim.walletAddress,
      claim.destinationWallet,
      claim.creditsRedeemed.toString(),
      claim.claimAmountLamports.toString(),
      claim.infrastructureLamports.toString(),
      claim.manualLamports.toString(),
      claim.status || 'PENDING_MANUAL_TRANSFER',
      claim.idempotencyKey,
      claim.transactionSignature || null,
      claim.confirmedAt || null,
      claim.createdAt || now,
      claim.updatedAt || now
    );
  }

  insertRewardAllocation(alloc) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO reward_allocations (
        id, claim_id, type, basis_points, amount_lamports, target_wallet, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      alloc.id,
      alloc.claimId,
      alloc.type,
      Number(alloc.basisPoints),
      alloc.amountLamports.toString(),
      alloc.targetWallet,
      alloc.createdAt || new Date().toISOString()
    );
  }

  insertManualTransfer(xfer) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO manual_transfers (
        id, claim_id, recipient_wallet, amount_lamports, status,
        operator_wallet, transaction_signature, confirmed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      xfer.id,
      xfer.claimId,
      xfer.recipientWallet,
      xfer.amountLamports.toString(),
      xfer.status || 'PENDING',
      xfer.operatorWallet,
      xfer.transactionSignature || null,
      xfer.confirmedAt || null,
      xfer.createdAt || new Date().toISOString()
    );
  }

  insertInfrastructureAllocation(infra) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO infrastructure_allocations (
        id, claim_id, infrastructure_wallet, amount_lamports, recorded_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      infra.id,
      infra.claimId,
      infra.infrastructureWallet,
      infra.amountLamports.toString(),
      infra.recordedAt || new Date().toISOString()
    );
  }

  getRewardClaim(claimId) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM reward_claims WHERE claim_id = ?').get(claimId);
    return row ? this.mapClaimRow(row) : null;
  }

  getRewardClaimByIdempotencyKey(idempotencyKey, walletAddress) {
    const db = this.getDb();
    // B-3 FIX: Scope idempotency key to wallet — prevents cross-user key replay
    if (walletAddress) {
      const row = db.prepare('SELECT * FROM reward_claims WHERE idempotency_key = ? AND wallet_address = ?').get(idempotencyKey, walletAddress);
      return row ? this.mapClaimRow(row) : null;
    }
    // Fallback for non-wallet-scoped lookups (e.g. internal use)
    const row = db.prepare('SELECT * FROM reward_claims WHERE idempotency_key = ?').get(idempotencyKey);
    return row ? this.mapClaimRow(row) : null;
  }

  getRewardClaimBySignature(signature) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM reward_claims WHERE transaction_signature = ?').get(signature);
    return row ? this.mapClaimRow(row) : null;
  }

  getPendingClaims() {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM reward_claims
      WHERE status = 'PENDING_MANUAL_TRANSFER'
      ORDER BY created_at ASC
    `).all();
    return rows.map(r => this.mapClaimRow(r));
  }

  getAllClaims() {
    const db = this.getDb();
    const rows = db.prepare('SELECT * FROM reward_claims ORDER BY created_at DESC').all();
    return rows.map(r => this.mapClaimRow(r));
  }

  getClaimsByWallet(walletAddress) {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM reward_claims
      WHERE wallet_address = ?
      ORDER BY created_at DESC
    `).all(walletAddress);
    return rows.map(r => this.mapClaimRow(r));
  }

  confirmClaim(claimId, transactionSignature, operatorWallet, confirmedAt = new Date().toISOString()) {
    const db = this.getDb();
    this.transaction(() => {
      db.prepare(`
        UPDATE reward_claims
        SET status = 'MANUAL_TRANSFER_CONFIRMED',
            transaction_signature = ?,
            confirmed_at = ?,
            updated_at = ?
        WHERE claim_id = ?
      `).run(transactionSignature, confirmedAt, confirmedAt, claimId);

      db.prepare(`
        UPDATE manual_transfers
        SET status = 'CONFIRMED',
            transaction_signature = ?,
            confirmed_at = ?,
            operator_wallet = ?
        WHERE claim_id = ?
      `).run(transactionSignature, confirmedAt, operatorWallet, claimId);
    });
  }

  mapClaimRow(r) {
    return {
      claimId: r.claim_id,
      walletAddress: r.wallet_address,
      destinationWallet: r.destination_wallet,
      creditsRedeemed: BigInt(r.credits_redeemed || '0'),
      claimAmountLamports: BigInt(r.claim_amount_lamports || '0'),
      infrastructureLamports: BigInt(r.infrastructure_lamports || '0'),
      manualLamports: BigInt(r.manual_lamports || '0'),
      status: r.status,
      idempotencyKey: r.idempotency_key,
      transactionSignature: r.transaction_signature,
      confirmedAt: r.confirmed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  // ── IDEMPOTENCY KEYS ───────────────────────────────────────────────────────

  getIdempotencyKey(key) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM idempotency_keys WHERE idempotency_key = ?').get(key);
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      action: row.action,
      walletAddress: row.wallet_address,
      responsePayload: JSON.parse(row.response_payload),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  saveIdempotencyKey(key, action, walletAddress, payload, expiresAt) {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO idempotency_keys (
        idempotency_key, action, wallet_address, response_payload, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      key,
      action,
      walletAddress,
      JSON.stringify(payload),
      new Date().toISOString(),
      expiresAt
    );
  }

  // ── AUDIT EVENTS ───────────────────────────────────────────────────────────

  recordAuditEvent(eventType, walletAddress, actorWallet, details = {}) {
    try {
      const db = this.getDb();
      const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO audit_events (
          id, event_type, wallet_address, actor_wallet, details, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        eventType,
        walletAddress || null,
        actorWallet || null,
        JSON.stringify(details),
        new Date().toISOString()
      );
    } catch (e) {
      console.warn('[DBAdapter] Failed to record audit event:', e.message);
    }
  }

  // ── FEE HARVESTING & 5% REWARD POOL ───────────────────────────────────────

  insertFeeHarvest(harvest) {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO fee_harvest_history (
        id, claimer_wallet, treasury_wallet, total_claimed_lamports,
        treasury_sent_lamports, pool_retained_lamports, tx_signature, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      harvest.id,
      harvest.claimerWallet,
      harvest.treasuryWallet,
      harvest.totalClaimedLamports.toString(),
      harvest.treasurySentLamports.toString(),
      harvest.poolRetainedLamports.toString(),
      harvest.txSignature || null,
      harvest.status || 'CONFIRMED',
      harvest.createdAt || new Date().toISOString()
    );
  }

  getFeeHarvestHistory(limit = 50) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM fee_harvest_history
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  isClaimSignatureProcessed(signature) {
    if (!signature) return false;
    const db = this.getDb();
    const row = db.prepare('SELECT signature FROM processed_claim_signatures WHERE signature = ?').get(signature);
    if (row) return true;
    const hist = db.prepare('SELECT id FROM fee_harvest_history WHERE tx_signature = ?').get(signature);
    return !!hist;
  }

  recordProcessedClaimSignature(signature, claimedLamports, treasurySentLamports, sweepTxSignature) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO processed_claim_signatures (
        signature, claimed_lamports, treasury_sent_lamports, sweep_tx_signature, processed_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(signature, claimedLamports.toString(), treasurySentLamports.toString(), sweepTxSignature || null, now);
  }

  // ── FEE HARVEST INTERVAL LOCKS (Exactly-Once Execution) ───────────────────

  tryAcquireHarvestInterval(intervalSlot, intervalId) {
    const db = this.getDb();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO fee_harvest_intervals (interval_id, interval_slot, status, created_at, updated_at)
        VALUES (?, ?, 'IN_PROGRESS', ?, ?)
      `).run(intervalId, intervalSlot, now, now);
      return { acquired: true, intervalId };
    } catch (err) {
      const existing = db.prepare('SELECT * FROM fee_harvest_intervals WHERE interval_id = ?').get(intervalId);
      if (existing) {
        if (existing.status === 'CONFIRMED') {
          return { acquired: false, reason: 'ALREADY_CONFIRMED', interval: existing };
        }
        if (existing.status === 'FAILED') {
          db.prepare(`
            UPDATE fee_harvest_intervals
            SET status = 'IN_PROGRESS', created_at = ?, updated_at = ?
            WHERE interval_id = ?
          `).run(now, now, intervalId);
          return { acquired: true, intervalId, retried: true };
        }
        // If stuck in IN_PROGRESS for > 10 minutes (crashed instance), allow take-over.
        // Conditional UPDATE: only the instance whose UPDATE actually flips the row wins.
        const ageMs = Date.now() - new Date(existing.created_at).getTime();
        if (ageMs > 10 * 60 * 1000) {
          const res = db.prepare(`
            UPDATE fee_harvest_intervals
            SET status = 'IN_PROGRESS', created_at = ?, updated_at = ?
            WHERE interval_id = ? AND status = 'IN_PROGRESS'
          `).run(now, now, intervalId);
          if (res && res.changes === 1) {
            return { acquired: true, intervalId, recovered: true };
          }
          // Another instance won the take-over race
          return { acquired: false, reason: 'IN_PROGRESS_ACTIVE', interval: existing };
        }
        return { acquired: false, reason: 'IN_PROGRESS_ACTIVE', interval: existing };
      }
      return { acquired: false, reason: err.message };
    }
  }

  confirmHarvestInterval(intervalId, harvestId, txSignature) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE fee_harvest_intervals
      SET status = 'CONFIRMED', harvest_id = ?, tx_signature = ?, updated_at = ?
      WHERE interval_id = ?
    `).run(harvestId, txSignature, now, intervalId);
  }

  failHarvestInterval(intervalId, reason) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE fee_harvest_intervals
      SET status = 'FAILED', tx_signature = ?, updated_at = ?
      WHERE interval_id = ?
    `).run(String(reason || 'FAILED').slice(0, 120), now, intervalId);
  }

  getHarvestInterval(intervalId) {
    const db = this.getDb();
    return db.prepare('SELECT * FROM fee_harvest_intervals WHERE interval_id = ?').get(intervalId) || null;
  }

  getRewardPoolState(poolId = 'global_mainnet') {
    const db = this.getDb();
    let row = db.prepare('SELECT * FROM reward_pool_state WHERE pool_id = ?').get(poolId);
    if (!row) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO reward_pool_state (
          pool_id, total_harvested_lamports, total_treasury_lamports, total_pool_lamports,
          available_pool_lamports, total_credits_burned, current_epoch, epoch_pool_lamports,
          epoch_credits_burned, last_harvest_at, updated_at
        ) VALUES (?, '0', '0', '0', '0', '0', 1, '0', '0', NULL, ?)
      `).run(poolId, now);
      row = db.prepare('SELECT * FROM reward_pool_state WHERE pool_id = ?').get(poolId);
    }
    return row;
  }

  updateRewardPoolState(poolId = 'global_mainnet', updates = {}) {
    const db = this.getDb();
    const current = this.getRewardPoolState(poolId);
    const now = new Date().toISOString();

    const totalHarvested = updates.totalHarvestedLamports !== undefined ? updates.totalHarvestedLamports.toString() : current.total_harvested_lamports;
    const totalTreasury = updates.totalTreasuryLamports !== undefined ? updates.totalTreasuryLamports.toString() : current.total_treasury_lamports;
    const totalPool = updates.totalPoolLamports !== undefined ? updates.totalPoolLamports.toString() : current.total_pool_lamports;
    const availablePool = updates.availablePoolLamports !== undefined ? updates.availablePoolLamports.toString() : current.available_pool_lamports;
    const totalCreditsBurned = updates.totalCreditsBurned !== undefined ? updates.totalCreditsBurned.toString() : current.total_credits_burned;
    const currentEpoch = updates.currentEpoch !== undefined ? updates.currentEpoch : current.current_epoch;
    const epochPool = updates.epochPoolLamports !== undefined ? updates.epochPoolLamports.toString() : current.epoch_pool_lamports;
    const epochCreditsBurned = updates.epochCreditsBurned !== undefined ? updates.epochCreditsBurned.toString() : current.epoch_credits_burned;
    const lastHarvest = updates.lastHarvestAt !== undefined ? updates.lastHarvestAt : current.last_harvest_at;

    db.prepare(`
      UPDATE reward_pool_state
      SET total_harvested_lamports = ?,
          total_treasury_lamports = ?,
          total_pool_lamports = ?,
          available_pool_lamports = ?,
          total_credits_burned = ?,
          current_epoch = ?,
          epoch_pool_lamports = ?,
          epoch_credits_burned = ?,
          last_harvest_at = ?,
          updated_at = ?
      WHERE pool_id = ?
    `).run(
      totalHarvested,
      totalTreasury,
      totalPool,
      availablePool,
      totalCreditsBurned,
      currentEpoch,
      epochPool,
      epochCreditsBurned,
      lastHarvest,
      now,
      poolId
    );

    return this.getRewardPoolState(poolId);
  }

  // ── CREDIT BURNS ───────────────────────────────────────────────────────────

  insertCreditBurn(burn) {
    const db = this.getDb();
    const nowIso = burn.createdAt || new Date().toISOString();
    db.prepare(`
      INSERT INTO credit_burns (
        id, wallet_address, destination_wallet, credits_burned,
        reward_lamports, reward_sol, market_cap_usd, tx_signature,
        signed_tx_raw, last_valid_block_height, blockhash, state_history,
        status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      burn.id,
      burn.walletAddress,
      burn.destinationWallet,
      burn.creditsBurned.toString(),
      burn.rewardLamports.toString(),
      Number(burn.rewardSol) || 0,
      Number(burn.marketCapUsd) || 0,
      burn.txSignature || null,
      burn.signedTxRaw || null,
      burn.lastValidBlockHeight ? Number(burn.lastValidBlockHeight) : null,
      burn.blockhash || null,
      burn.stateHistory ? JSON.stringify(burn.stateHistory) : null,
      burn.status || 'CREATED',
      burn.idempotencyKey || null,
      nowIso,
      nowIso
    );
  }

  getCreditBurnByIdempotencyKey(idempotencyKey, walletAddress) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_burns
      WHERE idempotency_key = ? AND wallet_address = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(idempotencyKey, walletAddress) || null;
  }

  getLatestCreditBurn(walletAddress) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_burns
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(walletAddress) || null;
  }

  updateCreditBurnState(burnId, updates = {}) {
    const db = this.getDb();
    const current = db.prepare('SELECT * FROM credit_burns WHERE id = ?').get(burnId);
    if (!current) return null;

    let history = [];
    try {
      if (current.state_history) history = JSON.parse(current.state_history);
    } catch {}
    if (updates.status && updates.status !== current.status) {
      history.push({ from: current.status, to: updates.status, at: new Date().toISOString(), note: updates.note || null });
    }

    const nextStatus = updates.status || current.status;
    const nextSig = updates.txSignature !== undefined ? updates.txSignature : current.tx_signature;
    const nextRaw = updates.signedTxRaw !== undefined ? updates.signedTxRaw : current.signed_tx_raw;
    const nextHeight = updates.lastValidBlockHeight !== undefined ? updates.lastValidBlockHeight : current.last_valid_block_height;
    const nextBlockhash = updates.blockhash !== undefined ? updates.blockhash : current.blockhash;
    const nowIso = new Date().toISOString();

    db.prepare(`
      UPDATE credit_burns
      SET status = ?,
          tx_signature = ?,
          signed_tx_raw = ?,
          last_valid_block_height = ?,
          blockhash = ?,
          state_history = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      nextSig,
      nextRaw,
      nextHeight !== null ? Number(nextHeight) : null,
      nextBlockhash,
      JSON.stringify(history),
      nowIso,
      burnId
    );

    return db.prepare('SELECT * FROM credit_burns WHERE id = ?').get(burnId);
  }

  updateCreditBurnOutcome(burnId, status, optionalTxSignature = null) {
    return this.updateCreditBurnState(burnId, {
      status,
      txSignature: optionalTxSignature
    });
  }

  getPendingBurnsForReconciliation() {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_burns
      WHERE status IN ('CREATED', 'SIGNED', 'BROADCASTING', 'BROADCASTED', 'PENDING_CONFIRMATION', 'PENDING_PAYMENT')
      ORDER BY created_at ASC
    `).all();
  }

  getActiveBurnReservationsTotal() {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT SUM(CAST(reward_lamports AS INTEGER)) as total
      FROM credit_burns
      WHERE status IN ('CREATED', 'SIGNED', 'BROADCASTING', 'BROADCASTED', 'PENDING_CONFIRMATION', 'PENDING_PAYMENT')
    `).get();
    return row && row.total ? BigInt(row.total) : 0n;
  }

  // ── CREDIT RESERVATIONS (Two-Phase AI Inference) ───────────────────────────

  createCreditReservation({ id, walletAddress, estimatedCredits, model, createdAt }) {
    const db = this.getDb();
    const nowIso = createdAt || new Date().toISOString();
    db.prepare(`
      INSERT INTO credit_reservations (
        id, wallet_address, estimated_credits, actual_credits, model, status, created_at
      ) VALUES (?, ?, ?, '0', ?, 'ACTIVE', ?)
    `).run(
      id,
      walletAddress,
      estimatedCredits.toString(),
      model || 'auto',
      nowIso
    );
    return db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id);
  }

  getCreditReservation(id) {
    const db = this.getDb();
    return db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id) || null;
  }

  updateCreditReservation({ id, actualCredits = 0n, status, settledAt }) {
    const db = this.getDb();
    const nowIso = settledAt || new Date().toISOString();
    db.prepare(`
      UPDATE credit_reservations
      SET actual_credits = ?,
          status = ?,
          settled_at = ?
      WHERE id = ?
    `).run(
      actualCredits.toString(),
      status,
      nowIso,
      id
    );
    return db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id) || null;
  }

  getActiveReservationsTotal(walletAddress) {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT SUM(CAST(estimated_credits AS INTEGER)) as total
      FROM credit_reservations
      WHERE wallet_address = ? AND status = 'ACTIVE'
    `).get(walletAddress);
    return row && row.total ? BigInt(row.total) : 0n;
  }

  getStaleReservations(cutoffIso) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_reservations
      WHERE status = 'ACTIVE' AND created_at < ?
      ORDER BY created_at ASC
    `).all(cutoffIso);
  }

  getCreditBurnsByWallet(walletAddress, limit = 50) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_burns
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(walletAddress, limit);
  }

  getAllCreditBurns(limit = 100) {
    const db = this.getDb();
    return db.prepare(`
      SELECT * FROM credit_burns
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  // ==========================================
  // JEV BRAIN CLI & API KEY MANAGEMENT
  // ==========================================

  createApiKey({ walletAddress, name = 'Default CLI Key', tokensHeld = 0, tierId = 0, expiresAt = null }) {
    const db = this.getDb();
    const keyId = `key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const apiKey = `jev_live_${crypto.randomBytes(24).toString('hex')}`;
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO api_keys (
        key_id, api_key, wallet_address, name, is_revoked, status,
        last_verified_tokens, last_verified_tier, last_verified_at, created_at, last_used_at, expires_at
      )
      VALUES (?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, NULL, ?)
    `).run(keyId, apiKey, walletAddress, name.trim().slice(0, 50), Number(tokensHeld) || 0, Number(tierId) || 0, createdAt, createdAt, expiresAt || null);

    return {
      keyId,
      apiKey,
      walletAddress,
      name,
      status: 'active',
      lastVerifiedTokens: Number(tokensHeld) || 0,
      lastVerifiedTier: Number(tierId) || 0,
      createdAt,
      expiresAt: expiresAt || null
    };
  }

  getApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return null;
    const cleanKey = apiKey.trim();

    // Fast-path for deterministic operator VIP keys
    if (cleanKey === 'jev_live_vip_2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx' || cleanKey === 'jev_live_vip_HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn') {
      const isHq = cleanKey.includes('HqHQ');
      return {
        key_id: isHq ? 'key_operator_vip_HqHQ' : 'key_operator_vip_2yHe',
        api_key: cleanKey,
        wallet_address: isHq ? 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn' : '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx',
        name: 'VIP Operator Master Key',
        is_revoked: 0,
        status: 'active',
        suspension_reason: null,
        last_verified_tokens: 1000000,
        last_verified_tier: 5,
        last_verified_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        expires_at: null
      };
    }

    const db = this.getDb();
    const row = db.prepare(`
      SELECT key_id, api_key, wallet_address, name, is_revoked, status,
             suspension_reason, last_verified_tokens, last_verified_tier,
             last_verified_at, created_at, last_used_at, expires_at
      FROM api_keys
      WHERE api_key = ? AND is_revoked = 0
    `).get(cleanKey);
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return {
        ...row,
        status: 'expired',
        isExpired: true
      };
    }
    return row;
  }

  getAllActiveApiKeys() {
    const db = this.getDb();
    return db.prepare(`
      SELECT key_id, api_key, wallet_address, name, is_revoked, status,
             suspension_reason, last_verified_tokens, last_verified_tier,
             last_verified_at, created_at, last_used_at, expires_at
      FROM api_keys
      WHERE is_revoked = 0
      ORDER BY created_at DESC
    `).all();
  }

  suspendApiKey(keyId, reason = 'tokens_sold_or_transferred') {
    if (!keyId) return false;
    const db = this.getDb();
    const now = new Date().toISOString();
    const res = db.prepare(`
      UPDATE api_keys
      SET status = 'suspended', suspension_reason = ?, last_verified_at = ?
      WHERE key_id = ? AND is_revoked = 0
    `).run(reason, now, keyId);
    return res.changes > 0;
  }

  reactivateApiKey(keyId, tokensHeld = 0, tierId = 0) {
    if (!keyId) return false;
    const db = this.getDb();
    const now = new Date().toISOString();
    const res = db.prepare(`
      UPDATE api_keys
      SET status = 'active', suspension_reason = NULL,
          last_verified_tokens = ?, last_verified_tier = ?, last_verified_at = ?
      WHERE key_id = ? AND is_revoked = 0
    `).run(Number(tokensHeld) || 0, Number(tierId) || 0, now, keyId);
    return res.changes > 0;
  }

  updateApiKeyAuditInfo(keyId, { status, suspensionReason = null, tokensHeld = 0, tierId = 0 }) {
    if (!keyId) return false;
    const db = this.getDb();
    const now = new Date().toISOString();
    const res = db.prepare(`
      UPDATE api_keys
      SET status = COALESCE(?, status),
          suspension_reason = ?,
          last_verified_tokens = ?,
          last_verified_tier = ?,
          last_verified_at = ?
      WHERE key_id = ?
    `).run(status || null, suspensionReason, Number(tokensHeld) || 0, Number(tierId) || 0, now, keyId);
    return res.changes > 0;
  }

  listApiKeys(walletAddress) {
    if (!walletAddress) return [];
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT key_id, wallet_address, name, is_revoked, status,
             suspension_reason, last_verified_tokens, last_verified_tier,
             last_verified_at, created_at, last_used_at, expires_at, api_key
      FROM api_keys
      WHERE wallet_address = ?
      ORDER BY created_at DESC
    `).all(walletAddress);

    const now = Date.now();
    return rows.map(r => {
      const isExpired = Boolean(r.expires_at && new Date(r.expires_at).getTime() < now);
      let effectiveStatus = r.status || (r.is_revoked ? 'revoked' : 'active');
      if (r.is_revoked) {
        effectiveStatus = 'revoked';
      } else if (isExpired) {
        effectiveStatus = 'expired';
      }

      return {
        keyId: r.key_id,
        walletAddress: r.wallet_address,
        name: r.name,
        isRevoked: Boolean(r.is_revoked),
        isExpired,
        status: effectiveStatus,
        suspensionReason: r.suspension_reason || null,
        lastVerifiedTokens: r.last_verified_tokens || 0,
        lastVerifiedTier: r.last_verified_tier || 0,
        lastVerifiedAt: r.last_verified_at || null,
        createdAt: r.created_at,
        expiresAt: r.expires_at || null,
        lastUsedAt: r.last_used_at,
        apiKey: r.api_key,
        maskedKey: r.api_key.length > 16 
          ? `${r.api_key.slice(0, 13)}...${r.api_key.slice(-4)}`
          : r.api_key
      };
    });
  }

  revokeApiKey({ keyId, walletAddress }) {
    if (!keyId || !walletAddress) return false;
    const db = this.getDb();
    const res = db.prepare(`
      UPDATE api_keys
      SET is_revoked = 1, status = 'revoked'
      WHERE key_id = ? AND wallet_address = ?
    `).run(keyId, walletAddress);
    return res.changes > 0;
  }

  deleteApiKey({ keyId, walletAddress }) {
    if (!keyId || !walletAddress) return false;
    const db = this.getDb();
    const res = db.prepare(`
      DELETE FROM api_keys
      WHERE key_id = ? AND wallet_address = ?
    `).run(keyId, walletAddress);
    return res.changes > 0;
  }

  touchApiKeyLastUsed(apiKey) {
    if (!apiKey) return;
    const db = this.getDb();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        UPDATE api_keys
        SET last_used_at = ?
        WHERE api_key = ?
      `).run(now, apiKey);
    } catch {}
  }

  // ==========================================
  // BURN-TO-BOOST LIFETIME REWARD MULTIPLIER
  // ==========================================

  insertBurnReceipt(receipt) {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_burn_receipts (
        id, wallet_address, tier_at_burn, boost_level_unlocked, multiplier_awarded,
        tokens_burned_raw, tokens_burned_ui, tx_signature, block_time, burn_method, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.walletAddress,
      Number(receipt.tierAtBurn),
      Number(receipt.boostLevelUnlocked),
      Number(receipt.multiplierAwarded),
      String(receipt.tokensBurnedRaw),
      Number(receipt.tokensBurnedUi),
      receipt.txSignature,
      Number(receipt.blockTime || Math.floor(Date.now() / 1000)),
      receipt.burnMethod || 'token_burn',
      receipt.createdAt || now
    );
    return this.getBurnReceiptById(receipt.id);
  }

  getBurnReceiptById(id) {
    if (!id) return null;
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM token_burn_receipts WHERE id = ?').get(id);
    return row ? this._formatBurnReceipt(row) : null;
  }

  getBurnReceiptBySignature(signature) {
    if (!signature) return null;
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM token_burn_receipts WHERE tx_signature = ?').get(signature);
    return row ? this._formatBurnReceipt(row) : null;
  }

  getBurnReceiptsByWallet(walletAddress, limit = 50) {
    if (!walletAddress) return [];
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM token_burn_receipts
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(walletAddress, limit);
    return rows.map(r => this._formatBurnReceipt(r));
  }

  _formatBurnReceipt(row) {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      tierAtBurn: Number(row.tier_at_burn),
      boostLevelUnlocked: Number(row.boost_level_unlocked),
      multiplierAwarded: Number(row.multiplier_awarded),
      tokensBurnedRaw: String(row.tokens_burned_raw),
      tokensBurnedUi: Number(row.tokens_burned_ui),
      txSignature: row.tx_signature,
      blockTime: Number(row.block_time),
      burnMethod: row.burn_method,
      createdAt: row.created_at
    };
  }

  applyBoostToHolder({ walletAddress, boostLevel, boostMultiplier, tokensBurnedRaw, txSignature }) {
    const db = this.getDb();
    const now = new Date().toISOString();
    const holder = this.getHolderAccount(walletAddress);
    const prevBurnedRaw = BigInt(holder?.totalTokensBurned || '0');
    const newBurnedRaw = (prevBurnedRaw + BigInt(tokensBurnedRaw || '0')).toString();

    db.prepare(`
      UPDATE holder_accounts
      SET boost_level = ?,
          boost_multiplier = ?,
          total_tokens_burned = ?,
          boost_activated_at = COALESCE(boost_activated_at, ?),
          last_burn_tx_hash = ?,
          updated_at = ?
      WHERE wallet_address = ?
    `).run(
      Number(boostLevel),
      Number(boostMultiplier),
      newBurnedRaw,
      now,
      txSignature,
      now,
      walletAddress
    );
    return this.getHolderAccount(walletAddress);
  }

  // ── P2P CREDIT ORDERS (Burning Day Market) ────────────────────────────────

  mapP2POrderRow(row) {
    if (!row) return null;
    let metadata = {};
    try {
      metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    } catch {}

    return {
      orderId: row.order_id,
      sellerWallet: row.seller_wallet,
      creditsAmount: Number(row.credits_amount),
      priceSol: Number(row.price_sol),
      priceLamports: String(row.price_lamports),
      tokensToBurnRaw: String(row.tokens_to_burn_raw),
      tokensToBurnUi: Number(row.tokens_to_burn_ui),
      status: row.status,
      buyerWallet: row.buyer_wallet || null,
      txSignature: row.tx_signature || null,
      jevBurnSignature: row.jev_burn_signature || row.tx_signature || null,
      solPayoutSignature: row.sol_payout_signature || null,
      createdAt: row.created_at,
      filledAt: row.filled_at || null,
      cancelledAt: row.cancelled_at || null,
      metadata
    };
  }

  getP2POrder(orderId) {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE order_id = ?').get(orderId);
    return this.mapP2POrderRow(row);
  }

  getP2POrderBySignature(txSignature) {
    if (!txSignature) return null;
    const db = this.getDb();
    const sig = txSignature.trim();
    const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE tx_signature = ? OR jev_burn_signature = ? OR sol_payout_signature = ?').get(sig, sig, sig);
    return this.mapP2POrderRow(row);
  }

  getP2POrderByBurnSignature(sig) {
    if (!sig) return null;
    const db = this.getDb();
    const clean = sig.trim();
    const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE jev_burn_signature = ? OR tx_signature = ?').get(clean, clean);
    return this.mapP2POrderRow(row);
  }

  getP2POrderBySolPayoutSignature(sig) {
    if (!sig) return null;
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE sol_payout_signature = ?').get(sig.trim());
    return this.mapP2POrderRow(row);
  }

  assertCreditAccountInvariants(account) {
    if (!account) return;
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
      throw new Error(`Financial Invariant Violation: earned credits (${earned}) < total outgoing (${totalOut})`);
    }
    if (avail !== (earned - totalOut)) {
      throw new Error(`Financial Invariant Violation: balance mismatch (available: ${avail}, expected: ${earned - totalOut})`);
    }
  }

  createP2POrder({ orderId, sellerWallet, creditsAmount, priceSol, priceLamports, tokensToBurnRaw, tokensToBurnUi, metadata = {} }) {
    const seller = (sellerWallet || '').trim();
    const credits = Number(creditsAmount);
    const sol = Number(priceSol);

    if (!orderId) throw new Error('Order ID is required.');
    if (!seller) throw new Error('Seller wallet is required.');
    if (!Number.isFinite(credits) || credits <= 0) throw new Error('Credits amount must be positive.');
    if (!Number.isFinite(sol) || sol <= 0) throw new Error('Price in SOL must be positive.');

    return this.transaction(() => {
      const db = this.getDb();
      const account = this.getCreditAccount(seller);
      if (!account || account.available < BigInt(credits)) {
        throw new Error(`Insufficient available credits to create listing: requested ${credits}, available ${account?.available ?? 0}`);
      }

      const now = new Date().toISOString();
      const newAvail = (account.available - BigInt(credits)).toString();
      const newTransferred = (account.transferred + BigInt(credits)).toString();

      // Assert financial invariant before committing escrow
      this.assertCreditAccountInvariants({
        ...account,
        available: BigInt(newAvail),
        transferred: BigInt(newTransferred)
      });

      // Escrow credits: available -> transferred
      db.prepare(`
        UPDATE credit_accounts
        SET available = ?, transferred = ?, updated_at = ?
        WHERE wallet_address = ?
      `).run(newAvail, newTransferred, now, seller);

      // Record P2P_ESCROW in immutable ledger
      this.insertCreditLedgerEntry({
        id: `ledg_p2p_escrow_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        walletAddress: seller,
        type: 'P2P_ESCROW',
        amount: BigInt(credits),
        balanceAfter: BigInt(newAvail),
        referenceId: orderId,
        metadata: { priceSol: sol, tokensToBurnUi, ...metadata },
        timestamp: now
      });

      // Insert order
      db.prepare(`
        INSERT INTO p2p_credit_orders (
          order_id, seller_wallet, credits_amount, price_sol, price_lamports,
          tokens_to_burn_raw, tokens_to_burn_ui, status, created_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(
        orderId,
        seller,
        credits,
        sol,
        String(priceLamports),
        String(tokensToBurnRaw),
        Number(tokensToBurnUi),
        now,
        JSON.stringify(metadata)
      );

      this.recordAuditEvent('P2P_ORDER_CREATED', seller, seller, {
        orderId,
        creditsAmount: credits,
        priceSol: sol,
        tokensToBurnUi
      });

      return this.getP2POrder(orderId);
    });
  }

  cancelP2POrder(orderId, callerWallet) {
    const caller = (callerWallet || '').trim();
    if (!orderId) throw new Error('Order ID is required.');
    if (!caller) throw new Error('Caller wallet is required for cancellation authorization.');

    return this.transaction(() => {
      const db = this.getDb();
      const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE order_id = ?').get(orderId);
      if (!row) throw new Error(`P2P order not found: ${orderId}`);
      if (row.status !== 'ACTIVE') throw new Error(`Order is not ACTIVE (current status: ${row.status})`);

      const isOwner = row.seller_wallet === caller;
      const isOperator = [
        'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn',
        '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx',
        (process.env.ADMIN_WALLET || '').trim()
      ].includes(caller);

      if (!isOwner && !isOperator) {
        throw new Error('Unauthorized: Only order seller or system operator can cancel an active listing.');
      }

      const now = new Date().toISOString();
      const credits = BigInt(row.credits_amount);

      // Refund escrowed credits: transferred -> available
      const account = this.getCreditAccount(row.seller_wallet);
      if (account) {
        if (account.transferred < credits) {
          throw new Error(`Escrow accounting invariant error: seller transferred credits (${account.transferred}) < refund amount (${credits})`);
        }
        const newTransferred = (account.transferred - credits).toString();
        const newAvail = (account.available + credits).toString();

        // Assert financial invariant before committing refund
        this.assertCreditAccountInvariants({
          ...account,
          available: BigInt(newAvail),
          transferred: BigInt(newTransferred)
        });

        db.prepare(`
          UPDATE credit_accounts
          SET available = ?, transferred = ?, updated_at = ?
          WHERE wallet_address = ?
        `).run(newAvail, newTransferred, now, row.seller_wallet);

        // Record P2P_REFUND in immutable ledger
        this.insertCreditLedgerEntry({
          id: `ledg_p2p_refund_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          walletAddress: row.seller_wallet,
          type: 'P2P_REFUND',
          amount: credits,
          balanceAfter: BigInt(newAvail),
          referenceId: orderId,
          metadata: { cancelledBy: caller, isOperatorOverride: !isOwner && isOperator },
          timestamp: now
        });
      }

      db.prepare(`
        UPDATE p2p_credit_orders
        SET status = 'CANCELLED', cancelled_at = ?
        WHERE order_id = ?
      `).run(now, orderId);

      this.recordAuditEvent('P2P_ORDER_CANCELLED', caller, row.seller_wallet, {
        orderId,
        creditsRefunded: Number(row.credits_amount),
        isOperatorOverride: !isOwner && isOperator
      });

      return this.getP2POrder(orderId);
    });
  }

  lockP2POrder(orderId, buyerWallet) {
    const buyer = (buyerWallet || '').trim();
    if (!orderId) throw new Error('Order ID is required.');
    if (!buyer) throw new Error('Buyer wallet is required.');

    return this.transaction(() => {
      const db = this.getDb();
      const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE order_id = ?').get(orderId);
      if (!row) throw new Error(`P2P order not found: ${orderId}`);
      if (row.seller_wallet === buyer) throw new Error('Self-dealing violation: You cannot purchase your own credit listing.');

      if (row.status === 'ACTIVE') {
        db.prepare(`
          UPDATE p2p_credit_orders
          SET status = 'PURCHASE_PENDING', buyer_wallet = ?
          WHERE order_id = ?
        `).run(buyer, orderId);
      } else if (row.status === 'PURCHASE_PENDING') {
        if (row.buyer_wallet && row.buyer_wallet !== buyer) {
          throw new Error('Order is currently reserved by another buyer.');
        }
      } else {
        throw new Error(`Order is not available for purchase (current status: ${row.status})`);
      }

      return this.getP2POrder(orderId);
    });
  }

  updateP2POrderStatus(orderId, status, { buyerWallet = null, jevBurnSignature = null, solPayoutSignature = null, metadata = null } = {}) {
    if (!orderId) throw new Error('Order ID is required.');
    if (!status) throw new Error('Status is required.');

    return this.transaction(() => {
      const db = this.getDb();
      const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE order_id = ?').get(orderId);
      if (!row) throw new Error(`P2P order not found: ${orderId}`);

      let metaObj = {};
      try {
        metaObj = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      } catch {}
      if (metadata && typeof metadata === 'object') {
        metaObj = { ...metaObj, ...metadata };
      }

      const updates = ['status = ?'];
      const params = [status];

      if (buyerWallet) {
        updates.push('buyer_wallet = ?');
        params.push(buyerWallet.trim());
      }
      if (jevBurnSignature) {
        const cleanBurnSig = jevBurnSignature.trim();
        updates.push('jev_burn_signature = ?');
        params.push(cleanBurnSig);
        updates.push('tx_signature = COALESCE(tx_signature, ?)');
        params.push(cleanBurnSig);
      }
      if (solPayoutSignature) {
        updates.push('sol_payout_signature = ?');
        params.push(solPayoutSignature.trim());
      }
      updates.push('metadata = ?');
      params.push(JSON.stringify(metaObj));

      params.push(orderId);

      db.prepare(`UPDATE p2p_credit_orders SET ${updates.join(', ')} WHERE order_id = ?`).run(...params);

      return this.getP2POrder(orderId);
    });
  }

  fillP2POrder({ orderId, buyerWallet, jevBurnSignature, solPayoutSignature, txSignature }) {
    const buyer = (buyerWallet || '').trim();
    const sig = (jevBurnSignature || txSignature || '').trim();
    const payoutSig = (solPayoutSignature || '').trim() || null;

    if (!orderId) throw new Error('Order ID is required.');
    if (!buyer) throw new Error('Buyer wallet is required.');
    if (!sig) throw new Error('Transaction signature is required.');

    return this.transaction(() => {
      const db = this.getDb();
      const row = db.prepare('SELECT * FROM p2p_credit_orders WHERE order_id = ?').get(orderId);
      if (!row) throw new Error(`P2P order not found: ${orderId}`);
      if (!['ACTIVE', 'PURCHASE_PENDING', 'JEV_BURN_CONFIRMED', 'SOL_PAYOUT_SUBMITTED'].includes(row.status)) {
        throw new Error(`Order is not in an actionable state (current status: ${row.status})`);
      }
      if (row.seller_wallet === buyer) throw new Error('Self-dealing violation: You cannot purchase your own credit listing.');

      // Check if signature already used
      const existingSig = db.prepare('SELECT order_id FROM p2p_credit_orders WHERE (tx_signature = ? OR jev_burn_signature = ?) AND order_id != ?').get(sig, sig, orderId);
      if (existingSig) throw new Error(`Transaction signature has already been used for order ${existingSig.order_id}`);

      if (payoutSig) {
        const existingPayoutSig = db.prepare('SELECT order_id FROM p2p_credit_orders WHERE sol_payout_signature = ? AND order_id != ?').get(payoutSig, orderId);
        if (existingPayoutSig) throw new Error(`SOL payout signature has already been used for order ${existingPayoutSig.order_id}`);
      }

      const now = new Date().toISOString();
      const credits = BigInt(row.credits_amount);

      // Ensure buyer has a credit account (and holder account to satisfy foreign key)
      let buyerHolder = this.getHolderAccount(buyer);
      if (!buyerHolder) {
        this.upsertHolderAccount({
          walletAddress: buyer,
          tokenBalanceRaw: '0',
          tokenBalanceUi: 0,
          tier: 'None',
          tierLevel: 0,
          creditRatePerHour: 0
        });
      }

      let buyerAcc = this.getCreditAccount(buyer);
      if (!buyerAcc) {
        buyerAcc = {
          walletAddress: buyer,
          creditAccountId: 'acc_' + buyer.slice(0, 8),
          earned: 0n,
          used: 0n,
          available: 0n,
          transferred: 0n,
          redeemed: 0n
        };
        this.upsertCreditAccount(buyerAcc);
      }

      // 1. Finalize seller ledger: P2P_SOLD (audit record)
      const sellerAcc = this.getCreditAccount(row.seller_wallet);
      this.insertCreditLedgerEntry({
        id: `ledg_p2p_sold_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        walletAddress: row.seller_wallet,
        type: 'P2P_SOLD',
        amount: credits,
        balanceAfter: sellerAcc?.available ?? 0n,
        referenceId: orderId,
        metadata: { buyer, txSignature: sig, jevBurnSignature: sig, solPayoutSignature: payoutSig, priceSol: row.price_sol },
        timestamp: now
      });

      // 2. Deliver credits to buyer: earned += credits, available += credits
      const newBuyerEarned = (buyerAcc.earned + credits).toString();
      const newBuyerAvail = (buyerAcc.available + credits).toString();

      // Assert financial invariant before committing buyer credit delivery
      this.assertCreditAccountInvariants({
        ...buyerAcc,
        earned: BigInt(newBuyerEarned),
        available: BigInt(newBuyerAvail)
      });

      db.prepare(`
        UPDATE credit_accounts
        SET earned = ?, available = ?, updated_at = ?
        WHERE wallet_address = ?
      `).run(newBuyerEarned, newBuyerAvail, now, buyer);

      this.insertCreditLedgerEntry({
        id: `ledg_p2p_bought_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        walletAddress: buyer,
        type: 'P2P_BOUGHT',
        amount: credits,
        balanceAfter: BigInt(newBuyerAvail),
        referenceId: orderId,
        metadata: {
          seller: row.seller_wallet,
          txSignature: sig,
          jevBurnSignature: sig,
          solPayoutSignature: payoutSig,
          priceSol: row.price_sol,
          tokensBurnedUi: row.tokens_to_burn_ui
        },
        timestamp: now
      });

      // 3. Mark order COMPLETED
      db.prepare(`
        UPDATE p2p_credit_orders
        SET status = 'COMPLETED', buyer_wallet = ?, tx_signature = ?, jev_burn_signature = ?, sol_payout_signature = ?, filled_at = ?
        WHERE order_id = ?
      `).run(buyer, sig, sig, payoutSig, now, orderId);

      this.recordAuditEvent('P2P_ORDER_COMPLETED', buyer, row.seller_wallet, {
        orderId,
        creditsDelivered: Number(row.credits_amount),
        priceSol: row.price_sol,
        tokensBurnedUi: row.tokens_to_burn_ui,
        jevBurnSignature: sig,
        solPayoutSignature: payoutSig
      });

      return this.getP2POrder(orderId);
    });
  }

  listP2POrders({ status = 'ACTIVE', sellerWallet = null, limit = 50, offset = 0, sort = 'price_asc' } = {}) {
    const db = this.getDb();
    let query = 'SELECT * FROM p2p_credit_orders WHERE 1=1';
    const params = [];

    if (status && status !== 'ALL') {
      query += ' AND status = ?';
      params.push(status);
    }
    if (sellerWallet) {
      query += ' AND seller_wallet = ?';
      params.push(sellerWallet.trim());
    }

    if (sort === 'price_asc') {
      query += ' ORDER BY (price_sol / credits_amount) ASC, created_at DESC';
    } else if (sort === 'price_desc') {
      query += ' ORDER BY (price_sol / credits_amount) DESC, created_at DESC';
    } else if (sort === 'credits_desc') {
      query += ' ORDER BY credits_amount DESC, created_at DESC';
    } else {
      query += ' ORDER BY created_at DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    params.push(Number(limit) || 50, Number(offset) || 0);

    const rows = db.prepare(query).all(...params);
    return rows.map(r => this.mapP2POrderRow(r));
  }

  // ── WALLET DOCKETS (Stable one-docket-per-wallet numbering for Live Audit) ──

  /**
   * Return Map<wallet_address, docket_number> for every docketed wallet.
   */
  getWalletDockets() {
    const db = this.getDb();
    const rows = db.prepare('SELECT wallet_address, docket_number FROM wallet_dockets').all();
    return new Map(rows.map(r => [r.wallet_address, r.docket_number]));
  }

  /**
   * Ensure every candidate wallet has exactly one persistent docket number.
   * New dockets are issued in first-seen activity order (then wallet address),
   * so numbering stays stable and ascending across refreshes.
   * @param {Array<{walletAddress: string, firstSeenAt?: string}>} candidates
   * @returns {Map<string, number>} wallet_address -> docket_number
   */
  ensureWalletDockets(candidates = []) {
    const db = this.getDb();
    const load = () => new Map(
      db.prepare('SELECT wallet_address, docket_number FROM wallet_dockets').all()
        .map(r => [r.wallet_address, r.docket_number])
    );

    let map = load();
    const missing = candidates.filter(c => c && c.walletAddress && !map.has(c.walletAddress));
    if (missing.length === 0) return map;

    missing.sort((a, b) => {
      const at = String(a.firstSeenAt || '');
      const bt = String(b.firstSeenAt || '');
      if (at !== bt) return at < bt ? -1 : 1;
      return String(a.walletAddress).localeCompare(String(b.walletAddress));
    });

    const now = new Date().toISOString();
    this.transaction(() => {
      const stmt = db.prepare('INSERT INTO wallet_dockets (wallet_address, created_at) VALUES (?, ?)');
      for (const c of missing) {
        try {
          stmt.run(c.walletAddress, now);
        } catch {
          // UNIQUE(wallet_address) race: another writer already issued its docket.
        }
      }
    });

    map = load();
    return map;
  }

  getP2PStats() {
    const db = this.getDb();
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_listings_count,
        COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN credits_amount ELSE 0 END), 0) as total_credits_active,
        COUNT(CASE WHEN status IN ('COMPLETED', 'FILLED') THEN 1 END) as filled_orders_count,
        COALESCE(SUM(CASE WHEN status IN ('COMPLETED', 'FILLED') THEN credits_amount ELSE 0 END), 0) as total_credits_traded,
        COALESCE(SUM(CASE WHEN status IN ('COMPLETED', 'FILLED') THEN price_sol ELSE 0 END), 0) as total_sol_volume,
        COALESCE(SUM(CASE WHEN status IN ('COMPLETED', 'FILLED') THEN tokens_to_burn_ui ELSE 0 END), 0) as total_tokens_burned_ui,
        COUNT(*) as total_orders_count
      FROM p2p_credit_orders
    `).get();

    return {
      activeListingsCount: Number(stats?.active_listings_count || 0),
      totalCreditsActive: Number(stats?.total_credits_active || 0),
      filledOrdersCount: Number(stats?.filled_orders_count || 0),
      totalCreditsTraded: Number(stats?.total_credits_traded || 0),
      totalSolVolume: Number(stats?.total_sol_volume || 0),
      totalTokensBurnedUi: Number(stats?.total_tokens_burned_ui || 0),
      totalOrdersCount: Number(stats?.total_orders_count || 0)
    };
  }

  close() {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}

// Global Singleton Instance
export const dbAdapter = new DatabaseAdapter();
