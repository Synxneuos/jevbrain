/**
 * Jev Brain — Burning Day P2P Credit & Token Burn Market Engine
 *
 * Mechanism Loop:
 *   unused credits → priced by seller in SOL → transferred to buyer →
 *   $JEVBRAIN burned on-chain → SOL settled to seller
 *
 * Core Guarantees:
 * 1. Immediate atomic escrow in SQLite (ledger type P2P_ESCROW). Prevents double-spending.
 * 2. On-chain settlement verification via Solana JSON-RPC getTransaction.
 * 3. Exact SOL delivery verification to seller_wallet.
 * 4. Exact $JEVBRAIN token burn / dead address delivery verification.
 * 5. Deduplication of transaction signatures (tx_signature UNIQUE in DB).
 * 6. Operator overrides for master administration wallets (HqHQf559... & 2yHeAq99...).
 * 7. System invariant conservation: Δ circulating credits = 0.
 */

import crypto from 'node:crypto';
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { dbAdapter } from './db-adapter.js';
import {
  OFFICIAL_SOLANA_MINT,
  isValidSolanaAddress,
  querySolanaRpcWithFailover,
  WHITELIST_ADMIN_WALLETS
} from './holder-eligibility.js';
import {
  parseTokenBurnFromTransaction,
  tokensUiToRaw,
  tokensRawToUi,
  BURN_DEAD_ADDRESSES
} from './boost-engine.js';
import { decodeBase58 } from './burn-engine.js';
import { fetchLiveMarketData } from './dexscreener.js';

export const COMPROMISED_REVOKED_WALLETS = new Set([
  '2yHeAq99m3NoZse674TQizAY8obNHwSm7mDXhNjssHYx'
]);

export const OFFICIAL_PAYOUT_WALLET = (process.env.PAYOUT_WALLET_PUBLIC_KEY || '').trim();

// Cache for live SOL price
let cachedSolPrice = null;
let lastSolPriceFetch = 0;
const SOL_PRICE_CACHE_MS = 15000;

/**
 * Fetch live SOL price in USD with caching and multi-tier fallbacks.
 */
export async function fetchLiveSolPriceUsd() {
  const now = Date.now();
  if (cachedSolPrice && (now - lastSolPriceFetch < SOL_PRICE_CACHE_MS)) {
    return cachedSolPrice;
  }

  // Tier 1: DexScreener SOL pair
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data?.pairs?.[0]?.priceUsd);
      if (price && price > 0) {
        cachedSolPrice = price;
        lastSolPriceFetch = now;
        return price;
      }
    }
  } catch (err) {
    // Proceed to fallback
  }

  // Tier 2: Jupiter Price API
  try {
    const jupRes = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112', {
      signal: AbortSignal.timeout(4000)
    });
    if (jupRes.ok) {
      const jupData = await jupRes.json();
      const jupPrice = parseFloat(jupData?.data?.['So11111111111111111111111111111111111111112']?.price);
      if (jupPrice && jupPrice > 0) {
        cachedSolPrice = jupPrice;
        lastSolPriceFetch = now;
        return jupPrice;
      }
    }
  } catch {}

  return cachedSolPrice || 140.0; // Reliable baseline fallback
}

/**
 * Check if an address has master operator privileges
 */
export function isP2POperator(walletAddress) {
  if (!walletAddress) return false;
  const clean = walletAddress.trim();
  if (COMPROMISED_REVOKED_WALLETS.has(clean)) return false;
  return (
    WHITELIST_ADMIN_WALLETS.has(clean) ||
    clean === 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn' ||
    clean === (process.env.ADMIN_WALLET || '').trim()
  );
}

/**
 * Extract native SOL transfer amount to a recipient from parsed transaction.
 */
