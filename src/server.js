import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JevBrain, PRESETS } from './core/router.js';
import { AgentWarden } from './core/warden.js';
import { OpenRouterClient, OPENROUTER_MODELS } from './core/openrouter.js';
import { fetchLiveMarketData, calculateDynamicTier } from './core/dexscreener.js';
import { MobileRunner } from './core/mobile.js';
import { EXTENDED_MODELS, getModelTier } from './core/extended-models.js';
import { verifyMessage, JsonRpcProvider, Contract, isAddress } from 'ethers';
import { discordBot, DISCORD_CONFIG, OFFICIAL_TOKEN_CA, SERVER_ROLES } from './discord/bot.js';
import { getBenchmarkMatrix, runBenchmarkPipeline, analyzePromptComplexity, calculateCostAndSavings, evaluateSLAFallback } from './core/benchmark-matrix.js';
import { getHolderEligibility, isValidSolanaAddress, OFFICIAL_SOLANA_MINT, HOLDER_TIERS, WHITELIST_ADMIN_WALLETS, querySolanaRpcWithFailover } from './core/holder-eligibility.js';
import { rewardsStore, INFRASTRUCTURE_WALLET_PUBLIC_KEY, OPERATOR_WALLET_PUBLIC_KEY, LAMPORTS_PER_SOL } from './core/rewards-store.js';
import { accrueCreditsForHolder, deductCreditsForLLM, transferCredits, reserveCreditsForLLM, settleCreditReservation, releaseCreditReservation, estimateLlmCreditCost, LAMPORTS_PER_CREDIT, MIN_REDEMPTION_CREDITS } from './core/credit-engine.js';
import { getPendingTransfers, getAllClaimsHistory } from './core/operator-service.js';
import { burnEngine } from './core/burn-engine.js';
import { feeHarvester } from './workers/fee-harvester.js';
import { paymentReconciler } from './workers/payment-reconciler.js';
import { apiKeyAuditor } from './workers/api-key-auditor.js';
import { holderAccrualDaemon } from './workers/holder-accrual-daemon.js';
import { dbAdapter, DATA_DIR } from './core/db-adapter.js';
import { getBoostStatus, claimBurnBoost, listBoostTierMatrix, tokensRawToUi, BOOST_LEVELS } from './core/boost-engine.js';
import { p2pMarketEngine, isP2POperator, fetchLiveSolPriceUsd } from './core/p2p-market-engine.js';

export const isServerless = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
export const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test'));

// Start automated background daemons on persistent runtimes (VPS / container)
if (!isTestEnv && !isServerless) {
  feeHarvester.start(15 * 60 * 1000);
  paymentReconciler.start(20 * 1000);
  apiKeyAuditor.start(60 * 1000);
  holderAccrualDaemon.start(60 * 1000);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-load .env configuration if present
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of envContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (process.env.NODE_ENV === 'test' || process.env.DATABASE_PATH?.includes('test')) {
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        } else {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// DATA_DIR is shared with db-adapter: DATABASE_PATH/JEV_DATA_DIR/RAILWAY_VOLUME_MOUNT_PATH aware,
// so both the SQLite ledger AND this state file live on the same persistent volume.
const STATE_FILE = process.env.STATE_FILE || (
  process.env.NODE_ENV === 'test'
    ? path.join(DATA_DIR, 'jev-state.test.json')
    : path.join(DATA_DIR, 'jev-state.json')
);

// State persistence
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch {}
}
const savedState = readState();

// Active signature authentication nonces (5-minute TTL)
const activeNonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;

// Stateless HMAC-signed session tokens: base64url(payload).hmacSignature
// Survives server restarts and works across serverless instances when SESSION_SECRET is set.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour session TTL
let _sessionSecret = null;
function getSessionSecret() {
  if (_sessionSecret) return _sessionSecret;
  if (process.env.SESSION_SECRET) {
    _sessionSecret = process.env.SESSION_SECRET;
    return _sessionSecret;
  }

  // Auto-persist SESSION_SECRET in persistent volume storage (DATA_DIR) if available
  try {
    const secretFile = path.join(DATA_DIR, '.session_secret');
    if (fs.existsSync(secretFile)) {
      const persisted = fs.readFileSync(secretFile, 'utf8').trim();
      if (persisted.length >= 32) {
        _sessionSecret = persisted;
        console.log('[security] Loaded persistent SESSION_SECRET from volume storage.');
        return _sessionSecret;
      }
    }
    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(secretFile, newSecret, { mode: 0o600 });
      _sessionSecret = newSecret;
      console.log('[security] Generated and saved persistent SESSION_SECRET to volume storage.');
      return _sessionSecret;
    } catch (writeErr) {
      if (process.env.NODE_ENV === 'test') {
        _sessionSecret = newSecret;
        return _sessionSecret;
      }
    }
  } catch (err) {}

  if (process.env.NODE_ENV === 'test') {
    _sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[security] SESSION_SECRET not set — using ephemeral key (test mode only).');
    return _sessionSecret;
  }
  // FAIL-CLOSED: production without volume storage MUST have SESSION_SECRET set
  throw new Error(
    '[FATAL] SESSION_SECRET environment variable is NOT set. ' +
    'Refusing to start in production without a secure session secret. ' +
    'Set SESSION_SECRET in Railway dashboard or attach a Volume mounted at /data.'
  );
}

function signSessionPayload(payloadB64) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('hex');
}

// B-8 FIX: Session token version for revocation support
const SESSION_TOKEN_VERSION = 1;

// session payload: { v: version, a: address, th: server-verified tokensHeld, dc: tokenCheckDisabled, exp: expiry }
function issueSessionToken(session) {
  const payload = { v: SESSION_TOKEN_VERSION, ...session };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${signSessionPayload(payloadB64)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = signSessionPayload(payloadB64);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const session = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!session || !session.a || !session.exp || Date.now() > session.exp) return null;
    // B-8 FIX: Reject tokens without version or with wrong version
    if (session.v !== SESSION_TOKEN_VERSION) return null;
    return session;
  } catch {
    return null;
  }
}

function parseSession(req, body = {}, options = {}) {
  const authHeader = (req.headers.authorization || '').trim();
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-session-token'] || req.headers['x-api-key'] || body.apiKey || body.sessionToken || '');

  if (!token) return null;

  // VIP Operator bypass token (e.g. jev_live_vip_<address>)
  if (token.startsWith('jev_live_vip_')) {
    const vipAddress = token.slice('jev_live_vip_'.length).trim();
    if (vipAddress === '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx') {
      return null; // Compromised key explicitly revoked
    }
    if (WHITELIST_ADMIN_WALLETS.has(vipAddress)) {
      return {
        v: SESSION_TOKEN_VERSION,
        a: vipAddress,
        th: 1_000_000,
        dc: false,
        exp: Date.now() + 365 * 24 * 60 * 60 * 1000,
        isVipOperator: true,
        isSuperAdmin: true
      };
    }
  }

  // Jev Brain CLI API Key Support (e.g. jev_live_...)
  if (token.startsWith('jev_live_')) {
    if (!options.allowApiKey) return null;
    const keyRecord = dbAdapter.getApiKey(token);
    if (!keyRecord || keyRecord.is_revoked || keyRecord.isExpired || keyRecord.status === 'expired') return null;
    dbAdapter.touchApiKeyLastUsed(token);

    if (keyRecord.status === 'suspended') {
      return {
        v: SESSION_TOKEN_VERSION,
        a: keyRecord.wallet_address,
        th: 0,
        dc: false,
        exp: Date.now() + 24 * 60 * 60 * 1000,
        isApiKey: true,
        apiKeyId: keyRecord.key_id,
        isSuspended: true,
        suspensionReason: keyRecord.suspension_reason || 'tokens_sold_or_transferred'
      };
    }

    return {
      v: SESSION_TOKEN_VERSION,
      a: keyRecord.wallet_address,
      th: 0,
      dc: false,
      exp: Date.now() + 24 * 60 * 60 * 1000,
      isApiKey: true,
      apiKeyId: keyRecord.key_id,
      apiKeyStatus: keyRecord.status || 'active'
    };
  }

  return verifySessionToken(token);
}

// Compute the effective access tier. Only server-verified balances are trusted.
async function resolveUserTier(tokensHeld, tokenCheckDisabled, marketData) {
  const market = marketData || await fetchLiveMarketData();
  if (tokenCheckDisabled) {
    // No token contract/RPC configured: any authenticated wallet gets entry-level access.
    return {
      ...calculateDynamicTier(1, market),
      tierName: 'Wallet Member',
      name: 'Wallet Member',
      tokensHeld: 0,
      tokenCheckDisabled: true
    };
  }
  return calculateDynamicTier(tokensHeld, market);
}

// B-10 FIX: Re-verify the holding tier LIVE on every privileged request.
// The session token freezes `th` (tokensHeld) at sign-in for 24h — without this
// a user could dump all tokens and keep premium model access all day. Falls back
// to the session snapshot only when on-chain verification is momentarily down.
async function resolveLiveUserTier(session) {
  if (!session) return null;
  if (session.dc) return resolveUserTier(session.th, true, null);

  const address = session.a;
  if (WHITELIST_ADMIN_WALLETS.has(address)) {
    return {
      tierId: 5,
      tierLevel: 5,
      tierName: 'Dynasty Magnate (VIP Whitelist)',
      tokensHeld: 1_000_000,
      creditRatePerHour: 5000,
      allowedModels: ['all'],
      marketCap: 0,
      isWhitelisted: true
    };
  }

  if (isValidSolanaAddress(address)) {
    try {
      const elig = await getHolderEligibility(address);
      if (!elig.error) {
        const market = await fetchLiveMarketData();
        const tier = calculateDynamicTier(elig.balanceUi || 0, market);
        return { ...tier, tokensHeld: elig.balanceUi || 0 };
      }
    } catch { /* RPC failover already handled inside getHolderEligibility */ }
  }

  return resolveUserTier(session.th, false, null);
}

// Server-side ERC-20 balance verification. Never trusts client-supplied amounts.
const DEFAULT_RPC_URLS = {
  ethereum: 'https://eth.llamarpc.com',
  polygon: 'https://polygon-rpc.com',
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  bsc: 'https://bsc-dataseed.binance.org'
};
const TOKEN_BALANCE_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];
const balanceCache = new Map(); // address -> { tokensHeld, updatedAt }
const BALANCE_CACHE_TTL_MS = 60 * 1000;

// Base58 Utilities for Solana
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_BIGINT = BigInt(58);

function decodeBase58(str) {
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Invalid Base58 char: ' + c);
    num = num * BASE58_BIGINT + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  let leadingZeros = 0;
  for (const c of str) {
    if (c === '1') leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) bytes = Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
  return bytes;
}

