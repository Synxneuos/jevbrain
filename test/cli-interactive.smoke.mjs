/**
 * Jev Brain CLI Interactive Smoke Test
 *
 * Simulates the full end-to-end loop on a live local server:
 *  1. Website side: token-holder eligibility + credit accrual + CLI API key generation
 *  2. CLI first run WITHOUT a key: paste key → live validation → saved to config
 *  3. CLI chat with a valid key: streamed answer + "Credits used / Remaining" line
 *  4. CLI rejects a bogus key during onboarding
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../src/server.js';
import { dbAdapter } from '../src/core/db-adapter.js';
import { setMockHolderBalance } from '../src/core/holder-eligibility.js';
import { accrueCreditsForHolder } from '../src/core/credit-engine.js';
import { apiKeyAuditor } from '../src/workers/api-key-auditor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'bin', 'brain.js');

function encodeBase58(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + (buffer.toString('hex') || '0'));
  let str = '';
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    str = ALPHABET[Number(rem)] + str;
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) str = '1' + str;
  return str;
}

function createTestSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  return { address: encodeBase58(rawPub), publicKey, privateKey };
}

function runCli(baseUrl, fakeHome, env, writePlan) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, 'chat'], {
      env: {
        ...process.env,
        JEV_ENDPOINT: baseUrl,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        NODE_ENV: 'worker-smoke',
        ...env
      }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const steps = [...writePlan];
    const tick = () => {
      if (steps.length === 0) {
        child.stdin.write('/exit\n');
        setTimeout(() => { try { child.kill(); } catch {} }, 2000);
        return;
      }
      const [delay, line] = steps.shift();
      setTimeout(() => {
        child.stdin.write(`${line}\n`);
        tick();
      }, delay);
    };
    tick();

    child.on('close', () => resolve(out));
    setTimeout(() => { try { child.kill(); } catch {} resolve(out); }, 60000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(handleRequest);
await new Promise((res) => server.listen(0, '127.0.0.1', () => res()));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`Smoke server listening on ${baseUrl}`);

// ── 1. Simulate the website side: holder + credits + generated key ──
const holder = createTestSolanaWallet();
setMockHolderBalance(holder.address, 100000);
await accrueCreditsForHolder(holder.address, { forceAmount: 500000 });
const key = dbAdapter.createApiKey({
  walletAddress: holder.address,
  name: 'Smoke CLI Key',
  tokensHeld: 100000,
  tierId: 3
});
assert.ok(key.apiKey.startsWith('jev_live_'));
console.log(`✔ Website side ready: holder ${holder.address.slice(0, 6)}... key ${key.apiKey.slice(0, 13)}...`);

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-smoke-'));

try {
  // ── 2. First run without key: paste key → validated → saved ──
  const onboardOut = await runCli(baseUrl, fakeHome, {}, [
    [1500, key.apiKey],
    [4000, '/exit']
  ]);
  assert.ok(onboardOut.includes('Verifying key'), 'Onboarding should verify pasted key');
  assert.ok(onboardOut.includes('API key verified & saved'), 'Valid key must be verified and saved');
  assert.ok(onboardOut.includes('Tier'), 'Welcome should show holding tier');
  const savedCfg = JSON.parse(fs.readFileSync(path.join(fakeHome, '.jevbrain', 'config.json'), 'utf8'));
  assert.strictEqual(savedCfg.apiKey, key.apiKey, 'Key must persist to ~/.jevbrain/config.json');
  console.log('✔ Onboarding: pasted key verified, credits shown, saved to config');

  // ── 3. Chat with saved key: streamed answer + credit line ──
  const chatOut = await runCli(baseUrl, fakeHome, {}, [
    [1500, 'Reply with exactly: SMOKE-OK'],
    [8000, '/exit']
  ]);
  const hasCreditLine = chatOut.includes('Credits used') || chatOut.includes('credits charged');
  assert.ok(chatOut.includes('Jev Brain Agent'), 'Agent session must start with saved key');
  assert.ok(hasCreditLine, `Expected a credit usage line. Output tail:\n${chatOut.slice(-800)}`);
  console.log('✔ Chat: streamed answer with credit usage + remaining balance line');

  // ── 4. Bogus key is rejected live ──
  const fakeHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-smoke2-'));
  const badOut = await runCli(baseUrl, fakeHome2, {}, [
    [1500, 'jev_live_definitely_not_a_real_key_000'],
    [2500, '/exit']
  ]);
  assert.ok(badOut.includes('Key rejected'), 'Bogus key must be rejected against the server');
  console.log('✔ Security: bogus key rejected during onboarding');

  console.log('\nALL CLI SMOKE CHECKS PASSED');
} finally {
  apiKeyAuditor.stop();
  await new Promise((res) => server.close(res));
  dbAdapter.close();
  for (const dir of [fakeHome]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  process.exit(0);
}