/**
 * Jev Brain CLI — Autonomous terminal agent
 *
 * Turns any model behind the Jev Brain API into a Hermes-style agent that can
 * explore the project, edit files, run commands, use git/GitHub and load skills.
 *
 * The backend exposes plain text completion (prompt → streamed text, ~512
 * output tokens per call), so tool use is done with a compact XML protocol the
 * model writes inline:
 *
 *   <tool name="read_file" path="src/app.js"></tool>
 *   <tool name="run">npm test</tool>
 *   <tool name="edit_file" path="src/app.js">
 *   <<<<<<< SEARCH
 *   old lines
 *   =======
 *   new lines
 *   >>>>>>> REPLACE
 *   </tool>
 *
 * Replies cut off by the output cap mid-tool-call are continued automatically.
 * Every action goes through the Agent Warden; writes and shell commands need
 * the user's approval unless auto mode is on, and destructive commands are
 * always blocked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AgentWarden } from '../core/warden.js';
import * as G from './git-workflow.js';
import * as Skills from './skills.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.idea', '.kilo', '.netlify', '.vercel']);
const MAX_RESULT_CHARS = 6000;
const TRANSCRIPT_BUDGET = 28000;
const MAX_CONTINUATIONS = 6;

export const TOOL_NAMES = ['list_files', 'read_file', 'search', 'write_file', 'append_file', 'edit_file', 'run', 'git', 'load_skill', 'done'];

// ─────────────────────────────────────────────────────────────────────────────
// Protocol parsing
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_RE = /<tool\b((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/tool>)/g;

export function parseAttrs(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function trimBody(body) {
  if (body === undefined) return '';
  return body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

/** Extract tool calls; `truncated` is true when a <tool …> was opened but never closed. */
export function parseToolCalls(text) {
  const calls = [];
  const src = String(text || '');
  for (const m of src.matchAll(TOOL_RE)) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.name) continue;
    calls.push({ name: attrs.name, attrs, body: trimBody(m[2]), raw: m[0] });
  }
  const leftover = src.replace(TOOL_RE, '');
  const truncated = /<tool\b/.test(leftover);
  return { calls, truncated };
}

