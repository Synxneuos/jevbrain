process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test_secret_for_p2p_market_suite_2026_secure';

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleRequest } from '../src/server.js';
import { p2pMarketEngine, isP2POperator, parseSolTransferFromTransaction } from '../src/core/p2p-market-engine.js';
import { dbAdapter } from '../src/core/db-adapter.js';
import { rewardsStore } from '../src/core/rewards-store.js';
import { setMockHolderBalance } from '../src/core/holder-eligibility.js';

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
  return 'test_simulated_sig_' + encodeBase58(crypto.randomBytes(48));
}

async function loginWallet(wallet) {
  setMockHolderBalance(wallet.address, 1000000);
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
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('P2P Market — Zero Mock or Seed Orders Invariant Enforced', async () => {
  const orders = p2pMarketEngine.listOrders({ status: 'ALL' });
  const seedOrders = orders.filter(o => o.orderId.startsWith('p2p_ord_seed_'));
  assert.strictEqual(seedOrders.length, 0, 'No mock or synthetic seed orders should exist in the database');
});

test('P2P Market — Quote Engine Calculates Valid Token Burn Quotas', async () => {
  const quote = await p2pMarketEngine.getQuote({ creditsAmount: 2000, priceSol: 0.02 });
  assert.strictEqual(quote.creditsAmount, 2000);
  assert.strictEqual(quote.priceSol, 0.02);
  assert.ok(quote.tokensToBurnUi > 0, 'Tokens to burn UI must be greater than zero');
  assert.ok(BigInt(quote.tokensToBurnRaw) > 0n, 'Tokens to burn raw must be positive BigInt');
  assert.ok(quote.solPriceUsd > 0, 'SOL price in USD must be positive');
  assert.strictEqual(quote.priceLamports, '20000000');
});

test('P2P Market — Atomic Credit Escrow & Invariant Preservation', async () => {
  const seller = createTestWallet();
  // Fund seller with 10,000 credits
  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 10000n
  });

  const beforeSummary = rewardsStore.getAccountSummary(seller.address);
  assert.strictEqual(Number(beforeSummary.available), 10000);
  assert.strictEqual(Number(beforeSummary.transferred), 0);

  // List 4,000 credits for 0.04 SOL
  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 4000,
    priceSol: 0.04
  });

  assert.ok(listing.order.orderId);
  assert.strictEqual(listing.order.creditsAmount, 4000);
  assert.strictEqual(listing.order.status, 'ACTIVE');

  // Verify escrowed state
  const afterSummary = rewardsStore.getAccountSummary(seller.address);
  assert.strictEqual(Number(afterSummary.available), 6000, 'Available should drop by exactly 4000');
  assert.strictEqual(Number(afterSummary.transferred), 4000, 'Transferred should rise by exactly 4000');

  // Mathematical invariant check
  rewardsStore.assertAccountInvariants(afterSummary);

  // Attempting to list more than available credits must fail
  await assert.rejects(
    async () => {
      await p2pMarketEngine.createListing({
        sellerWallet: seller.address,
        creditsAmount: 7000,
        priceSol: 0.05
      });
    },
    /Insufficient available credits/
  );
});

test('P2P Market — Cancellation Restores Escrowed Balance & Invariants', async () => {
  const seller = createTestWallet();
  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 5000n
  });

  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 3000,
    priceSol: 0.03
  });

  const midSummary = rewardsStore.getAccountSummary(seller.address);
  assert.strictEqual(Number(midSummary.available), 2000);
  assert.strictEqual(Number(midSummary.transferred), 3000);

  // Cancel listing
  const cancelled = await p2pMarketEngine.cancelListing({
    orderId: listing.order.orderId,
    callerWallet: seller.address
  });

  assert.strictEqual(cancelled.status, 'CANCELLED');

  const finalSummary = rewardsStore.getAccountSummary(seller.address);
  assert.strictEqual(Number(finalSummary.available), 5000, 'Available balance should be fully restored to 5000');
  assert.strictEqual(Number(finalSummary.transferred), 0, 'Transferred balance should be restored to 0');

  // Strict invariant verification
  rewardsStore.assertAccountInvariants(finalSummary);
});

test('P2P Market — Operator Authority Can Cancel Any Order', async () => {
  const seller = createTestWallet();
  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 5000n
  });

  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 2000,
    priceSol: 0.02
  });

  // Random stranger cannot cancel
  const stranger = createTestWallet();
  await assert.rejects(
    async () => {
      await p2pMarketEngine.cancelListing({
        orderId: listing.order.orderId,
        callerWallet: stranger.address
      });
    },
    /Unauthorized/
  );

  // VIP Master Operator can cancel
  const operatorWallet = 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn';
  const cancelledByOp = await p2pMarketEngine.cancelListing({
    orderId: listing.order.orderId,
    callerWallet: operatorWallet
  });

  assert.strictEqual(cancelledByOp.status, 'CANCELLED');
});