export function parseSolTransferFromTransaction({ tx, recipientWallet }) {
  if (!tx) throw new Error('Transaction object is required for SOL transfer verification.');
  const dest = (recipientWallet || '').trim();
  if (!dest) throw new Error('Recipient wallet is required.');

  let totalLamports = 0n;

  // 1. Inspect parsed SystemProgram transfer instructions
  const instructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...((tx.meta?.innerInstructions || []).flatMap(ii => ii.instructions || []))
  ];

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    const info = parsed?.info;
    if (!parsed || !info) continue;

    const program = (ix.program || '').toLowerCase();
    if (program === 'system' && parsed.type === 'transfer') {
      if (info.destination === dest) {
        totalLamports += BigInt(info.lamports || 0);
      }
    }
  }

  // 2. Fallback: Net balance delta check for recipient
  if (totalLamports <= 0n) {
    const accountKeys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k?.pubkey));
    const recipientIndex = accountKeys.indexOf(dest);
    if (recipientIndex !== -1 && tx.meta?.preBalances && tx.meta?.postBalances) {
      const pre = BigInt(tx.meta.preBalances[recipientIndex] || 0);
      const post = BigInt(tx.meta.postBalances[recipientIndex] || 0);
      if (post > pre) {
        totalLamports = post - pre;
      }
    }
  }

  return totalLamports;
}

/**
 * Verify whether an address signed the Solana transaction.
 */
export function isTransactionSigner(tx, walletAddress) {
  if (!tx || !walletAddress) return false;
  const address = walletAddress.trim();
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const header = tx.transaction?.message?.header;
  const numRequiredSignatures = header?.numRequiredSignatures ?? 0;

  for (let i = 0; i < accountKeys.length; i++) {
    const k = accountKeys[i];
    const pubkey = typeof k === 'string' ? k : k?.pubkey;
    if (pubkey === address) {
      if (typeof k === 'object' && k.signer === true) return true;
      if (i < numRequiredSignatures) return true;
    }
  }
  return false;
}

export class P2PMarketEngine {
  constructor(db = dbAdapter) {
    this.db = db;
  }

  getPayoutKeypair() {
    const rawKey = (process.env.PAYOUT_WALLET_PRIVATE_KEY || '').trim();
    if (!rawKey) {
      throw new Error('Payout wallet private key (PAYOUT_WALLET_PRIVATE_KEY) is not configured on server.');
    }
    try {
      const secretBytes = rawKey.startsWith('[')
        ? new Uint8Array(JSON.parse(rawKey))
        : new Uint8Array(decodeBase58(rawKey));
      const kp = Keypair.fromSecretKey(secretBytes);
      if (COMPROMISED_REVOKED_WALLETS.has(kp.publicKey.toBase58())) {
        throw new Error(`Refusing to use compromised/revoked wallet (${kp.publicKey.toBase58()}) as payout keypair.`);
      }
      return kp;
    } catch (err) {
      throw new Error(`Failed to initialize payout wallet keypair: ${err.message}`);
    }
  }

  getSolanaConnection() {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    return new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Executes a real on-chain SOL transfer from the server's dedicated payout wallet
   * directly to the seller's wallet address.
   */
  async executeSolPayoutToSeller({ sellerWallet, priceLamports, orderId }) {
    const seller = (sellerWallet || '').trim();
    if (!isValidSolanaAddress(seller)) {
      throw new Error(`Invalid seller wallet address for SOL payout: ${seller}`);
    }
    const lamports = BigInt(priceLamports);
    if (lamports <= 0n) {
      throw new Error(`Payout lamports must be positive: ${lamports}`);
    }

    const keypair = this.getPayoutKeypair();
    const connection = this.getSolanaConnection();
    const sellerPubkey = new PublicKey(seller);

    // Verify payout wallet has sufficient balance on-chain
    const balance = BigInt(await connection.getBalance(keypair.publicKey));
    const minReserveLamports = 2_000_000n; // 0.002 SOL network fee buffer
    if (balance < lamports + minReserveLamports) {
      const currentSol = Number(balance) / 1e9;
      const requiredSol = Number(lamports + minReserveLamports) / 1e9;
      throw new Error(
        `PAYOUT_WALLET_INSUFFICIENT_FUNDS: Payout wallet (${keypair.publicKey.toBase58()}) balance is ${currentSol} SOL, but ${requiredSol} SOL is required to settle order ${orderId}.`
      );
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: sellerPubkey,
        lamports: Number(lamports)
      })
    );

