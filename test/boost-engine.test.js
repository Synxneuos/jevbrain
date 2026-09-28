process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test_secret_for_boost_engine_suite_2026_secure';
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleRequest } from '../src/server.js';
import {
  BOOST_TIER_MATRIX,
  BOOST_LEVELS,
  MAX_ACTIVE_BOOST_LEVEL,
  getBurnRequirementForTier,
  listBoostTierMatrix,
  parseTokenBurnFromTransaction,
  claimBurnBoost,
  getBoostStatus,
  tokensUiToRaw,
  tokensRawToUi
} from '../src/core/boost-engine.js';
import { OFFICIAL_SOLANA_MINT } from '../src/core/holder-eligibility.js';
import { accrueCreditsForHolder } from '../src/core/credit-engine.js';
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

function generateMockSignature() {
  const bytes = crypto.randomBytes(64);
  return encodeBase58(bytes);
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
  if (server) await new Promise(r => server.close(r));
  dbAdapter.close();
});

test('Boost Engine Matrix: matches exact 5-tier specification (§2)', () => {
  assert.strictEqual(BOOST_TIER_MATRIX.length, 5);

  const t1 = getBurnRequirementForTier(1);
  assert.strictEqual(t1.tierName, 'Reserve Initiate');
  assert.strictEqual(t1.requiredTokensUi, 100);
  assert.strictEqual(t1.baseRatePer15Min, 10);
  assert.strictEqual(t1.baseRatePerHour, 40);
  assert.strictEqual(t1.boostedRatePer15Min, 20);
  assert.strictEqual(t1.boostedRatePerHour, 80);
  assert.strictEqual(t1.boostedCreditsPerDay, 1920);

  const t2 = getBurnRequirementForTier(2);
  assert.strictEqual(t2.tierName, 'Charter Associate');
  assert.strictEqual(t2.requiredTokensUi, 250);
  assert.strictEqual(t2.baseRatePer15Min, 50);
  assert.strictEqual(t2.baseRatePerHour, 200);
  assert.strictEqual(t2.boostedRatePer15Min, 100);
  assert.strictEqual(t2.boostedRatePerHour, 400);
  assert.strictEqual(t2.boostedCreditsPerDay, 9600);

  const t3 = getBurnRequirementForTier(3);
  assert.strictEqual(t3.tierName, 'Principal Partner');
  assert.strictEqual(t3.requiredTokensUi, 2000);
  assert.strictEqual(t3.baseRatePer15Min, 200);
  assert.strictEqual(t3.baseRatePerHour, 800);
  assert.strictEqual(t3.boostedRatePer15Min, 400);
  assert.strictEqual(t3.boostedRatePerHour, 1600);
  assert.strictEqual(t3.boostedCreditsPerDay, 38400);

  const t4 = getBurnRequirementForTier(4);
  assert.strictEqual(t4.tierName, 'Syndicate Director');
  assert.strictEqual(t4.requiredTokensUi, 15000);
  assert.strictEqual(t4.baseRatePer15Min, 750);
  assert.strictEqual(t4.baseRatePerHour, 3000);
  assert.strictEqual(t4.boostedRatePer15Min, 1500);
  assert.strictEqual(t4.boostedRatePerHour, 6000);
  assert.strictEqual(t4.boostedCreditsPerDay, 144000);

  const t5 = getBurnRequirementForTier(5);
  assert.strictEqual(t5.tierName, 'Dynasty Magnate');
  assert.strictEqual(t5.requiredTokensUi, 100000);
  assert.strictEqual(t5.baseRatePer15Min, 2500);
  assert.strictEqual(t5.baseRatePerHour, 10000);
  assert.strictEqual(t5.boostedRatePer15Min, 5000);
  assert.strictEqual(t5.boostedRatePerHour, 20000);
  assert.strictEqual(t5.boostedCreditsPerDay, 480000);

  assert.strictEqual(getBurnRequirementForTier(0), null);
});

test('Boost Engine: raw and UI token unit conversion with pump.fun 6 decimals', () => {
  const ui = 100;
  const raw = tokensUiToRaw(ui);
  assert.strictEqual(raw, 100_000_000n);
  assert.strictEqual(tokensRawToUi(raw), 100);
});

