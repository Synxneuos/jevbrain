/**
 * Git / GitHub workflow test
 *
 * Runs the real CLI (`jevbrain ship -y`, `jevbrain commit`, …) against:
 *  - a throwaway git repo whose origin is "https://github.com/acme/demo.git"
 *    (pushes are redirected to a local bare repo via pushInsteadOf)
 *  - a mock Jev Brain /api/chat/stream (AI commit message / PR text / branch name)
 *  - a mock GitHub REST API (GITHUB_API_URL) that records the created PR
 */
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from '../src/cli/git-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'brain.js');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-git-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'config', 'user.email', 'dev@example.com');
  sh(work, 'config', 'user.name', 'Dev');
  sh(work, 'config', 'commit.gpgsign', 'false');
  sh(work, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  sh(work, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/acme/demo.git');
  fs.writeFileSync(path.join(work, 'app.js'), 'console.log("v1");\n');
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'init');
  sh(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, bare, work };
}

function startMocks() {
  const prs = [];
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/api/chat/stream') {
        prompts.push(json.prompt);
        let text = 'ok';
        if (json.prompt.includes('commit message')) text = 'fix(app): bump version string\n\n- change log output to v2';
        else if (json.prompt.includes('pull request')) text = 'TITLE: Bump app version\n\n## Summary\n- v2';
        else if (json.prompt.includes('branch name')) text = 'fix/bump-version';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ token: text })}\n\n`);
        res.end(`data: ${JSON.stringify({ done: true, model: 'mock' })}\n\n`);
        return;
      }
      if (req.url === '/repos/acme/demo/pulls' && req.method === 'POST') {
        assert.match(req.headers.authorization, /^Bearer test-token$/);
        prs.push(json);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ number: 7, html_url: 'https://github.com/acme/demo/pull/7' }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, prs, prompts, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

function cli(cwd, mockUrl, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        JEV_ENDPOINT: mockUrl,
        JEV_API_KEY: 'jev_live_test',
        GITHUB_API_URL: mockUrl,
        GITHUB_TOKEN: 'test-token',
        GH_TOKEN: '',
        PATH: process.env.PATH,
        HOME: cwd
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.stdin.end();
    child.on('close', code => resolve({ code, out }));
  });
}

test('parseGitHubRemote handles https, ssh and token URLs', () => {
  assert.deepStrictEqual(G.parseGitHubRemote('https://github.com/Synxneuos/jevbrain.git'), { owner: 'Synxneuos', repo: 'jevbrain' });
  assert.deepStrictEqual(G.parseGitHubRemote('git@github.com:Synxneuos/jevbrain.git'), { owner: 'Synxneuos', repo: 'jevbrain' });
  assert.deepStrictEqual(G.parseGitHubRemote('ssh://git@github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepStrictEqual(G.parseGitHubRemote('https://x:tok@github.com/o/my.repo.git'), { owner: 'o', repo: 'my.repo' });
  assert.strictEqual(G.parseGitHubRemote('https://gitlab.com/o/r.git'), null);
});

test('toBranchName produces safe, typed branch names', () => {
  assert.strictEqual(G.toBranchName('Fix login bug on mobile!'), 'fix/login-bug-on-mobile');
  assert.strictEqual(G.toBranchName('feat: GitHub PR flow'), 'feat/github-pr-flow');
  assert.strictEqual(G.toBranchName('add dark mode'), 'feat/add-dark-mode');
  assert.ok(G.toBranchName('$(rm -rf /); `x`').match(/^[a-z]+\/[a-z0-9-]+$/));
});

test('readFileForContext refuses paths outside the repo and secret files', () => {
  const { work } = makeRepo();
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1');
  assert.strictEqual(G.readFileForContext('app.js', work).ok, true);
  assert.strictEqual(G.readFileForContext('../remote.git/config', work).ok, false);
  assert.strictEqual(G.readFileForContext('.env', work).ok, false);
});

test('jevbrain ship -y: branch → Warden-checked commit → push → PR', async () => {
  const { work, bare } = makeRepo();
  const mocks = await startMocks();
  try {
    fs.writeFileSync(path.join(work, 'app.js'), 'console.log("v2");\n');
    fs.writeFileSync(path.join(work, '.env'), 'PRIVATE_KEY=abc\n');

    const { out } = await cli(work, mocks.url, ['ship', '-y']);

    // Branch was created off main with the AI-suggested name
    assert.strictEqual(sh(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/bump-version', out);
    // Commit used the AI message and did NOT include the .env file
    assert.strictEqual(sh(work, 'log', '-1', '--pretty=%s'), 'fix(app): bump version string');
    const committed = sh(work, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean);
    assert.deepStrictEqual(committed, ['app.js']);
    assert.match(out, /Agent Warden kept these out/);
    // Branch reached the remote
    assert.ok(sh(bare, 'branch', '--list', 'fix/bump-version').includes('fix/bump-version'));
    // PR created against main with AI title
    assert.strictEqual(mocks.prs.length, 1);
    assert.deepStrictEqual(
      { head: mocks.prs[0].head, base: mocks.prs[0].base, title: mocks.prs[0].title },
      { head: 'fix/bump-version', base: 'main', title: 'Bump app version' }
    );
    assert.match(out, /pull\/7/);
  } finally {
    mocks.server.close();
  }
});

test('jevbrain pr refuses to run from the base branch', async () => {
  const { work } = makeRepo();
  const mocks = await startMocks();
  try {
    const { out } = await cli(work, mocks.url, ['pr', '-y']);
    assert.match(out, /You're on main/);
    assert.strictEqual(mocks.prs.length, 0);
  } finally {
    mocks.server.close();
  }
});

test('jevbrain commit "msg" uses the given message and skips the AI', async () => {
  const { work } = makeRepo();
  const mocks = await startMocks();
  try {
    fs.writeFileSync(path.join(work, 'new.txt'), 'hello\n');
    await cli(work, mocks.url, ['commit', 'docs: add note', '-y']);
    assert.strictEqual(sh(work, 'log', '-1', '--pretty=%s'), 'docs: add note');
    assert.strictEqual(mocks.prompts.length, 0);
  } finally {
    mocks.server.close();
  }
});
