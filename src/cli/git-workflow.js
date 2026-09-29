/**
 * Jev Brain CLI — Git & GitHub workflow helpers
 *
 * Lets the terminal AI session work directly on the current repository and run
 * the branch → commit → push → pull request loop without leaving the CLI.
 *
 * Safety notes:
 *  - Every git / gh invocation uses spawnSync with an argument array (no shell),
 *    so branch names, commit messages and PR titles can never inject commands.
 *  - Files are staged through the Agent Warden: protected / secret paths are
 *    unstaged automatically and reported, never committed.
 *  - No force pushes, no history rewrites.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AgentWarden } from '../core/warden.js';

const MAX_BUFFER = 32 * 1024 * 1024;
// GITHUB_API_URL is set automatically in GitHub Actions and points at GHE for enterprise users.
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

// ─────────────────────────────────────────────────────────────────────────────
// Low-level runners
// ─────────────────────────────────────────────────────────────────────────────

export function run(bin, args, cwd = process.cwd(), input) {
  const res = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    input,
    windowsHide: true
  });
  if (res.error) {
    return { ok: false, code: -1, stdout: '', stderr: res.error.message, missing: res.error.code === 'ENOENT' };
  }
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: (res.stdout || '').replace(/\s+$/, ''),
    stderr: (res.stderr || '').replace(/\s+$/, '')
  };
}

export function git(args, cwd) {
  return run('git', args, cwd);
}

export function hasGhCli() {
  const r = run('gh', ['--version']);
  return r.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository inspection
// ─────────────────────────────────────────────────────────────────────────────

export function repoRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? r.stdout : null;
}

export function isGitRepo(cwd = process.cwd()) {
  return repoRoot(cwd) !== null;
}

export function currentBranch(cwd) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (r.ok && r.stdout !== 'HEAD') return r.stdout;
  // Fresh repo with no commits yet
  const sym = git(['symbolic-ref', '--short', 'HEAD'], cwd);
  return sym.ok ? sym.stdout : null;
}

export function branchExists(name, cwd) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], cwd).ok;
}

export function defaultBranch(cwd, remote = 'origin') {
  const sym = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], cwd);
  if (sym.ok && sym.stdout.includes('/')) return sym.stdout.split('/').slice(1).join('/');
  for (const candidate of ['main', 'master', 'develop']) {
    if (branchExists(candidate, cwd)) return candidate;
    if (git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`], cwd).ok) return candidate;
  }
  return 'main';
}

/** Parse `git status --porcelain=v1 -b` into a structured summary. */
export function status(cwd) {
  const r = git(['status', '--porcelain=v1', '-b'], cwd);
  if (!r.ok) return null;
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.startsWith('##') ? lines.shift() : '';
  const ahead = Number((header.match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((header.match(/behind (\d+)/) || [])[1] || 0);
  const upstream = (header.match(/\.\.\.(\S+)/) || [])[1] || null;

  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).replace(/^"|"$/g, '');
    if (x === '?' && y === '?') { untracked.push(file); continue; }
    if (x !== ' ') staged.push({ code: x, file });
    if (y !== ' ') unstaged.push({ code: y, file });
  }
  return {
    branch: currentBranch(cwd),
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0
  };
}

export function remoteUrl(cwd, remote = 'origin') {
  const r = git(['remote', 'get-url', remote], cwd);
  return r.ok ? r.stdout : null;
}

/**
 * Extract { owner, repo } from any common GitHub remote form:
 *   https://github.com/o/r(.git)   git@github.com:o/r.git   ssh://git@github.com/o/r
 *   https://user:token@github.com/o/r.git
 */
export function parseGitHubRemote(url) {
  if (!url) return null;
  const m = String(url).trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function githubRepo(cwd, remote = 'origin') {
  return parseGitHubRemote(remoteUrl(cwd, remote));
}

export function recentLog(cwd, count = 10) {
  const r = git(['log', `-${count}`, '--pretty=format:%h %s (%cr)'], cwd);
  return r.ok ? r.stdout : '';
}

export function commitsSince(base, cwd) {
  const r = git(['log', `${base}..HEAD`, '--pretty=format:- %s'], cwd);
  return r.ok ? r.stdout : '';
}

export function diff({ staged = false, base = null, stat = false } = {}, cwd) {
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  if (stat) args.push('--stat');
  if (base) args.push(`${base}...HEAD`);
  const r = git(args, cwd);
  return r.ok ? r.stdout : '';
}

export function truncate(text, max = 12000) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max)}\n\n… [truncated ${text.length - max} more characters]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch names
// ─────────────────────────────────────────────────────────────────────────────