test('On-Chain Transaction Parsing: validates SPL Token burn and dead address transfer', () => {
  const claimant = '9vPBk5k9W6bE5B8UeA1zQ5yH2Vf5M6N8p9X8Y7Z6W5V4';

  // 1. Transaction failure on chain
  assert.throws(() => {
    parseTokenBurnFromTransaction({
      tx: { meta: { err: { InstructionError: [0, 'Custom'] } } },
      walletAddress: claimant
    });
  }, /Transaction failed on-chain/);

  // 2. Claimant not a signer
  assert.throws(() => {
    parseTokenBurnFromTransaction({
      tx: {
        meta: { err: null, confirmationStatus: 'confirmed' },
        transaction: {
          message: {
            accountKeys: [{ pubkey: claimant, signer: false }]
          }
        }
      },
      walletAddress: claimant
    });
  }, /not a required signer/);

  // 3. Valid SPL Token burn instruction
  const validBurnTx = {
    meta: { err: null, confirmationStatus: 'confirmed' },
    transaction: {
      message: {
        accountKeys: [{ pubkey: claimant, signer: true }],
        instructions: [
          {
            program: 'spl-token',
            parsed: {
              type: 'burnChecked',
              info: {
                mint: OFFICIAL_SOLANA_MINT,
                authority: claimant,
                tokenAmount: { amount: '250000000' } // 250 tokens
              }
            }
          }
        ]
      }
    }
  };

  const parsed = parseTokenBurnFromTransaction({ tx: validBurnTx, walletAddress: claimant });
  assert.strictEqual(parsed.burnedTokensUi, 250);
  assert.strictEqual(parsed.burnMethod, 'token_burn');

  // 4. Valid transfer to Solana Incinerator dead address
  const deadTransferTx = {
    meta: { err: null, confirmationStatus: 'confirmed' },
    transaction: {
      message: {
        accountKeys: [{ pubkey: claimant, signer: true }],
        instructions: [
          {
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                mint: OFFICIAL_SOLANA_MINT,
                authority: claimant,
                destination: '1nc1nerator11111111111111111111111111111111',
                tokenAmount: { amount: '100000000' } // 100 tokens
              }
            }
          }
        ]
      }
    }
  };

  const parsedDead = parseTokenBurnFromTransaction({ tx: deadTransferTx, walletAddress: claimant });
  assert.strictEqual(parsedDead.burnedTokensUi, 100);
  assert.strictEqual(parsedDead.burnMethod, 'transfer_to_dead_address');
});

test('Claim Flow: rejects non-holding wallet (Tier 0)', async () => {
  const wallet = createTestWallet();
  const sig = generateMockSignature();

  await assert.rejects(async () => {
    await claimBurnBoost({
      walletAddress: wallet.address,
      txSignature: sig,
      options: { mockBalance: 0, mockBurnTokensUi: 100 }
    });
  }, /Wallet must hold verified \$JEVBRAIN tokens \(Tier 1\+\)/);
});

test('Claim Flow: rejects insufficient burn amount for user holding tier', async () => {
  const wallet = createTestWallet();
  const sig = generateMockSignature();

  // Wallet holds 1,500 tokens (Tier 2: Charter Associate, requires 250 token burn)
  // But user only burns 100 tokens
  await assert.rejects(async () => {
    await claimBurnBoost({
      walletAddress: wallet.address,
      txSignature: sig,
      options: { mockBalance: 1500, mockBurnTokensUi: 100 }
    });
  }, /Insufficient burn for Charter Associate boost: burned 100 \$JEVBRAIN, but 250 are required/);
});

test('Claim Flow: successful burn permanently unlocks 2.0x lifetime boost and prevents replay', async () => {
  const wallet = createTestWallet();
  const sig = generateMockSignature();

  // Tier 2 holder burns 250 tokens
  const claimRes = await claimBurnBoost({
    walletAddress: wallet.address,
    txSignature: sig,
    options: { mockBalance: 1500, mockBurnTokensUi: 250 }
  });

  assert.strictEqual(claimRes.success, true);
  assert.strictEqual(claimRes.boostLevel, 2);
  assert.strictEqual(claimRes.boostMultiplier, 2.0);
  assert.strictEqual(claimRes.boostName, 'Titan Boost');
  assert.strictEqual(claimRes.tokensBurned, 250);
  assert.strictEqual(claimRes.txSignature, sig);

  // Check persistent DB state
  const holder = dbAdapter.getHolderAccount(wallet.address);
  assert.strictEqual(holder.boostLevel, 2);
  assert.strictEqual(holder.boostMultiplier, 2.0);
  assert.strictEqual(holder.lastBurnTxHash, sig);
  assert.strictEqual(tokensRawToUi(holder.totalTokensBurned), 250);

  // Replay Attack Protection: Re-claiming with same transaction signature MUST be rejected
  await assert.rejects(async () => {
    await claimBurnBoost({
      walletAddress: wallet.address,
      txSignature: sig,
      options: { mockBalance: 1500, mockBurnTokensUi: 250 }
    });
  }, /This burn transaction signature has already been claimed for a boost/);

  // Trying to claim again beyond MAX_ACTIVE_BOOST_LEVEL (Level 2) is blocked
  const sig2 = generateMockSignature();
  await assert.rejects(async () => {
    await claimBurnBoost({
      walletAddress: wallet.address,
      txSignature: sig2,
      options: { mockBalance: 1500, mockBurnTokensUi: 500 }
    });
  }, /Wallet is already boosted to maximum active level/);
});

