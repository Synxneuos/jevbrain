/**
 * Jev Brain Arena — several AI agents race to solve the same task; your tests pick the winner.
 *
 *   jevbrain arena "fix the failing login test" --test "npm test" --models deepseek/deepseek-chat,openai/gpt-4o
 *
 * How it works
 *  1. Snapshot the repo (HEAD + your uncommitted tracked changes, via `git stash create`).
 *  2. Give every contender its own throwaway git worktree of that snapshot.
 *  3. Run one JevAgent per contender in parallel (auto-approve is safe: each works in
 *     its own sandbox copy; the Agent Warden still blocks destructive commands).
 *  4. Run the judge command (your tests) in every worktree.
 *  5. Rank: tests passed → fewer steps → fewer credits → smaller diff.
 *  6. Apply the winner's patch to your working tree (you confirm), clean up.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JevAgent } from './agent.js';
import * as G from './git-workflow.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const GOLD = '\x1b[38;5;220m';
const PALETTE = ['\x1b[38;5;51m', '\x1b[38;5;201m', '\x1b[38;5;220m', '\x1b[38;5;48m', '\x1b[38;5;141m'];
const MEDALS = ['🥇', '🥈', '🥉', '4.', '5.'];

function runShell(command, cwd, timeoutSec = 300) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.stdin.end();
    const timer = setTimeout(() => { out += `\n[timeout after ${timeoutSec}s]`; try { child.kill(); } catch {} }, timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function shortModel(m) {
  return m === 'auto' ? 'auto-router' : m.split('/').pop();
}

/** Rank contenders: passing tests first, then efficiency, then smallest change. */
export function rankContenders(list) {
  return [...list].sort((a, b) =>
    (Number(b.passed) - Number(a.passed)) ||
    (Number(b.changed) - Number(a.changed)) ||
    (a.stats.steps - b.stats.steps) ||
    (a.stats.credits - b.stats.credits) ||
    (a.linesChanged - b.linesChanged)
  );
}

class Board {
  constructor(contenders, write) {
    this.c = contenders;
    this.write = write;
    this.tty = process.stdout.isTTY;
    this.drawn = false;
    this.timer = null;
  }
  line(x) {
    const color = PALETTE[x.idx % PALETTE.length];
    const state = x.state === 'done' ? `${GREEN}✔ finished${RESET}` : x.state === 'failed' ? `${RED}✖ ${x.error || 'failed'}${RESET}` : `${YELLOW}● step ${x.step}${RESET}`;
    const last = (x.last || 'thinking…').slice(0, 52);
    return `  ${color}${BOLD}${x.label.padEnd(3)}${RESET} ${color}${shortModel(x.model).padEnd(24)}${RESET} ${state.padEnd(28)} ${GRAY}${last}${RESET}`;
  }
  render() {
    if (!this.tty) return;
    if (this.drawn) this.write(`\x1b[${this.c.length}A`);
    for (const x of this.c) this.write(`\x1b[2K${this.line(x)}\n`);
    this.drawn = true;
  }
  start() {
    if (this.tty) { this.render(); this.timer = setInterval(() => this.render(), 250); }
  }
  event(x, msg) {
    if (!this.tty) this.write(`  ${x.label} ${shortModel(x.model)}: ${msg}\n`);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.render();
  }
}

/**
 * @param {object} o
 * @param {string} o.task
 * @param {string[]} o.models            one entry per contender (repeats allowed = best-of-N)
 * @param {string} [o.test]              judge command, e.g. "npm test"
 * @param {(model:string)=>(prompt:string,onToken:Function)=>Promise<object|null>} o.aiFor
 * @param {(q:string)=>Promise<string>} [o.ask]
 * @param {boolean} [o.apply]            apply the winner without asking
 * @param {boolean} [o.keep]             keep worktrees for inspection
 * @param {number} [o.maxSteps]
 * @param {string[]} [o.skills]
 * @param {string} [o.cwd]
 * @param {(s:string)=>void} [o.write]
 */