    const txSignature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      { commitment: 'confirmed' }
    );

    return {
      txSignature,
      payoutWallet: keypair.publicKey.toBase58(),
      sellerWallet: seller,
      lamports: lamports.toString(),
      solAmount: Number(lamports) / 1e9
    };
  }

  /**
   * Calculate live quote for listing or buying credits:
   * Tokens to burn is derived from the order's SOL USD value divided by the token USD price
   * using exact micro-USD integer arithmetic (Section 8 Invariant).
   */
  async getQuote({ creditsAmount, priceSol }) {
    const credits = Math.max(1, parseInt(creditsAmount, 10) || 1000);
    const sol = Math.max(0.0001, parseFloat(priceSol) || 0.01);

    const [marketData, solPriceUsd] = await Promise.all([
      fetchLiveMarketData(),
      fetchLiveSolPriceUsd()
    ]);

    const tokenPriceUsd = marketData?.priceUsd && marketData.priceUsd > 0
      ? marketData.priceUsd
      : 0.00005;

    // Micro-USD integer arithmetic (Section 8 Invariant)
    const pSolMicro = BigInt(Math.max(1, Math.round(solPriceUsd * 1e6)));
    const pJevMicro = BigInt(Math.max(1, Math.round(tokenPriceUsd * 1e6)));
    const priceLamports = BigInt(Math.round(sol * 1e9));

    // tokensToBurnRaw = (priceLamports * pSolMicro) / (1000n * pJevMicro)
    let tokensToBurnRaw = (priceLamports * pSolMicro) / (1000n * pJevMicro);
    if (tokensToBurnRaw <= 0n) tokensToBurnRaw = 1_000_000n; // 1 full token minimum
    const tokensToBurnUi = Number(tokensToBurnRaw) / 1e6;

    const orderSolValueUsd = (Number(priceLamports) / 1e9) * solPriceUsd;
    const rateSolPer1kCredits = (sol / credits) * 1000;
    const rateUsdPer1kCredits = (orderSolValueUsd / credits) * 1000;

    return {
      creditsAmount: credits,
      priceSol: sol,
      priceLamports: priceLamports.toString(),
      solPriceUsd,
      tokenPriceUsd,
      orderSolValueUsd: Math.round(orderSolValueUsd * 10000) / 10000,
      tokensToBurnUi,
      tokensToBurnRaw: tokensToBurnRaw.toString(),
      rateSolPer1kCredits: Math.round(rateSolPer1kCredits * 10000) / 10000,
      rateUsdPer1kCredits: Math.round(rateUsdPer1kCredits * 100) / 100,
      marketCapUsd: marketData?.marketCap || 0
    };
  }

  /**
   * Create a new P2P credit sell listing with immediate atomic escrow
   */
  async createListing({ sellerWallet, creditsAmount, priceSol, metadata = {} }) {
    const seller = (sellerWallet || '').trim();
    if (!isValidSolanaAddress(seller)) {
      throw new Error('Seller wallet must be a valid Solana address.');
    }

    const credits = parseInt(creditsAmount, 10);
    if (!Number.isFinite(credits) || credits < 100) {
      throw new Error('Minimum listing amount is 100 credits.');
    }

    const sol = parseFloat(priceSol);
    if (!Number.isFinite(sol) || sol < 0.001) {
      throw new Error('Minimum price is 0.001 SOL.');
    }

    // Check seller balance
    const account = this.db.getCreditAccount(seller);
    if (!account || account.available < BigInt(credits)) {
      throw new Error(`Insufficient available credits: requested ${credits}, available ${account?.available ?? 0}`);
    }

    // Get live quote for required token burn
    const quote = await this.getQuote({ creditsAmount: credits, priceSol: sol });

    const orderId = `p2p_ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const order = this.db.createP2POrder({
      orderId,
      sellerWallet: seller,
      creditsAmount: credits,
      priceSol: sol,
      priceLamports: quote.priceLamports,
      tokensToBurnRaw: quote.tokensToBurnRaw,
      tokensToBurnUi: quote.tokensToBurnUi,
      metadata: {
        ...metadata,
        solPriceUsd: quote.solPriceUsd,
        tokenPriceUsd: quote.tokenPriceUsd,
        rateSolPer1kCredits: quote.rateSolPer1kCredits
      }
    });

    return {
      order,
      quote
    };
  }

  /**
   * Cancel an active listing and refund escrowed credits
   */
  async cancelListing({ orderId, callerWallet }) {
    const id = (orderId || '').trim();
    const caller = (callerWallet || '').trim();

    if (!id) throw new Error('Order ID is required.');
    if (!isValidSolanaAddress(caller)) {
      throw new Error('Caller wallet must be a valid Solana address.');
    }

    return this.db.cancelP2POrder(id, caller);
  }

  /**
   * Lock an order into PURCHASE_PENDING to prevent concurrency conflicts
   */
  async lockOrder({ orderId, buyerWallet }) {
    const id = (orderId || '').trim();
    const buyer = (buyerWallet || '').trim();
    if (!id) throw new Error('Order ID is required.');
    if (!isValidSolanaAddress(buyer)) throw new Error('Buyer wallet must be a valid Solana address.');

    return this.db.lockP2POrder(id, buyer);
  }

  /**
   * Verify on-chain settlement and fulfill order:
   * 1. Buyer paid required SOL to seller OR burned required $JEVBRAIN tokens on-chain
   * 2. If buyer burned tokens, dedicated server payout wallet pays SOL directly to seller wallet
   * 3. Atomically deliver credits to buyer in SQLite ledger
   */
  async fulfillOrder({ orderId, buyerWallet, txSignature }) {
    const id = (orderId || '').trim();
    const buyer = (buyerWallet || '').trim();
    const sig = (txSignature || '').trim();

    if (!id) throw new Error('Order ID is required.');
    if (!isValidSolanaAddress(buyer)) throw new Error('Buyer wallet must be a valid Solana address.');
    if (!sig) throw new Error('Transaction signature is required.');

    const order = this.db.getP2POrder(id);
    if (!order) throw new Error(`P2P order not found: ${id}`);
    if (!['ACTIVE', 'PURCHASE_PENDING'].includes(order.status)) {
      throw new Error(`Order is not active or pending purchase (current status: ${order.status})`);
    }
    if (order.sellerWallet === buyer) throw new Error('Self-dealing violation: You cannot buy your own credit listing.');

    // Enforce tx signature uniqueness
    const existingOrderWithSig = this.db.getP2POrderByBurnSignature(sig);
    if (existingOrderWithSig && existingOrderWithSig.orderId !== id) {
      throw new Error(`Transaction signature ${sig} has already been used for order ${existingOrderWithSig.orderId}`);
    }

    const isSyntheticTest = process.env.NODE_ENV === 'test' && sig.startsWith('test_simulated_sig_');
    let settlementMethod = 'burn';
    let solPayoutSignature = null;

    if (!isSyntheticTest) {
      // 1. Fetch transaction from Solana RPC with automatic failover
      const rpcResult = await querySolanaRpcWithFailover({
        method: 'getTransaction',
        params: [
          sig,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          }
        ]
      });

      const tx = rpcResult.result;
      if (!tx) {
        throw new Error(`Transaction ${sig} not found on Solana network. Please wait a few seconds for finality.`);
      }

      if (tx.meta && tx.meta.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
      }

      // Verify transaction occurred after or around order creation
      if (tx.blockTime) {
        const orderTimeSec = Math.floor(new Date(order.createdAt).getTime() / 1000);
        // Allow up to 10 minutes buffer for clock skew
        if (tx.blockTime < orderTimeSec - 600) {
          throw new Error('Transaction block timestamp is older than order creation time. Cannot reuse old transactions.');
        }
      }

      // 1. Verify buyer is an authorized SIGNER of the transaction
      if (!isTransactionSigner(tx, buyer)) {
        throw new Error('Buyer wallet must be an authorized signer of the transaction.');
      }

      // 2. Check for token burn or direct SOL transfer
      const requiredBurnRaw = BigInt(order.tokensToBurnRaw);
      let burnedRaw = 0n;
      try {
        const burnResult = parseTokenBurnFromTransaction({
          tx,
          walletAddress: buyer,
          tokenMint: OFFICIAL_SOLANA_MINT
        });
        burnedRaw = burnResult.burnedRaw || 0n;
      } catch {}

      let solPaidLamports = 0n;
      try {
        solPaidLamports = parseSolTransferFromTransaction({
          tx,
          recipientWallet: order.sellerWallet
        });
      } catch {}

      const hasBurnedTokens = burnedRaw >= requiredBurnRaw;
      const hasPaidSol = solPaidLamports >= BigInt(order.priceLamports);

      if (!hasBurnedTokens && !hasPaidSol) {
        throw new Error(
          `Settlement verification failed: Transaction must contain 🔥 ${order.tokensToBurnUi} $JEVBRAIN tokens burned, or ${order.priceSol} SOL transferred to seller (${order.sellerWallet.slice(0, 4)}...${order.sellerWallet.slice(-4)}). Found: ${Number(burnedRaw) / 1e6} tokens burned, ${Number(solPaidLamports) / 1e9} SOL paid.`
        );
      }

      // Stage 2: Server payout wallet pays SOL to seller
      if (hasBurnedTokens) {
        settlementMethod = 'burn';
        this.db.updateP2POrderStatus(id, 'JEV_BURN_CONFIRMED', {
          buyerWallet: buyer,
          jevBurnSignature: sig,
          metadata: { burnedRaw: burnedRaw.toString() }
        });

        try {
          const payoutResult = await this.executeSolPayoutToSeller({
            sellerWallet: order.sellerWallet,
            priceLamports: order.priceLamports,
            orderId: id
          });
          solPayoutSignature = payoutResult.txSignature;
          this.db.updateP2POrderStatus(id, 'SOL_PAYOUT_SUBMITTED', {
            solPayoutSignature
          });
        } catch (payoutErr) {
          console.error(`[P2PMarket] SOL payout failed for order ${id}:`, payoutErr.message);
          this.db.updateP2POrderStatus(id, 'RECOVERY_REQUIRED', {
            buyerWallet: buyer,
            jevBurnSignature: sig,
            metadata: {
              payoutError: payoutErr.message,
              requiresAdminRecovery: true,
              payoutPendingLamports: order.priceLamports
            }
          });
          throw new Error(
            `Buyer $JEV token burn verified on-chain (${sig.slice(0, 8)}...), but server SOL payout to seller encountered an error: ${payoutErr.message}. The trade has been flagged for immediate operator recovery. No tokens need to be re-burned.`
          );
        }
      } else {
        settlementMethod = 'direct_sol';
        solPayoutSignature = sig;
      }
    } else {
      solPayoutSignature = `test_payout_sig_${Date.now()}`;
    }

    // Stage 3: Atomic database fulfillment & credit transfer
    const updatedOrder = this.db.fillP2POrder({
      orderId: id,
      buyerWallet: buyer,
      jevBurnSignature: sig,
      solPayoutSignature,
      txSignature: sig
    });

    return {
      success: true,
      order: updatedOrder,
      settlementMethod,
      jevBurnSignature: sig,
      solPayoutSignature,
      message: `Successfully purchased ${order.creditsAmount} credits. Delivered to ${buyer}.`
    };
  }

  /**
   * Allows operator to retry SOL payout for an order in RECOVERY_REQUIRED or JEV_BURN_CONFIRMED
   */
  async retrySolPayout({ orderId, callerWallet }) {
    const id = (orderId || '').trim();
    const caller = (callerWallet || '').trim();
    if (!id) throw new Error('Order ID is required.');
    if (!isP2POperator(caller)) {
      throw new Error('Unauthorized: Only system operators can retry failed payouts.');
    }

    const order = this.db.getP2POrder(id);
    if (!order) throw new Error(`P2P order not found: ${id}`);
    if (!['RECOVERY_REQUIRED', 'JEV_BURN_CONFIRMED'].includes(order.status)) {
      throw new Error(`Order ${id} is not eligible for payout retry (current status: ${order.status})`);
    }
    if (!order.buyerWallet) throw new Error('Order is missing buyer wallet.');
    const burnSig = order.jevBurnSignature || order.txSignature;
    if (!burnSig) throw new Error('Order is missing verified JEV burn signature.');

    const payoutResult = await this.executeSolPayoutToSeller({
      sellerWallet: order.sellerWallet,
      priceLamports: order.priceLamports,
      orderId: id
    });

    const updatedOrder = this.db.fillP2POrder({
      orderId: id,
      buyerWallet: order.buyerWallet,
      jevBurnSignature: burnSig,
      solPayoutSignature: payoutResult.txSignature,
      txSignature: burnSig
    });

    return {
      success: true,
      order: updatedOrder,
      solPayoutSignature: payoutResult.txSignature
    };
  }

  /**
   * List orders with optional filters and sorting
   */
  listOrders(filters = {}) {
    return this.db.listP2POrders(filters);
  }

  /**
   * Get single order
   */
  getOrder(orderId) {
    return this.db.getP2POrder(orderId);
  }

  /**
   * Market stats overview
   */
  getStats() {
    return this.db.getP2PStats();
  }
}

export const p2pMarketEngine = new P2PMarketEngine();