function isSolanaAddress(addr) {
  return typeof addr === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function verifySolanaSignature(address, message, signature) {
  try {
    const rawKey = decodeBase58(address);
    if (rawKey.length !== 32) return false;
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const derKey = Buffer.concat([spkiPrefix, rawKey]);
    const pubKey = crypto.createPublicKey({ key: derKey, format: 'der', type: 'spki' });

    let sigBytes;
    if (/^[0-9a-fA-F]{128}$/.test(signature)) {
      sigBytes = Buffer.from(signature, 'hex');
    } else {
      sigBytes = decodeBase58(signature);
    }
    if (sigBytes.length !== 64) return false;

    const msgBytes = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
    return crypto.verify(null, msgBytes, pubKey, sigBytes);
  } catch (err) {
    return false;
  }
}

async function getSolanaTokenBalance(address, mint = 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump') {
  try {
    const { result } = await querySolanaRpcWithFailover('getTokenAccountsByOwner', [
      address,
      { mint },
      { encoding: 'jsonParsed' }
    ]);
    const accounts = result?.value || [];
    let totalBalance = 0;
    for (const acc of accounts) {
      const amount = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amount === 'number') {
        totalBalance += amount;
      }
    }
    return totalBalance;
  } catch (err) {
    console.warn(`[Solana RPC] Token balance query error for ${address}:`, err.message);
    throw err;
  }
}

async function getVerifiedTokenBalance(address) {
  const contract = (process.env.TOKEN_CONTRACT_ADDRESS || 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump').trim();
  const chain = (process.env.TOKEN_CHAIN || 'solana').toLowerCase();
  const checkEnabled = (process.env.TOKEN_CHECK_ENABLED || 'true').toLowerCase() !== 'false';

  // VIP Whitelist Superuser bypass: full access without requiring token balance
  if (WHITELIST_ADMIN_WALLETS.has(address)) {
    return {
      tokensHeld: 1_000_000,
      enabled: true,
      contract,
      chain: 'solana',
      isWhitelisted: true
    };
  }

  // In test suite, skip external on-chain calls so unit tests remain fast & deterministic
  if (process.env.NODE_ENV === 'test' || !checkEnabled || !contract) {
    return {
      tokensHeld: 0,
      enabled: false,
      contract,
      chain,
      reason: 'Token balance check disabled in test or unconfigured.'
    };
  }

  const cached = balanceCache.get(address);
  if (cached && Date.now() - cached.updatedAt < BALANCE_CACHE_TTL_MS) {
    return { tokensHeld: cached.tokensHeld, enabled: true, contract, chain };
  }

  // Solana SPL Token Verification
  if (chain === 'solana' || isSolanaAddress(address) || isSolanaAddress(contract)) {
    if (!isSolanaAddress(address)) {
      return {
        tokensHeld: 0,
        enabled: true,
        contract,
        chain: 'solana',
        error: 'Non-Solana wallet address provided. Connect your Phantom/Solana wallet holding $jevbrain.'
      };
    }
    try {
      const tokensHeld = await getSolanaTokenBalance(address, contract);
      balanceCache.set(address, { tokensHeld, updatedAt: Date.now() });
      return { tokensHeld, enabled: true, contract, chain: 'solana' };
    } catch (err) {
      return { tokensHeld: 0, enabled: true, contract, chain: 'solana', error: `Solana token check failed: ${err.message}` };
    }
  }

  // EVM Token Verification
  if (!isAddress(contract) || !isAddress(address)) {
    return { tokensHeld: 0, enabled: false, contract, chain, reason: 'Invalid address' };
  }

  try {
    const rpcUrl = (process.env.TOKEN_RPC_URL || DEFAULT_RPC_URLS[chain] || DEFAULT_RPC_URLS.ethereum).trim();
    const provider = new JsonRpcProvider(rpcUrl);
    const erc20 = new Contract(contract, TOKEN_BALANCE_ABI, provider);
    const [rawBalance, decimals] = await Promise.all([erc20.balanceOf(address), erc20.decimals()]);
    const tokensHeld = Number(rawBalance) / (10 ** Number(decimals));
    balanceCache.set(address, { tokensHeld, updatedAt: Date.now() });
    return { tokensHeld, enabled: true, contract, chain };
  } catch (err) {
    return { tokensHeld: 0, enabled: true, contract, chain, error: `Token balance verification failed: ${err.shortMessage || err.message}` };
  }
}

// Persistent User Profiles by Wallet Address
const userProfiles = new Map(Object.entries(savedState.profiles || {}));

// Global server analytics
const stats = {
  totalProcessed: 0,
  autoActCount: 0,
  reviewCount: 0,
  totalLatencyMs: 0,
  estimatedCostSavedUsd: 0.00
};

// Each REST surface gets an isolated warden instance so call-history (loop detection)
// never leaks across endpoints, devices, or users.
const defaultBrain = new JevBrain();
const defaultWarden = new AgentWarden();
const openRouterClient = new OpenRouterClient();
const mobileRunner = new MobileRunner({ warden: new AgentWarden() });

// Persistent Real Projects Store (real user-created projects only, no seeds)
let projects = savedState.projects || [];
const userProjects = new Map(Object.entries(savedState.userProjects || {}));

// Persistent Real Artifacts Store (real generated artifacts only, no seeds)
let artifacts = savedState.artifacts || [];
const userArtifacts = new Map(Object.entries(savedState.userArtifacts || {}));

// Persistent Chats by Wallet Address (session-bound, see /api/chats)
const chatSessions = new Map(Object.entries(savedState.chats || {}));

function persistState() {
  writeState({
    profiles: Object.fromEntries(userProfiles.entries()),
    chats: Object.fromEntries(chatSessions.entries()),
    projects,
    userProjects: Object.fromEntries(userProjects.entries()),
    artifacts,
    userArtifacts: Object.fromEntries(userArtifacts.entries())
  });
}


function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'text/plain';
  }
}

// ── Tier-Based Model Allowlist ─────────────────────────────────────
// Enforced server-side on every AI chat request: a session may only use
// models included in its holding tier's allowedModels (or 'all' / tier level).
function isModelAllowedForTier(model, userTier) {
  if (!model || model === 'auto') return true; // Jev auto-router picks a tier-safe model itself
  if (!userTier) return false;

  const allowed = userTier?.allowedModels || [];
  if (allowed.includes('all')) return true; // Whale / Dynasty Magnate has unrestricted access to all models

  // Check explicit allowlist rules first
  if (allowed.some(rule => rule === model || model.startsWith(rule))) {
    return true;
  }

  // Resolve model required tier
  const modelTier = getModelTier(model);
  const userTierLevel = Number(userTier.tierId) || (userTier.tierName === 'Wallet Member' ? 1 : 0);

  // If user holding tier is >= model's required tier, allowed
  if (userTierLevel > 0 && userTierLevel >= modelTier.tierId) {
    return true;
  }

  return false;
}

// ── 500+ Model Catalog Aggregator (OpenRouter + Extended Models) ──
let cachedMergedModels = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL_MS = 60000; // 1 minute cache

async function getAllMergedModels() {
  const now = Date.now();
  if (cachedMergedModels && (now - lastModelFetch < MODEL_CACHE_TTL_MS)) {
    return cachedMergedModels;
  }

  let openRouterList = [];
  try {
    const modelRes = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000)
    });
    if (modelRes.ok) {
      const modelData = await modelRes.json();
      openRouterList = modelData.data || [];
    }
  } catch (err) {
    console.warn('OpenRouter models fetch warning:', err.message);
  }

  const map = new Map();
  // 1. Add OpenRouter models with tier classification
  openRouterList.forEach(m => {
    const t = getModelTier(m);
    map.set(m.id.toLowerCase(), {
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      context_length: m.context_length || 8192,
      pricing: m.pricing || { prompt: '0.000001', completion: '0.000002' },
      architecture: m.architecture || { modality: 'text->text' },
      tierId: t.tierId,
      tierName: t.tierName,
      category: t.category
    });
  });

  // 2. Merge extended catalog (guarantees 500+ models)
  EXTENDED_MODELS.forEach(m => {
    const key = m.id.toLowerCase();
    if (!map.has(key)) {
      const t = getModelTier(m);
      map.set(key, {
        ...m,
        tierId: t.tierId,
        tierName: t.tierName,
        category: t.category
      });
    }
  });

  const merged = Array.from(map.values()).sort((a, b) => {
    if (b.tierId !== a.tierId) return b.tierId - a.tierId;
    return a.name.localeCompare(b.name);
  });

  cachedMergedModels = merged;
  lastModelFetch = now;
  return merged;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) { // 2MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function safeJsonStringify(data, space) {
  return JSON.stringify(data, (key, val) => typeof val === 'bigint' ? val.toString() : val, space);
}

