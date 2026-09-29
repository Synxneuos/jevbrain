/**
 * Jev Brain CLI — Skills
 *
 * A skill is a reusable instruction pack the agent can load on demand, in the
 * same SKILL.md format used by Hermes Agent / Claude / agentskills.io:
 *
 *   my-skill/
 *     SKILL.md          ← YAML frontmatter (name, description) + markdown instructions
 *     scripts/…         ← optional helper files the agent may read or run
 *
 * A single `my-skill.md` file with the same frontmatter also works.
 *
 * Search order (later wins on name clash):
 *   1. ~/.jevbrain/skills            (global — `jevbrain skill add … --global`)
 *   2. <project>/.jevbrain/skills    (project — committed with the repo, shared with the team)
 *   3. extra dirs in JEV_SKILL_PATHS (path-delimited)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function globalSkillsDir() {
  return path.join(os.homedir(), '.jevbrain', 'skills');
}

export function projectSkillsDir(cwd = process.cwd()) {
  // Prefer the git root so skills work from any subfolder of the project
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
  const root = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
  return path.join(root, '.jevbrain', 'skills');
}

export function skillDirs(cwd = process.cwd()) {
  const extra = (process.env.JEV_SKILL_PATHS || '').split(path.delimiter).filter(Boolean);
  return [
    { scope: 'global', dir: globalSkillsDir() },
    { scope: 'project', dir: projectSkillsDir(cwd) },
    ...extra.map(dir => ({ scope: 'extra', dir }))
  ];
}

/** Minimal YAML-frontmatter parser (key: value, quoted values, folded `>`/`|` blocks). */
export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