test('Credit Engine Accrual: boosted holder receives exactly 2.0x credit emissions', async () => {
  const unboostedWallet = createTestWallet();
  const boostedWallet = createTestWallet();

  // Seed both accounts with Tier 2 holdings (1,000 tokens → base rate 50/15m = 200 credits/hr)
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();

  // 1. Unboosted wallet setup
  dbAdapter.upsertHolderAccount({
    walletAddress: unboostedWallet.address,
    tokenBalanceRaw: '1000000000',
    tokenBalanceUi: 1000,
    tier: 'Charter Associate',
    tierLevel: 2,
    creditRatePerHour: 200,
    lastVerifiedAt: twoHoursAgo,
    lastAccrualAt: twoHoursAgo
  });

  // 2. Boosted wallet setup (boostMultiplier = 2.0)
  dbAdapter.upsertHolderAccount({
    walletAddress: boostedWallet.address,
    tokenBalanceRaw: '1000000000',
    tokenBalanceUi: 1000,
    tier: 'Charter Associate',
    tierLevel: 2,
    creditRatePerHour: 200,
    lastVerifiedAt: twoHoursAgo,
    lastAccrualAt: twoHoursAgo
  });
  dbAdapter.applyBoostToHolder({
    walletAddress: boostedWallet.address,
    boostLevel: 2,
    boostMultiplier: 2.0,
    tokensBurnedRaw: '250000000',
    txSignature: generateMockSignature()
  });

  // Accrue for unboosted wallet: 2 hours elapsed * 200 base rate = 400 credits
  const unboostedRes = await accrueCreditsForHolder(unboostedWallet.address, { mockBalance: 1000 });
  assert.strictEqual(unboostedRes.boost.multiplier, 1.0);
  assert.strictEqual(Number(unboostedRes.accrued), 400);

  // Accrue for boosted wallet: 2 hours elapsed * (200 base rate * 2.0x multiplier) = 800 credits
  const boostedRes = await accrueCreditsForHolder(boostedWallet.address, { mockBalance: 1000 });
  assert.strictEqual(boostedRes.boost.multiplier, 2.0);
  assert.strictEqual(boostedRes.effectiveRatePerHour, 400);
  assert.strictEqual(Number(boostedRes.accrued), 800);

  // Ledger metadata confirms boostMultiplier was recorded
  const history = rewardsStore.getLedgerHistory(boostedWallet.address, 1);
  assert.strictEqual(history[0].type, 'EARN');
  assert.strictEqual(history[0].metadata.boostMultiplier, 2.0);
  assert.strictEqual(history[0].metadata.effectiveRatePerHour, 400);
});