test('P2P Market — Self-Dealing Blocked & Atomic Fulfillment with Signature Deduplication', async () => {
  const seller = createTestWallet();
  const buyer = createTestWallet();

  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 8000n
  });

  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 3000,
    priceSol: 0.03
  });

  const orderId = listing.order.orderId;

  // 1. Seller cannot buy their own listing
  await assert.rejects(
    async () => {
      await p2pMarketEngine.fulfillOrder({
        orderId,
        buyerWallet: seller.address,
        txSignature: generateMockSignature()
      });
    },
    /Self-dealing violation/
  );

  // 2. Buyer fulfills order with simulated on-chain signature
  const mockSig = generateMockSignature();
  const result = await p2pMarketEngine.fulfillOrder({
    orderId,
    buyerWallet: buyer.address,
    txSignature: mockSig
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.order.status, 'COMPLETED');
  assert.strictEqual(result.order.buyerWallet, buyer.address);
  assert.strictEqual(result.order.txSignature, mockSig);
  assert.strictEqual(result.order.jevBurnSignature, mockSig);
  assert.ok(result.solPayoutSignature, 'Should have real/deterministic SOL payout signature');
  assert.strictEqual(result.order.solPayoutSignature, result.solPayoutSignature);

  // Verify buyer received exactly 3000 credits
  const buyerSummary = rewardsStore.getAccountSummary(buyer.address);
  assert.strictEqual(Number(buyerSummary.available), 3000);
  assert.strictEqual(Number(buyerSummary.earned), 3000);
  rewardsStore.assertAccountInvariants(buyerSummary);

  // Verify seller's invariant
  const sellerSummary = rewardsStore.getAccountSummary(seller.address);
  assert.strictEqual(Number(sellerSummary.available), 5000);
  assert.strictEqual(Number(sellerSummary.transferred), 3000);
  rewardsStore.assertAccountInvariants(sellerSummary);

  // 3. Signature reuse attack blocked
  await assert.rejects(
    async () => {
      // Create new order to test signature replay
      const newListing = await p2pMarketEngine.createListing({
        sellerWallet: seller.address,
        creditsAmount: 1000,
        priceSol: 0.01
      });
      await p2pMarketEngine.fulfillOrder({
        orderId: newListing.order.orderId,
        buyerWallet: buyer.address,
        txSignature: mockSig // Same signature!
      });
    },
    /Transaction signature .* has already been used/
  );
});

test('P2P Market — REST API Endpoints End-to-End', async () => {
  // 1. GET /api/p2p/stats
  const statsRes = await fetch(`${baseUrl}/api/p2p/stats`);
  const statsData = await statsRes.json();
  assert.strictEqual(statsRes.status, 200);
  assert.strictEqual(statsData.success, true);
  assert.ok(statsData.stats.activeListingsCount >= 0);

  // 2. GET /api/p2p/quote
  const quoteRes = await fetch(`${baseUrl}/api/p2p/quote?credits=5000&sol=0.05`);
  const quoteData = await quoteRes.json();
  assert.strictEqual(quoteRes.status, 200);
  assert.strictEqual(quoteData.success, true);
  assert.strictEqual(quoteData.creditsAmount, 5000);
  assert.strictEqual(quoteData.priceSol, 0.05);

  // 3. Authenticated POST /api/p2p/orders/create
  const seller = createTestWallet();
  const token = await loginWallet(seller);

  // Fund seller
  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 10000n
  });

  const createRes = await fetch(`${baseUrl}/api/p2p/orders/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      creditsAmount: 2500,
      priceSol: 0.025
    })
  });

  const createData = await createRes.json();
  assert.strictEqual(createRes.status, 201);
  assert.strictEqual(createData.success, true);
  assert.strictEqual(createData.order.creditsAmount, 2500);

  // 4. GET /api/p2p/orders
  const ordersRes = await fetch(`${baseUrl}/api/p2p/orders?status=ACTIVE&seller=${seller.address}`);
  const ordersData = await ordersRes.json();
  assert.strictEqual(ordersRes.status, 200);
  assert.strictEqual(ordersData.success, true);
  assert.strictEqual(ordersData.orders.length, 1);
  assert.strictEqual(ordersData.orders[0].orderId, createData.order.orderId);

  // 5. POST /api/p2p/orders/cancel
  const cancelRes = await fetch(`${baseUrl}/api/p2p/orders/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      orderId: createData.order.orderId
    })
  });
  const cancelData = await cancelRes.json();
  assert.strictEqual(cancelRes.status, 200);
  assert.strictEqual(cancelData.success, true);
  assert.strictEqual(cancelData.order.status, 'CANCELLED');
});