/** Turn free text ("Fix login bug on mobile!") into a valid branch name ("fix/login-bug-on-mobile"). */
export function toBranchName(text, fallbackPrefix = 'feat') {
  let raw = String(text || '').trim();
  const typed = raw.match(/^(feat|fix|chore|docs|refactor|test|perf|ci|build|hotfix)[/:\s-]+(.*)$/i);
  let prefix = fallbackPrefix;
  if (typed) {
    prefix = typed[1].toLowerCase();
    raw = typed[2];
  } else if (/\b(fix|bug|crash|error|broken)\b/i.test(raw)) {
    prefix = 'fix';
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug ? `${prefix}/${slug}` : `${prefix}/update-${Date.now().toString(36)}`;
}

export function isValidBranchName(name, cwd) {
  if (!name || /\s/.test(name)) return false;
  return git(['check-ref-format', '--branch', name], cwd).ok;
}

export function createBranch(name, cwd) {
  if (!isValidBranchName(name, cwd)) return { ok: false, error: `Invalid branch name: ${name}` };
  if (branchExists(name, cwd)) {
    const sw = git(['switch', name], cwd);
    return sw.ok ? { ok: true, switched: true, name } : { ok: false, error: sw.stderr };
  }
  const r = git(['switch', '-c', name], cwd);
  return r.ok ? { ok: true, created: true, name } : { ok: false, error: r.stderr };
}

// ─────────────────────────────────────────────────────────────────────────────
// Staging through the Agent Warden
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage changes (all, or the given paths), then unstage anything the Agent
 * Warden considers protected. Returns what ended up staged and what was held back.
 */
export function stageSafely(paths = [], cwd, { add = true } = {}) {
  if (add) {
    const addArgs = paths.length ? ['add', '--', ...paths] : ['add', '-A'];
    const r = git(addArgs, cwd);
    if (!r.ok) return { ok: false, error: r.stderr, staged: [], blocked: [] };
  }

  const names = git(['diff', '--cached', '--name-only'], cwd);
  const files = names.ok ? names.stdout.split(/\r?\n/).filter(Boolean) : [];
  const warden = new AgentWarden();
  const blocked = [];
  const staged = [];
  for (const file of files) {
    const check = warden.checkTargetFile(file);
    if (check.ok) staged.push(file);
    else blocked.push({ file, reason: check.reason });
  }
  if (blocked.length) {
    // `git reset -q -- <files>` works even before the first commit (unlike `restore --staged`)
    git(['reset', '-q', '--', ...blocked.map(b => b.file)], cwd);
  }
  return { ok: true, staged, blocked };
}

export function commit(message, cwd) {
  const r = run('git', ['commit', '-F', '-'], cwd, message);
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
  const sha = git(['rev-parse', '--short', 'HEAD'], cwd).stdout;
  return { ok: true, sha, output: r.stdout };
}

export function push(branch, cwd, remote = 'origin') {
  const r = git(['push', '-u', remote, branch], cwd);
  return r.ok ? { ok: true, output: r.stderr || r.stdout } : { ok: false, error: r.stderr || r.stdout };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull requests (gh CLI first, GitHub REST API fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveGitHubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.JEV_GITHUB_TOKEN;
  if (envToken) return envToken.trim();
  const gh = run('gh', ['auth', 'token']);
  return gh.ok && gh.stdout ? gh.stdout.trim() : null;
}

async function githubApi(method, apiPath, token, body) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jev-brain-cli',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function findOpenPullRequest({ owner, repo, head, token }) {
  const q = `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`;
  const r = await githubApi('GET', q, token);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

/**
 * Open a PR for `head` into `base`. Uses the `gh` CLI when installed and
 * authenticated, otherwise the REST API with GITHUB_TOKEN / GH_TOKEN.
 * If a PR for the branch already exists, returns it instead of failing.
 */
export async function createPullRequest({ cwd, head, base, title, body, draft = false }) {
  const ghRepo = githubRepo(cwd);
  if (!ghRepo) return { ok: false, error: 'origin is not a GitHub remote' };

  if (hasGhCli()) {
    const args = ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body-file', '-'];
    if (draft) args.push('--draft');
    const r = run('gh', args, cwd, body || '');
    if (r.ok) return { ok: true, url: r.stdout.split(/\s+/).find(s => s.startsWith('https://')) || r.stdout, via: 'gh' };
    const existing = r.stderr.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
    if (existing) return { ok: true, url: existing[0], existed: true, via: 'gh' };
    // gh present but not logged in → fall through to the API if a token exists
    if (!/auth|login|token/i.test(r.stderr)) return { ok: false, error: r.stderr || r.stdout };
  }

  const token = resolveGitHubToken();
  if (!token) {
    return {
      ok: false,
      error: 'No GitHub credentials. Install GitHub CLI and run `gh auth login`, or set GITHUB_TOKEN.'
    };
  }

  const r = await githubApi('POST', `/repos/${ghRepo.owner}/${ghRepo.repo}/pulls`, token, {
    title, head, base, body: body || '', draft
  });
  if (r.ok) return { ok: true, url: r.data.html_url, number: r.data.number, via: 'api' };

  const alreadyExists = r.status === 422 && JSON.stringify(r.data).includes('already exists');
  if (alreadyExists) {
    const pr = await findOpenPullRequest({ ...ghRepo, head, token });
    if (pr) return { ok: true, url: pr.html_url, number: pr.number, existed: true, via: 'api' };
  }
  const detail = r.data?.errors?.map(e => e.message || e.code).join('; ') || r.data?.message || `HTTP ${r.status}`;
  return { ok: false, error: `GitHub API: ${detail}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo-aware chat context
// ─────────────────────────────────────────────────────────────────────────────

/** Read a file inside the repo for AI context; refuses paths outside the repo and protected files. */
export function readFileForContext(relPath, cwd = process.cwd(), maxChars = 20000) {
  const root = repoRoot(cwd) || cwd;
  const abs = path.resolve(cwd, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Path is outside the repository' };
  }
  const check = new AgentWarden().checkTargetFile(rel.split(path.sep).join('/'));
  if (!check.ok) return { ok: false, error: `Blocked by Agent Warden (${check.reason})` };
  let stat;
  try { stat = fs.statSync(abs); } catch { return { ok: false, error: 'File not found' }; }
  if (!stat.isFile()) return { ok: false, error: 'Not a file' };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: 'Binary file skipped' };
  const text = buf.toString('utf8');
  return { ok: true, rel: rel.split(path.sep).join('/'), content: truncate(text, maxChars), size: text.length };
}

/** Compact one-paragraph description of the repo state for the model. */
export function repoContextSummary(cwd) {
  const st = status(cwd);
  if (!st) return '';
  const gh = githubRepo(cwd);
  const changed = [
    ...st.staged.map(s => `${s.code} ${s.file} (staged)`),
    ...st.unstaged.map(s => `${s.code} ${s.file}`),
    ...st.untracked.map(f => `? ${f}`)
  ];
  const lines = [
    `Repository: ${gh ? `${gh.owner}/${gh.repo}` : path.basename(repoRoot(cwd) || cwd)}`,
    `Branch: ${st.branch || '(none)'}${st.upstream ? ` → ${st.upstream}` : ''}${st.ahead ? `, ${st.ahead} ahead` : ''}${st.behind ? `, ${st.behind} behind` : ''}`,
    changed.length ? `Working tree changes:\n${changed.slice(0, 40).join('\n')}${changed.length > 40 ? `\n… ${changed.length - 40} more` : ''}` : 'Working tree: clean'
  ];
  return lines.join('\n');
}

/** Strip code fences / chatter the model sometimes wraps around a commit message. */
export function cleanAiText(text) {
  let t = String(text || '').trim();
  const fenced = t.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  t = t.replace(/^(here('| i)s|sure[,!]?)[^\n]*:\s*\n+/i, '').trim();
  return t;
}