function readSkillAt(entryPath, scope) {
  let file;
  let baseDir;
  let stat;
  try { stat = fs.statSync(entryPath); } catch { return null; }
  if (stat.isDirectory()) {
    file = ['SKILL.md', 'skill.md', 'Skill.md'].map(f => path.join(entryPath, f)).find(f => fs.existsSync(f));
    if (!file) return null;
    baseDir = entryPath;
  } else if (/\.md$/i.test(entryPath)) {
    file = entryPath;
    baseDir = path.dirname(entryPath);
  } else {
    return null;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const fallbackName = stat.isDirectory() ? path.basename(entryPath) : path.basename(entryPath, path.extname(entryPath));
  const name = String(meta.name || fallbackName).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return {
    name,
    description: String(meta.description || body.split('\n').find(l => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 300),
    body,
    file,
    dir: stat.isDirectory() ? entryPath : null,
    baseDir,
    scope,
    meta
  };
}

/** All discoverable skills, keyed by name (project overrides global). */
export function listSkills(cwd = process.cwd()) {
  const found = new Map();
  for (const { scope, dir } of skillDirs(cwd)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const skill = readSkillAt(path.join(dir, e.name), scope);
      if (skill && NAME_RE.test(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name, cwd = process.cwd()) {
  const n = String(name || '').trim().toLowerCase();
  return listSkills(cwd).find(s => s.name === n) || null;
}

/** Supporting files shipped with a skill (relative paths), for the agent to read/run. */
export function skillFiles(skill, max = 50) {
  if (!skill?.dir) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (p !== skill.file) out.push(path.relative(skill.dir, p).split(path.sep).join('/'));
      if (out.length >= max) return;
    }
  };
  walk(skill.dir, 0);
  return out;
}

/** Text given to the model when a skill is loaded. */
export function renderSkillForPrompt(skill) {
  const files = skillFiles(skill);
  const location = skill.dir || skill.baseDir;
  return [
    `# Skill: ${skill.name}`,
    skill.description ? `> ${skill.description}` : '',
    '',
    skill.body,
    files.length ? `\nSupporting files (paths relative to ${location}):\n${files.map(f => `- ${f}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Management: new / add / remove
// ─────────────────────────────────────────────────────────────────────────────

export function targetDir(global, cwd) {
  return global ? globalSkillsDir() : projectSkillsDir(cwd);
}

export function createSkill(name, { description = '', global = false, cwd = process.cwd() } = {}) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(n)) {
    return { ok: false, error: 'Skill names use lowercase letters, digits and dashes (max 64), e.g. "deploy-railway".' };
  }
  const dir = path.join(targetDir(global, cwd), n);
  if (fs.existsSync(dir)) return { ok: false, error: `Skill "${n}" already exists at ${dir}` };
  fs.mkdirSync(dir, { recursive: true });
  const desc = description || `Describe when the agent should use the ${n} skill.`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${n}
description: ${desc}
---

# ${n}

## When to use
- Describe the situations where this skill applies.

## Steps
1. First thing the agent should do (e.g. read \`package.json\`).
2. Commands to run (e.g. \`npm test\`).
3. How to verify the result.

## Rules
- Constraints the agent must follow (style, files not to touch, etc.).
`, 'utf8');
  return { ok: true, name: n, dir, file: path.join(dir, 'SKILL.md') };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** Find skill folders (dirs with SKILL.md) inside a checkout, max depth 3. */
function findSkillRoots(root, max = 50) {
  const roots = [];
  const walk = (d, depth) => {
    if (depth > 3 || roots.length >= max) return;
    if (fs.existsSync(path.join(d, 'SKILL.md')) || fs.existsSync(path.join(d, 'skill.md'))) {
      roots.push(d);
      return;
    }
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return roots;
}

/**
 * Parse a remote source:
 *   https://github.com/owner/repo(.git)
 *   https://github.com/owner/repo/tree/<ref>/<subpath>
 *   github:owner/repo[/subpath][@ref]
 *   any other git URL (git@…, https://…​.git)
 */
export function parseRemoteSource(source) {
  const s = String(source || '').trim();
  let m = s.match(/^github:([\w.-]+)\/([\w.-]+)(\/[^@]*)?(?:@([\w./-]+))?$/i);
  if (m) return { url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`, subpath: (m[3] || '').replace(/^\/+/, ''), ref: m[4] || null };
  m = s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(\/.*)?)?\/?$/i);
  if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, ref: m[3] || null, subpath: (m[4] || '').replace(/^\/+/, '') };
  if (/^(git@|ssh:\/\/|https?:\/\/).+\.git$/i.test(s)) return { url: s, subpath: '', ref: null };
  return null;
}

/**
 * Install skill(s) from a local path, a GitHub repo/folder, or a raw https .md URL.
 * Returns { ok, installed: [{name, dir}], error }.
 */
export async function addSkill(source, { global = false, cwd = process.cwd(), force = false } = {}) {
  const dest = targetDir(global, cwd);
  fs.mkdirSync(dest, { recursive: true });
  const installed = [];

  const installFrom = (skillRoot) => {
    const skill = readSkillAt(skillRoot, 'new');
    if (!skill) throw new Error(`No SKILL.md found in ${skillRoot}`);
    if (!NAME_RE.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
    const target = path.join(dest, skill.name);
    if (fs.existsSync(target)) {
      if (!force) throw new Error(`Skill "${skill.name}" already installed (use --force to overwrite)`);
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (skill.dir) copyDir(skill.dir, target);
    else {
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(skill.file, path.join(target, 'SKILL.md'));
    }
    installed.push({ name: skill.name, dir: target, description: skill.description });
  };

  try {
    // 1. Local path (dir with SKILL.md, a folder of skills, or a single .md)
    const expanded = source.startsWith('~') ? path.join(os.homedir(), source.slice(1)) : source;
    const local = path.resolve(cwd, expanded);
    if (fs.existsSync(local)) {
      const st = fs.statSync(local);
      if (st.isFile()) installFrom(local);
      else {
        const roots = findSkillRoots(local);
        if (!roots.length) throw new Error(`No SKILL.md found under ${local}`);
        roots.forEach(installFrom);
      }
      return { ok: true, installed };
    }

    // 2. Raw markdown URL
    if (/^https?:\/\/\S+\.md(\?.*)?$/i.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const text = await res.text();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-skill-'));
      const { meta } = parseFrontmatter(text);
      const fname = `${(meta.name || path.basename(new URL(source).pathname, '.md')).toLowerCase()}.md`;
      const file = path.join(tmp, fname);
      fs.writeFileSync(file, text, 'utf8');
      installFrom(file);
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: true, installed };
    }

    // 3. Git / GitHub
    const remote = parseRemoteSource(source);
    if (!remote) throw new Error(`Unrecognised skill source: ${source}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-skill-'));
    const args = ['clone', '--depth', '1', '--quiet'];
    if (remote.ref) args.push('--branch', remote.ref);
    args.push(remote.url, tmp);
    const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${(r.stderr || '').trim() || 'unknown error'}`);
    }
    const base = path.join(tmp, remote.subpath || '');
    const roots = fs.existsSync(base) ? findSkillRoots(base) : [];
    if (!roots.length) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`No SKILL.md found in ${remote.url}${remote.subpath ? `/${remote.subpath}` : ''}`);
    }
    try { roots.forEach(installFrom); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return { ok: true, installed };
  } catch (err) {
    return { ok: false, installed, error: err.message };
  }
}

export function removeSkill(name, { cwd = process.cwd() } = {}) {
  const skill = getSkill(name, cwd);
  if (!skill) return { ok: false, error: `No skill named "${name}"` };
  if (skill.scope === 'extra') return { ok: false, error: `"${name}" lives in JEV_SKILL_PATHS (${skill.baseDir}); remove it there.` };
  if (skill.dir) fs.rmSync(skill.dir, { recursive: true, force: true });
  else fs.rmSync(skill.file, { force: true });
  return { ok: true, name: skill.name, scope: skill.scope };
}
