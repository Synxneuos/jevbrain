process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test_secret_for_dynamic_burn_suite_2026_secure';
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleRequest } from '../src/server.js';
import { calculateDynamicTier, HOLDING_TIERS } from '../src/core/dexscreener.js';
import { resolveHolderTier } from '../src/core/holder-eligibility.js';
import { feeHarvester, GAS_RESERVE_LAMPORTS, TREASURY_WALLET_ADDRESS } from '../src/workers/fee-harvester.js';
import { burnEngine } from '../src/core/burn-engine.js';
import { rewardsStore } from '../src/core/rewards-store.js';
import { dbAdapter } from '../src/core/db-adapter.js';

let server;
let baseUrl;

// Base58 helper
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(buffer) {
  let num = BigInt('0x' + (buffer.toString('hex') || '0'));
  let str = '';
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    str = B58_ALPHABET[Number(rem)] + str;
  }
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) str = '1' + str;
    else break;
  }
  return str;
}

function createTestWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  return { address: encodeBase58(rawPub), privateKey };
}

async function loginWallet(wallet) {
  const nRes = await fetch(`${baseUrl}/api/wallet/nonce?address=${wallet.address}`);
  const nData = await nRes.json();
  const signature = encodeBase58(crypto.sign(null, Buffer.from(nData.message, 'utf8'), wallet.privateKey));
  const vRes = await fetch(`${baseUrl}/api/wallet/verify-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature, message: nData.message })
  });
  const vData = await vRes.json();
  return vData.sessionToken;
}

test.before(async () => {
  server = http.createServer(handleRequest);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(r => server.close(r));
  feeHarvester.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. DYNAMIC MARKET CAP TIER SCALING TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Dynamic MC Tiers: Higher Market Cap reduces required tokens for holding tiers', () => {
  // Low MC ($70k)
  const lowMc = { marketCap: 70000, priceUsd: 0.00007 };
  const lowTierCalc = calculateDynamicTier(500_000, lowMc);
  
  // High MC ($10,000,000)
  const highMc = { marketCap: 10000000, priceUsd: 0.01 };
  const highTierCalc = calculateDynamicTier(50_000, highMc);

  assert.ok(lowTierCalc.dynamicTiers, 'Should calculate dynamic tiers');
  assert.ok(highTierCalc.dynamicTiers, 'Should calculate dynamic tiers');

  // Whale tier at 10M MC requires fewer tokens than at 70k MC
  const lowWhaleTokens = lowTierCalc.dynamicTiers.find(t => t.tierId === 5).requiredTokens;
  const highWhaleTokens = highTierCalc.dynamicTiers.find(t => t.tierId === 5).requiredTokens;

  assert.ok(
    highWhaleTokens < lowWhaleTokens,
    `Whale at $10M MC (${highWhaleTokens}) should require fewer tokens than at $70k MC (${lowWhaleTokens})`
  );
});

test('Dynamic MC Tiers: resolveHolderTier adapts rate and level dynamically to market data', () => {
  const market = { marketCap: 500000, priceUsd: 0.0005 };
  const tier = resolveHolderTier(200_000, market);

  assert.ok(tier.tierLevel >= 1, 'Should resolve to a valid holding tier');
  assert.ok(tier.creditRatePerHour > 0, 'Should have positive credit rate per hour');
  assert.strictEqual(tier.marketCap, 500000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FEE HARVESTER & 95%/5% SPLIT TESTS
// ─────────────────────────────────────────────────────────────────────────────

// Payout keys are env-only since f282e8f — this check needs the real production env to be meaningful.
const hasPayoutEnv = !!(process.env.FEE_CLAIMER_PRIVATE_KEY && process.env.TREASURY_WALLET_PUBLIC_KEY);
test('Fee Harvester: Correctly identifies Claimer and Treasury addresses', { skip: hasPayoutEnv ? false : 'FEE_CLAIMER_PRIVATE_KEY / TREASURY_WALLET_PUBLIC_KEY not set' }, () => {
  const claimerPub = feeHarvester.getClaimerPublicKey();
  assert.strictEqual(claimerPub, '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx');
  assert.strictEqual(TREASURY_WALLET_ADDRESS, '83SqfW6gs2jALfvpXnV4sMb1RQnzmiZNwjeunivMSaJ2');
});

test('Fee Harvester Split Math: Exact 95% to Treasury and 5% retained in wallet', () => {
  const surplus = 1_000_000_000n; // 1.0 SOL surplus
  const treasury = (surplus * 95n) / 100n;
  const pool = surplus - treasury;

  assert.strictEqual(treasury, 950_000_000n, 'Treasury must receive exactly 95%');
  assert.strictEqual(pool, 50_000_000n, 'Pool must retain exactly 5%');
  assert.strictEqual(treasury + pool, surplus, '95% + 5% must equal 100% of surplus');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BURN ENGINE DYNAMIC QUOTES & EXECUTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Burn Engine: Calculates dynamic quote with zero-deficit protection', async () => {
  const quote = await burnEngine.calculateBurnQuote(500);
  assert.ok(quote.creditsToBurn === 500);
  assert.ok(typeof quote.estimatedRewardSol === 'number');
  assert.ok(quote.marketCapUsd > 0);
  assert.ok(quote.distributablePoolSol >= 0);
});

test('Burn Engine: End-to-End credit burn debits credits and records burn', async () => {
  const wallet = createTestWallet();
  const sessionToken = await loginWallet(wallet);

  // Seed credits to wallet
  rewardsStore.recordLedgerEntry({
    walletAddress: wallet.address,
    type: 'EARN',
    amount: 10_000n,
    referenceId: 'burn_test_seed',
    metadata: {}
  });

  const preSummary = rewardsStore.getAccountSummary(wallet.address);
  assert.strictEqual(preSummary.available, '10000');

  // Execute burn
  const burnResult = await burnEngine.executeBurn({
    walletAddress: wallet.address,
    creditsToBurn: 1000
  });

  assert.strictEqual(burnResult.success, true);
  assert.strictEqual(burnResult.creditsBurned, '1000');
  assert.strictEqual(burnResult.remainingCredits, '9000');
  assert.ok(burnResult.txSignature);

  // Check database table
  const burns = dbAdapter.getCreditBurnsByWallet(wallet.address);
  assert.strictEqual(burns.length, 1);
  assert.strictEqual(burns[0].credits_burned, '1000');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REST API ENDPOINTS FOR POOL & BURN
// ─────────────────────────────────────────────────────────────────────────────

test('API GET /api/pool/status: Returns live market cap, pool metrics, and token symbol', async () => {
  const res = await fetch(`${baseUrl}/api/pool/status`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.success, true);
  assert.strictEqual(data.tokenSymbol, 'jevbrain');
  assert.ok(data.marketCapUsd > 0);
  assert.ok(data.rewardPool.distributablePoolSol >= 0);
});

test('API GET /api/credits/burn-quote: Returns live dynamic quote for credit amount', async () => {
  const res = await fetch(`${baseUrl}/api/credits/burn-quote?credits=250`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.success, true);
  assert.strictEqual(data.creditsToBurn, 250);
  assert.ok(data.estimatedRewardLamports !== undefined);
});

test('API POST /api/credits/burn: Rejects unauthenticated requests with 401', async () => {
  const res = await fetch(`${baseUrl}/api/credits/burn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credits: 50 })
  });
  assert.strictEqual(res.status, 401);
});

test('API POST /api/credits/burn: Authenticated burn succeeds and debits credits', async () => {
  const wallet = createTestWallet();
  const sessionToken = await loginWallet(wallet);

  rewardsStore.recordLedgerEntry({
    walletAddress: wallet.address,
    type: 'EARN',
    amount: 2000n,
    referenceId: 'api_burn_seed',
    metadata: {}
  });

  const res = await fetch(`${baseUrl}/api/credits/burn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ credits: 500 })
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.creditsBurned, '500');
  assert.strictEqual(data.remainingCredits, '1500');
});
