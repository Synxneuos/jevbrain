/**
 * Jev Brain agent + skills tests
 *
 * Drives the real CLI (`jevbrain do … --auto`) against a scripted mock model
 * (served on /api/chat/stream) and a mock GitHub API, in a throwaway repo.
 */
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseToolCalls, applyEdits, parseEditBlocks, JevAgent } from '../src/cli/agent.js';
import * as Skills from '../src/cli/skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'brain.js');

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-agent-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  fs.mkdirSync(work);
  fs.mkdirSync(home);
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'config', 'user.email', 'dev@example.com');
  sh(work, 'config', 'user.name', 'Dev');
  sh(work, 'config', 'commit.gpgsign', 'false');
  sh(work, 'remote', 'add', 'origin', 'https://github.com/acme/calc.git');
  sh(work, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/acme/calc.git');
  fs.writeFileSync(path.join(work, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(work, 'test.mjs'), "import assert from 'node:assert';\nimport { add } from './math.mjs';\nassert.strictEqual(add(2, 3), 5);\nconsole.log('tests pass');\n");
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'init');
  sh(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, bare, work, home };
}

function startMock(script) {
  const prompts = [];
  const prs = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/api/chat/stream') {
        prompts.push(json.prompt);
        const text = script[i++] ?? 'All done.';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // stream in small chunks like a real model
        for (let k = 0; k < text.length; k += 7) res.write(`data: ${JSON.stringify({ token: text.slice(k, k + 7) })}\n\n`);
        res.end(`data: ${JSON.stringify({ done: true, model: 'mock', creditDeduction: { creditsDeducted: 2, availableCredits: 98 } })}\n\n`);
        return;
      }
      if (req.url === '/repos/acme/calc/pulls' && req.method === 'POST') {
        prs.push(json);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ number: 3, html_url: 'https://github.com/acme/calc/pull/3' }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, prompts, prs, url: `http://127.0.0.1:${server.address().port}` })));
}