test('P2P Market — Order Locking & Concurrency Protection', async () => {
  const seller = createTestWallet();
  const buyer1 = createTestWallet();
  const buyer2 = createTestWallet();

  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 10000n
  });

  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 5000,
    priceSol: 0.05
  });

  // Buyer 1 locks order
  const lockRes = await fetch(`${baseUrl}/api/p2p/orders/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: listing.order.orderId,
      buyerWallet: buyer1.address
    })
  });
  const lockData = await lockRes.json();
  assert.strictEqual(lockRes.status, 200);
  assert.strictEqual(lockData.order.status, 'PURCHASE_PENDING');
  assert.strictEqual(lockData.order.buyerWallet, buyer1.address);

  // Buyer 2 attempts to lock same order -> rejected
  const lockRes2 = await fetch(`${baseUrl}/api/p2p/orders/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: listing.order.orderId,
      buyerWallet: buyer2.address
    })
  });
  assert.strictEqual(lockRes2.status, 400);

  // Buyer 1 fulfills locked order
  const sig = generateMockSignature();
  const fillRes = await fetch(`${baseUrl}/api/p2p/orders/fulfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: listing.order.orderId,
      buyerWallet: buyer1.address,
      txSignature: sig
    })
  });
  const fillData = await fillRes.json();
  assert.strictEqual(fillRes.status, 200);
  assert.strictEqual(fillData.order.status, 'COMPLETED');
  assert.strictEqual(fillData.order.buyerWallet, buyer1.address);
});

test('P2P Market — Conservation of Circulating Credits Invariant: Δ circulating credits = 0', async () => {
  const seller = createTestWallet();
  const buyer = createTestWallet();

  rewardsStore.recordLedgerEntry({
    walletAddress: seller.address,
    type: 'EARN',
    amount: 25000n
  });

  const sellerBefore = rewardsStore.getAccountSummary(seller.address);
  const buyerBefore = rewardsStore.getAccountSummary(buyer.address);
  const totalBefore = BigInt(sellerBefore.available) + BigInt(buyerBefore.available);

  // Seller lists 10,000 credits
  const listing = await p2pMarketEngine.createListing({
    sellerWallet: seller.address,
    creditsAmount: 10000,
    priceSol: 0.1
  });

  // Buyer fulfills
  const sig = generateMockSignature();
  await p2pMarketEngine.fulfillOrder({
    orderId: listing.order.orderId,
    buyerWallet: buyer.address,
    txSignature: sig
  });

  const sellerAfter = rewardsStore.getAccountSummary(seller.address);
  const buyerAfter = rewardsStore.getAccountSummary(buyer.address);
  const totalAfter = BigInt(sellerAfter.available) + BigInt(buyerAfter.available);

  // Invariant: Total available circulating credits between buyer and seller MUST be identical
  assert.strictEqual(
    totalAfter.toString(),
    totalBefore.toString(),
    'Circulating credit supply must be conserved exactly: Δ circulating credits = 0'
  );
});

test('P2P Market — Security Regression: Zero Hardcoded Private Keys & Compromised 2yHe... Revoked', async () => {
  const fs = await import('node:fs');
  const engineSource = fs.readFileSync(new URL('../src/core/p2p-market-engine.js', import.meta.url), 'utf8');

  // 1. Source file must contain ZERO hardcoded private keys
  assert.strictEqual(engineSource.includes('DEFAULT_PAYOUT_PRIVATE_KEY'), false, 'Must not contain DEFAULT_PAYOUT_PRIVATE_KEY');
  assert.strictEqual(engineSource.includes('5yqMkFLP'), false, 'Must not contain exposed base58 private key');

  // 2. Compromised wallet 2yHe... must have ZERO operator or VIP privileges
  const compromised = '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx';
  assert.strictEqual(isP2POperator(compromised), false, 'Compromised wallet must not be a P2P operator');

  // 3. VIP bypass token for compromised wallet must be rejected with 401
  const res = await fetch(`${baseUrl}/api/keys`, {
    headers: { 'Authorization': `Bearer jev_live_vip_${compromised}` }
  });
  assert.strictEqual(res.status, 401, 'Compromised VIP token must be rejected with 401');
});