test('REST API: GET /api/boost/status and POST /api/boost/burn-verify', async () => {
  const wallet = createTestWallet();
  const sessionToken = await loginWallet(wallet);

  // 1. Unauthenticated boost status gives public matrix
  const pubRes = await fetch(`${baseUrl}/api/boost/status`);
  const pubData = await pubRes.json();
  assert.strictEqual(pubRes.status, 200);
  assert.strictEqual(pubData.success, true);
  assert.strictEqual(pubData.matrix.length, 5);

  // 2. Authenticated boost status for new user
  const statRes = await fetch(`${baseUrl}/api/boost/status`, {
    headers: { 'Authorization': `Bearer ${sessionToken}` }
  });
  const statData = await statRes.json();
  assert.strictEqual(statRes.status, 200);
  assert.strictEqual(statData.boostLevel, 1);
  assert.strictEqual(statData.boostMultiplier, 1.0);

  // 3. POST /api/boost/burn-verify without auth fails with 401
  const noAuthRes = await fetch(`${baseUrl}/api/boost/burn-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txSignature: generateMockSignature() })
  });
  assert.strictEqual(noAuthRes.status, 401);

  // 4. POST /api/boost/burn-verify with valid signature and test mock burn
  const sig = generateMockSignature();
  const verifyRes = await fetch(`${baseUrl}/api/boost/burn-verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    },
    body: JSON.stringify({
      txSignature: sig,
      mockBalance: 1500, // Tier 2
      mockBurnTokensUi: 250 // Meets 250 burn quota
    })
  });
  const verifyData = await verifyRes.json();
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyData.success, true);
  assert.strictEqual(verifyData.boostLevel, 2);
  assert.strictEqual(verifyData.boostMultiplier, 2.0);

  // 5. GET /api/credits/balance includes boost info
  const balRes = await fetch(`${baseUrl}/api/credits/balance`, {
    headers: { 'Authorization': `Bearer ${sessionToken}` }
  });
  const balData = await balRes.json();
  assert.strictEqual(balRes.status, 200);
  assert.strictEqual(balData.boost.level, 2);
  assert.strictEqual(balData.boost.multiplier, 2.0);
  assert.strictEqual(balData.boost.totalTokensBurned, 250);
});

test('On-Chain Transaction Parsing: dynamic dead ATA resolution matching live mainnet tx structure', () => {
  const claimant = '7i63nECxwFnr1G7Z8hCvihhhLdtCD1Xd17TtBohQD72E';
  const customDeadAta = 'CustomDeadAtaAddress111111111111111111111111';

  // Simulating the exact mainnet tx structure where destination is an ATA owned by 1nc1nerator...
  const dynamicAtaTx = {
    meta: {
      err: null,
      confirmationStatus: 'confirmed',
      preTokenBalances: [
        { accountIndex: 1, mint: OFFICIAL_SOLANA_MINT, owner: claimant, uiTokenAmount: { amount: '26741130877934' } },
        { accountIndex: 2, mint: OFFICIAL_SOLANA_MINT, owner: '1nc1nerator11111111111111111111111111111111', uiTokenAmount: { amount: '100000000000' } }
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: OFFICIAL_SOLANA_MINT, owner: claimant, uiTokenAmount: { amount: '26641130877934' } },
        { accountIndex: 2, mint: OFFICIAL_SOLANA_MINT, owner: '1nc1nerator11111111111111111111111111111111', uiTokenAmount: { amount: '200000000000' } }
      ]
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: claimant, signer: true },
          { pubkey: 'SourceAta111111111111111111111111111111111111', signer: false },
          { pubkey: customDeadAta, signer: false },
          { pubkey: '1nc1nerator11111111111111111111111111111111', signer: false }
        ],
        instructions: [
          {
            program: 'spl-associated-token-account',
            parsed: {
              type: 'createIdempotent',
              info: {
                account: customDeadAta,
                wallet: '1nc1nerator11111111111111111111111111111111',
                mint: OFFICIAL_SOLANA_MINT
              }
            }
          },
          {
            program: 'spl-token',
            programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
            parsed: {
              type: 'transferChecked',
              info: {
                authority: claimant,
                destination: customDeadAta,
                mint: OFFICIAL_SOLANA_MINT,
                tokenAmount: { amount: '100000000000' }
              }
            }
          }
        ]
      }
    }
  };

  const parsed = parseTokenBurnFromTransaction({ tx: dynamicAtaTx, walletAddress: claimant });
  assert.strictEqual(parsed.burnedTokensUi, 100000);
  assert.strictEqual(parsed.burnMethod, 'transfer_to_dead_address');
});

test('REST API: POST /api/boost/burn-verify allows walletAddress in body when session token is absent', async () => {
  const wallet = createTestWallet();
  const sig = generateMockSignature();

  // Tier 1 holder burns 100 tokens with walletAddress supplied in request body
  const res = await fetch(`${baseUrl}/api/boost/burn-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: wallet.address,
      txSignature: sig,
      mockBalance: 500, // Tier 1
      mockBurnTokensUi: 100
    })
  });

  const data = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.walletAddress, wallet.address);
  assert.strictEqual(data.boostLevel, 2);
  assert.strictEqual(data.boostMultiplier, 2.0);
});