export async function runArena(o) {
  const write = o.write || ((s) => process.stdout.write(s));
  const log = (s = '') => write(`${s}\n`);
  const cwd = o.cwd || process.cwd();
  const root = G.repoRoot(cwd);
  if (!root) { log(`${YELLOW}Arena needs a git repository (run it inside your project).${RESET}`); return null; }
  if (!G.git(['rev-parse', '--verify', 'HEAD'], root).ok) { log(`${YELLOW}Arena needs at least one commit.${RESET}`); return null; }
  const models = (o.models && o.models.length ? o.models : ['auto', 'auto', 'auto']).slice(0, 5);

  // 1. Snapshot: HEAD + uncommitted tracked changes
  const stash = G.git(['stash', 'create'], root);
  const base = stash.ok && stash.stdout ? stash.stdout : G.git(['rev-parse', 'HEAD'], root).stdout;
  const untracked = G.status(root)?.untracked || [];

  const runId = Date.now().toString(36);
  const arenaDir = fs.mkdtempSync(path.join(os.tmpdir(), `jev-arena-${runId}-`));
  const contenders = models.map((model, idx) => ({
    idx, model, label: String.fromCharCode(65 + idx),
    dir: path.join(arenaDir, String.fromCharCode(97 + idx)),
    state: 'running', step: 0, last: '', stats: { steps: 0, credits: 0, ms: 0 }
  }));

  log(`\n  ${GOLD}${BOLD}⚔  JEV BRAIN ARENA${RESET} ${GRAY}— ${contenders.length} agents, 1 task, your tests decide${RESET}`);
  log(`  ${GRAY}Task:${RESET} ${o.task}`);
  log(`  ${GRAY}Judge:${RESET} ${o.test ? `${CYAN}${o.test}${RESET}` : `${YELLOW}none (pass --test "npm test" to let tests pick the winner)${RESET}`}`);
  if (untracked.length) log(`  ${GRAY}Note: ${untracked.length} untracked file(s) are not copied into the arena.${RESET}`);
  log('');

  // 2. Worktrees
  for (const c of contenders) {
    const r = G.git(['worktree', 'add', '--detach', '--quiet', c.dir, base], root);
    if (!r.ok) { log(`${RED}✖ Could not create sandbox: ${r.stderr}${RESET}`); cleanup(); return null; }
  }

  function cleanup() {
    if (o.keep) return;
    for (const c of contenders) G.git(['worktree', 'remove', '--force', c.dir], root);
    G.git(['worktree', 'prune'], root);
    try { fs.rmSync(arenaDir, { recursive: true, force: true }); } catch {}
  }

  // 3. Race
  const board = new Board(contenders, write);
  board.start();
  const started = Date.now();
  await Promise.all(contenders.map(async (c) => {
    const agent = new JevAgent({
      cwd: c.dir,
      mode: 'auto',
      maxSteps: o.maxSteps || 15,
      write: () => {},
      ai: o.aiFor(c.model),
      onEvent: (e) => {
        if (e.type === 'step') c.step = e.step;
        if (e.type === 'tool') { c.last = e.label; board.event(c, e.label); }
        if (e.type === 'done') c.stats = e.stats;
      }
    });
    for (const s of o.skills || []) agent.activeSkills.add(s);
    try {
      c.answer = await agent.run(o.task);
      c.state = /request failed/i.test(c.answer || '') ? 'failed' : 'done';
      if (c.state === 'failed') c.error = 'model error';
    } catch (err) {
      c.state = 'failed';
      c.error = err.message.slice(0, 40);
    }
    c.stats = agent.lastStats || c.stats;
    board.event(c, c.state);
  }));
  board.stop();

  // 4. Judge
  log(`\n  ${GRAY}Judging${o.test ? ` with ${o.test}` : ''}…${RESET}`);
  await Promise.all(contenders.map(async (c) => {
    G.git(['add', '-A'], c.dir);
    c.patch = G.git(['diff', '--cached', '--binary', base], c.dir).stdout;
    c.patch = c.patch ? `${c.patch}\n` : '';
    const stat = G.git(['diff', '--cached', '--numstat', base], c.dir).stdout;
    c.files = stat ? stat.split('\n').length : 0;
    c.linesChanged = stat ? stat.split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0) : 0;
    c.changed = c.files > 0;
    if (o.test && c.changed) {
      const t = await runShell(o.test, c.dir, 300);
      c.passed = t.code === 0;
      c.testTail = t.out.trim().split('\n').slice(-3).join(' ⏎ ').slice(0, 160);
    } else {
      c.passed = !o.test && c.changed; // without a judge, "made a change" is the bar
    }
  }));

  // 5. Leaderboard
  const ranked = rankContenders(contenders);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`\n  ${BOLD}Leaderboard${RESET} ${GRAY}(${secs}s)${RESET}`);
  log(`  ${GRAY}${'   '}${'model'.padEnd(26)}${'tests'.padEnd(10)}${'steps'.padEnd(7)}${'credits'.padEnd(9)}diff${RESET}`);
  ranked.forEach((c, i) => {
    const color = PALETTE[c.idx % PALETTE.length];
    const [testText, testColor] = !c.changed ? ['no change', GRAY] : o.test ? (c.passed ? ['PASS', GREEN] : ['FAIL', RED]) : ['—', GRAY];
    const tests = `${testColor}${testText.padEnd(10)}${RESET}`;
    log(`  ${MEDALS[i]} ${color}${(`${c.label} ${shortModel(c.model)}`).padEnd(26)}${RESET}${tests}${String(c.stats.steps).padEnd(7)}${String(c.stats.credits).padEnd(9)}${c.changed ? `${c.files} file(s), ±${c.linesChanged}` : '—'}`);
  });

  const winner = ranked[0];
  const hasWinner = winner && winner.changed && (winner.passed || !o.test);
  if (!hasWinner) {
    log(`\n  ${YELLOW}No contender produced a ${o.test ? 'passing ' : ''}change. Nothing applied.${RESET}`);
    if (o.keep) log(`  ${GRAY}Sandboxes kept in ${arenaDir}${RESET}`);
    cleanup();
    return { winner: null, contenders: ranked };
  }

  log(`\n  ${GOLD}${BOLD}🏆 Winner: ${winner.label} ${shortModel(winner.model)}${RESET}${winner.answer ? ` ${GRAY}— ${winner.answer.split('\n')[0].slice(0, 100)}${RESET}` : ''}`);
  log(`${DIM}${G.truncate(G.git(['diff', '--cached', '--stat', base], winner.dir).stdout, 2000)}${RESET}`);

  // 6. Apply
  let apply = !!o.apply;
  if (!apply && o.ask) {
    const ans = String(await o.ask(`\n  Apply the winner's changes to your project? ${GRAY}[Y/n]${RESET} `)).trim().toLowerCase();
    apply = ans === '' || ans === 'y' || ans === 'yes';
  }
  let applied = false;
  if (apply) {
    const patchFile = path.join(arenaDir, 'winner.patch');
    fs.writeFileSync(patchFile, winner.patch);
    const r = G.git(['apply', '--whitespace=nowarn', patchFile], root);
    if (r.ok) {
      applied = true;
      log(`  ${GREEN}✔ Applied. Review with ${CYAN}/diff${GREEN}, ship with ${CYAN}/ship${GREEN}.${RESET}`);
    } else {
      const saved = path.join(root, `.jevbrain-arena-${runId}.patch`);
      fs.writeFileSync(saved, winner.patch);
      log(`  ${RED}✖ Patch didn't apply cleanly (${r.stderr.split('\n')[0]}).${RESET} ${GRAY}Saved to ${saved}${RESET}`);
    }
  } else {
    const saved = path.join(root, `.jevbrain-arena-${runId}.patch`);
    fs.writeFileSync(saved, winner.patch);
    log(`  ${GRAY}Not applied. Patch saved to ${saved} (git apply it anytime).${RESET}`);
  }
  if (o.keep) log(`  ${GRAY}Sandboxes kept in ${arenaDir}${RESET}`);
  cleanup();
  return { winner, applied, contenders: ranked };
}