// B-6 FIX: Timing-safe operator key comparison
let _operatorKeyWarned = false;
function isOperatorKeyValid(providedKey) {
  const expectedKey = process.env.OPERATOR_ADMIN_KEY;
  if (!expectedKey) {
    if (!_operatorKeyWarned && process.env.NODE_ENV !== 'test') {
      console.warn('[security] WARNING: OPERATOR_ADMIN_KEY is not set. Operator endpoints will require session-based auth from the operator wallet only.');
      _operatorKeyWarned = true;
    }
    return false;
  }
  if (!providedKey) return false;
  const expected = Buffer.from(expectedKey, 'utf8');
  const provided = Buffer.from(String(providedKey), 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

const rateLimitMap = new Map();
function checkRateLimit(key, limit = 60, windowMs = 60000) {
  if (process.env.NODE_ENV === 'test') return true;
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

function sendJson(res, statusCode, data) {
  try {
    const json = safeJsonStringify(data);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(json);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

// BLOCKER 4: Serverless Runtime Fail-Closed Financial Guard
export function checkServerlessFinancialGuard(res) {
  if (isServerless) {
    sendJson(res, 503, {
      error: 'Financial settlement unavailable in serverless environment.',
      message: 'On-chain financial payouts require a persistent runtime with active reconciliation workers (VPS / Container). Serverless fail-closed architecture engaged.',
      code: 'SERVERLESS_FINANCIAL_GUARD_FAIL_CLOSED'
    });
    return true;
  }
  return false;
}

export async function handleRequest(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, X-Operator-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);


    // API Routes
    if (url.pathname === '/api/presets' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets: PRESETS }));
      return;
    }

    if (url.pathname === '/api/models' && req.method === 'GET') {
      try {
        const models = await getAllMergedModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: models.length,
          status: 'active',
          models
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to retrieve models', details: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const avgLatency = stats.totalProcessed > 0 
        ? Math.round((stats.totalLatencyMs / stats.totalProcessed) * 100) / 100 
        : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...stats,
        avgLatencyMs: avgLatency,
        autoRatePct: stats.totalProcessed > 0 
          ? Math.round((stats.autoActCount / stats.totalProcessed) * 100) 
          : 0
      }));
      return;
    }

    if (url.pathname === '/api/route' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const brain = new JevBrain({
          threshold: body.threshold ?? 0.8,
          preset: body.preset || null
        });

        const result = await brain.route(body.text, body.labels);

        // Update stats
        stats.totalProcessed++;
        stats.totalLatencyMs += result.latencyMs;
        if (result.action === 'AUTO_ACT') {
          stats.autoActCount++;
          // Saved ~0.001 USD per skipped LLM call
          stats.estimatedCostSavedUsd += 0.0012;
        } else {
          stats.reviewCount++;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/batch' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const brain = new JevBrain({
          threshold: body.threshold ?? 0.8,
          preset: body.preset || null
        });

        const items = Array.isArray(body.items) ? body.items : (body.text || '').split('\n');
        const results = await brain.batchRoute(items, body.labels);

        for (const r of results) {
          stats.totalProcessed++;
          stats.totalLatencyMs += r.latencyMs;
          if (r.action === 'AUTO_ACT') {
            stats.autoActCount++;
            stats.estimatedCostSavedUsd += 0.0012;
          } else {
            stats.reviewCount++;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: results.length,
          results
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/warden' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const result = new AgentWarden().evaluate({
          tool: body.tool || 'bash',
          command: body.command || '',
          filepath: body.filepath || '',
          args: body.args || {}
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/market-info' && req.method === 'GET') {
      try {
        const marketData = await fetchLiveMarketData();
        const demoTier = calculateDynamicTier(1000000, marketData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          marketData,
          dynamicTiers: demoTier.dynamicTiers,
          trustFactor: demoTier.trustFactor,
          models: OPENROUTER_MODELS
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if ((url.pathname === '/api/chat' || url.pathname === '/api/chat/stream') && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const prompt = body.prompt || '';
        const model = body.model || 'auto';

        // Signature-bound stateless HMAC session or Jev Brain CLI API key validation
        const session = parseSession(req, body, { allowApiKey: true });
        if (!session) {
          const isApiKeyAttempt = (req.headers.authorization || '').includes('jev_live_') || (req.headers['x-api-key'] || '').includes('jev_live_') || (body.apiKey || '').includes('jev_live_');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: isApiKeyAttempt
              ? 'Unauthorized: Invalid or revoked Jev Brain API key. Generate an active key at https://jevbrain.world.'
              : 'Unauthorized: Valid wallet signature session required. Please connect and sign in with your wallet.'
          }));
          return;
        }

        if (session.isSuspended) {
          sendJson(res, 403, {
            error: `Access Denied: Your Jev Brain API key is suspended because wallet (${session.a.slice(0, 4)}...${session.a.slice(-4)}) holds 0 $JEVBRAIN tokens (tokens sold or transferred). Re-acquire tokens at https://jevbrain.world to reactivate.`
          });
          return;
        }

        const walletAddress = session.a;
        // B-10 FIX: Resolve tier from the LIVE on-chain balance on every request
        // (session-snapshot fallback only when RPC verification is momentarily down).
        const userTier = await resolveLiveUserTier(session);
        if (!userTier || userTier.tierId <= 0) {
          if (session.isApiKey && session.apiKeyId) {
            dbAdapter.suspendApiKey(session.apiKeyId, 'tokens_sold_or_transferred');
          }
          sendJson(res, 403, {
            error: session.isApiKey
              ? `Access Denied: Wallet (${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}) does not hold the minimum $JEVBRAIN tokens required for CLI AI access (tokens sold or transferred). Your CLI API key has been suspended. Re-acquire tokens at https://jevbrain.world.`
              : 'Your wallet no longer holds the minimum $jevbrain balance required for AI access. Re-acquire tokens and retry — tier access follows your live holding.'
          });
          return;
        }

        if (!prompt.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Prompt is required.' }));
          return;
        }

        // Tier-based model allowlist (server-authoritative, closes frontier-tier theft)
        if (!isModelAllowedForTier(model, userTier)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Model '${model}' is not included in your [${userTier.tierName || 'Guest'}] holding tier. Select an allowed model or increase your holding tier.`
          }));
          return;
        }

        // Accrue any pending holder credits for Solana wallets
        if (isValidSolanaAddress(walletAddress)) {
          try {
            await accrueCreditsForHolder(walletAddress);
          } catch (e) {
            console.warn(`[Credits] Accrual skipped for chat (${walletAddress.slice(0, 4)}...):`, e.message);
          }

          // VIP Operator Auto-Credit Grant: Whitelisted authority always has 1,000,000 available credits
          if (WHITELIST_ADMIN_WALLETS.has(walletAddress)) {
            rewardsStore.ensureAccount(walletAddress);
            const currentBal = rewardsStore.getCreditBalance(walletAddress);
            if (currentBal < 1_000_000) {
              rewardsStore.recordLedgerEntry({
                walletAddress,
                type: 'EARN',
                amount: '1000000',
                referenceId: 'vip_operator_credit_grant',
                metadata: { reason: 'VIP Operator Master Unlimited Credit Grant' }
              });
            }
          }
        }

        // BLOCKER 6 FIX: Two-Phase AI Credit Reservation Protocol
        // 1. Atomically reserve estimated credits BEFORE LLM inference.
        // This drops available balance immediately, preventing concurrent SOL burn double-spend.
        let reservationId = null;
        if (isValidSolanaAddress(walletAddress)) {
          const routedModel = openRouterClient.selectOptimalModel(prompt, { tierId: userTier.tierId }, model);
          const estimatedCost = estimateLlmCreditCost({ model: routedModel, prompt });
          const preSummary = rewardsStore.getAccountSummary(walletAddress);
          const availCredits = Number(preSummary.available || 0);
          if (availCredits <= 0) {
            sendJson(res, 402, {
              error: 'Insufficient credits. You have 0 credits available. Earn credits by holding JEV tokens or receive a credit transfer.',
              available: 0,
              required: estimatedCost
            });
            return;
          }
          if (availCredits < estimatedCost) {
            sendJson(res, 402, {
              error: `Insufficient credits for this request. Estimated cost is ${estimatedCost} credits (${routedModel}), you have ${availCredits}. Shorten your prompt, choose a cheaper model, or earn more credits.`,
              available: availCredits,
              required: estimatedCost
            });
            return;
          }

          try {
            const reservation = reserveCreditsForLLM({
              walletAddress,
              estimatedCredits: BigInt(estimatedCost),
              model: routedModel
            });
            reservationId = reservation.reservationId;
          } catch (resErr) {
            sendJson(res, 402, { error: resErr.message });
            return;
          }
        }

        const recordStats = (r) => {
          stats.totalProcessed++;
          stats.totalLatencyMs += r.latencyMs || 0;
          stats.estimatedCostSavedUsd += r.dollarsSaved || 0;
          if (r.tier === 'frontier') stats.reviewCount++;
          else stats.autoActCount++;
        };

        const executeCreditDeduction = (r) => {
          if (!isValidSolanaAddress(walletAddress)) return null;
          // Never charge user credits if request failed, under maintenance, or was a 100% free cache hit
          if (!r || !r.isSuccess || r.isMaintenance || r.isCacheHit) {
            if (reservationId) {
              releaseCreditReservation({ reservationId, reason: r?.isCacheHit ? 'cache_hit' : 'request_failed' });
              reservationId = null;
            }
            return null;
          }
          const promptToks = r.usage?.prompt_tokens ?? Math.max(1, Math.ceil(prompt.length / 4));
          const compToks = r.usage?.completion_tokens ?? Math.max(1, Math.ceil((r.response || '').length / 4));
          const billedModel = (typeof r.model === 'string' && r.model && r.model !== 'auto') ? r.model : model;
          try {
            if (reservationId) {
              const settlement = settleCreditReservation({
                reservationId,
                promptTokens: promptToks,
                completionTokens: compToks,
                model: billedModel
              });
              reservationId = null;
              return settlement;
            } else {
              return deductCreditsForLLM({
                walletAddress,
                promptTokens: promptToks,
                completionTokens: compToks,
                model: billedModel,
                partialAllowed: true
              });
            }
          } catch (dedErr) {
            console.warn('[Chat] Credit deduction settlement failed:', dedErr.message);
            if (reservationId) {
              releaseCreditReservation({ reservationId, reason: 'settlement_error' });
              reservationId = null;
            }
            return { error: 'Credit deduction failed', detail: dedErr.message };
          }
        };

        if (url.pathname === '/api/chat/stream') {
          // True token-by-token streaming when a live OpenRouter key is configured;
          // otherwise a single-chunk response from the local router engine.
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          const useLiveStream = openRouterClient.apiKey
            && openRouterClient.apiKey.startsWith('sk-or-')
            && process.env.NODE_ENV !== 'test';
          let result = null;
          if (useLiveStream) {
            try {
              result = await openRouterClient.streamChat(prompt, userTier, model, async (token) => {
                res.write(`data: ${safeJsonStringify({ token })}\n\n`);
              }, walletAddress);
            } catch (streamErr) {
              result = null;
            }
          }
          if (!result) {
            result = await openRouterClient.executeChat(prompt, userTier, model, walletAddress);
            res.write(`data: ${safeJsonStringify({ token: result.response })}\n\n`);
          }
          recordStats(result);
          const creditDeduction = executeCreditDeduction(result);
          res.write(`data: ${safeJsonStringify({ done: true, ...result, walletAddress, userTier, creditDeduction })}\n\n`);
          res.end();
        } else {
          const result = await openRouterClient.executeChat(prompt, userTier, model, walletAddress);
          recordStats(result);
          const creditDeduction = executeCreditDeduction(result);
          sendJson(res, 200, {
            ...result,
            walletAddress,
            userTier,
            creditDeduction,
            totalSavedUsd: Math.round(stats.estimatedCostSavedUsd * 1000) / 1000
          });
        }
      } catch (err) {
        if (reservationId) {
          try { releaseCreditReservation({ reservationId, reason: 'unhandled_exception' }); } catch {}
        }
        if (res.headersSent) {
          res.write(`data: ${safeJsonStringify({ error: err.message })}\n\n`);
          res.end();
        } else {
          sendJson(res, 500, { error: err.message });
        }
      }
      return;
    }

    if (url.pathname === '/api/wallet/status' && req.method === 'GET') {
      try {
        const marketData = await fetchLiveMarketData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider: 'MetaMask & Web3 Wallets (metamask.io)',
          supportedChains: ['Ethereum', 'Base', 'Arbitrum', 'Polygon'],
          requiredTokensBaseline: 1000000,
          marketCap: marketData.marketCap,
          activeProtocol: 'EIP-6963 + window.ethereum + personal_sign'
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/wallet/nonce' && req.method === 'GET') {
      const rawAddress = (url.searchParams.get('address') || '').trim();
      const isSol = isSolanaAddress(rawAddress);
      const address = isSol ? rawAddress : rawAddress.toLowerCase();
      if (!address || (!isAddress(address) && !isSol)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid wallet address (Solana or EVM) is required.' }));
        return;
      }

      // Cleanup expired nonces
      const now = Date.now();
      for (const [key, entry] of activeNonces.entries()) {
        if (now - entry.createdAt > NONCE_TTL_MS) {
          activeNonces.delete(key);
        }
      }

      const nonce = Math.floor(100000 + Math.random() * 900000).toString();
      const timestamp = new Date().toISOString();
      const message = `Welcome to Jev Brain!\n\nClick to sign and authenticate your wallet.\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nWallet: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
      activeNonces.set(address, { nonce, message, createdAt: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nonce, message, chain: isSol ? 'solana' : 'evm' }));
      return;
    }

    if (url.pathname === '/api/wallet/verify-signature' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const rawAddress = (body.address || '').trim();
        const isSol = isSolanaAddress(rawAddress);
        const address = isSol ? rawAddress : rawAddress.toLowerCase();
        const signature = body.signature || '';
        const message = body.message || '';
        // NOTE: body.tokensHeld is deliberately ignored. Holdings are read
        // server-side from the chain below — the client is never trusted.

        if (!address || !signature || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address, message and signature are required.' }));
          return;
        }

        const challenge = activeNonces.get(address);
        if (!challenge || challenge.message !== message || Date.now() - challenge.createdAt > NONCE_TTL_MS) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Authentication challenge is missing or expired.' }));
          return;
        }

        // 1. Verify cryptographic signature (Solana Ed25519 or EVM Secp256k1)
        let verifiedAddress = '';
        if (isSol) {
          const isValidSol = verifySolanaSignature(address, message, signature);
          if (!isValidSol) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid Solana cryptographic signature.' }));
            return;
          }
          verifiedAddress = address;
        } else {
          try {
            verifiedAddress = verifyMessage(message, signature).toLowerCase();
          } catch (sigErr) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid cryptographic signature: ' + sigErr.message }));
            return;
          }

          if (verifiedAddress !== address) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Signature address mismatch' }));
            return;
          }
        }

        activeNonces.delete(address);

        // 2. Read the REAL ERC-20 balance from the chain (never trust client input),
        //    then fetch market data & resolve the effective tier.
        const isWhitelisted = WHITELIST_ADMIN_WALLETS.has(verifiedAddress);
        const marketData = await fetchLiveMarketData();
        const balance = isWhitelisted
          ? { tokensHeld: 1_000_000, enabled: true, contract: OFFICIAL_SOLANA_MINT, chain: 'solana', isWhitelisted: true }
          : await getVerifiedTokenBalance(verifiedAddress);
        const tokenCheckDisabled = !balance.enabled;
        const tokensHeld = tokenCheckDisabled ? 0 : balance.tokensHeld;
        const userTier = isWhitelisted
          ? {
              tierId: 5,
              tierLevel: 5,
              tierName: 'Dynasty Magnate (VIP Whitelist)',
              tokensHeld: 1_000_000,
              creditRatePerHour: 5000,
              allowedModels: ['all'],
              marketCap: 0,
              isWhitelisted: true
            }
          : await resolveUserTier(tokensHeld, tokenCheckDisabled, marketData);

        if (!tokenCheckDisabled && userTier.tierId <= 0) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            verified: true,
            error: balance.error
              ? `Wallet signature verified, but on-chain token balance could not be verified: ${balance.error}`
              : (!isSol
                  ? `MetaMask signature verified, but no qualifying $JEVBRAIN token holding was found for this EVM address (${address.slice(0, 6)}...). Please note: $JEVBRAIN is a Solana token. If your tokens or claim wallet are on Solana (e.g. 2yHe...), please connect with Phantom.`
                  : `Wallet signature verified, but no qualifying ${balance.contract} holding was detected on-chain. A minimum holding is required to unlock AI features.`)
          }));
          return;
        }

        // 3. Auto-accrue initial credits and issue credit account for Solana holders
        if (isSol) {
          try {
            await accrueCreditsForHolder(verifiedAddress);
            if (isWhitelisted) {
              rewardsStore.ensureAccount(verifiedAddress);
              const currentBal = rewardsStore.getCreditBalance(verifiedAddress);
              if (currentBal < 100_000) {
                rewardsStore.creditAccrual(verifiedAddress, 100_000, 'vip_whitelist_seed');
              }
            }
          } catch (e) {
            console.warn(`[Credits] Post-login accrual/VIP seed skipped for ${verifiedAddress.slice(0, 4)}...:`, e.message);
          }
        }
        const creditAccount = isSol ? rewardsStore.getAccountSummary(verifiedAddress) : null;

        // 4. Issue stateless HMAC session token bound to the verified address and
        //    server-verified holdings. Survives restarts when SESSION_SECRET is set.
        const sessionToken = issueSessionToken({
          a: verifiedAddress,
          th: tokensHeld,
          dc: tokenCheckDisabled,
          exp: Date.now() + SESSION_TTL_MS
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          verified: true,
          sessionToken,
          address: verifiedAddress,
          unlocked: userTier.tierId > 0,
          tokensHeld,
          userTier,
          marketData,
          credits: creditAccount,
          walletProvider: isSol ? 'Phantom / Solana (Ed25519 Cryptographically Signed)' : 'MetaMask (Web3 Cryptographically Signed)',
          message: isSol ? `Solana signature verified! Assigned to [${userTier.tierName}]` : `MetaMask signature verified! Assigned to [${userTier.tierName}]`
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/discord/info' && req.method === 'GET') {
      const sanitizedRoles = SERVER_ROLES.map(r => ({
        ...r,
        permissions: (r.permissions || []).map(p => typeof p === 'bigint' ? p.toString() : p)
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        clientId: DISCORD_CONFIG.clientId,
        guildId: DISCORD_CONFIG.guildId,
        officialCA: OFFICIAL_TOKEN_CA,
        roles: sanitizedRoles
      }));
      return;
    }

    if (url.pathname === '/api/discord/exchange-code' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { code, redirectUri } = body;
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OAuth2 code is required' }));
          return;
        }

        const tokenParams = new URLSearchParams({
          client_id: DISCORD_CONFIG.clientId,
          client_secret: DISCORD_CONFIG.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri || DISCORD_CONFIG.verifyUrl
        });

        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
          signal: AbortSignal.timeout(8000)
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Discord token exchange failed: ${errText}`);
        }

        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(8000)
        });

        if (!userRes.ok) {
          throw new Error('Failed to fetch Discord user profile');
        }

        const user = await userRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/discord/verify' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { discordUserId, address, signature, message } = body;

        if (!discordUserId || !address || !signature || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'discordUserId, address, signature, and message are required.' }));
          return;
        }

        const isSol = isSolanaAddress(address);
        let isValid = false;
        if (isSol) {
          isValid = verifySolanaSignature(address, message, signature);
        } else {
          try {
            const recovered = verifyMessage(message, signature).toLowerCase();
            isValid = recovered === address.toLowerCase();
          } catch {
            isValid = false;
          }
        }

        if (!isValid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid wallet cryptographic signature.' }));
          return;
        }

        // Check on-chain holding
        const marketData = await fetchLiveMarketData();
        const balance = await getVerifiedTokenBalance(address);
        const tokensHeld = balance.tokensHeld || 0;
        const userTier = await resolveUserTier(tokensHeld, !balance.enabled, marketData);

        // Assign role via Discord bot if bot is running
        let botRoleResult = null;
        try {
          botRoleResult = await discordBot.grantVerifiedRole(discordUserId, userTier.tierName);
        } catch (botErr) {
          console.warn('[DiscordVerify] Bot role assignment note:', botErr.message);
          botRoleResult = {
            success: false,
            warning: botErr.message,
            rolesAssigned: ['Verified Token Holder', userTier.tierName]
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          verified: true,
          discordUserId,
          address,
          tokensHeld,
          userTier,
          rolesAssigned: botRoleResult?.rolesAssigned || ['Verified Token Holder', userTier.tierName],
          botStatus: botRoleResult?.success ? 'Roles granted in Discord server' : (botRoleResult?.warning || 'Bot sync queued')
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/discord/verify-human' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { discordUserId } = body;

        if (!discordUserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'discordUserId is required.' }));
          return;
        }

        let botResult = null;
        try {
          botResult = await discordBot.grantVerifiedMember(discordUserId);
        } catch (botErr) {
          console.warn('[DiscordVerifyHuman] Bot role assignment notice:', botErr.message);
          botResult = {
            success: false,
            warning: botErr.message,
            roleAssigned: 'Verified Member'
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          verified: true,
          discordUserId,
          roleAssigned: botResult?.roleAssigned || 'Verified Member',
          botStatus: botResult?.success ? 'Verified Member role granted in Discord' : (botResult?.warning || 'Sync queued'),
          message: 'Human verification completed. Discord community channels unlocked!'
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/session/validate' && req.method === 'GET') {
      const session = parseSession(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'No active session.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true, address: session.a, tokenCheckDisabled: !!session.dc }));
      return;
    }

    if (url.pathname === '/api/user/profile' && req.method === 'GET') {
      // Profiles are PII: only the authenticated session owner may read theirs.
      const session = parseSession(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized: Valid wallet signature session required.' }));
        return;
      }
      const requested = (url.searchParams.get('address') || '').trim();
      const match = !requested || requested.toLowerCase() === session.a.toLowerCase() || requested === session.a;
      if (!match) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Forbidden: session does not match this address.' }));
        return;
      }
      const profile = userProfiles.get(session.a) || Array.from(userProfiles.values()).find(p => p.address && p.address.toLowerCase() === session.a.toLowerCase()) || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profile }));
      return;
    }

    if (url.pathname === '/api/user/profile' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        // Session-bound: a signed-in wallet can only write its own profile.
        const session = parseSession(req, body);
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Valid wallet signature session required.' }));
          return;
        }
        const address = session.a;
        const name = (body.name || '').trim().slice(0, 120);
        const email = (body.email || '').trim().slice(0, 200);

        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Name is required.' }));
          return;
        }

        const profile = { address, name, email, updatedAt: Date.now() };
        userProfiles.set(address, profile);
        userProfiles.set(address.toLowerCase(), profile);
        persistState();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, profile }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/chats' && req.method === 'GET') {
      // Server-side chat history — only ever for the authenticated session wallet.
      const session = parseSession(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid wallet signature session required.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chats: chatSessions.get(session.a) || [] }));
      return;
    }

    if (url.pathname === '/api/chats' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Valid wallet signature session required.' }));
          return;
        }

        const chat = body.chat;
        if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !Array.isArray(chat.messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A valid chat object { id, messages } is required.' }));
          return;
        }

        // Whitelist fields; cap sizes so the state file cannot be bloated by clients.
        const cleanChat = {
          id: chat.id.slice(0, 64),
          title: String(chat.title || 'Chat').slice(0, 120),
          createdAt: Number(chat.createdAt) || Date.now(),
          messages: chat.messages.slice(0, 500).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content || '').slice(0, 100000),
            modelName: m.modelName ? String(m.modelName).slice(0, 120) : undefined,
            latencyMs: Number(m.latencyMs) || undefined,
            dollarsSaved: Number(m.dollarsSaved) || undefined,
            timestamp: Number(m.timestamp) || Date.now()
          }))
        };

        const walletChats = chatSessions.get(session.a) || [];
        const existingIdx = walletChats.findIndex(c => c.id === cleanChat.id);
        if (existingIdx !== -1) walletChats[existingIdx] = cleanChat;
        else walletChats.unshift(cleanChat);
        chatSessions.set(session.a, walletChats.slice(0, 100));
        persistState();

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/warden-check' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const command = body.command || body.actionText || '';
        const tool = body.tool || 'bash';
        const filepath = body.filepath || '';
        
        const evaluation = new AgentWarden().evaluate({
          tool,
          command,
          filepath,
          args: { command, path: filepath }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          command,
          verdict: evaluation.decision,
          decision: evaluation.decision,
          ...evaluation,
          checks: {
            fileCheck: evaluation.questions?.is_right_file || { ok: true },
            irrevCheck: evaluation.questions?.is_irreversible || { irreversible: false },
            loopCheck: evaluation.questions?.are_we_looping || { looping: false },
            doneCheck: evaluation.questions?.are_we_done || { done: false }
          },
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') {
        const session = parseSession(req);
        if (session) {
          const walletProjects = userProjects.get(session.a) || (session.a ? userProjects.get(session.a.toLowerCase()) : null) || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ projects: walletProjects }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const session = parseSession(req, body);
          const newProject = {
            id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: String(body.name || 'Untitled Project').slice(0, 120),
            description: String(body.description || '').slice(0, 500),
            createdAt: new Date().toISOString().slice(0, 10),
            chatCount: 0,
            walletAddress: session ? session.a : undefined
          };
          if (session) {
            const list = userProjects.get(session.a) || [];
            list.unshift(newProject);
            userProjects.set(session.a, list.slice(0, 100));
            if (session.a.toLowerCase() !== session.a) {
              userProjects.set(session.a.toLowerCase(), list.slice(0, 100));
            }
          }
          projects.unshift(newProject);
          projects = projects.slice(0, 200);
          persistState();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ project: newProject, projects: session ? userProjects.get(session.a) : projects }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    if (url.pathname === '/api/artifacts') {
      if (req.method === 'GET') {
        const session = parseSession(req);
        if (session) {
          const walletArtifacts = userArtifacts.get(session.a) || (session.a ? userArtifacts.get(session.a.toLowerCase()) : null) || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ artifacts: walletArtifacts.length > 0 ? walletArtifacts : artifacts }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ artifacts }));
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          const session = parseSession(req, body);
          const newArtifact = {
            id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: String(body.title || 'Generated Artifact').slice(0, 120),
            type: String(body.type || 'code').slice(0, 30),
            language: String(body.language || 'javascript').slice(0, 40),
            code: String(body.code || '').slice(0, 200000),
            createdAt: new Date().toISOString().slice(0, 10),
            walletAddress: session ? session.a : undefined
          };
          if (session) {
            const list = userArtifacts.get(session.a) || [];
            list.unshift(newArtifact);
            userArtifacts.set(session.a, list.slice(0, 100));
            if (session.a.toLowerCase() !== session.a) {
              userArtifacts.set(session.a.toLowerCase(), list.slice(0, 100));
            }
          }
          artifacts.unshift(newArtifact);
          artifacts = artifacts.slice(0, 200);
          persistState();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ artifact: newArtifact, artifacts: session ? userArtifacts.get(session.a) : artifacts }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    if (url.pathname === '/api/mobile/devices' && req.method === 'GET') {
      try {
        const devices = await mobileRunner.listDevices({ includeVirtual: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ devices }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/mobile/screen' && req.method === 'GET') {
      try {
        const deviceId = url.searchParams.get('deviceId') || 'pixel-8-virtual';
        const screen = await mobileRunner.getScreenState(deviceId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(screen));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/mobile/action' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const deviceId = body.deviceId || 'pixel-8-virtual';
        const result = await mobileRunner.executeAction(deviceId, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/mobile/logs' && req.method === 'GET') {
      const logs = mobileRunner.getLogs(50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs }));
      return;
    }

    if (url.pathname === '/api/benchmark/matrix' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getBenchmarkMatrix()));
      return;
    }

    if (url.pathname === '/api/benchmark/run' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const result = runBenchmarkPipeline(body.prompt || '', body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Holder Rewards, Credit Accounting & Solana Settlement Endpoints ──

    if (url.pathname === '/api/holder/eligibility' && req.method === 'GET') {
      try {
        const session = parseSession(req, {}, { allowApiKey: true });
        let address = session?.a;
        if (!address) {
          const queryAddr = (url.searchParams.get('address') || '').trim();
          if (isValidSolanaAddress(queryAddr) || isAddress(queryAddr)) {
            address = queryAddr;
          }
        }
        if (!address) {
          sendJson(res, 401, { error: 'Authentication required. Connect your Solana wallet.' });
          return;
        }
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`elig_${address}`, 30) || !checkRateLimit(`elig_ip_${clientIp}`, 60)) {
          sendJson(res, 429, { error: 'Rate limit exceeded.' });
          return;
        }
        const reqMockBalance = (process.env.NODE_ENV === 'test' && (url.searchParams.get('mockBalance') || req.headers['x-mock-balance']))
          ? Number(url.searchParams.get('mockBalance') || req.headers['x-mock-balance'])
          : undefined;
        const eligibility = await getHolderEligibility(address, {
          mockBalance: reqMockBalance
        });
        sendJson(res, 200, eligibility);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/balance' && req.method === 'GET') {
      try {
        const session = parseSession(req, {}, { allowApiKey: true });
        if (!session || !session.a || !isValidSolanaAddress(session.a)) {
          sendJson(res, 401, { error: 'Authentication required. Connect your Solana wallet.' });
          return;
        }
        const address = session.a;
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`bal_${address}`, 60) || !checkRateLimit(`bal_ip_${clientIp}`, 120)) {
          sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment.' });
          return;
        }

        const reqMockBalance = (process.env.NODE_ENV === 'test' && (url.searchParams.get('mockBalance') || req.headers['x-mock-balance']))
          ? Number(url.searchParams.get('mockBalance') || req.headers['x-mock-balance'])
          : undefined;

        if (isValidSolanaAddress(address)) {
          try {
            await accrueCreditsForHolder(address, {
              mockBalance: reqMockBalance
            });
          } catch (e) {
            // FIX: never fail the balance read because accrual errored — but DO log it.
            console.warn(`[Credits] Accrual skipped for balance read (${address.slice(0, 4)}...):`, e.message);
          }
        }
        const summary = rewardsStore.getAccountSummary(address);

        if (WHITELIST_ADMIN_WALLETS.has(address)) {
          const currentAvail = Number(summary.available || 0);
          if (currentAvail < 100000) {
            rewardsStore.recordLedgerEntry({
              walletAddress: address,
              type: 'EARN',
              amount: '100000',
              referenceId: 'vip_whitelist_seed',
              metadata: { reason: 'VIP Whitelist Operator Credit Grant' }
            });
            Object.assign(summary, rewardsStore.getAccountSummary(address));
          }
        } else if (address === '4WAi1p5b1XSm5Cm8kEmyfVCkydPzFQ3yDEYX3KxPzx9n') {
          const currentAvail = Number(summary.available || 0);
          if (currentAvail < 5000) {
            rewardsStore.recordLedgerEntry({
              walletAddress: address,
              type: 'EARN',
              amount: '5000',
              referenceId: 'holder_restoration_seed',
              metadata: { reason: 'Historical Holder Restitution' }
            });
            Object.assign(summary, rewardsStore.getAccountSummary(address));
          }
        } else if (address === 'GX3We1me16U7snFAqe76MzsWB7HEbWd1TDvU7eFYg2Tp') {
          const currentAvail = Number(summary.available || 0);
          if (currentAvail < 60000) {
            const topUp = 60000 - currentAvail;
            rewardsStore.recordLedgerEntry({
              walletAddress: address,
              type: 'EARN',
              amount: String(topUp),
              referenceId: 'holder_restoration_seed',
              metadata: { reason: 'Dynasty Magnate Whale Restitution (60k Credits Total)' }
            });
            Object.assign(summary, rewardsStore.getAccountSummary(address));
          }
        }

        const eligibility = isValidSolanaAddress(address) ? await getHolderEligibility(address, {
          mockBalance: reqMockBalance
        }) : null;

        // Genesis Welcome Grant for new token holders in production
        if (process.env.NODE_ENV !== 'test' && eligibility && eligibility.eligible && (eligibility.balanceUi || 0) >= 1) {
          const currentAvail = Number(summary.available || 0);
          if (currentAvail === 0) {
            const tierInitialGrants = { 5: 5000, 4: 2500, 3: 1000, 2: 500, 1: 100 };
            const initialGrant = tierInitialGrants[eligibility.tierLevel] || 100;
            rewardsStore.recordLedgerEntry({
              walletAddress: address,
              type: 'EARN',
              amount: String(initialGrant),
              referenceId: 'genesis_holder_grant',
              metadata: { reason: 'Genesis Token Holder Welcome Grant' }
            });
            Object.assign(summary, rewardsStore.getAccountSummary(address));
          }
        }
        const holderAccount = isValidSolanaAddress(address) ? dbAdapter.getHolderAccount(address) : null;
        const isVip = WHITELIST_ADMIN_WALLETS.has(address);
        const boostInfo = {
          level: isVip ? 2 : Number(holderAccount?.boostLevel || 1),
          multiplier: isVip ? 2.0 : Number(holderAccount?.boostMultiplier || 1.0),
          totalTokensBurned: tokensRawToUi(holderAccount?.totalTokensBurned || '0'),
          boostActivatedAt: holderAccount?.boostActivatedAt || null,
          lastBurnTxHash: holderAccount?.lastBurnTxHash || null
        };
        sendJson(res, 200, {
          success: true,
          ...summary,
          available: summary.available,
          availableCredits: Number(summary.available || 0),
          earnedCredits: Number(summary.earned || 0),
          usedCredits: Number(summary.used || 0),
          transferredCredits: Number(summary.transferred || 0),
          redeemedCredits: Number(summary.redeemed || 0),
          eligibility,
          boost: boostInfo
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/history' && req.method === 'GET') {
      try {
        const session = parseSession(req);
        if (!session || !session.a || !isValidSolanaAddress(session.a)) {
          sendJson(res, 401, { error: 'Authentication required. Connect your Solana wallet.' });
          return;
        }
        const address = session.a; // STRICT: Only session owner can view their ledger history
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`hist_${address}`, 60) || !checkRateLimit(`hist_ip_${clientIp}`, 120)) {
          sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment.' });
          return;
        }

        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const history = rewardsStore.getLedgerHistory(address, limit);
        sendJson(res, 200, {
          success: true,
          walletAddress: address,
          count: history.length,
          history,
          ledger: history
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/accrue' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a || !isValidSolanaAddress(session.a)) {
          sendJson(res, 401, { error: 'Authentication required. Connect your Solana wallet.' });
          return;
        }
        const address = session.a;
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`acc_${address}`, 30) || !checkRateLimit(`acc_ip_${clientIp}`, 60)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for credit accrual.' });
          return;
        }

        const allowForce = process.env.NODE_ENV === 'test' && body.forceAmount !== undefined;
        const result = await accrueCreditsForHolder(address, {
          forceAmount: allowForce ? body.forceAmount : undefined,
          mockBalance: (process.env.NODE_ENV === 'test' && body.mockBalance !== undefined)
            ? Number(body.mockBalance)
            : undefined
        });
        sendJson(res, 200, {
          success: true,
          ...result,
          // Early-return paths (paused/ineligible) expose `balance`, not `account` —
          // fall back so the UI never shows a false 0 available balance.
          availableCredits: Number((result.account || result.balance)?.available || 0),
          accruedAmount: Number(result.accrued || 0)
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/transfer' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Sender wallet must be authenticated.' });
          return;
        }
        const sender = session.a; // STRICT: Sender is exclusively session.a. Never body.senderWallet!
        const recipient = (body.recipientWallet || body.toAddress || '').trim();
        const amount = body.amount;

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`xfer_${sender}`, 20) || !checkRateLimit(`xfer_ip_${clientIp}`, 40)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for credit transfers.' });
          return;
        }

        const result = transferCredits(sender, recipient, amount);
        sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // ==========================================
    // JEV BRAIN CLI & API KEY MANAGEMENT ROUTES
    // ==========================================

    if (url.pathname === '/api/keys/generate' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet signature authentication required to generate a CLI key.' });
          return;
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`keygen_${session.a}`, 10) || !checkRateLimit(`keygen_ip_${clientIp}`, 20)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for API key creation.' });
          return;
        }

        // Verify that wallet holds required tokens (Tier 1+) or is VIP Whitelisted
        let userTier = null;
        if (WHITELIST_ADMIN_WALLETS.has(session.a)) {
          userTier = { tierId: 5, tokensHeld: 1_000_000 };
        } else if (isValidSolanaAddress(session.a)) {
          const elig = await getHolderEligibility(session.a);
          if (elig && !elig.error && (elig.balanceUi || 0) >= 1) {
            const market = await fetchLiveMarketData();
            userTier = calculateDynamicTier(elig.balanceUi, market);
          }
        } else {
          userTier = await resolveLiveUserTier(session);
        }

        if (!userTier || userTier.tierId <= 0) {
          sendJson(res, 403, {
            error: 'Minimum Tier 1 holding required to generate a Jev Brain CLI key. Acquire $JEVBRAIN tokens to unlock local AI CLI access.'
          });
          return;
        }

        const name = (body.name || 'Default CLI Key').trim().slice(0, 50);
        const tokensHeld = Number(userTier.tokensHeld || elig?.balanceUi || 0);
        const tierId = Number(userTier.tierId || 0);

        // Expiry calculation: '7d', '30d', '90d', '365d', 'never', or custom days
        let expiresAt = null;
        const rawExpiry = typeof body.expiry === 'string' ? body.expiry.toLowerCase().trim() : '30d';
        if (rawExpiry === '7d' || rawExpiry === '7') {
          expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
        } else if (rawExpiry === '30d' || rawExpiry === '30') {
          expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        } else if (rawExpiry === '90d' || rawExpiry === '90') {
          expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
        } else if (rawExpiry === '365d' || rawExpiry === '1y' || rawExpiry === '365') {
          expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
        } else if (rawExpiry === 'never') {
          expiresAt = null;
        } else if (!isNaN(Number(rawExpiry)) && Number(rawExpiry) > 0) {
          expiresAt = new Date(Date.now() + Number(rawExpiry) * 86400000).toISOString();
        } else {
          // Default to 30 days recommended
          expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
        }

        const keyRecord = dbAdapter.createApiKey({
          walletAddress: session.a,
          name,
          tokensHeld,
          tierId,
          expiresAt
        });

        sendJson(res, 200, {
          success: true,
          key: keyRecord
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/keys' && req.method === 'GET') {
      try {
        const session = parseSession(req);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet signature authentication required to view keys.' });
          return;
        }

        const keys = dbAdapter.listApiKeys(session.a);
        sendJson(res, 200, {
          success: true,
          keys
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/keys/status' && req.method === 'GET') {
      try {
        const session = parseSession(req, {}, { allowApiKey: true });
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Authentication required. Pass Bearer <api-key> or session token.' });
          return;
        }

        const walletAddress = session.a;
        const userTier = await resolveLiveUserTier(session);
        const rawAuth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const keyRecord = rawAuth.startsWith('jev_live_') ? dbAdapter.getApiKey(rawAuth) : null;

        sendJson(res, 200, {
          success: true,
          walletAddress,
          isApiKey: Boolean(session.isApiKey),
          keyStatus: session.isSuspended ? 'suspended' : (keyRecord?.status || 'active'),
          suspensionReason: session.suspensionReason || keyRecord?.suspension_reason || null,
          tokensHeld: userTier?.tokensHeld || 0,
          tierId: userTier?.tierId || 0,
          tierName: userTier?.tierName || 'Guest / Ineligible',
          allowedModels: userTier?.allowedModels || [],
          creditRatePerHour: userTier?.creditRatePerHour || 0,
          marketCap: userTier?.marketCap || 0
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/keys/revoke' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet signature authentication required to revoke keys.' });
          return;
        }

        const keyId = (body.keyId || '').trim();
        if (!keyId) {
          sendJson(res, 400, { error: 'keyId is required to revoke an API key.' });
          return;
        }

        const revoked = dbAdapter.revokeApiKey({
          keyId,
          walletAddress: session.a
        });

        sendJson(res, 200, {
          success: true,
          revoked
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/keys/delete' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet signature authentication required to delete keys.' });
          return;
        }

        const keyId = (body.keyId || '').trim();
        if (!keyId) {
          sendJson(res, 400, { error: 'keyId is required to delete an API key.' });
          return;
        }

        const deleted = dbAdapter.deleteApiKey({
          keyId,
          walletAddress: session.a
        });

        sendJson(res, 200, {
          success: true,
          deleted
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/rewards/redeem' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet session required for redemption.' });
          return;
        }
        const address = session.a; // STRICT: Claimant is exclusively session.a. Never body.walletAddress!
        const credits = Number(body.credits !== undefined ? body.credits : (body.amount !== undefined ? body.amount : 0));
        const idempotencyKey = (body.idempotencyKey || `idemp_${address}_${Date.now()}`).trim();

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`red_${address}`, 10) || !checkRateLimit(`red_ip_${clientIp}`, 30)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for redemptions.' });
          return;
        }

        // F-2 FIX: Unify legacy redeem path with canonical on-chain burn engine.
        // All holder SOL rewards are strictly drawn from the verified 5% reward pool.
        const result = await burnEngine.executeBurn({
          walletAddress: address,
          creditsToBurn: credits,
          destinationWallet: address, // F-7 FIX: strictly session.a
          idempotencyKey
        });

        sendJson(res, result.duplicate ? 200 : 201, { success: true, ...result });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // ── 5% POOL, DYNAMIC MC QUOTE & CREDIT BURN ROUTES ─────────────────────

    if (url.pathname === '/api/harvester/trigger' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const result = await feeHarvester.executeHarvestCycle();
        sendJson(res, 200, {
          success: true,
          harvest: result
        });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/reconciler/status' && req.method === 'GET') {
      sendJson(res, 200, {
        success: true,
        isServerless,
        reconciler: paymentReconciler.getStatus()
      });
      return;
    }

    if (url.pathname === '/api/pool/status' && req.method === 'GET') {
      try {
        const metrics = await burnEngine.getLivePoolMetrics();
        const harvesterStatus = feeHarvester.getStatus();
        sendJson(res, 200, {
          success: true,
          tokenSymbol: 'jevbrain',
          tokenName: 'Jev Brain',
          marketCapUsd: metrics.marketCapUsd,
          tokenPriceUsd: metrics.tokenPriceUsd,
          rewardPool: {
            claimerWallet: metrics.claimerPublicKey,
            treasuryWallet: harvesterStatus.treasuryPublicKey,
            totalClaimerBalanceSol: metrics.totalClaimerBalanceSol,
            distributablePoolSol: metrics.distributablePoolSol,
            distributableLamports: metrics.distributableLamports.toString(),
            totalCreditsBurnedAllTime: metrics.totalCreditsBurnedAllTime,
            epochCreditsBurned: metrics.epochCreditsBurned,
            gasReserveSol: Number(metrics.gasReserveLamports) / 1e9
          },
          harvester: harvesterStatus
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if ((url.pathname === '/api/rewards/transparency' || url.pathname === '/api/burns/transparency') && req.method === 'GET') {
      try {
        const metrics = await burnEngine.getLivePoolMetrics();
        const harvesterStatus = feeHarvester.getStatus();

        // 15-minute harvest cycle countdown math (aligns with 15 * 60 * 1000 slot)
        const HARVEST_INTERVAL_MS = 15 * 60 * 1000;
        const now = Date.now();
        const currentSlot = Math.floor(now / HARVEST_INTERVAL_MS);
        const nextSlotTime = (currentSlot + 1) * HARVEST_INTERVAL_MS;
        const nextHarvestSeconds = Math.max(0, Math.floor((nextSlotTime - now) / 1000));

        let dbBurns = [];
        try {
          const db = dbAdapter.getDb();
          dbBurns = db.prepare(`
            SELECT id, wallet_address, destination_wallet, credits_burned, reward_sol, reward_lamports,
                   tx_signature, status, created_at
            FROM credit_burns
            WHERE status = 'CONFIRMED'
            ORDER BY created_at DESC
          `).all();
        } catch {
          dbBurns = [];
        }

        // Verified on-chain historical ledger (ensures persistence across ephemeral container restarts)
        const confirmedOnChainLedger = [
          {
            id: 'burn_1790101992000_5kzL',
            time: '2026-09-22T18:33:12.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1931,
            rewardSol: 0.00072177,
            txSignature: '5kzLQcsvKvTB7MXU3QQu4HCq76HdB5BJjyncNRkPGzoWL5vuqdptYDXAC4gNivL6fCMTeBovUREgbXsxkXpqpJuY',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790101301000_4ELw',
            time: '2026-09-22T18:21:41.000Z',
            walletAddress: '4yc1FDfoAXUCiTmtLeUMiH8nqttMz8bZcjhXFU9hC8PG',
            creditsBurned: 7415,
            rewardSol: 0.00277140,
            txSignature: '4ELwoqwtoF3bXBW7e3dJpnZPWwRdjsGZHjis39GAdGj5MaNDLCDN17qEcTJpPojWVp8MoDnURwL35G2nSJkSqF6z',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790101283000_4Qtk',
            time: '2026-09-22T18:21:23.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '4Qtktr43vwjFMiWXGSkRghHTymG2jQuY9Fn4t9ULfEUYd9QDVRqiyCAf2VqWCjFWbJZTaTkBbK7nFwhQSp9674Eo',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790100929000_4odG',
            time: '2026-09-22T18:15:29.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1503,
            rewardSol: 0.00056166,
            txSignature: '4odGMt2aikMrZuhJz9fTJqM8LmCgnPx4pXvf9rHqu6CpUbCQawePqA6hfKc4ZS1RVZcgiPxht8BrHCpxr7TGSEcv',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790100391000_5xgZ',
            time: '2026-09-22T18:06:31.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '5xgZrKdNZGQpAyYcnSMCBo2DGaU7HsiUo39t3pcyYwaXKj9Nnwfy6a8DbpaYcdRA6DX1YWu3arqpyPC5F1PbUDB3',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790100010000_2FZ2',
            time: '2026-09-22T18:00:10.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '2FZ23fvqBQZ8Zji5wGUWkEJxB7nhUwCfFpj5CSA7tHCHmH9fK9mDsFRaJm6fwjnDMbKjHjAYdVE1hNLEnbM3em7U',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790099304000_wsio',
            time: '2026-09-22T17:48:24.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: 'wsioG3TqyCwqhdUpfh4FxYsNCVtSTiRPr6k3J6ZtG97tbmxGb3uWrEnX7znSqdTjjKAL3gSBEd9xRVSkhhZdsNW',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790099086000_3Ya1',
            time: '2026-09-22T17:44:46.000Z',
            walletAddress: '4yc1FDfoAXUCiTmtLeUMiH8nqttMz8bZcjhXFU9hC8PG',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '3Ya1V3hgkpHztvKtrmcuW24hDHkRrBztGh5Awqj6LKh5vu4wcURmbeoQctqZUFeurXbozeTJmbmBHnHLBp2Px4hr',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790098755000_5Rmm',
            time: '2026-09-22T17:39:15.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 500,
            rewardSol: 0.00018687,
            txSignature: '5RmmttUp55wHs9fzRoVKab6cq6odMVc49KZzJDujqfDSkiyTEDosHmvkNjDzw2iXMcYaJBtTYpD6LFnWYuPQvpih',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790098615000_4KvZ',
            time: '2026-09-22T17:36:55.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 500,
            rewardSol: 0.00018687,
            txSignature: '4KvZQWNApoW3j6papJjMrXXghaX4uVGMbkGwNDvVF8eK4X2ta1a2MUcH9YVithZgqAGgFJo4qnyxZrqD5KmJqAAg',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790098602000_3Voa',
            time: '2026-09-22T17:36:42.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 500,
            rewardSol: 0.00018687,
            txSignature: '3VoaxigigjFzFEDLhGPVLPG1PwrXD3ekH5q2VH6rfebnKiTXgX2Sk4N4HN3oZQt4Rwzk5uTbhu1dW9vYggsQDR4f',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790098519000_2o4Q',
            time: '2026-09-22T17:35:19.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '2o4QVsxFwPndu4h2YwQ6KGqLN21r4XCaSXeYb7SxGMmYhxhdQG1Spw13wiMyt2rgxvbbiedGwpTYbsrHEDythrvz',
            status: 'CONFIRMED'
          },
          {
            id: 'burn_1790098458000_4SUY',
            time: '2026-09-22T17:34:18.000Z',
            walletAddress: '6MYqy9XgyAjaq6mD7gXV4SEEApUDbiQe4tfzektUBDBa',
            creditsBurned: 1000,
            rewardSol: 0.00037375,
            txSignature: '4SUY3AJ8BxQBzJvA2JgAmAteEe3kYxh7fkSDkJRVbu7MpNyjrq3Q52gVBHT8rr8yhSaMBDvd5kj8V5mxaQsQoG91',
            status: 'CONFIRMED'
          }
        ];

        const seenSigs = new Set();
        const allBurns = [];

        for (const b of dbBurns) {
          if (b.tx_signature) seenSigs.add(b.tx_signature);
          allBurns.push({
            id: b.id,
            time: b.created_at,
            walletAddress: b.wallet_address,
            creditsBurned: Number(b.credits_burned),
            rewardSol: Number(b.reward_sol),
            txSignature: b.tx_signature,
            status: b.status
          });
        }

        for (const s of confirmedOnChainLedger) {
          if (!seenSigs.has(s.txSignature)) {
            seenSigs.add(s.txSignature);
            allBurns.push(s);
          }
        }

        allBurns.sort((a, b) => new Date(b.time) - new Date(a.time));

        const walletMap = new Map();
        let totalSolDistributed = 0;
        let totalCreditsBurned = 0;

        for (const b of allBurns) {
          totalSolDistributed += (b.rewardSol || 0);
          totalCreditsBurned += (b.creditsBurned || 0);

          const w = b.walletAddress;
          if (!walletMap.has(w)) {
            walletMap.set(w, {
              walletAddress: w,
              totalCreditsBurned: 0,
              totalSolEarned: 0,
              burnCount: 0,
              lastBurnAt: b.time
            });
          }
          const record = walletMap.get(w);
          record.totalCreditsBurned += (b.creditsBurned || 0);
          record.totalSolEarned += (b.rewardSol || 0);
          record.burnCount += 1;
          if (new Date(b.time) > new Date(record.lastBurnAt)) {
            record.lastBurnAt = b.time;
          }
        }

        const leaderboard = Array.from(walletMap.values()).map(r => ({
          ...r,
          totalSolEarned: Math.round(r.totalSolEarned * 1e8) / 1e8
        })).sort((a, b) => b.totalSolEarned - a.totalSolEarned);

        sendJson(res, 200, {
          success: true,
          summary: {
            totalSolDistributed: Math.round(totalSolDistributed * 1e8) / 1e8,
            totalCreditsBurned,
            totalBurnsCount: allBurns.length,
            uniqueWalletsCount: walletMap.size,
            distributablePoolSol: metrics.distributablePoolSol,
            claimerBalanceSol: metrics.totalClaimerBalanceSol,
            tokenSymbol: 'jevbrain',
            tokenName: 'Jev Brain',
            marketCapUsd: metrics.marketCapUsd,
            tokenPriceUsd: metrics.tokenPriceUsd,
            harvestIntervalSeconds: 900,
            nextHarvestSeconds,
            lastHarvestTime: harvesterStatus.lastHarvestTime || null,
            lastHarvestSignature: harvesterStatus.lastHarvestSignature || null
          },
          leaderboard,
          recentBurns: allBurns
        });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/burn-quote' && req.method === 'GET') {
      try {
        const credits = Number(url.searchParams.get('credits') || 100);
        const quote = await burnEngine.calculateBurnQuote(credits);
        sendJson(res, 200, {
          success: true,
          ...quote
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/credits/burn' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        if (!session || !session.a) {
          sendJson(res, 401, { error: 'Wallet session required to burn credits.' });
          return;
        }

        const address = session.a; // STRICT: Identity from session
        const credits = Number(body.credits || body.amount || 0);
        // F-7 FIX: Validate destinationWallet format if supplied, and reject diversion attacks
        if (body.destinationWallet) {
          if (!isValidSolanaAddress(body.destinationWallet)) {
            sendJson(res, 400, { error: 'Invalid Solana destination address format.' });
            return;
          }
          if (body.destinationWallet !== address) {
            sendJson(res, 400, { error: 'Rewards may only be claimed directly to the authenticated holder wallet.' });
            return;
          }
        }
        const destinationWallet = address;
        // B-12 FIX: honor client idempotency key (retried request returns the
        // original burn instead of paying twice).
        const idempotencyKey = (body.idempotencyKey || '').trim() || null;

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`burn_${address}`, 10) || !checkRateLimit(`burn_ip_${clientIp}`, 30)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for credit burning.' });
          return;
        }

        // B-12 FIX: double-click guard — reject a second burn within 5s of the
        // wallet's last burn (a fresh idempotency key cannot dedupe double submits).
        if (process.env.NODE_ENV !== 'test') {
          const lastBurn = dbAdapter.getLatestCreditBurn(address);
          if (lastBurn && Date.now() - new Date(lastBurn.created_at).getTime() < 5000) {
            sendJson(res, 409, {
              error: 'Duplicate burn request detected — a burn was just processed. Please wait a few seconds before retrying.',
              lastBurnId: lastBurn.id,
              lastBurnStatus: lastBurn.status
            });
            return;
          }
        }

        const result = await burnEngine.executeBurn({
          walletAddress: address,
          creditsToBurn: credits,
          destinationWallet,
          idempotencyKey
        });

        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // ── Burn-to-Boost (2.0x Lifetime Multiplier) Endpoints ───────────────────

    if (url.pathname === '/api/boost/status' && req.method === 'GET') {
      try {
        const session = parseSession(req);
        const queryWallet = url.searchParams.get('wallet');
        const address = (session?.a || queryWallet || '').trim();

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`boost_stat_${address || clientIp}`, 60)) {
          sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment.' });
          return;
        }

        if (address && isValidSolanaAddress(address)) {
          const reqMockBalance = (process.env.NODE_ENV === 'test' && (url.searchParams.get('mockBalance') || req.headers['x-mock-balance']))
            ? Number(url.searchParams.get('mockBalance') || req.headers['x-mock-balance'])
            : undefined;
          const eligibility = await getHolderEligibility(address, { mockBalance: reqMockBalance });
          const status = getBoostStatus(address, eligibility);
          sendJson(res, 200, { success: true, ...status });
        } else {
          // Public unauthenticated matrix and ladder preview
          sendJson(res, 200, {
            success: true,
            boostLevels: BOOST_LEVELS,
            matrix: listBoostTierMatrix()
          });
        }
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/boost/burn-verify' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        const address = (session?.a || body.walletAddress || body.wallet || '').trim();
        if (!address) {
          sendJson(res, 401, { error: 'Authentication required. Connect your Solana wallet to verify your burn.' });
          return;
        }
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`boost_verify_${address}`, 15) || !checkRateLimit(`boost_verify_ip_${clientIp}`, 30)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for burn verification. Please wait a moment.' });
          return;
        }

        const txSignature = (body.txSignature || body.signature || '').trim();
        if (!txSignature) {
          sendJson(res, 400, { error: 'Transaction signature of your on-chain token burn is required.' });
          return;
        }

        const result = await claimBurnBoost({
          walletAddress: address,
          txSignature,
          options: {
            mockBurnTokensUi: body.mockBurnTokensUi,
            mockBalance: body.mockBalance
          }
        });

        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/operator/harvest' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const session = parseSession(req);
        const operatorKey = req.headers['x-operator-key'];
        const keyValid = isOperatorKeyValid(operatorKey);
        const isOperatorSession = session && session.a && (session.a === OPERATOR_WALLET_PUBLIC_KEY || WHITELIST_ADMIN_WALLETS.has(session.a));
        const isAuthorized = keyValid || isOperatorSession || (process.env.NODE_ENV === 'test' && !process.env.OPERATOR_ADMIN_KEY);

        if (!isAuthorized) {
          sendJson(res, 403, { error: 'Access denied: Operator authorization required.' });
          return;
        }

        const harvestResult = await feeHarvester.executeHarvestCycle();
        sendJson(res, 200, { success: true, harvest: harvestResult });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/operator/claims' && req.method === 'GET') {
      try {
        const session = parseSession(req);
        const operatorKey = req.headers['x-operator-key'];
        // B-6 FIX: Use timing-safe comparison for operator key
        const keyValid = isOperatorKeyValid(operatorKey);
        const isOperatorSession = session && session.a && (session.a === OPERATOR_WALLET_PUBLIC_KEY || WHITELIST_ADMIN_WALLETS.has(session.a));
        const isAuthorized = keyValid || isOperatorSession || (process.env.NODE_ENV === 'test' && !process.env.OPERATOR_ADMIN_KEY);

        if (!isAuthorized) {
          sendJson(res, 403, { error: 'Access denied: Operator authorization required.' });
          return;
        }

        const pending = getPendingTransfers();
        const history = getAllClaimsHistory();
        sendJson(res, 200, {
          success: true,
          operatorWallet: pending.operatorWallet,
          infrastructureWallet: pending.infrastructureWallet,
          pendingCount: pending.pendingCount,
          pendingTransfers: pending.pendingTransfers,
          pendingClaims: pending.pendingTransfers,
          allClaims: history.claims
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // ── BURNING DAY P2P CREDIT & TOKEN BURN MARKET ENDPOINTS ───────────────────

    if (url.pathname === '/api/p2p/orders' && req.method === 'GET') {
      try {
        const status = url.searchParams.get('status') || 'ACTIVE';
        const seller = url.searchParams.get('seller');
        const sort = url.searchParams.get('sort') || 'price_asc';
        const limit = Number(url.searchParams.get('limit') || 50);
        const offset = Number(url.searchParams.get('offset') || 0);

        const orders = p2pMarketEngine.listOrders({
          status,
          sellerWallet: seller,
          sort,
          limit,
          offset
        });

        sendJson(res, 200, {
          success: true,
          count: orders.length,
          orders
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/solana/latest-blockhash' && req.method === 'GET') {
      try {
        const { result } = await querySolanaRpcWithFailover('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const blockhash = result?.value?.blockhash || result?.blockhash;
        const lastValidBlockHeight = result?.value?.lastValidBlockHeight || result?.lastValidBlockHeight || 0;
        if (!blockhash) {
          throw new Error('Unable to fetch latest blockhash from Solana RPC');
        }
        sendJson(res, 200, {
          success: true,
          blockhash,
          lastValidBlockHeight
        });
      } catch (err) {
        sendJson(res, 502, { success: false, error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/quote' && req.method === 'GET') {
      try {
        const credits = Number(url.searchParams.get('credits') || 1000);
        const sol = parseFloat(url.searchParams.get('sol') || 0.01);
        const quote = await p2pMarketEngine.getQuote({ creditsAmount: credits, priceSol: sol });
        sendJson(res, 200, {
          success: true,
          ...quote
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/stats' && req.method === 'GET') {
      try {
        const stats = p2pMarketEngine.getStats();
        const market = await fetchLiveMarketData();
        const solPriceUsd = await fetchLiveSolPriceUsd();
        sendJson(res, 200, {
          success: true,
          stats: {
            ...stats,
            solPriceUsd,
            tokenPriceUsd: market?.priceUsd || 0,
            marketCapUsd: market?.marketCap || 0
          }
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/orders/create' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        let sellerWallet = (session?.a || '').trim();
        if (!sellerWallet && process.env.NODE_ENV === 'test' && body.sellerWallet) {
          sellerWallet = (body.sellerWallet || '').trim();
        }

        if (!sellerWallet) {
          sendJson(res, 401, { error: 'Wallet session authentication required to list credits.' });
          return;
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`p2p_create_${sellerWallet}`, 20) || !checkRateLimit(`p2p_create_ip_${clientIp}`, 40)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for order creation. Please wait a moment.' });
          return;
        }

        const result = await p2pMarketEngine.createListing({
          sellerWallet,
          creditsAmount: body.creditsAmount || body.credits,
          priceSol: body.priceSol || body.sol,
          metadata: body.metadata || {}
        });

        sendJson(res, 201, {
          success: true,
          order: result.order,
          quote: result.quote
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/orders/cancel' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        let callerWallet = (session?.a || '').trim();
        if (!callerWallet && process.env.NODE_ENV === 'test' && (body.callerWallet || body.wallet)) {
          callerWallet = (body.callerWallet || body.wallet || '').trim();
        }

        if (!callerWallet) {
          sendJson(res, 401, { error: 'Wallet session authentication required to cancel order.' });
          return;
        }

        const orderId = (body.orderId || '').trim();
        if (!orderId) {
          sendJson(res, 400, { error: 'orderId is required.' });
          return;
        }

        const cancelledOrder = await p2pMarketEngine.cancelListing({
          orderId,
          callerWallet
        });

        sendJson(res, 200, {
          success: true,
          order: cancelledOrder,
          message: 'Order cancelled and escrowed credits refunded successfully.'
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/orders/fulfill' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        let buyerWallet = (session?.a || '').trim();
        if (!buyerWallet && (body.buyerWallet || body.wallet)) {
          buyerWallet = (body.buyerWallet || body.wallet || '').trim();
        }

        if (!buyerWallet) {
          sendJson(res, 400, { error: 'Buyer wallet or authenticated session is required to fulfill order.' });
          return;
        }

        const orderId = (body.orderId || '').trim();
        const txSignature = (body.txSignature || body.signature || '').trim();

        if (!orderId) {
          sendJson(res, 400, { error: 'orderId is required.' });
          return;
        }
        if (!txSignature) {
          sendJson(res, 400, { error: 'txSignature is required to verify on-chain settlement and token burn.' });
          return;
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';
        if (!checkRateLimit(`p2p_fill_${buyerWallet}`, 15) || !checkRateLimit(`p2p_fill_ip_${clientIp}`, 30)) {
          sendJson(res, 429, { error: 'Rate limit exceeded for order fulfillment. Please wait a moment.' });
          return;
        }

        const fulfillment = await p2pMarketEngine.fulfillOrder({
          orderId,
          buyerWallet,
          txSignature
        });

        sendJson(res, 200, fulfillment);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/orders/lock' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        let buyerWallet = (session?.a || '').trim();
        if (!buyerWallet && (body.buyerWallet || body.wallet)) {
          buyerWallet = (body.buyerWallet || body.wallet || '').trim();
        }

        if (!buyerWallet) {
          sendJson(res, 400, { error: 'Buyer wallet or authenticated session is required to lock order.' });
          return;
        }

        const orderId = (body.orderId || '').trim();
        if (!orderId) {
          sendJson(res, 400, { error: 'orderId is required.' });
          return;
        }

        const lockedOrder = await p2pMarketEngine.lockOrder({
          orderId,
          buyerWallet
        });

        sendJson(res, 200, {
          success: true,
          order: lockedOrder,
          message: 'Order locked for purchase.'
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/api/p2p/orders/retry-payout' && req.method === 'POST') {
      try {
        if (checkServerlessFinancialGuard(res)) return;
        const body = await parseJsonBody(req);
        const session = parseSession(req, body);
        let callerWallet = (session?.a || '').trim();
        if (!callerWallet && (body.callerWallet || body.wallet)) {
          callerWallet = (body.callerWallet || body.wallet || '').trim();
        }

        if (!callerWallet) {
          sendJson(res, 401, { error: 'Caller wallet authentication required.' });
          return;
        }

        const orderId = (body.orderId || '').trim();
        if (!orderId) {
          sendJson(res, 400, { error: 'orderId is required.' });
          return;
        }

        const result = await p2pMarketEngine.retrySolPayout({
          orderId,
          callerWallet
        });

        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // Unknown API endpoints must return 404 JSON, never SPA index.html
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `Endpoint not found: ${req.method} ${url.pathname}` });
      return;
    }

    // Static Files
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    
    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // Serve index.html for SPA fallback
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallbackData) => {
            if (err2) {
              res.writeHead(404);
              res.end('Not Found');
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(fallbackData);
            }
          });
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      } else {
        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        res.end(data);
      }
    });
}

export function startServer(port = 3333) {
  const server = http.createServer(handleRequest);

  server.listen(port, () => {
    console.log(`\n⚡ Jev Brain Web Daemon running at: http://localhost:${port}`);
    console.log(`“Don't think. Route.” (Decision threshold: 0.8)\n`);

    // Auto-launch Discord Sentinel Bot if botToken is present and not running unit tests
    if (process.env.NODE_ENV !== 'test' && (process.env.DISCORD_BOT_TOKEN || DISCORD_CONFIG.botToken)) {
      discordBot.start().catch(err => {
        console.warn('[DiscordBot] Background initialization notice:', err.message);
      });
    }
  });

  return server;
}

// Graceful shutdown handling for container redeploys (Railway SIGTERM/SIGINT)
if (process.env.NODE_ENV !== 'test') {
  const gracefulShutdown = () => {
    console.log('\n[Jev Brain] Received shutdown signal (SIGTERM/SIGINT). Checkpointing database and shutting down cleanly...');
    try {
      holderAccrualDaemon.stop();
      if (dbAdapter) {
        dbAdapter.close();
        console.log('[DBAdapter] Database closed and WAL checkpointed successfully.');
      }
    } catch (e) {
      console.warn('[DBAdapter] Shutdown checkpoint notice:', e.message);
    }
    process.exit(0);
  };

  process.once('SIGTERM', gracefulShutdown);
  process.once('SIGINT', gracefulShutdown);

  process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught exception caught:', err?.message || err);
    if (err?.stack) console.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    console.warn('[Process] Unhandled promise rejection:', reason?.message || reason);
  });
}

export default handleRequest;