export function stripToolCalls(text) {
  return String(text || '').replace(TOOL_RE, '').replace(/<tool\b[\s\S]*$/, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Streams model output to the terminal while hiding the raw <tool>…</tool> markup. */
export class ToolTagFilter {
  constructor(write) {
    this.write = write;
    this.buf = '';
    this.inTag = false;
    this.printedAny = false;
  }
  push(token) {
    this.buf += token;
    let out = '';
    for (;;) {
      if (this.inTag) {
        const end = this.buf.indexOf('</tool>');
        const selfClose = this.buf.match(/^<tool\b[^>]*\/>/);
        if (selfClose) { this.buf = this.buf.slice(selfClose[0].length); this.inTag = false; this.afterTag = true; continue; }
        if (end === -1) break;
        this.buf = this.buf.slice(end + 7);
        this.inTag = false;
        this.afterTag = true;
        continue;
      }
      const start = this.buf.indexOf('<tool');
      if (start === -1) {
        // hold back a possible partial "<tool" at the end
        const lt = this.buf.lastIndexOf('<');
        const safe = lt !== -1 && '<tool'.startsWith(this.buf.slice(lt)) ? lt : this.buf.length;
        out += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        break;
      }
      out += this.buf.slice(0, start);
      this.buf = this.buf.slice(start);
      this.inTag = true;
    }
    if (out) {
      const cleaned = this.printedAny && !this.afterTag ? out : out.replace(/^\s+/, '');
      if (cleaned) {
        this.write(this.afterTag && this.printedAny ? `\n${cleaned}` : cleaned);
        this.printedAny = true;
        this.afterTag = false;
      }
    }
  }
  flush() {
    if (!this.inTag && this.buf.trim() && !this.buf.startsWith('<tool')) this.write(this.buf);
    this.buf = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH/REPLACE editing
// ─────────────────────────────────────────────────────────────────────────────

export function parseEditBlocks(body) {
  const blocks = [];
  const re = /<{5,9} ?SEARCH[^\n]*\r?\n([\s\S]*?)\r?\n?={5,9}[^\n]*\r?\n([\s\S]*?)\r?\n?>{5,9} ?REPLACE/g;
  for (const m of String(body || '').matchAll(re)) blocks.push({ search: m[1], replace: m[2] });
  return blocks;
}

function findLineMatch(lines, searchLines, norm) {
  const target = searchLines.map(norm);
  const hits = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(lines[i + j]) !== target[j]) { ok = false; break; }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Apply SEARCH/REPLACE blocks to text. Exact match first, then whitespace-tolerant. */
export function applyEdits(original, blocks) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(/\r\n/g, '\n');
  const report = [];
  for (const [idx, b] of blocks.entries()) {
    const search = b.search.replace(/\r\n/g, '\n');
    const replace = b.replace.replace(/\r\n/g, '\n');
    if (!search.trim()) {
      return { ok: false, error: `Block ${idx + 1}: SEARCH section is empty. To create or overwrite a file use write_file.` };
    }
    const count = text.split(search).length - 1;
    if (count === 1) {
      text = text.replace(search, () => replace);
      report.push(`block ${idx + 1}: exact`);
      continue;
    }
    if (count > 1) {
      return { ok: false, error: `Block ${idx + 1}: SEARCH text appears ${count} times — include more surrounding lines so it is unique.` };
    }
    const lines = text.split('\n');
    const sLines = search.replace(/\n$/, '').split('\n');
    let hits = findLineMatch(lines, sLines, l => l.trimEnd());
    let mode = 'trailing-whitespace';
    if (hits.length !== 1) { hits = findLineMatch(lines, sLines, l => l.trim()); mode = 'indent-insensitive'; }
    if (hits.length === 1) {
      const start = hits[0];
      let repLines = replace.replace(/\n$/, '').split('\n');
      if (mode === 'indent-insensitive') {
        // Re-indent the replacement by the difference between file and model indentation
        const fileIndent = (lines[start].match(/^\s*/) || [''])[0];
        const modelIndent = (sLines[0].match(/^\s*/) || [''])[0];
        if (fileIndent !== modelIndent) {
          repLines = repLines.map(l => (l.startsWith(modelIndent) ? fileIndent + l.slice(modelIndent.length) : l));
        }
      }
      lines.splice(start, sLines.length, ...(replace === '' ? [] : repLines));
      text = lines.join('\n');
      report.push(`block ${idx + 1}: ${mode}`);
      continue;
    }
    return {
      ok: false,
      error: `Block ${idx + 1}: SEARCH text not found${hits.length > 1 ? ' uniquely' : ''}. Re-read the file and copy the exact current lines.`
    };
  }
  return { ok: true, text: eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// File-system helpers
// ─────────────────────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function truncate(text, max = MAX_RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.25));
  return `${head}\n… [${s.length - head.length - tail.length} chars omitted] …\n${tail}`;
}

function walk(root, { maxDepth = 3, maxEntries = 400 } = {}) {
  const out = [];
  const rec = (dir, depth) => {
    if (out.length >= maxEntries) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (IGNORED_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ path: p, dir: true, depth });
        if (depth < maxDepth) rec(p, depth + 1);
      } else if (e.isFile()) {
        out.push({ path: p, dir: false, depth });
      }
    }
  };
  rec(root, 0);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent
// ─────────────────────────────────────────────────────────────────────────────

export class JevAgent {
  /**
   * @param {object} opts
   * @param {(prompt:string, onToken:(t:string)=>void)=>Promise<{text:string, creditDeduction?:object}|null>} opts.ai
   * @param {(q:string)=>Promise<string>} [opts.ask]   interactive approval; omit for non-interactive
   * @param {'ask'|'auto'|'readonly'} [opts.mode]
   * @param {string} [opts.cwd]
   * @param {number} [opts.maxSteps]
   * @param {(s:string)=>void} [opts.write]
   */
  constructor(opts) {
    this.ai = opts.ai;
    this.ask = opts.ask || null;
    this.mode = opts.mode || (opts.ask ? 'ask' : 'readonly');
    this.cwd = opts.cwd || process.cwd();
    this.root = G.repoRoot(this.cwd) || this.cwd;
    this.maxSteps = opts.maxSteps || 20;
    this.write = opts.write || ((s) => process.stdout.write(s));
    this.warden = new AgentWarden();
    this.alwaysAllow = new Set();
    this.activeSkills = new Set();
    this.history = []; // previous tasks in this session: { task, answer }
    this.creditsUsed = 0;
    this.lastBalance = null;
    this.onEvent = opts.onEvent || null; // ({ type: 'step'|'tool'|'result'|'done', … }) — used by Arena
    this.undoStack = [];                  // [{ task, files: Map<abs, original|null> }]
    this.pendingChanges = null;           // files touched by the task currently running
    this.lastStats = null;                // { steps, toolCalls, credits, ms }
  }

  log(line = '') {
    this.write(`${line}\n`);
  }

  // ── Path safety ─────────────────────────────────────────────────────────
  resolvePath(p, { forWrite = false } = {}) {
    if (!p) throw new Error('path is required');
    const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    const abs = path.resolve(this.cwd, expanded);
    const relToRoot = path.relative(this.root, abs);
    const insideProject = !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot);
    const insideSkill = !forWrite && Skills.listSkills(this.cwd).some(s => {
      const r = path.relative(s.baseDir, abs);
      return !r.startsWith('..') && !path.isAbsolute(r);
    });
    if (!insideProject && !insideSkill) {
      throw new Error(`Path "${p}" is outside the project (${this.root}). Only project files${forWrite ? '' : ' and skill files'} are accessible.`);
    }
    const check = this.warden.checkTargetFile(toPosix(insideProject ? relToRoot : abs));
    if (!check.ok) throw new Error(`Blocked by Agent Warden: ${check.reason}`);
    return { abs, rel: insideProject ? toPosix(relToRoot) || '.' : abs };
  }

  async approve(kind, summary, preview = '') {
    if (this.mode === 'auto' || this.alwaysAllow.has(kind)) return true;
    if (this.mode === 'readonly' || !this.ask) return false;
    return this.askHuman(kind, summary, preview);
  }

  async askHuman(kind, summary, preview = '') {
    if (!this.ask) return false;
    this.log(`\n  ${YELLOW}${BOLD}? ${summary}${RESET}`);
    if (preview) this.log(`${GRAY}${preview.split('\n').slice(0, 20).map(l => `    │ ${l}`).join('\n')}${RESET}`);
    const ans = String(await this.ask(`    ${YELLOW}Allow? ${GRAY}[y]es / [n]o / [a]lways for ${kind} this session:${RESET} `)).trim().toLowerCase();
    if (ans === 'a' || ans === 'always') { this.alwaysAllow.add(kind); return true; }
    return ans === 'y' || ans === 'yes';
  }

  // ── Tools ───────────────────────────────────────────────────────────────
  async execTool(call) {
    const a = call.attrs;
    switch (call.name) {
      case 'list_files': {
        const { abs, rel } = this.resolvePath(a.path || '.');
        const depth = Math.min(Number(a.depth) || 2, 5);
        const entries = walk(abs, { maxDepth: depth - 1 });
        const lines = entries.map(e => `${'  '.repeat(e.depth)}${path.basename(e.path)}${e.dir ? '/' : ''}`);
        return `${rel}/ (${entries.length} entries${entries.length >= 400 ? ', truncated' : ''})\n${lines.join('\n')}`;
      }
      case 'read_file': {
        const { abs, rel } = this.resolvePath(a.path);
        const buf = fs.readFileSync(abs);
        if (isBinary(buf)) return `${rel} is a binary file (${buf.length} bytes).`;
        const lines = buf.toString('utf8').split(/\r?\n/);
        const start = Math.max(1, Number(a.start) || 1);
        const end = Math.min(lines.length, Number(a.end) || start + 399);
        const body = lines.slice(start - 1, end).join('\n');
        const more = end < lines.length ? `\n[… ${lines.length - end} more lines — read_file with start="${end + 1}"]` : '';
        return `${rel} (lines ${start}-${end} of ${lines.length})\n\`\`\`\n${truncate(body, 16000)}\n\`\`\`${more}`;
      }
      case 'search': {
        if (!a.pattern) throw new Error('pattern is required');
        let re;
        try { re = new RegExp(a.pattern, a.case === 'sensitive' ? '' : 'i'); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
        const { abs } = this.resolvePath(a.path || '.');
        const files = fs.statSync(abs).isFile() ? [{ path: abs, dir: false }] : walk(abs, { maxDepth: 8, maxEntries: 5000 });
        const hits = [];
        for (const f of files) {
          if (f.dir || hits.length >= 80) continue;
          let buf;
          try { buf = fs.readFileSync(f.path); } catch { continue; }
          if (buf.length > 1_000_000 || isBinary(buf)) continue;
          const lines = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 80; i++) {
            if (re.test(lines[i])) hits.push(`${toPosix(path.relative(this.root, f.path))}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
        return hits.length ? `${hits.length}${hits.length >= 80 ? '+' : ''} matches\n${hits.join('\n')}` : 'No matches.';
      }
      case 'write_file':
      case 'append_file': {
        const { abs, rel } = this.resolvePath(a.path, { forWrite: true });
        const exists = fs.existsSync(abs);
        const content = call.body.endsWith('\n') || !call.body ? call.body : `${call.body}\n`;
        const verb = call.name === 'append_file' ? 'Append to' : exists ? 'Overwrite' : 'Create';
        const done = call.name === 'append_file' ? 'appended to' : exists ? 'overwrote' : 'created';
        if (!(await this.approve('write', `${verb} ${rel} (${content.split('\n').length - 1} lines)`, content))) {
          return 'DENIED: the user did not approve this write.';
        }
        this.snapshot(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (call.name === 'append_file') fs.appendFileSync(abs, content, 'utf8');
        else fs.writeFileSync(abs, content, 'utf8');
        return `OK: ${done} ${rel}`;
      }
      case 'edit_file': {
        const { abs, rel } = this.resolvePath(a.path, { forWrite: true });
        if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist — use write_file to create it.`);
        const blocks = parseEditBlocks(call.body);
        if (!blocks.length) throw new Error('No SEARCH/REPLACE blocks found. Use <<<<<<< SEARCH / ======= / >>>>>>> REPLACE.');
        const original = fs.readFileSync(abs, 'utf8');
        const result = applyEdits(original, blocks);
        if (!result.ok) throw new Error(result.error);
        const preview = blocks.map(b => `${b.search.split('\n').map(l => `- ${l}`).join('\n')}\n${b.replace.split('\n').map(l => `+ ${l}`).join('\n')}`).join('\n');
        if (!(await this.approve('write', `Edit ${rel} (${blocks.length} change${blocks.length > 1 ? 's' : ''})`, preview))) {
          return 'DENIED: the user did not approve this edit.';
        }
        this.snapshot(abs);
        fs.writeFileSync(abs, result.text, 'utf8');
        return `OK: edited ${rel} (${result.report.join(', ')})`;
      }
      case 'run': {
        const command = (call.body || a.command || '').trim();
        if (!command) throw new Error('command is required');
        const verdict = this.warden.evaluate({ tool: 'bash', command });
        if (verdict.decision === 'BLOCKED_RISKY') {
          return `BLOCKED by Agent Warden (${verdict.reasons.join('; ')}). Find a safer, non-destructive approach.`;
        }
        let approved;
        if (verdict.decision === 'NEEDS_CONFIRM') {
          // Warden suspects a loop: always ask a human (even in auto mode); without one, pause.
          if (!this.ask) return `PAUSED by Agent Warden (${verdict.reasons.join('; ')}). Change approach instead of repeating the same command.`;
          approved = await this.askHuman('run', `Run (Warden: ${verdict.reasons.join('; ')}): ${command}`);
        } else {
          approved = await this.approve('run', `Run: ${command}`);
        }
        if (!approved) return 'DENIED: the user did not approve this command.';
        return await this.runCommand(command, Number(a.timeout) || 120);
      }
      case 'git':
        return await this.gitTool(a, call.body);
      case 'load_skill': {
        const skill = Skills.getSkill(a.skill || call.body, this.cwd);
        if (!skill) {
          const names = Skills.listSkills(this.cwd).map(s => s.name).join(', ') || 'none installed';
          return `No skill "${a.skill || call.body}". Available: ${names}`;
        }
        this.activeSkills.add(skill.name);
        return Skills.renderSkillForPrompt(skill);
      }
      case 'done':
        return 'DONE';
      default:
        return `Unknown tool "${call.name}". Available: ${TOOL_NAMES.join(', ')}`;
    }
  }

  /** Remember a file's content before the agent first touches it in this task (for /undo). */
  snapshot(abs) {
    if (!this.pendingChanges || this.pendingChanges.has(abs)) return;
    this.pendingChanges.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
  }

  /** Revert every file the last task created/edited. Shell side-effects are not reverted. */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, error: 'Nothing to undo.' };
    const restored = [];
    for (const [abs, original] of entry.files) {
      if (original === null) {
        try { fs.rmSync(abs, { force: true }); } catch {}
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, original);
      }
      restored.push(toPosix(path.relative(this.root, abs)));
    }
    return { ok: true, task: entry.task, restored };
  }

  runCommand(command, timeoutSec = 120) {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: this.cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI || '1' } });
      let out = '';
      let atLineStart = true;
      const onData = (d) => {
        const s = d.toString();
        out += s;
        if (out.length > 200_000) return;
        let shown = '';
        for (const ch of s) {
          if (atLineStart && ch !== '\n') shown += '    ';
          shown += ch;
          atLineStart = ch === '\n';
        }
        this.write(`${DIM}${shown}${RESET}`);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.stdin.end();
      const timer = setTimeout(() => {
        out += `\n[killed after ${timeoutSec}s timeout]`;
        try { child.kill(); } catch {}
      }, timeoutSec * 1000);
      child.on('error', (err) => { clearTimeout(timer); resolve(`ERROR: ${err.message}`); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!atLineStart) this.write('\n');
        resolve(`exit code ${code}\n${truncate(out.trim() || '(no output)')}`);
      });
    });
  }

  async gitTool(a, body) {
    if (!G.isGitRepo(this.cwd)) return 'Not a git repository.';
    const action = (a.action || '').toLowerCase();
    const branch = G.currentBranch(this.cwd);
    const base = G.defaultBranch(this.cwd);
    switch (action) {
      case 'status':
        return G.repoContextSummary(this.cwd);
      case 'diff':
        return truncate(G.diff({ staged: a.staged === 'true', base: a.base || null }, this.cwd) || 'No changes.');
      case 'log':
        return G.recentLog(this.cwd, 15) || 'No commits yet.';
      case 'branch': {
        const name = a.branch || body;
        if (!name) return `Current branch: ${branch}`;
        const bn = G.isValidBranchName(name, this.cwd) ? name : G.toBranchName(name);
        if (!(await this.approve('git', `Create/switch to branch ${bn}`))) return 'DENIED by user.';
        const r = G.createBranch(bn, this.cwd);
        return r.ok ? `OK: on branch ${bn}` : `ERROR: ${r.error}`;
      }
      case 'commit': {
        const message = (a.message || body || '').trim();
        if (!message) return 'ERROR: commit needs a message (message="type(scope): summary").';
        const st = G.status(this.cwd);
        const staging = G.stageSafely([], this.cwd, { add: st.staged.length === 0 });
        if (!staging.ok) return `ERROR: ${staging.error}`;
        if (!staging.staged.length) return 'Nothing to commit.';
        if (!(await this.approve('git', `Commit ${staging.staged.length} file(s) on ${branch}: "${message.split('\n')[0]}"`, staging.staged.join('\n')))) {
          return 'DENIED by user (changes remain staged).';
        }
        const c = G.commit(message, this.cwd);
        const kept = staging.blocked.length ? `\nKept out by Warden: ${staging.blocked.map(b => b.file).join(', ')}` : '';
        return c.ok ? `OK: committed ${c.sha}${kept}` : `ERROR: ${c.error}`;
      }
      case 'push': {
        if (branch === base && !(await this.approve('push-base', `Push directly to ${base}`))) return `DENIED: push to ${base} not approved — create a feature branch first.`;
        if (!(await this.approve('git', `Push ${branch} to origin`))) return 'DENIED by user.';
        const r = G.push(branch, this.cwd);
        return r.ok ? `OK: pushed ${branch}` : `ERROR: ${r.error}`;
      }
      case 'pr': {
        if (branch === base) return `ERROR: on ${base}; create a branch and commit first.`;
        const title = a.title || (body || '').split('\n')[0] || branch;
        const prBody = a.title ? body : (body || '').split('\n').slice(1).join('\n').trim();
        if (!(await this.approve('git', `Push ${branch} and open PR → ${base}: "${title}"`, prBody))) return 'DENIED by user.';
        const pushed = G.push(branch, this.cwd);
        if (!pushed.ok) return `ERROR (push): ${pushed.error}`;
        const r = await G.createPullRequest({ cwd: this.cwd, head: branch, base, title, body: `${prBody || ''}\n\n---\n_Opened by the Jev Brain agent_`, draft: a.draft === 'true' });
        return r.ok ? `OK: PR ${r.existed ? 'already open' : 'opened'} ${r.url}` : `ERROR: ${r.error}`;
      }
      default:
        return 'ERROR: git action must be one of status, diff, log, branch, commit, push, pr.';
    }
  }

  // ── Prompt construction ────────────────────────────────────────────────
  systemPrompt() {
    const skills = Skills.listSkills(this.cwd);
    const platform = process.platform === 'win32' ? 'Windows (commands run in cmd.exe; use PowerShell via `powershell -Command` if needed)' : `${process.platform} (commands run in sh)`;
    const permission = this.mode === 'auto' ? 'auto-approved' : this.mode === 'readonly' ? 'NOT available (read-only session) — explain what you would change instead' : 'shown to the user for approval';
    const lines = [
      'You are Jev Brain, an autonomous software agent working directly in the user\'s project through tools.',
      `Project root: ${this.root} · Current dir: ${this.cwd} · OS: ${platform} · Date: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'TOOLS — call them by writing XML tags exactly like these (several per reply is fine):',
      '<tool name="list_files" path="." depth="2"></tool>',
      '<tool name="read_file" path="src/app.js" start="1" end="200"></tool>',
      '<tool name="search" pattern="regex" path="src"></tool>',
      '<tool name="write_file" path="src/new.js">\nfull file content\n</tool>',
      '<tool name="append_file" path="src/new.js">\nmore content\n</tool>',
      '<tool name="edit_file" path="src/app.js">\n<<<<<<< SEARCH\nexact current lines\n=======\nnew lines\n>>>>>>> REPLACE\n</tool>',
      '<tool name="run">npm test</tool>',
      '<tool name="git" action="status|diff|log"></tool>  <tool name="git" action="branch" branch="fix/x"></tool>',
      '<tool name="git" action="commit" message="fix(api): handle null user"></tool>  <tool name="git" action="push"></tool>',
      '<tool name="git" action="pr" title="Fix null user crash">markdown description</tool>',
      '<tool name="load_skill" skill="name"></tool>',
      '<tool name="done">one-paragraph summary of what you did</tool>',
      '',
      'RULES:',
      '- Work step by step: look before you change. Read a file before editing it; copy SEARCH lines exactly.',
      '- Prefer edit_file for changes to existing files; write_file only for new files or full rewrites.',
      '- Each reply is limited to ~500 tokens. Keep prose to one or two sentences; write big files in parts (write_file then append_file).',
      '- After tool calls, STOP and wait — results arrive in the next message. Never invent tool results.',
      '- Verify your work (run tests/linters/the script) when possible. Fix failures you caused.',
      `- Writes, commands and git actions are ${permission}. Destructive commands (rm -rf, force-push, DROP …) are blocked.`,
      '- Never read or print secrets (.env, keys). Never commit to the base branch unless asked; use git branch → commit → pr.',
      '- When the task is complete, call done (or answer normally without tools). If blocked, explain what you need.'
    ];
    if (skills.length) {
      lines.push('', 'SKILLS (load with load_skill when relevant):');
      for (const s of skills.slice(0, 60)) lines.push(`- ${s.name}: ${s.description}`);
    }
    for (const name of this.activeSkills) {
      const s = Skills.getSkill(name, this.cwd);
      if (s) lines.push('', `ACTIVE SKILL — follow these instructions:\n${Skills.renderSkillForPrompt(s)}`);
    }
    return lines.join('\n');
  }

  buildPrompt(task, transcript, step) {
    this.lastSystemPrompt = this.systemPrompt();
    const parts = [this.lastSystemPrompt];
    if (G.isGitRepo(this.cwd)) parts.push(`[Repository state]\n${G.repoContextSummary(this.cwd)}`);
    if (this.history.length) {
      parts.push('[Earlier in this session]\n' + this.history.slice(-3).map(h => `User: ${truncate(h.task, 600)}\nYou: ${truncate(h.answer, 900)}`).join('\n\n'));
    }
    parts.push(`[Task]\n${task}`);

    // Keep the newest transcript items within budget
    const rendered = [];
    let used = 0;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const t = transcript[i];
      const s = t.role === 'assistant' ? `[You]\n${t.text}` : `[Tool result: ${t.label}]\n${t.text}`;
      if (used + s.length > TRANSCRIPT_BUDGET && rendered.length) {
        rendered.unshift(`[… ${i + 1} earlier steps omitted to save context …]`);
        break;
      }
      rendered.unshift(s);
      used += s.length;
    }
    if (rendered.length) parts.push(rendered.join('\n\n'));
    parts.push(`[Step ${step}/${this.maxSteps}] Continue. Use tools, or finish with done.`);
    return parts.join('\n\n');
  }

  /** For the transcript: don't resend whole file bodies the model already wrote. */
  compactAssistantText(text) {
    return text.replace(TOOL_RE, (raw, attrStr, body) => {
      const attrs = parseAttrs(attrStr);
      if ((attrs.name === 'write_file' || attrs.name === 'append_file') && body && body.length > 400) {
        return `<tool${attrStr}>[${body.split('\n').length} lines — content omitted]</tool>`;
      }
      return raw;
    });
  }

  async callModel(prompt) {
    const filter = new ToolTagFilter((s) => this.write(s));
    let first = true;
    const r = await this.ai(prompt, (tok) => {
      if (first) { first = false; this.write(`${CYAN}`); }
      filter.push(tok);
    });
    filter.flush();
    this.write(`${RESET}`);
    if (!r) return null;
    const cd = r.creditDeduction;
    if (cd && cd.creditsDeducted !== undefined) {
      this.creditsUsed += Number(cd.creditsDeducted) || 0;
      this.lastBalance = cd.availableCredits;
    }
    return r.text || '';
  }

  describeCall(c) {
    const a = c.attrs;
    const label = {
      list_files: `list ${a.path || '.'}`,
      read_file: `read ${a.path}${a.start ? `:${a.start}-${a.end || ''}` : ''}`,
      search: `search /${a.pattern}/ in ${a.path || '.'}`,
      write_file: `write ${a.path}`,
      append_file: `append ${a.path}`,
      edit_file: `edit ${a.path}`,
      run: `$ ${(c.body || a.command || '').split('\n')[0]}`,
      git: `git ${a.action}${a.branch ? ` ${a.branch}` : ''}${a.message ? ` "${a.message}"` : ''}${a.title ? ` "${a.title}"` : ''}`,
      load_skill: `skill ${a.skill || c.body}`,
      done: 'done'
    }[c.name];
    return label || c.name;
  }

  /** Run one task to completion. Returns the final answer text. */
  async run(task) {
    const started = Date.now();
    let steps = 0;
    let toolCalls = 0;
    this.pendingChanges = new Map();
    const transcript = [];
    let finalAnswer = '';
    let alreadyShown = false;
    this.warden.resetHistory();

    for (let step = 1; step <= this.maxSteps; step++) {
      steps = step;
      this.onEvent?.({ type: 'step', step });
      const prompt = this.buildPrompt(task, transcript, step);
      let text = await this.callModel(prompt);
      if (text === null) {
        finalAnswer = finalAnswer || '(The model request failed — see the error above.)';
        break;
      }

      // Auto-continue replies cut off by the output cap in the middle of a tool call
      let parsed = parseToolCalls(text);
      for (let k = 0; parsed.truncated && k < MAX_CONTINUATIONS; k++) {
        const contPrompt = `${prompt}\n\n[Your reply so far — it was cut off by the output limit]\n${text}\n\n` +
          '[Continue EXACTLY where the text stops. Do not repeat anything, do not add commentary — output only the remaining characters, finishing the open tool tag with </tool>.]';
        const more = await this.callModel(contPrompt);
        if (!more) break;
        text += more;
        parsed = parseToolCalls(text);
      }

      // A model (or a demo backend) that echoes the prompt would "call" the example
      // tools from the instructions — ignore calls copied verbatim from the system prompt.
      const echoed = parsed.calls.filter(c => this.lastSystemPrompt.includes(c.raw));
      if (echoed.length) {
        parsed = { ...parsed, calls: parsed.calls.filter(c => !echoed.includes(c)) };
        this.log(`  ${GRAY}(ignored ${echoed.length} tool example${echoed.length > 1 ? 's' : ''} echoed from the instructions)${RESET}`);
      }

      const prose = stripToolCalls(text);
      if (prose) this.write('\n');
      transcript.push({ role: 'assistant', text: this.compactAssistantText(text) });

      if (!parsed.calls.length) {
        finalAnswer = prose;
        alreadyShown = true; // it was streamed live
        break;
      }

      let finished = false;
      for (const call of parsed.calls) {
        this.log(`  ${GRAY}⚙ ${this.describeCall(call)}${RESET}`);
        toolCalls++;
        this.onEvent?.({ type: 'tool', label: this.describeCall(call), step: steps });
        if (call.name === 'done') {
          finalAnswer = call.body || prose || 'Done.';
          finished = true;
          break;
        }
        let result;
        try {
          result = await this.execTool(call);
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }
        const status = /^(ERROR|BLOCKED|DENIED|PAUSED)/.test(result) ? `${RED}✖` : `${GREEN}✔`;
        this.log(`    ${status} ${GRAY}${result.split('\n')[0].slice(0, 140)}${RESET}`);
        transcript.push({ role: 'tool', label: this.describeCall(call), text: truncate(result) });
        this.onEvent?.({ type: 'result', ok: !/^(ERROR|BLOCKED|DENIED|PAUSED)/.test(result), text: result.split('\n')[0] });
      }
      if (finished) break;
      if (step === this.maxSteps) {
        finalAnswer = `Stopped after ${this.maxSteps} steps. Say "continue" to keep going.`;
      }
    }

    if (finalAnswer && !alreadyShown) this.log(`\n${BOLD}${finalAnswer}${RESET}`);
    if (this.creditsUsed || this.lastBalance !== null) {
      this.log(`${GRAY}💳 Credits used: ${YELLOW}${this.creditsUsed}${GRAY}${this.lastBalance !== null ? ` · Remaining: ${GREEN}${this.lastBalance}` : ''}${RESET}`);
    }
    if (this.pendingChanges.size) {
      this.undoStack.push({ task, files: this.pendingChanges });
      if (this.undoStack.length > 20) this.undoStack.shift();
      if (this.ask) this.log(`${GRAY}↩  Changed ${this.pendingChanges.size} file(s) — /undo reverts them.${RESET}`);
    }
    this.pendingChanges = null;
    this.lastStats = { steps, toolCalls, credits: this.creditsUsed, ms: Date.now() - started };
    this.onEvent?.({ type: 'done', answer: finalAnswer, stats: this.lastStats });
    this.history.push({ task, answer: finalAnswer });
    if (this.history.length > 6) this.history.shift();
    this.creditsUsed = 0;
    return finalAnswer;
  }
}