function runCli(cwd, home, url, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, JEV_ENDPOINT: url, JEV_API_KEY: 'jev_live_test', GITHUB_API_URL: url, GITHUB_TOKEN: 'tok', GH_TOKEN: '', HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.stdin.end();
    child.on('close', code => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('parser: multiple calls, self-closing tags and truncation detection', () => {
  const r = parseToolCalls('Look.\n<tool name="read_file" path="a.js"></tool><tool name="list_files" path="."/>\n<tool name="run">npm test</tool>');
  assert.deepStrictEqual(r.calls.map(c => c.name), ['read_file', 'list_files', 'run']);
  assert.strictEqual(r.calls[2].body, 'npm test');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(parseToolCalls('<tool name="write_file" path="x">abc').truncated, true);
});

test('edits: exact, whitespace-tolerant, CRLF-preserving, ambiguous rejected', () => {
  const blocks = (s, r) => parseEditBlocks(`<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`);
  assert.strictEqual(applyEdits('a\nb\nc\n', blocks('b', 'B')).text, 'a\nB\nc\n');
  assert.strictEqual(applyEdits('def f():\n    return 1\n', blocks('return 1', 'return 2')).text, 'def f():\n    return 2\n');
  assert.strictEqual(applyEdits('x\r\ny\r\n', blocks('y', 'z')).text, 'x\r\nz\r\n');
  assert.strictEqual(applyEdits('dup\ndup\n', blocks('dup', 'x')).ok, false);
  assert.strictEqual(applyEdits('abc\n', blocks('zzz', 'x')).ok, false);
});

test('agent sandbox: no writes outside project, no secrets, destructive commands blocked', async () => {
  const { work } = makeProject();
  fs.writeFileSync(path.join(work, '.env'), 'KEY=secret');
  const agent = new JevAgent({ cwd: work, mode: 'auto', ai: async () => null, write: () => {} });
  await assert.rejects(() => agent.execTool({ name: 'write_file', attrs: { path: '../evil.txt' }, body: 'x' }), /outside the project/);
  await assert.rejects(() => agent.execTool({ name: 'read_file', attrs: { path: '.env' }, body: '' }), /Warden/);
  const r = await agent.execTool({ name: 'run', attrs: {}, body: 'rm -rf /' });
  assert.match(r, /^BLOCKED/);
  const ro = new JevAgent({ cwd: work, mode: 'readonly', ai: async () => null, write: () => {} });
  assert.match(await ro.execTool({ name: 'write_file', attrs: { path: 'a.txt' }, body: 'x' }), /^DENIED/);
  assert.strictEqual(fs.existsSync(path.join(work, 'a.txt')), false);
});

test('jevbrain do --auto: reads, fixes (with continuation), tests, branches, commits and opens a PR', async () => {
  const { work, bare, home } = makeProject();
  const mock = await startMock([
    'Let me check the code and run the tests.\n<tool name="read_file" path="math.mjs"></tool>\n<tool name="run">node test.mjs</tool>',
    // reply cut off mid-tool-call by the output cap …
    'Found it: add subtracts.\n<tool name="edit_file" path="math.mjs">\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======',
    // … and continued in the next call
    '\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE\n</tool>',
    '<tool name="run">node test.mjs</tool>\n<tool name="run">rm -rf /</tool>',
    '<tool name="git" action="branch" branch="fix/add"></tool>\n<tool name="git" action="commit" message="fix(math): add numbers instead of subtracting"></tool>\n<tool name="git" action="pr" title="Fix add()">add() subtracted its arguments.</tool>',
    '<tool name="done">Fixed add() and opened a PR.</tool>'
  ]);
  try {
    const { out } = await runCli(work, home, mock.url, ['do', 'the tests fail, fix it and open a PR', '--auto']);

    assert.strictEqual(fs.readFileSync(path.join(work, 'math.mjs'), 'utf8'), 'export const add = (a, b) => a + b;\n', out);
    // tool results were fed back to the model
    assert.match(mock.prompts[1], /exit code 1/);
    assert.match(mock.prompts[1], /a - b/);
    // continuation prompt carried the partial reply
    assert.match(mock.prompts[2], /cut off by the output limit/);
    // second test run passed and rm -rf was blocked
    assert.match(mock.prompts[4], /tests pass/);
    assert.match(mock.prompts[4], /BLOCKED by Agent Warden/);
    // git flow
    assert.strictEqual(sh(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/add');
    assert.strictEqual(sh(work, 'log', '-1', '--pretty=%s'), 'fix(math): add numbers instead of subtracting');
    assert.ok(sh(bare, 'branch', '--list', 'fix/add').includes('fix/add'));
    assert.strictEqual(mock.prs.length, 1);
    assert.deepStrictEqual([mock.prs[0].head, mock.prs[0].base, mock.prs[0].title], ['fix/add', 'main', 'Fix add()']);
    // UI: prose shown, raw tool XML hidden, summary + credits printed
    assert.match(out, /Let me check the code/);
    assert.doesNotMatch(out, /<tool name=/);
    assert.match(out, /Fixed add\(\) and opened a PR\./);
    assert.match(out, /Credits used: 12/);
  } finally {
    mock.server.close();
  }
});

test('jevbrain do without --auto in a pipe is read-only', async () => {
  const { work, home } = makeProject();
  const mock = await startMock([
    '<tool name="write_file" path="hack.txt">x</tool>',
    'I could not write the file.'
  ]);
  try {
    await runCli(work, home, mock.url, ['do', 'create hack.txt']);
    assert.strictEqual(fs.existsSync(path.join(work, 'hack.txt')), false);
    assert.match(mock.prompts[1], /DENIED/);
  } finally {
    mock.server.close();
  }
});

test('skills: new, add from folder, list, --skill injects instructions, remove', async () => {
  const { root, work, home } = makeProject();

  // scaffold a project skill
  let r = await runCli(work, home, 'http://127.0.0.1:9', ['skill', 'new', 'release-notes', 'Write release notes from git log']);
  assert.match(r.out, /Created skill release-notes/);
  assert.ok(fs.existsSync(path.join(work, '.jevbrain', 'skills', 'release-notes', 'SKILL.md')));

  // a third-party skill pack with two skills + a helper script
  const pack = path.join(root, 'pack');
  fs.mkdirSync(path.join(pack, 'deploy-railway', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'deploy-railway', 'SKILL.md'), '---\nname: deploy-railway\ndescription: >\n  Deploy this app to Railway\n  safely.\n---\n# Deploy\nAlways run `railway status` first. SECRET_PHRASE_42\n');
  fs.writeFileSync(path.join(pack, 'deploy-railway', 'scripts', 'check.sh'), 'echo ok\n');
  fs.mkdirSync(path.join(pack, 'lint'));
  fs.writeFileSync(path.join(pack, 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint the code\n---\nRun eslint.\n');
  r = await runCli(work, home, 'http://127.0.0.1:9', ['skill', 'add', pack, '--global']);
  assert.match(r.out, /Installed deploy-railway/);
  assert.match(r.out, /Installed lint/);
  assert.ok(fs.existsSync(path.join(home, '.jevbrain', 'skills', 'deploy-railway', 'scripts', 'check.sh')));

  r = await runCli(work, home, 'http://127.0.0.1:9', ['skill', 'list']);
  assert.match(r.out, /deploy-railway\s+\[global\] Deploy this app to Railway safely\./);
  assert.match(r.out, /release-notes\s+\[project\]/);

  // --skill puts the skill body into the agent prompt; catalog lists all skills
  const mock = await startMock(['<tool name="done">ok</tool>']);
  try {
    await runCli(work, home, mock.url, ['do', 'deploy', '--skill', 'deploy-railway', '--auto']);
    assert.match(mock.prompts[0], /ACTIVE SKILL[\s\S]*SECRET_PHRASE_42/);
    assert.match(mock.prompts[0], /scripts\/check\.sh/);
    assert.match(mock.prompts[0], /- lint: Lint the code/);
  } finally {
    mock.server.close();
  }

  r = await runCli(work, home, 'http://127.0.0.1:9', ['skill', 'remove', 'lint']);
  assert.match(r.out, /Removed lint/);
  assert.strictEqual(fs.existsSync(path.join(home, '.jevbrain', 'skills', 'lint')), false);
});

test('skills: load_skill tool and GitHub source parsing', async () => {
  const { work } = makeProject();
  Skills.createSkill('my-flow', { description: 'demo', cwd: work });
  const agent = new JevAgent({ cwd: work, mode: 'auto', ai: async () => null, write: () => {} });
  const res = await agent.execTool({ name: 'load_skill', attrs: { skill: 'my-flow' }, body: '' });
  assert.match(res, /# Skill: my-flow/);
  assert.ok(agent.activeSkills.has('my-flow'));

  assert.deepStrictEqual(Skills.parseRemoteSource('github:acme/skills/devops/deploy@v2'), { url: 'https://github.com/acme/skills.git', subpath: 'devops/deploy', ref: 'v2' });
  assert.deepStrictEqual(Skills.parseRemoteSource('https://github.com/acme/skills/tree/main/lint'), { url: 'https://github.com/acme/skills.git', ref: 'main', subpath: 'lint' });
  assert.deepStrictEqual(Skills.parseRemoteSource('https://github.com/acme/skills'), { url: 'https://github.com/acme/skills.git', ref: null, subpath: '' });
  assert.strictEqual(Skills.createSkill('Bad Name!', { cwd: work }).ok, false);
});

test('agent ignores tool examples echoed back from its own instructions', async () => {
  const { work } = makeProject();
  let prompt = '';
  const agent = new JevAgent({
    cwd: work,
    mode: 'auto',
    write: () => {},
    ai: async (p) => {
      if (!prompt) { prompt = p; return { text: p }; } // echo the whole prompt back once
      return { text: 'nothing to do' };
    }
  });
  await agent.run('hello');
  assert.strictEqual(fs.existsSync(path.join(work, 'src', 'new.js')), false, 'example write_file must not execute');
});

// ─────────────────────────────────────────────────────────────────────────────
// Arena + undo
// ─────────────────────────────────────────────────────────────────────────────

function startModelMock(scripts) {
  const counters = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { model } = JSON.parse(body || '{}');
      const i = counters[model] = (counters[model] ?? -1) + 1;
      const text = (scripts[model] || [])[i] ?? '<tool name="done">nothing more</tool>';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ token: text })}\n\n`);
      res.end(`data: ${JSON.stringify({ done: true, model, creditDeduction: { creditsDeducted: 1, availableCredits: 50 } })}\n\n`);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const EDIT = (to) => `<tool name="edit_file" path="math.mjs">\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = ${to};\n>>>>>>> REPLACE\n</tool>`;

test('arena: contenders race in sandboxes, tests pick the winner, winner is applied', async () => {
  const { work, home } = makeProject();
  fs.writeFileSync(path.join(work, 'notes.txt'), 'uncommitted work\n'); // untracked file must survive
  const mock = await startModelMock({
    good: [EDIT('(a, b) => a + b'), '<tool name="run">node test.mjs</tool>', '<tool name="done">fixed</tool>'],
    bad: [EDIT('(a, b) => a * b'), '<tool name="done">fixed?</tool>'],
    lazy: ['I think the code is fine.']
  });
  try {
    const { out } = await runCli(work, home, mock.url, ['arena', 'make the test pass', '--test', 'node test.mjs', '--models', 'bad,lazy,good', '--apply']);
    assert.match(out, /JEV BRAIN ARENA/);
    assert.match(out, /Winner: C good/, out);
    assert.match(out, /🥇 C good\s+PASS/);
    assert.match(out, /bad\s+FAIL/);
    assert.match(out, /lazy\s+no change/);
    assert.strictEqual(fs.readFileSync(path.join(work, 'math.mjs'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    assert.strictEqual(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'uncommitted work\n');
    // sandboxes cleaned up
    assert.strictEqual(sh(work, 'worktree', 'list').split('\n').length, 1);
    // main branch history untouched (changes are in the working tree, ready to review / ship)
    assert.strictEqual(sh(work, 'log', '--oneline').split('\n').length, 1);
  } finally {
    mock.server.close();
  }
});

test('arena: no passing contender → nothing applied', async () => {
  const { work, home } = makeProject();
  const mock = await startModelMock({ bad: [EDIT('(a, b) => a * b'), '<tool name="done">x</tool>'] });
  try {
    const { out } = await runCli(work, home, mock.url, ['arena', 'fix', '--test', 'node test.mjs', '--models', 'bad', '-n', '2', '--apply']);
    assert.match(out, /No contender produced a passing change/);
    assert.strictEqual(fs.readFileSync(path.join(work, 'math.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n');
    assert.strictEqual(sh(work, 'worktree', 'list').split('\n').length, 1);
  } finally {
    mock.server.close();
  }
});

test('undo reverts edits and removes files the agent created', async () => {
  const { work } = makeProject();
  const replies = [
    `${EDIT('(a, b) => a + b')}\n<tool name="write_file" path="docs/NEW.md">hello</tool>`,
    '<tool name="done">ok</tool>'
  ];
  let i = 0;
  const agent = new JevAgent({ cwd: work, mode: 'auto', write: () => {}, ai: async () => ({ text: replies[i++] }) });
  await agent.run('fix and document');
  assert.match(fs.readFileSync(path.join(work, 'math.mjs'), 'utf8'), /a \+ b/);
  assert.ok(fs.existsSync(path.join(work, 'docs', 'NEW.md')));
  const r = agent.undo();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(work, 'math.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n');
  assert.strictEqual(fs.existsSync(path.join(work, 'docs', 'NEW.md')), false);
  assert.strictEqual(agent.undo().ok, false);
});
