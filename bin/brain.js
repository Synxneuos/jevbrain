#!/usr/bin/env node

import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { JevBrain, PRESETS } from '../src/core/router.js';
import { AgentWarden } from '../src/core/warden.js';
import { MobileRunner } from '../src/core/mobile.js';
import * as GitFlow from '../src/cli/git-workflow.js';
import * as GitCmd from '../src/cli/git-commands.js';
import * as Skills from '../src/cli/skills.js';
import { JevAgent } from '../src/cli/agent.js';
import { runArena } from '../src/cli/arena.js';

const args = process.argv.slice(2);

const command = args[0] || 'help';

// ANSI colors & gradients (Hermes / Cortex Terminal styling)
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

// High-fidelity 256-color palette
const C_CYAN = '\x1b[38;5;51m';
const C_SKY = '\x1b[38;5;45m';
const C_BLUE = '\x1b[38;5;75m';
const C_PURPLE = '\x1b[38;5;141m';
const C_VIOLET = '\x1b[38;5;177m';
const C_PINK = '\x1b[38;5;201m';
const C_GOLD = '\x1b[38;5;220m';
const C_EMERALD = '\x1b[38;5;48m';
const C_MUTED = '\x1b[38;5;244m';

// Sleek White-to-Gray metallic gradient palette (monochrome minimal design)
const G_W1 = '\x1b[38;2;255;255;255m'; // Pure Crisp White (#FFFFFF)
const G_W2 = '\x1b[38;2;225;225;230m'; // Platinum Silver (#E1E1E6)
const G_W3 = '\x1b[38;2;185;185;195m'; // Light Steel Gray (#B9B9C3)
const G_W4 = '\x1b[38;2;145;145;155m'; // Medium Silver (#91919B)
const G_W5 = '\x1b[38;2;110;110;120m'; // Slate Gray (#6E6E78)
const G_W6 = '\x1b[38;2;80;80;90m';    // Deep Shadow Gray (#50505A)

const C_BOX = '\x1b[38;2;90;90;100m';
const C_TEXT = '\x1b[38;2;240;240;245m';
const C_DIM = '\x1b[38;2;140;140;150m';

function banner() {
  const gradientLines = [
    { text: '   ██╗███████╗██╗   ██╗    ██████╗ ██████╗   █████╗  ██╗███╗   ██╗', color: G_W1 },
    { text: '   ██║██╔════╝██║   ██║    ██╔══██╗██╔══██╗ ██╔══██╗ ██║████╗  ██║', color: G_W2 },
    { text: '   ██║█████╗  ██║   ██║    ██████╔╝██████╔╝ ███████║ ██║██╔██╗ ██║', color: G_W3 },
    { text: '██ ██║██╔══╝  ╚██╗ ██╔╝    ██╔══██╗██╔══██╗ ██╔══██║ ██║██║╚██╗██║', color: G_W4 },
    { text: '╚████║███████╗ ╚████╔╝     ██████╔╝██║  ██║ ██║  ██║ ██║██║ ╚████║', color: G_W5 },
    { text: ' ╚═══╝╚══════╝  ╚═══╝      ╚═════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝╚═╝  ╚═══╝', color: G_W6 },
  ];

  console.log();
  for (const line of gradientLines) {
    console.log(`${BOLD}${line.color}${line.text}${RESET}`);
  }
  console.log(`\n  ${C_BOX}┌────────────────────────────────────────────────────────────────────────┐${RESET}`);
  console.log(`  ${C_BOX}│${RESET}  ${BOLD}${C_TEXT}⚡ JEV BRAIN CLI${RESET} ${C_DIM}v1.0.0${RESET} · ${C_TEXT}Autonomous On-Chain AI Terminal${RESET}         ${C_BOX}│${RESET}`);
  console.log(`  ${C_BOX}│${RESET}  ${C_DIM}Contract:${RESET} ${C_TEXT}AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump${RESET}  ${C_DIM}(Solana SPL)${RESET}  ${C_BOX}│${RESET}`);
  console.log(`  ${C_BOX}│${RESET}  ${C_DIM}Official Hub:${RESET} ${C_TEXT}https://jevbrain.world${RESET} · ${C_DIM}“Don't think. Route.”${RESET}        ${C_BOX}│${RESET}`);
  console.log(`  ${C_BOX}└────────────────────────────────────────────────────────────────────────┘${RESET}\n`);
}

async function readAllStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let timer = setTimeout(() => resolve(''), 30);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      clearTimeout(timer);
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function renderBar(confidence) {
  const width = 12;
  const filled = Math.round(confidence * width);
  const empty = width - filled;
  const color = confidence >= 0.8 ? GREEN : YELLOW;
  return `${color}${'█'.repeat(filled)}${GRAY}${'░'.repeat(empty)}${RESET}`;
}

async function handleClassify() {
  const labelArg = args[1];
  const fileArg = args[2];

  let rawText = '';
  if (fileArg && !fileArg.startsWith('-')) {
    try {
      rawText = readFileSync(fileArg, 'utf8');
    } catch (e) {
      console.error(`${RED}Error reading file ${fileArg}:${RESET}`, e.message);
      process.exit(1);
    }
  } else {
    rawText = await readAllStdin();
  }

  if (!rawText.trim()) {
    console.log(`${YELLOW}No input provided via stdin or file.${RESET}`);
    console.log(`Usage:`);
    console.log(`  brain classify urgent,later,ignore < inbox.txt`);
    console.log(`  brain classify urgent,later,ignore inbox.txt`);
    process.exit(1);
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const brain = new JevBrain();
  const results = await brain.batchRoute(lines, labelArg);

  banner();
  console.log(`${BOLD}Classifying ${lines.length} items with labels: [${CYAN}${labelArg || 'default'}${RESET}] (Threshold: 0.8)\n`);

  let autoActCount = 0;
  let reviewCount = 0;

  for (const res of results) {
    const isAuto = res.action === 'AUTO_ACT';
    if (isAuto) autoActCount++; else reviewCount++;

    const badge = isAuto 
      ? `${GREEN}${BOLD} AUTO_ACT   ${RESET}` 
      : `${YELLOW}${BOLD} REVIEW_REQ ${RESET}`;

    const scorePct = `${Math.round(res.confidence * 100)}%`.padStart(4);
    const labelStr = `[${CYAN}${res.label.toUpperCase()}${RESET}]`.padEnd(14);
    const bar = renderBar(res.confidence);
    const shortText = res.text.length > 55 ? res.text.slice(0, 52) + '...' : res.text;

    console.log(`${badge} ${bar} ${scorePct}  ${labelStr} ${shortText} ${GRAY}(${res.latencyMs}ms)${RESET}`);
  }

  console.log(`\n${BOLD}Summary:${RESET}`);
  console.log(`  ${GREEN}✔ Auto-routed (≥ 0.8):${RESET} ${autoActCount}`);
  console.log(`  ${YELLOW}⚠ Review Queue (< 0.8):${RESET} ${reviewCount}`);
  console.log(`  ${CYAN}⚡ Speed:${RESET} instant zero-cost local routing`);
}

async function handleRoute() {
  const text = args[1];
  if (!text) {
    console.error(`${RED}Usage: brain route "<text>" [--preset inbox|warden|attention|model-router]${RESET}`);
    process.exit(1);
  }

  let preset = 'inbox';
  const presetIdx = args.indexOf('--preset');
  if (presetIdx !== -1 && args[presetIdx + 1]) {
    preset = args[presetIdx + 1];
  }

  const brain = new JevBrain({ preset });
  const res = await brain.route(text);

  banner();
  console.log(`${BOLD}Input:${RESET}      ${res.text}`);
  console.log(`${BOLD}Preset:${RESET}     ${preset}`);
  console.log(`${BOLD}Route:${RESET}      ${CYAN}${BOLD}${res.label.toUpperCase()}${RESET}`);
  console.log(`${BOLD}Confidence:${RESET} ${renderBar(res.confidence)} ${Math.round(res.confidence * 100)}%`);
  console.log(`${BOLD}Decision:${RESET}   ${res.action === 'AUTO_ACT' ? `${GREEN}AUTO_ACT (Confidence ≥ 0.8)${RESET}` : `${YELLOW}REVIEW_QUEUE (Confidence < 0.8)${RESET}`}`);
  console.log(`${BOLD}Latency:${RESET}    ${res.latencyMs}ms`);
  console.log(`${BOLD}Reasoning:${RESET}  ${GRAY}${res.reason}${RESET}`);
}

async function handleWarden() {
  const toolIdx = args.indexOf('--tool');
  const cmdIdx = args.indexOf('--command');
  const pathIdx = args.indexOf('--path');

  const tool = toolIdx !== -1 ? args[toolIdx + 1] : 'bash';
  const command = cmdIdx !== -1 ? args[cmdIdx + 1] : (args[1] || 'git status');
  const filepath = pathIdx !== -1 ? args[pathIdx + 1] : '';

  const warden = new AgentWarden();
  const evaluation = warden.evaluate({ tool, command, filepath });

  banner();
  console.log(`${BOLD}Coding Agent Pre-Flight Check:${RESET}`);
  console.log(`  ${BOLD}Tool:${RESET}    ${tool}`);
  console.log(`  ${BOLD}Command:${RESET} ${command}`);
  if (filepath) console.log(`  ${BOLD}Path:${RESET}    ${filepath}`);

  const badge = evaluation.decision === 'AUTO_ALLOW' 
    ? `${GREEN}${BOLD}✔ ALLOWED (Safe)${RESET}`
    : evaluation.decision === 'NEEDS_CONFIRM'
    ? `${YELLOW}${BOLD}⚠ CONFIRMATION REQUIRED${RESET}`
    : `${RED}${BOLD}✖ BLOCKED (High Risk / Destructive)${RESET}`;

  console.log(`\n  ${BOLD}Gate:${RESET}    ${badge} (${evaluation.latencyMs}ms)`);
  console.log(`\n${BOLD}4 Pre-flight Questions:${RESET}`);
  console.log(`  1. Is this the right file?   ${evaluation.questions.is_right_file.ok ? `${GREEN}✔ Yes${RESET}` : `${RED}✖ No - ${evaluation.questions.is_right_file.reason}${RESET}`}`);
  console.log(`  2. Is this irreversible?     ${!evaluation.questions.is_irreversible.irreversible ? `${GREEN}✔ Safe${RESET}` : `${RED}✖ DANGER - ${evaluation.questions.is_irreversible.reason}${RESET}`}`);
  console.log(`  3. Are we looping?           ${!evaluation.questions.are_we_looping.looping ? `${GREEN}✔ No${RESET}` : `${YELLOW}⚠ Loop Detected (${evaluation.questions.are_we_looping.count}x)${RESET}`}`);
  console.log(`  4. Are we done?              ${evaluation.questions.are_we_done.done ? `${CYAN}✔ Done criteria met${RESET}` : `${GRAY}Ongoing${RESET}`}`);
}

async function handleServe() {
  let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3333;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || port;
  }
  const { startServer } = await import('../src/server.js');
  startServer(port);
}

async function handleMobile() {
  const sub = args[1] || 'devices';
  const mobile = new MobileRunner();
  banner();

  if (sub === 'devices') {
    const devices = await mobile.listDevices();
    console.log(`${BOLD}Connected Android Devices & Gateways:${RESET}`);
    devices.forEach((d, i) => {
      console.log(`  [${i + 1}] ${GREEN}${BOLD}${d.name}${RESET} (ID: ${CYAN}${d.id}${RESET}) [${d.type}] Status: ${d.status}`);
    });
  } else if (sub === 'tap') {
    const x = parseInt(args[2], 10) || 540;
    const y = parseInt(args[3], 10) || 1200;
    console.log(`${BOLD}Executing Mobile Tap:${RESET} (${x}, ${y})`);
    const res = await mobile.executeAction('pixel-8-virtual', { type: 'tap', x, y });
    const badge = res.verdict === 'AUTO_ALLOW' ? `${GREEN}✔ AUTO_ALLOW${RESET}` : `${RED}✖ ${res.verdict}${RESET}`;
    console.log(`  Gate:   ${badge} (${res.latencyMs}ms)`);
    console.log(`  Output: ${res.output}`);
  } else if (sub === 'type') {
    const text = args.slice(2).join(' ') || 'Hello from Jev Brain';
    console.log(`${BOLD}Typing Input Stream:${RESET} "${text}"`);
    const res = await mobile.executeAction('pixel-8-virtual', { type: 'type', text });
    console.log(`  Gate:   ${GREEN}✔ ${res.verdict}${RESET} (${res.latencyMs}ms)`);
    console.log(`  Output: ${res.output}`);
  } else if (sub === 'inspect') {
    const state = await mobile.getScreenState('pixel-8-virtual');
    console.log(`${BOLD}Android Screen State Inspection:${RESET}`);
    console.log(`  Foreground: ${CYAN}${state.foregroundPackage}${RESET}`);
    console.log(`  Activity:   ${state.activity || 'N/A'}`);
    console.log(`  Battery:    ${state.batteryPct || 90}%`);
    console.log(`  UI Tree:    ${state.uiHierarchy ? state.uiHierarchy.length : 0} visible accessibility nodes`);
  } else {
    console.log(`${YELLOW}Unknown mobile subcommand:${RESET} ${sub}`);
    console.log(`Usage: brain mobile [devices | tap <x> <y> | type "<text>" | inspect]`);
  }
}

async function handleHook() {
  const sub = args[1] || 'check';
  const gitDir = path.join(process.cwd(), '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  const hookFile = path.join(hooksDir, 'pre-commit');

  if (sub === 'install') {
    if (!fs.existsSync(gitDir)) {
      console.error(`${RED}Error: Not a git repository (.git directory not found).${RESET}`);
      process.exit(1);
    }
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookContent = `#!/bin/sh\n# Jev Agent Warden Pre-Commit Guard\nnode -e "import('./bin/brain.js').catch(() => import('jev-brain'))" hook check || npx --yes jev-brain hook check\n`;
    fs.writeFileSync(hookFile, hookContent, { mode: 0o755 });
    console.log(`${GREEN}✔ Jev Pre-Commit Hook installed successfully at .git/hooks/pre-commit${RESET}`);
    console.log(`Agent Warden will now automatically verify staged files before every git commit.`);
    return;
  }

  if (sub === 'uninstall') {
    if (fs.existsSync(hookFile)) {
      fs.unlinkSync(hookFile);
      console.log(`${YELLOW}✔ Jev Pre-Commit Hook uninstalled.${RESET}`);
    } else {
      console.log(`No pre-commit hook found at .git/hooks/pre-commit.`);
    }
    return;
  }

  if (sub === 'check') {
    try {
      const stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
      if (!stagedOutput) {
        process.exit(0);
      }
      const files = stagedOutput.split(/\r?\n/).filter(Boolean);
      const warden = new AgentWarden();
      const violations = [];

      for (const file of files) {
        const check = warden.checkTargetFile(file);
        if (!check.ok) {
          violations.push({ file, reason: check.reason });
        }
      }

      if (violations.length > 0) {
        console.error(`\n${RED}${BOLD}✖ COMMIT REJECTED BY JEV AGENT WARDEN${RESET}`);
        console.error(`${RED}Protected or sensitive files detected in staged git index:${RESET}\n`);
        violations.forEach(v => {
          console.error(`  ${RED}• ${v.file}${RESET} (${v.reason})`);
        });
        console.error(`\n${YELLOW}To unstage: git restore --staged <file>${RESET}\n`);
        process.exit(1);
      } else {
        console.log(`${GREEN}✔ Jev Agent Warden: All ${files.length} staged files verified safe.${RESET}`);
      }
    } catch (err) {
      // Pass through if not in git context or initial empty commit
    }
  }
}

async function handleAudit() {
  const targetDir = args[1] || '.';
  banner();
  console.log(`${BOLD}Scanning codebase for agent security, protected files, and destructive commands...${RESET}`);
  console.log(`Target: ${CYAN}${path.resolve(targetDir)}${RESET}\n`);

  const warden = new AgentWarden();
  const findings = [];
  let filesScanned = 0;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.venv' || e.name === 'dist' || e.name === '.idea' || e.name === '.kilo') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(targetDir, full);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        filesScanned++;
        const check = warden.checkTargetFile(rel);
        if (!check.ok) {
          findings.push({ type: 'PROTECTED_FILE', target: rel, severity: 'HIGH', reason: check.reason });
        }
        if (rel.endsWith('.sh') || rel.endsWith('.bat') || rel.endsWith('.js') || rel.endsWith('package.json')) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            const irrev = warden.checkIrreversible(content);
            if (irrev.irreversible) {
              findings.push({ type: 'DESTRUCTIVE_COMMAND', target: rel, severity: 'CRITICAL', reason: irrev.reason });
            }
          } catch {}
        }
      }
    }
  }

  try {
    walk(targetDir);
  } catch (err) {
    console.error(`${RED}Audit error:${RESET}`, err.message);
    process.exit(1);
  }

  console.log(`${BOLD}Scanned ${filesScanned} files.${RESET}\n`);
  if (findings.length === 0) {
    console.log(`${GREEN}${BOLD}✔ CLEAN REPOSITORY: No protected file leaks or unconstrained commands detected.${RESET}`);
  } else {
    console.log(`${RED}${BOLD}⚠ ${findings.length} Potential Security Concerns Detected:${RESET}`);
    findings.forEach((f, i) => {
      const color = f.severity === 'CRITICAL' ? RED : YELLOW;
      console.log(`  [${i + 1}] ${color}${BOLD}${f.severity}${RESET} [${f.type}] ${CYAN}${f.target}${RESET}`);
      console.log(`      ${GRAY}${f.reason}${RESET}`);
    });
  }
}

async function handleInit() {
  banner();
  console.log(`${BOLD}⚡ Initializing Jev Brain in current project...${RESET}\n`);
  const configPath = path.join(process.cwd(), '.jev.json');
  const defaultConfig = {
    version: '1.0.0',
    threshold: 0.8,
    warden: {
      protectedPatterns: ['.env', '*.pem', '*.key', 'id_rsa', '.git'],
      failOnRisk: true
    },
    routing: {
      defaultPreset: 'inbox'
    }
  };

  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
  console.log(`${GREEN}✔ Created .jev.json configuration.${RESET}`);

  if (fs.existsSync(path.join(process.cwd(), '.git'))) {
    await handleHook();
  }

  console.log(`\n${BOLD}Next steps:${RESET}`);
  console.log(`  • Security audit:       ${CYAN}npx jev-brain audit${RESET}`);
  console.log(`  • Test pre-flight gate: ${CYAN}npx jevbrain warden --command "rm -rf /"${RESET}`);
  console.log(`  • Launch dashboard:     ${CYAN}npx jevbrain serve${RESET}\n`);
}

// ==========================================
// JEV BRAIN CLI & LOCAL AI CONFIGURATION
// ==========================================

const CONFIG_DIR = path.join(os.homedir(), '.jevbrain');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadCliConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        endpoint: process.env.JEV_ENDPOINT || parsed.endpoint || 'https://jevbrain.world',
        apiKey: process.env.JEV_API_KEY || parsed.apiKey || ''
      };
    }
  } catch {}
  return {
    endpoint: process.env.JEV_ENDPOINT || 'https://jevbrain.world',
    apiKey: process.env.JEV_API_KEY || ''
  };
}

function saveCliConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`${RED}Failed to save configuration:${RESET}`, err.message);
    return false;
  }
}

// Prompt a single line through an existing readline interface
function promptLine(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

// Validate a jev_live_ API key against the backend (returns account + tier info)
async function validateApiKey(endpoint, apiKey) {
  try {
    const res = await fetch(`${endpoint}/api/keys/status`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.success === true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Could not reach server: ${err.message}` } };
  }
}

// Fetch live credit balance for the configured key
async function fetchCreditSummary(endpoint, apiKey) {
  try {
    const res = await fetch(`${endpoint}/api/credits/balance`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await res.json().catch(() => ({}));
    return data.success ? data : null;
  } catch {
    return null;
  }
}

// Interactive first-run onboarding: paste key from website, verify live, save & welcome
async function interactiveApiKeySetup(rl, cfg, maxAttempts = 3) {
  const endpoint = (cfg.endpoint || 'https://jevbrain.world').replace(/\/+$/, '');
  console.log(`  ${C_MUTED}┌────────────────────────────────────────────────────────────────────────┐${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${BOLD}${C_GOLD}🔑 Setup Required: Jev Brain Live API Key${RESET}                            ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}                                                                        ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  To use this terminal, connect your Solana wallet at:                  ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ➔  ${CYAN}${BOLD}${endpoint}/api-keys${RESET}                                            ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}                                                                        ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${CYAN}1.${RESET} Connect your Phantom / Solana wallet holding $JEVBRAIN tokens       ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${CYAN}2.${RESET} Generate your unique API key (${BOLD}jev_live_...${RESET})                      ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${CYAN}3.${RESET} Paste it below to unlock local terminal AI access                   ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}                                                                        ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${GRAY}* Whitelisted operator wallets can enter without holding tokens.${RESET}      ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}└────────────────────────────────────────────────────────────────────────┘${RESET}\n`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = (await promptLine(rl, `${BOLD}${C_CYAN}➤ Paste your API key (jev_live_...): ${RESET}`)).trim();
    if (!raw) {
      console.log(`${YELLOW}Empty input. Paste the full key copied from ${endpoint}/api-keys or type /exit to quit.${RESET}\n`);
      continue;
    }
    if (raw === '/exit' || raw === '/quit') return false;
    if (!raw.startsWith('jev_live_')) {
      console.log(`${YELLOW}⚠ Keys start with ${BOLD}jev_live_${RESET}${YELLOW}. Copy the complete key from your dashboard at ${endpoint}/api-keys and try again.${RESET}\n`);
      continue;
    }

    process.stdout.write(`${GRAY}Verifying key against ${endpoint}...${RESET} `);
    const check = await validateApiKey(endpoint, raw);
    if (!check.ok) {
      console.log(`${RED}✖${RESET}`);
      console.log(`${RED}✖ Key rejected (${check.status || 'network'}): ${check.data?.error || 'Invalid or revoked key'}${RESET}\n`);
      continue;
    }
    console.log(`${GREEN}✔${RESET}`);

    cfg.apiKey = raw;
    saveCliConfig(cfg);

    const d = check.data;
    console.log(`\n${GREEN}${BOLD}✔ API key verified & saved to ${CONFIG_FILE}${RESET}`);
    console.log(`  ${BOLD}Wallet:${RESET}   ${CYAN}${(d.walletAddress || '').slice(0, 6)}...${(d.walletAddress || '').slice(-4)}${RESET}`);
    console.log(`  ${BOLD}Tier:${RESET}     ${MAGENTA}[${d.tierName || 'Holder'}]${RESET} (Tier ${d.tierId || 0}) · ${GRAY}+${d.creditRatePerHour || 0} credits/hr${RESET}`);

    const summary = await fetchCreditSummary(endpoint, raw);
    if (summary) {
      console.log(`  ${BOLD}Credits:${RESET}  ${GREEN}${Number(summary.availableCredits || 0).toLocaleString()}${RESET} available\n`);
    } else {
      console.log('');
    }
    return true;
  }

  console.log(`${YELLOW}Too many failed attempts. Run ${CYAN}jevbrain config set-key <your-key>${RESET}${YELLOW} when you have a valid key.${RESET}\n`);
  return false;
}

async function handleConfig() {
  const sub = args[1];
  const val = args[2];
  const cfg = loadCliConfig();

  if (sub === 'set-key') {
    if (!val) {
      console.error(`${RED}Usage: jevbrain config set-key <jev_live_...>${RESET}`);
      process.exit(1);
    }
    if (!val.startsWith('jev_live_')) {
      console.warn(`${YELLOW}Note: Jev Brain API keys start with 'jev_live_'. Make sure you copied it from your dashboard at https://jevbrain.world.${RESET}`);
    }
    cfg.apiKey = val.trim();
    saveCliConfig(cfg);
    console.log(`${GREEN}✔ Jev Brain API key successfully saved to ${CONFIG_FILE}${RESET}`);
    console.log(`You can now run:`);
    console.log(`  ${CYAN}jevbrain "Write a python script to monitor Solana tokens"${RESET}`);
    console.log(`  ${CYAN}jevbrain chat${RESET}\n`);
    return;
  }

  if (sub === 'set-url' || sub === 'set-endpoint') {
    if (!val) {
      console.error(`${RED}Usage: jevbrain config set-url <url>${RESET}`);
      process.exit(1);
    }
    cfg.endpoint = val.trim().replace(/\/+$/, '');
    saveCliConfig(cfg);
    console.log(`${GREEN}✔ Jev Brain endpoint set to: ${cfg.endpoint}${RESET}`);
    return;
  }

  if (sub === 'get-key' || sub === 'show' || !sub) {
    banner();
    const masked = cfg.apiKey && cfg.apiKey.length > 16
      ? `${cfg.apiKey.slice(0, 13)}...${cfg.apiKey.slice(-4)}`
      : (cfg.apiKey || 'None configured');
    console.log(`${BOLD}Jev Brain CLI Configuration:${RESET}`);
    console.log(`  ${BOLD}Endpoint:${RESET}  ${CYAN}${cfg.endpoint || 'https://jevbrain.world'}${RESET}`);
    console.log(`  ${BOLD}API Key:${RESET}   ${GREEN}${masked}${RESET}`);
    console.log(`  ${BOLD}Config:${RESET}    ${GRAY}${CONFIG_FILE}${RESET}\n`);

    if (cfg.apiKey) {
      process.stdout.write(`${GRAY}Checking token holder status on-chain...${RESET} `);
      try {
        const res = await fetch(`${cfg.endpoint || 'https://jevbrain.world'}/api/credits/balance`, {
          headers: { 'Authorization': `Bearer ${cfg.apiKey}` }
        });
        const data = await res.json();
        if (data.success && data.eligibility) {
          console.log(`${GREEN}✔ Verified Token Holder${RESET}`);
          console.log(`  ${BOLD}Wallet:${RESET}    ${CYAN}${data.eligibility.walletAddress}${RESET}`);
          console.log(`  ${BOLD}Tier:${RESET}      ${MAGENTA}${data.eligibility.tier} (Level ${data.eligibility.tierLevel})${RESET}`);
          console.log(`  ${BOLD}Holding:${RESET}   ${data.eligibility.balanceUi} $JEVBRAIN`);
          console.log(`  ${BOLD}Credits:${RESET}   ${data.availableCredits} available\n`);
        } else {
          console.log(`${YELLOW}⚠ ${data.error || 'Unable to verify status'}${RESET}\n`);
        }
      } catch (e) {
        console.log(`${YELLOW}⚠ (Could not reach server: ${e.message})${RESET}\n`);
      }
    } else {
      console.log(`${YELLOW}No API key configured. Obtain your free key by connecting your Solana wallet at https://jevbrain.world${RESET}`);
      console.log(`Then configure it with: ${CYAN}npx jevbrain config set-key <your-key>${RESET}\n`);
    }
    return;
  }
}

// opts.silent: don't print tokens/meta — just return the text (used for commit messages, PR bodies).
// Returns { text, ...doneMeta } or null on failure.
async function streamAiResponse(prompt, model = 'auto', opts = {}) {
  const silent = !!opts.silent;
  const onToken = typeof opts.onToken === 'function' ? opts.onToken : null;
  const cfg = loadCliConfig();
  const apiKey = cfg.apiKey || process.env.JEV_API_KEY;
  const endpoint = (cfg.endpoint || process.env.JEV_ENDPOINT || 'https://jevbrain.world').replace(/\/+$/, '');

  if (!apiKey) {
    if (silent) return null;
    banner();
    console.error(`${RED}${BOLD}✖ No Jev Brain API Key Found${RESET}\n`);
    console.error(`${YELLOW}To use Jev Brain AI from your terminal, obtain your free API key for token holders:${RESET}`);
    console.error(`  1. Connect your Solana wallet at: ${CYAN}https://jevbrain.world${RESET}`);
    console.error(`  2. Open ${BOLD}Holder Hub ➔ Jev Brain CLI${RESET} and click 'Generate CLI Key'.`);
    console.error(`  3. Run in your terminal: ${CYAN}jevbrain config set-key <your-key>${RESET}\n`);
    process.exit(1);
  }

  try {
    const res = await fetch(`${endpoint}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ prompt, model })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      console.error(`\n${RED}${BOLD}✖ Error (${res.status}):${RESET} ${errJson.error || res.statusText}\n`);
      if (res.status === 401 || res.status === 403) {
        console.error(`${YELLOW}Make sure your wallet holds the minimum $JEVBRAIN tokens at https://jevbrain.world${RESET}\n`);
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let metaInfo = null;
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const block of lines) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.slice(6));
            if (parsed.token) {
              fullText += parsed.token;
              if (onToken) onToken(parsed.token);
              else if (!silent) process.stdout.write(parsed.token);
            }
            if (parsed.done) {
              metaInfo = parsed;
            }
          } catch {}
        }
      }
    }

    if (silent) {
      return { ...(metaInfo || {}), text: fullText };
    }
    process.stdout.write('\n');
    if (metaInfo && metaInfo.model) {
      const tierBadge = metaInfo.userTier?.tierName || 'Holder';
      console.log(`\n${GRAY}⚡ Model: ${metaInfo.model} · Tier: [${tierBadge}] · Latency: ${Math.round(metaInfo.latencyMs || 0)}ms${RESET}`);
      if (metaInfo.isCacheHit) {
        console.log(`${GRAY}💾 Semantic cache hit · 0 credits charged${RESET}`);
      } else {
        const cd = metaInfo.creditDeduction;
        if (cd && cd.creditsDeducted !== undefined) {
          console.log(`${GRAY}💳 Credits used: ${YELLOW}${cd.creditsDeducted}${GRAY} · Remaining balance: ${GREEN}${cd.availableCredits}${RESET}`);
        }
      }
    }
    return { ...(metaInfo || {}), text: fullText };
  } catch (err) {
    console.error(`\n${RED}Connection error:${RESET}`, err.message);
    return null;
  }
}

async function handleStatus() {
  banner();
  const cfg = loadCliConfig();
  const apiKey = cfg.apiKey || process.env.JEV_API_KEY;
  const endpoint = (cfg.endpoint || process.env.JEV_ENDPOINT || 'https://jevbrain.world').replace(/\/+$/, '');

  if (!apiKey) {
    console.log(`${YELLOW}No API key configured.${RESET}`);
    console.log(`Connect your Solana wallet holding $JEVBRAIN tokens at: ${CYAN}https://jevbrain.world${RESET}`);
    console.log(`Then set your key with: ${CYAN}npx jevbrain config set-key <your-key>${RESET}\n`);
    return;
  }

  console.log(`${BOLD}Fetching Live On-Chain Holding & Tier Status...${RESET}\n`);
  try {
    const res = await fetch(`${endpoint}/api/keys/status`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`${RED}${BOLD}✖ Error (${res.status}):${RESET} ${err.error || res.statusText}\n`);
      return;
    }

    const data = await res.json();
    const isSuspended = data.keyStatus === 'suspended';
    const statusColor = isSuspended ? RED : GREEN;
    const statusText = isSuspended ? 'SUSPENDED (0 Tokens / Sold)' : 'ACTIVE';

    console.log(`${BOLD}Jev Brain CLI Account Status:${RESET}`);
    console.log(`  ${BOLD}Connected Wallet:${RESET}  ${CYAN}${data.walletAddress || 'Unknown'}${RESET}`);
    console.log(`  ${BOLD}Key Status:${RESET}        ${statusColor}${BOLD}${statusText}${RESET}`);
    if (data.suspensionReason) {
      console.log(`  ${BOLD}Suspension Note:${RESET}   ${YELLOW}${data.suspensionReason}${RESET}`);
    }
    console.log(`  ${BOLD}Tokens Held:${RESET}       ${BOLD}${Number(data.tokensHeld || 0).toLocaleString()} $JEVBRAIN${RESET}`);
    console.log(`  ${BOLD}Holding Tier:${RESET}      ${CYAN}[${data.tierName || 'Guest'}]${RESET} (Tier ${data.tierId || 0})`);
    console.log(`  ${BOLD}Credit Rate:${RESET}       ${GREEN}+${data.creditRatePerHour || 0} credits/hr${RESET}`);
    console.log(`  ${BOLD}Endpoint:${RESET}          ${GRAY}${endpoint}${RESET}`);

    console.log(`\n${BOLD}Permitted Models for your Tier:${RESET}`);
    if (data.allowedModels && data.allowedModels.length > 0) {
      if (data.allowedModels.includes('all')) {
        console.log(`  ${GREEN}✔ All 500+ Frontier & Open-Weight Models Unlocked (Dynasty Magnate VIP)${RESET}`);
      } else {
        for (const m of data.allowedModels) {
          console.log(`  ${GREEN}✔${RESET} ${m}`);
        }
      }
    } else {
      console.log(`  ${YELLOW}No models unlocked. Wallet holds 0 tokens.${RESET}`);
    }

    if (isSuspended) {
      console.log(`\n${YELLOW}⚠ Your API key is suspended because your wallet holds 0 tokens.${RESET}`);
      console.log(`Re-acquire $JEVBRAIN tokens at https://jevbrain.world to immediately reactivate.`);
    } else {
      console.log(`\n${GRAY}Run queries with: jevbrain "<prompt>" or jevbrain -m <model> "<prompt>"${RESET}`);
    }
    console.log();
  } catch (err) {
    console.error(`${RED}Failed to fetch account status:${RESET}`, err.message);
  }
}

async function handleModels() {
  banner();
  const cfg = loadCliConfig();
  const apiKey = cfg.apiKey || process.env.JEV_API_KEY;
  const endpoint = (cfg.endpoint || 'https://jevbrain.world').replace(/\/+$/, '');

  if (!apiKey) {
    console.log(`${YELLOW}No API key configured.${RESET}`);
    console.log(`Connect your Solana wallet holding $JEVBRAIN tokens at: ${CYAN}https://jevbrain.world/api-keys${RESET}`);
    console.log(`Then set your key with: ${CYAN}jevbrain config set-key <your-key>${RESET}\n`);
    return;
  }

  process.stdout.write(`${GRAY}Fetching unlocked AI models for your holding tier...${RESET} `);
  try {
    const res = await fetch(`${endpoint}/api/keys/status`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.log(`${RED}✖${RESET}`);
      const err = await res.json().catch(() => ({}));
      console.error(`${RED}${BOLD}✖ Error (${res.status}):${RESET} ${err.error || res.statusText}\n`);
      return;
    }

    console.log(`${GREEN}✔${RESET}\n`);
    const data = await res.json();
    const shortAddr = data.walletAddress ? `${data.walletAddress.slice(0, 6)}...${data.walletAddress.slice(-4)}` : 'Unknown';
    const tierName = data.tierName || 'Holder';

    console.log(`  ${C_MUTED}┌────────────────────────────────────────────────────────────────────────┐${RESET}`);
    console.log(`  ${C_MUTED}│${RESET}  ${BOLD}${C_CYAN}Permitted AI Models for Your Holding Tier${RESET}                             ${C_MUTED}│${RESET}`);
    console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Wallet:${RESET} ${CYAN}${shortAddr}${RESET} · ${GRAY}Tier:${RESET} ${C_PURPLE}[${tierName}]${RESET} (Tier ${data.tierId || 0})               ${C_MUTED}│${RESET}`);
    console.log(`  ${C_MUTED}└────────────────────────────────────────────────────────────────────────┘${RESET}\n`);

    if (data.allowedModels && data.allowedModels.includes('all')) {
      console.log(`  ${C_EMERALD}${BOLD}✔ ALL 500+ Frontier, Reasoning, Coding & Open-Weight Models Unlocked!${RESET}`);
      console.log(`  ${GRAY}(Dynasty Magnate VIP tier has unrestricted access to all catalog models)${RESET}\n`);
      console.log(`  ${BOLD}Top Recommended Models for Development & Architecture:${RESET}`);
      console.log(`    ${CYAN}• anthropic/claude-3.7-sonnet${RESET}   ${GRAY}- SOTA Hybrid Reasoning & Architecture${RESET}`);
      console.log(`    ${CYAN}• anthropic/claude-3.5-haiku${RESET}    ${GRAY}- Ultra-low latency code execution & chat${RESET}`);
      console.log(`    ${CYAN}• openai/gpt-4o${RESET}                 ${GRAY}- Flagship multimodal intelligence${RESET}`);
      console.log(`    ${CYAN}• openai/o3-mini${RESET}                ${GRAY}- Mathematical & algorithm reasoning engine${RESET}`);
      console.log(`    ${CYAN}• deepseek/deepseek-chat${RESET}        ${GRAY}- DeepSeek V3 code intelligence & logic${RESET}`);
      console.log(`    ${CYAN}• meta-llama/llama-3.3-70b-instruct${RESET} ${GRAY}- Top open-weights powerhouse${RESET}`);
    } else if (data.allowedModels && data.allowedModels.length > 0) {
      console.log(`  ${BOLD}Available Models for [${tierName}]:${RESET}`);
      for (const m of data.allowedModels) {
        console.log(`    ${GREEN}✔${RESET} ${CYAN}${m}${RESET}`);
      }
    } else {
      console.log(`  ${YELLOW}No models unlocked. Wallet holds 0 tokens.${RESET}`);
      console.log(`  Acquire $JEVBRAIN tokens on Solana to unlock higher tiers.`);
    }

    console.log(`\n  ${GRAY}Single query: ${CYAN}jevbrain -m <model> "<prompt>"${RESET}`);
    console.log(`  ${GRAY}Switch inside chat: ${CYAN}/model <model>${RESET}\n`);
  } catch (err) {
    console.error(`${RED}Failed to query model list:${RESET}`, err.message);
  }
}

async function handleChat(initialModel = 'auto', opts = {}) {
  if (!opts.skipBanner) banner();
  const cfg = loadCliConfig();
  const endpoint = (cfg.endpoint || 'https://jevbrain.world').replace(/\/+$/, '');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}${C_CYAN}jevbrain${RESET}${C_MUTED}❯${RESET} `
  });

  // First-run onboarding: paste the key copied from the website, verify live, save.
  if (!cfg.apiKey && !process.env.JEV_API_KEY) {
    const ready = await interactiveApiKeySetup(rl, cfg);
    if (!ready) {
      rl.close();
      return;
    }
  }

  const apiKey = cfg.apiKey || process.env.JEV_API_KEY;
  let activeModel = initialModel;

  // ── Repo-aware session state ────────────────────────────────────────────
  const cwd = process.cwd();
  const repoMode = GitFlow.isGitRepo(cwd);
  let repoContextEnabled = repoMode;
  const repoLabel = repoMode
    ? (() => { const gh = GitFlow.githubRepo(cwd); const br = GitFlow.currentBranch(cwd) || 'no commits'; return `${gh ? `${gh.owner}/${gh.repo}` : path.basename(GitFlow.repoRoot(cwd))} @ ${br}`; })()
    : '';
  const attachedFiles = new Map(); // rel path → content (re-read before each prompt)
  const history = [];              // [{ user, assistant }], last few turns sent as context
  const MAX_HISTORY_TURNS = 4;

  const gitCtx = {
    cwd,
    yes: false,
    ask: (q) => promptLine(rl, q),
    ai: async (prompt) => {
      const r = await streamAiResponse(prompt, activeModel, { silent: true });
      return r?.text || null;
    }
  };

  // ── Agent mode (default): the model can read/edit files, run commands, use git & skills ──
  let agentMode = !opts.plain;
  const agent = new JevAgent({
    cwd,
    mode: opts.auto ? 'auto' : 'ask',
    maxSteps: 20,
    ask: (q) => promptLine(rl, q),
    ai: (prompt, onToken) => streamAiResponse(prompt, activeModel, { silent: true, onToken })
  });
  let busy = false;

  function buildPrompt(userInput) {
    const parts = [];
    if (repoContextEnabled && GitFlow.isGitRepo(cwd)) {
      parts.push(`[Workspace — the user is running you inside their git repository]\n${GitFlow.repoContextSummary(cwd)}`);
    }
    for (const rel of attachedFiles.keys()) {
      const f = GitFlow.readFileForContext(rel, cwd);
      if (f.ok) parts.push(`[File: ${f.rel}]\n\`\`\`\n${f.content}\n\`\`\``);
    }
    if (history.length) {
      parts.push('[Recent conversation]\n' + history.map(h =>
        `User: ${GitFlow.truncate(h.user, 1500)}\nAssistant: ${GitFlow.truncate(h.assistant, 2500)}`
      ).join('\n\n'));
    }
    if (!parts.length) return userInput;
    parts.push(`[Current request]\n${userInput}`);
    return parts.join('\n\n');
  }

  // Live key validation on entry
  const check = await validateApiKey(endpoint, apiKey);
  if (!check.ok) {
    console.log(`${RED}${BOLD}✖ API Key Rejected or Expired (${check.status}):${RESET} ${check.data?.error || 'Invalid API key'}`);
    console.log(`${YELLOW}Please generate an active key at ${endpoint}/api-keys and run:${RESET}`);
    console.log(`  ${CYAN}jevbrain config set-key <new-key>${RESET}\n`);
    rl.close();
    return;
  }

  const d = check.data;
  const shortAddr = d.walletAddress ? `${d.walletAddress.slice(0, 6)}...${d.walletAddress.slice(-4)}` : 'Unknown';
  const tierName = d.tierName || 'Holder';

  if (d.keyStatus === 'suspended') {
    console.log(`  ${RED}${BOLD}✖ API Key Suspended:${RESET} ${YELLOW}${d.suspensionReason || '0 tokens held (sold/transferred)'}${RESET}`);
    console.log(`  ${GRAY}Re-acquire $JEVBRAIN tokens on Solana to immediately reactivate.${RESET}\n`);
    rl.close();
    return;
  }

  const startSummary = await fetchCreditSummary(endpoint, apiKey);
  const availCredits = startSummary ? Number(startSummary.availableCredits || 0).toLocaleString() : 'Active';

  console.log(`  ${C_MUTED}┌────────────────────────────────────────────────────────────────────────┐${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${BOLD}${C_CYAN}⚡ Jev Brain Agent${RESET} ${GRAY}· reads, edits, runs & ships code in ${path.basename(cwd)}${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Wallet:${RESET} ${CYAN}${shortAddr}${RESET} · ${GRAY}Tier:${RESET} ${C_PURPLE}[${tierName}]${RESET} (Tier ${d.tierId || 0})               ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Credits:${RESET} ${C_EMERALD}${availCredits} available${RESET} ${GRAY}(+${d.creditRatePerHour || 0}/hr)${RESET} · ${GRAY}Model:${RESET} ${C_CYAN}[${activeModel}]${RESET}         ${C_MUTED}│${RESET}`);
  console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Commands: ${CYAN}/help${GRAY}, ${CYAN}/models${GRAY}, ${CYAN}/model <name>${GRAY}, ${CYAN}/balance${GRAY}, ${CYAN}/clear${GRAY}, ${CYAN}/exit${RESET}     ${C_MUTED}│${RESET}`);
  if (repoMode) {
    console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Git:${RESET} ${CYAN}${repoLabel}${RESET} ${GRAY}· /repo /commit /push /pr /ship${RESET}`);
  }
  const skillCount = Skills.listSkills(cwd).length;
  console.log(`  ${C_MUTED}│${RESET}  ${GRAY}Agent:${RESET} ${agentMode ? `${C_EMERALD}on${RESET}` : `${YELLOW}off${RESET}`} ${GRAY}· approvals:${RESET} ${agent.mode} ${GRAY}· skills:${RESET} ${skillCount} ${GRAY}(/skills)${RESET}`);
  console.log(`  ${C_MUTED}└────────────────────────────────────────────────────────────────────────┘${RESET}\n`);

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (busy) {
      if (input) console.log(`${GRAY}(still working — wait for the current task to finish)${RESET}`);
      return;
    }
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === '/exit' || input === 'exit' || input === 'quit' || input === '/quit') {
      rl.close();
      return;
    }
    if (input === '/clear' || input === 'clear') {
      console.clear();
      banner();
      console.log(`  ${C_MUTED}┌────────────────────────────────────────────────────────────────────────┐${RESET}`);
      console.log(`  ${C_MUTED}│${RESET}  ${BOLD}${C_CYAN}⚡ Jev Brain Interactive Terminal Chat${RESET} · Active Model: ${C_CYAN}[${activeModel}]${RESET}        ${C_MUTED}│${RESET}`);
      console.log(`  ${C_MUTED}└────────────────────────────────────────────────────────────────────────┘${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input === '/help') {
      console.log(`\n${BOLD}Interactive Terminal Commands:${RESET}`);
      console.log(`  ${CYAN}/models${RESET}              List permitted AI models for your holding tier`);
      console.log(`  ${CYAN}/model <name>${RESET}        Switch active model (e.g. /model deepseek/deepseek-chat)`);
      console.log(`  ${CYAN}/balance | /credits${RESET}  Check live credit balance and accrual rate`);
      console.log(`  ${CYAN}/status | /tier${RESET}      Show on-chain token holding and tier details`);
      console.log(`  ${CYAN}/key${RESET}                 Show active configured API key`);
      console.log(`  ${CYAN}/clear${RESET}               Clear terminal screen`);
      console.log(`  ${CYAN}/reset${RESET}               Forget conversation history (keeps attached files)`);
      console.log(`\n${BOLD}Agent:${RESET}`);
      console.log(`  ${CYAN}/agent on|off${RESET}        Agent mode (tools: files, shell, git, skills) — currently ${agentMode ? 'on' : 'off'}`);
      console.log(`  ${CYAN}/auto on|off${RESET}         Auto-approve edits & commands (Warden still blocks destructive ones) — ${agent.mode === 'auto' ? 'on' : 'off'}`);
      console.log(`  ${CYAN}/readonly${RESET}            Agent may only look, never change anything`);
      console.log(`  ${CYAN}/steps <n>${RESET}           Max tool steps per task (now ${agent.maxSteps})`);
      console.log(`  ${CYAN}/undo${RESET}                Revert every file the last task changed`);
      console.log(`  ${CYAN}/arena <task> --test "npm test" [--models a,b,c]${RESET}`);
      console.log(`                       ${GRAY}⚔ Several AI agents race on the same task in sandboxes; your tests pick the winner${RESET}`);
      console.log(`\n${BOLD}Skills:${RESET}`);
      console.log(`  ${CYAN}/skills${RESET}              List installed skills`);
      console.log(`  ${CYAN}/<skill> [task]${RESET}      Run a task with that skill loaded`);
      console.log(`  ${CYAN}/skill use|drop <name>${RESET}  Keep a skill active for the whole session / deactivate`);
      console.log(`  ${CYAN}/skill new <name>${RESET}    Scaffold a skill in .jevbrain/skills (add --global for ~/.jevbrain)`);
      console.log(`  ${CYAN}/skill add <src>${RESET}     Install from a folder, GitHub repo/folder, or .md URL`);
      console.log(`  ${CYAN}/skill show|remove <name>${RESET}`);
      console.log(`  ${CYAN}/exit${RESET}                Exit chat session`);
      console.log(`\n${BOLD}Repository & GitHub:${RESET}`);
      for (const [c, d] of GitCmd.GIT_HELP) console.log(`  ${CYAN}${c.padEnd(30)}${RESET}${d}`);
      console.log(`  ${CYAN}${'/context on|off'.padEnd(30)}${RESET}Include branch + changed files in every prompt (${repoContextEnabled ? 'on' : 'off'})\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/agent')) {
      const v = input.split(/\s+/)[1];
      if (v === 'on' || v === 'off') agentMode = v === 'on';
      console.log(`${GRAY}Agent mode: ${agentMode ? `${GREEN}on` : `${YELLOW}off (plain chat)`}${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/auto')) {
      const v = input.split(/\s+/)[1] || (agent.mode === 'auto' ? 'off' : 'on');
      agent.mode = v === 'on' ? 'auto' : 'ask';
      console.log(agent.mode === 'auto'
        ? `${YELLOW}⚡ Auto-approve ON — edits, commands and git run without asking. Warden still blocks destructive actions.${RESET}\n`
        : `${GREEN}✔ Auto-approve OFF — you'll confirm each edit/command.${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input === '/readonly') {
      agent.mode = 'readonly';
      console.log(`${GREEN}✔ Read-only: the agent can explore but not change anything. /auto off to re-enable approvals.${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input === '/undo') {
      const r = agent.undo();
      if (!r.ok) console.log(`${GRAY}${r.error}${RESET}\n`);
      else console.log(`${GREEN}↩ Reverted ${r.restored.length} file(s) from "${r.task.slice(0, 60)}":${RESET}\n${r.restored.map(f => `   ${CYAN}${f}${RESET}`).join('\n')}\n${GRAY}(Shell command side-effects are not reverted.)${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input === '/arena' || input.startsWith('/arena ')) {
      busy = true;
      rl.pause();
      try {
        await handleArena(splitArgs(input.slice(6)), { model: activeModel, ask: (q) => promptLine(rl, q) });
      } catch (err) {
        console.log(`${RED}✖ Arena error: ${err.message}${RESET}`);
      } finally {
        busy = false;
      }
      console.log();
      rl.resume();
      rl.prompt();
      return;
    }
    if (input.startsWith('/steps')) {
      const n = parseInt(input.split(/\s+/)[1], 10);
      if (n > 0 && n <= 100) agent.maxSteps = n;
      console.log(`${GRAY}Max steps per task: ${agent.maxSteps}${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input === '/skills' || input.startsWith('/skill ') || input === '/skill') {
      const parts = input === '/skills' ? ['list'] : input.split(/\s+/).slice(1);
      const sub = parts[0] || 'list';
      if (sub === 'use' || sub === 'drop') {
        const sk = Skills.getSkill(parts[1], cwd);
        if (!sk) console.log(`${RED}✖ No skill "${parts[1] || ''}". /skills to list.${RESET}\n`);
        else if (sub === 'use') { agent.activeSkills.add(sk.name); console.log(`${GREEN}✔ Skill ${CYAN}${sk.name}${GREEN} active for this session.${RESET}\n`); }
        else { agent.activeSkills.delete(sk.name); console.log(`${GREEN}✔ Skill ${sk.name} deactivated.${RESET}\n`); }
      } else {
        rl.pause();
        await handleSkillCommand(parts, { cwd, active: agent.activeSkills });
        rl.resume();
      }
      rl.prompt();
      return;
    }
    if (input === '/reset') {
      agent.history.length = 0;
      history.length = 0;
      console.log(`${GREEN}✔ Conversation history cleared.${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/context')) {
      const v = input.split(/\s+/)[1];
      if (v === 'on' || v === 'off') repoContextEnabled = v === 'on';
      console.log(`${GRAY}Repo context in prompts: ${repoContextEnabled ? 'on' : 'off'}${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/add ') || input === '/add') {
      const targets = input.slice(4).trim().split(/\s+/).filter(Boolean);
      if (!targets.length) console.log(`${YELLOW}Usage: /add <file> [file…]${RESET}`);
      for (const t of targets) {
        const f = GitFlow.readFileForContext(t, cwd);
        if (f.ok) {
          attachedFiles.set(f.rel, true);
          console.log(`${GREEN}✔ Attached ${CYAN}${f.rel}${RESET} ${GRAY}(${f.size.toLocaleString()} chars)${RESET}`);
        } else {
          console.log(`${RED}✖ ${t}: ${f.error}${RESET}`);
        }
      }
      console.log();
      rl.prompt();
      return;
    }
    if (input === '/files') {
      console.log(attachedFiles.size
        ? `\n${[...attachedFiles.keys()].map(f => `  ${CYAN}${f}${RESET}`).join('\n')}\n`
        : `${GRAY}No files attached. Use /add <file>.${RESET}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith('/drop')) {
      const t = input.slice(5).trim();
      if (!t || t === 'all') attachedFiles.clear();
      else attachedFiles.delete(t.replace(/\\/g, '/').replace(/^\.\//, ''));
      console.log(`${GREEN}✔ ${!t || t === 'all' ? 'All files detached' : `Detached ${t}`}.${RESET}\n`);
      rl.prompt();
      return;
    }
    if (/^\/(repo|git|diff|log|branch|switch|checkout|commit|push|pr|ship)(\s|$)/.test(input)) {
      rl.pause();
      try {
        await GitCmd.handleGitSlashCommand(input, gitCtx);
      } catch (err) {
        console.log(`${RED}✖ ${err.message}${RESET}\n`);
      }
      rl.resume();
      rl.prompt();
      return;
    }
    if (input === '/models') {
      rl.pause();
      await handleModels();
      rl.resume();
      rl.prompt();
      return;
    }
    if (input.startsWith('/model ') || input === '/model') {
      const newModel = input.slice(7).trim();
      if (newModel) {
        activeModel = newModel;
        console.log(`${GREEN}✔ Active model switched to: [${CYAN}${activeModel}${GREEN}]${RESET}\n`);
      } else {
        console.log(`${GRAY}Current active model: [${CYAN}${activeModel}${GRAY}]. To change: ${CYAN}/model <model-name>${RESET}\n`);
      }
      rl.prompt();
      return;
    }
    if (input === '/credits' || input === '/balance') {
      rl.pause();
      const summary = await fetchCreditSummary(endpoint, cfg.apiKey || process.env.JEV_API_KEY);
      if (summary) {
        console.log(`\n  ${BOLD}💳 Credit Balance:${RESET} ${C_EMERALD}${BOLD}${Number(summary.availableCredits || 0).toLocaleString()}${RESET} credits available`);
        if (summary.eligibility) {
          console.log(`  ${GRAY}Accrual Rate: +${summary.eligibility.creditRatePerHour || 0} credits/hr · Tier: [${summary.eligibility.tier || 'Holder'}]${RESET}\n`);
        } else {
          console.log('');
        }
      } else {
        console.log(`${YELLOW}Could not fetch credit balance. Check your connection or key with /status.${RESET}\n`);
      }
      rl.resume();
      rl.prompt();
      return;
    }
    if (input === '/status' || input === '/tier') {
      rl.pause();
      await handleStatus();
      rl.resume();
      rl.prompt();
      return;
    }
    if (input === '/key') {
      const activeKey = cfg.apiKey || process.env.JEV_API_KEY || 'None';
      const masked = activeKey.length > 16 ? `${activeKey.slice(0, 13)}...${activeKey.slice(-4)}` : activeKey;
      console.log(`\n  ${BOLD}Active API Key:${RESET} ${C_CYAN}${masked}${RESET}`);
      console.log(`  ${GRAY}Endpoint:${RESET}       ${endpoint}`);
      console.log(`  ${GRAY}Config File:${RESET}    ${CONFIG_FILE}\n`);
      rl.prompt();
      return;
    }

    // /<skill-name> [task] → run the task with that skill loaded
    let task = input;
    let oneShotSkill = null;
    if (input.startsWith('/')) {
      const [cmdName, ...restWords] = input.slice(1).split(/\s+/);
      const sk = Skills.getSkill(cmdName, cwd);
      if (!sk) {
        console.log(`${YELLOW}Unknown command ${input.split(/\s+/)[0]}. Type /help (or /skills for installed skills).${RESET}\n`);
        rl.prompt();
        return;
      }
      oneShotSkill = sk.name;
      task = restWords.join(' ').trim() || `Use the ${sk.name} skill on this project.`;
    }

    busy = true;
    rl.pause();
    try {
      if (agentMode) {
        const attached = [...attachedFiles.keys()];
        const fullTask = attached.length ? `${task}\n\n(The user attached these files for context: ${attached.join(', ')} — read them first.)` : task;
        const hadSkill = oneShotSkill && agent.activeSkills.has(oneShotSkill);
        if (oneShotSkill) agent.activeSkills.add(oneShotSkill);
        console.log();
        await agent.run(fullTask);
        if (oneShotSkill && !hadSkill) agent.activeSkills.delete(oneShotSkill);
      } else {
        const reply = await streamAiResponse(buildPrompt(task), activeModel);
        if (reply?.text) {
          history.push({ user: task, assistant: reply.text });
          if (history.length > MAX_HISTORY_TURNS) history.shift();
        }
      }
    } catch (err) {
      console.log(`${RED}✖ ${err.message}${RESET}`);
    } finally {
      busy = false;
    }
    console.log();
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n  ${C_PURPLE}${BOLD}“Don't think. Route.”${RESET}\n`);
    process.exit(0);
  });
}

// `jevbrain skill …` and `/skill …` in chat
async function handleSkillCommand(parts, { cwd = process.cwd(), active = new Set() } = {}) {
  const flags = new Set(parts.filter(p => p.startsWith('--')));
  const pos = parts.filter(p => !p.startsWith('--'));
  const sub = pos[0] || 'list';
  const global = flags.has('--global') || flags.has('-g');

  switch (sub) {
    case 'list':
    case 'ls': {
      const skills = Skills.listSkills(cwd);
      if (!skills.length) {
        console.log(`\n  ${GRAY}No skills installed yet.${RESET}`);
        console.log(`  ${CYAN}jevbrain skill new <name>${RESET}                 ${GRAY}scaffold your own${RESET}`);
        console.log(`  ${CYAN}jevbrain skill add github:owner/repo/path${RESET}  ${GRAY}install from GitHub${RESET}\n`);
        return;
      }
      console.log(`\n  ${BOLD}Installed skills${RESET} ${GRAY}(run with /<name> in chat, or jevbrain do --skill <name> "…")${RESET}`);
      for (const sk of skills) {
        const badge = active.has(sk.name) ? `${C_EMERALD}●${RESET}` : ' ';
        console.log(`  ${badge} ${CYAN}${sk.name.padEnd(24)}${RESET}${GRAY}[${sk.scope}]${RESET} ${sk.description.slice(0, 90)}`);
      }
      console.log();
      return;
    }
    case 'new':
    case 'create': {
      const name = pos[1];
      const description = pos.slice(2).join(' ');
      const r = Skills.createSkill(name, { description, global, cwd });
      if (!r.ok) { console.log(`${RED}✖ ${r.error}${RESET}\n`); return; }
      console.log(`${GREEN}✔ Created skill ${CYAN}${r.name}${RESET}\n  ${GRAY}Edit:${RESET} ${r.file}`);
      console.log(`  ${GRAY}Use it: ${CYAN}/${r.name} <task>${GRAY} in chat, or ${CYAN}jevbrain do --skill ${r.name} "<task>"${RESET}\n`);
      return;
    }
    case 'add':
    case 'install': {
      const source = pos[1];
      if (!source) {
        console.log(`${YELLOW}Usage: jevbrain skill add <folder | github:owner/repo[/path] | https://github.com/… | https://…/SKILL.md> [--global] [--force]${RESET}\n`);
        return;
      }
      process.stdout.write(`${GRAY}Installing skill(s) from ${source}…${RESET}\n`);
      const r = await Skills.addSkill(source, { global, cwd, force: flags.has('--force') });
      for (const i of r.installed) console.log(`${GREEN}✔ Installed ${CYAN}${i.name}${RESET} ${GRAY}→ ${i.dir}${RESET}`);
      if (!r.ok) console.log(`${RED}✖ ${r.error}${RESET}`);
      if (r.installed.length) {
        console.log(`${YELLOW}⚠ Skills are instructions the agent will follow — review third-party skills (jevbrain skill show <name>) before using them.${RESET}`);
      }
      console.log();
      return;
    }
    case 'show':
    case 'cat': {
      const sk = Skills.getSkill(pos[1], cwd);
      if (!sk) { console.log(`${RED}✖ No skill "${pos[1] || ''}"${RESET}\n`); return; }
      console.log(`\n${GRAY}${sk.file} [${sk.scope}]${RESET}\n\n${Skills.renderSkillForPrompt(sk)}\n`);
      return;
    }
    case 'remove':
    case 'rm':
    case 'uninstall': {
      const r = Skills.removeSkill(pos[1], { cwd });
      console.log(r.ok ? `${GREEN}✔ Removed ${r.name} (${r.scope})${RESET}\n` : `${RED}✖ ${r.error}${RESET}\n`);
      return;
    }
    case 'path':
    case 'dirs':
      for (const d of Skills.skillDirs(cwd)) console.log(`  ${d.scope.padEnd(8)} ${d.dir}`);
      console.log();
      return;
    default:
      console.log(`${YELLOW}Usage: jevbrain skill [list | new <name> [description] | add <source> | show <name> | remove <name> | path] [--global]${RESET}\n`);
  }
}

// Parse `arena` arguments (shared by `jevbrain arena …` and `/arena …`)
function parseArenaArgs(argv, defaultModel = 'auto') {
  const o = { task: '', models: [], test: '', apply: false, keep: false, steps: 15, skills: [], n: 0 };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models' || a === '--model' || a === '-m') { o.models.push(...String(argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean)); continue; }
    if (a === '--test' || a === '-t') { o.test = argv[++i] || ''; continue; }
    if (a === '-n' || a === '--runs') { o.n = Math.min(5, Math.max(2, parseInt(argv[++i], 10) || 3)); continue; }
    if (a === '--steps') { o.steps = parseInt(argv[++i], 10) || o.steps; continue; }
    if (a === '--skill' || a === '-s') { if (argv[i + 1]) o.skills.push(argv[++i]); continue; }
    if (a === '--apply' || a === '-y' || a === '--yes') { o.apply = true; continue; }
    if (a === '--keep') { o.keep = true; continue; }
    words.push(a);
  }
  o.task = words.join(' ').trim();
  if (!o.models.length) o.models = Array(o.n || 3).fill(defaultModel);
  else if (o.models.length === 1) o.models = Array(o.n || 3).fill(o.models[0]);
  return o;
}

/** Split a command line honoring "double" and 'single' quotes (for /arena inside chat). */
function splitArgs(line) {
  const out = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function handleArena(argv, { model = 'auto', ask = null } = {}) {
  const o = parseArenaArgs(argv, model);
  if (!o.task) {
    console.log(`${YELLOW}Usage: jevbrain arena "<task>" [--test "npm test"] [--models a,b,c | -n 3] [--apply] [--steps 15] [--skill x] [--keep]${RESET}\n`);
    return null;
  }
  const cfg = loadCliConfig();
  if (!cfg.apiKey && !process.env.JEV_API_KEY) {
    console.log(`${YELLOW}No API key configured. Run ${CYAN}jevbrain${YELLOW} once to set it up.${RESET}\n`);
    return null;
  }
  for (const name of o.skills) {
    if (!Skills.getSkill(name)) { console.log(`${RED}✖ No skill "${name}"${RESET}`); return null; }
  }
  return runArena({
    task: o.task,
    models: o.models,
    test: o.test,
    apply: o.apply,
    keep: o.keep,
    maxSteps: o.steps,
    skills: o.skills,
    ask,
    aiFor: (m) => (prompt, onToken) => streamAiResponse(prompt, m, { silent: true, onToken })
  });
}

// `jevbrain do "<task>"` — one-shot autonomous agent run in the current folder
async function handleAgentTask(restArgs, model) {
  const flags = [];
  const words = [];
  const skillsToUse = [];
  let steps = 20;
  for (let i = 0; i < restArgs.length; i++) {
    const a = restArgs[i];
    if (a === '--skill' || a === '-s') { if (restArgs[i + 1]) skillsToUse.push(restArgs[++i]); continue; }
    if (a === '--steps') { steps = parseInt(restArgs[++i], 10) || steps; continue; }
    if (a.startsWith('--') || a === '-y') { flags.push(a); continue; }
    words.push(a);
  }
  let task = words.join(' ').trim();
  const piped = await readAllStdin();
  if (piped.trim()) task = `${task || 'Handle the following input.'}\n\nInput:\n\`\`\`\n${piped}\n\`\`\``;
  if (!task) {
    console.log(`${YELLOW}Usage: jevbrain do "<task>" [--auto|-y] [--readonly] [--skill <name>] [--steps <n>]${RESET}\n`);
    return;
  }

  const cfg = loadCliConfig();
  if (!cfg.apiKey && !process.env.JEV_API_KEY) {
    console.log(`${YELLOW}No API key configured. Run ${CYAN}jevbrain${YELLOW} once to set it up (or jevbrain config set-key <key>).${RESET}\n`);
    return;
  }

  const interactive = process.stdin.isTTY;
  const auto = flags.includes('--auto') || flags.includes('--yes') || flags.includes('-y');
  let rl = null;
  const agent = new JevAgent({
    cwd: process.cwd(),
    mode: flags.includes('--readonly') ? 'readonly' : auto ? 'auto' : interactive ? 'ask' : 'readonly',
    maxSteps: steps,
    ask: interactive ? (q) => {
      if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return promptLine(rl, q);
    } : null,
    ai: (prompt, onToken) => streamAiResponse(prompt, model, { silent: true, onToken })
  });
  for (const name of skillsToUse) {
    const sk = Skills.getSkill(name);
    if (!sk) { console.log(`${RED}✖ No skill "${name}" (jevbrain skill list)${RESET}`); return; }
    agent.activeSkills.add(sk.name);
  }
  if (!interactive && !auto && !flags.includes('--readonly')) {
    console.log(`${GRAY}(non-interactive: read-only unless you pass --auto)${RESET}`);
  }
  try {
    await agent.run(task);
  } finally {
    if (rl) rl.close();
  }
}

// Top-level `jevbrain commit|push|pr|ship|branch|repo` — same flows as the chat slash commands.
async function handleGitTopLevel(sub, restArgs, model) {
  const yes = restArgs.includes('-y') || restArgs.includes('--yes') || !process.stdin.isTTY;
  const arg = restArgs.filter(a => a !== '-y' && a !== '--yes').join(' ').trim();
  let rl = null;
  const ctx = {
    cwd: process.cwd(),
    yes,
    ask: (q) => {
      if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return promptLine(rl, q);
    },
    ai: async (prompt) => {
      const r = await streamAiResponse(prompt, model, { silent: true });
      return r?.text || null;
    }
  };
  try {
    switch (sub) {
      case 'repo': GitCmd.showRepo(ctx.cwd); break;
      case 'branch': GitCmd.doBranch(arg, ctx.cwd); break;
      case 'commit': await GitCmd.doCommit(arg, ctx); break;
      case 'push': await GitCmd.doPush(ctx); break;
      case 'pr': await GitCmd.doPr(arg, ctx); break;
      case 'ship': await GitCmd.doShip(arg, ctx); break;
    }
  } finally {
    if (rl) rl.close();
  }
}

function showHelp() {
  banner();
  console.log(`${BOLD}AI & Terminal Commands:${RESET}`);
  console.log(`  ${CYAN}jevbrain${RESET}                            Start interactive terminal AI chat session`);
  console.log(`  ${CYAN}jevbrain "<prompt>"${RESET}                   Run AI query directly with streaming output`);
  console.log(`  ${CYAN}jevbrain -m <model> "<prompt>"${RESET}        Run AI query with a specific tier-allowed model`);
  console.log(`  ${CYAN}jevbrain chat [-m <model>] [--auto|--plain]${RESET}  Interactive agent (--plain = chat without tools)`);
  console.log(`  ${CYAN}jevbrain do "<task>" [--auto] [--skill x]${RESET}  One-shot agent: explores, edits, runs, commits`);
  console.log(`  ${CYAN}jevbrain skill list|new|add|show|remove${RESET}    Manage agent skills (SKILL.md, Hermes-compatible)`);
  console.log(`  ${CYAN}jevbrain arena "<task>" --test "<cmd>"${RESET}      ⚔ AI agents race in sandboxes; tests pick the winner`);
  console.log(`  ${CYAN}jevbrain models${RESET}                       List permitted AI models for your holding tier`);
  console.log(`  ${CYAN}jevbrain status | tier${RESET}                Show live on-chain token holding, tier, and models`);
  console.log(`  ${CYAN}jevbrain balance | credits${RESET}            Check live credit balance and emissions`);
  console.log(`  ${CYAN}jevbrain config set-key <key>${RESET}         Configure your Jev Brain API key (jev_live_...)`);
  console.log(`  ${CYAN}jevbrain config get-key${RESET}               Show active key and check on-chain token tier`);
  console.log(`  ${CYAN}jevbrain config set-url <url>${RESET}         Point CLI to custom backend URL`);
  console.log(`\n${BOLD}Git & GitHub (run inside your repo, or use the /slash versions in chat):${RESET}`);
  console.log(`  ${CYAN}jevbrain repo${RESET}                         Branch, remote and changed files`);
  console.log(`  ${CYAN}jevbrain branch [name|description]${RESET}    List branches or create & switch`);
  console.log(`  ${CYAN}jevbrain commit ["message"] [-y]${RESET}      Warden-checked stage + commit (AI message if omitted)`);
  console.log(`  ${CYAN}jevbrain push${RESET}                         Push current branch (sets upstream)`);
  console.log(`  ${CYAN}jevbrain pr ["title"] [--draft] [-y]${RESET}  Push + open a GitHub PR (gh CLI or GITHUB_TOKEN)`);
  console.log(`  ${CYAN}jevbrain ship ["description"] [-y]${RESET}    Branch → commit → push → PR in one step`);
  console.log(`\n${BOLD}Safety & Routing Commands:${RESET}`);
  console.log(`  ${CYAN}jevbrain init${RESET}                         Setup .jev.json config and pre-commit hook`);
  console.log(`  ${CYAN}jevbrain hook [install|uninstall|check]${RESET}  Git pre-commit safety firewall hook`);
  console.log(`  ${CYAN}jevbrain audit [dir]${RESET}                  Scan codebase for secrets and destructive commands`);
  console.log(`  ${CYAN}jevbrain warden --tool <name> ...${RESET}     Coding agent 4-question pre-flight safety gate`);
  console.log(`  ${CYAN}jevbrain route "<text>" [--preset]${RESET}    Single item instant routing decision (<1ms)`);
  console.log(`  ${CYAN}jevbrain classify <labels> [file]${RESET}    Batch route from stdin or file`);
  console.log(`  ${CYAN}jevbrain mobile [subcommand]${RESET}          Android device gateway (devices, tap, type, inspect)`);
  console.log(`  ${CYAN}jevbrain serve [--port 3333]${RESET}          Launch Web dashboard and REST API`);
  console.log(`\n${BOLD}Examples:${RESET}`);
  console.log(`  jevbrain`);
  console.log(`  jevbrain "Write a python script to check Solana token balances"`);
  console.log(`  jevbrain -m deepseek/deepseek-chat "Review this architecture"`);
  console.log(`  jevbrain status`);
  console.log(`  jevbrain models`);
  console.log(`  cat src/server.js | jevbrain "Audit this code for security vulnerabilities"`);
  console.log(`  jevbrain do "the tests in test/ are failing — find out why and fix it"`);
  console.log(`  jevbrain skill add github:owner/skills-repo/deploy-railway`);
  console.log(`  jevbrain arena "fix the failing auth test" --test "npm test" --models deepseek/deepseek-chat,openai/gpt-4o,auto`);
  console.log(`  jevbrain ship "fix login timeout on mobile"`);
  console.log(`  jevbrain config set-key jev_live_xxxxxxxxxxxxxxxx`);
  console.log();
}

async function main() {
  // Parse global -m / --model flags
  let requestedModel = 'auto';
  let cleanArgs = [...args];
  const modelFlagIdx = cleanArgs.findIndex(a => a === '-m' || a === '--model');
  if (modelFlagIdx !== -1 && cleanArgs[modelFlagIdx + 1]) {
    requestedModel = cleanArgs[modelFlagIdx + 1];
    cleanArgs.splice(modelFlagIdx, 2);
  }

  // Bare `jevbrain` in a terminal opens the interactive AI session (banner + key setup + chat).
  // Bare `jevbrain` with piped stdin streams the piped text as one prompt.
  let primaryCommand = cleanArgs[0];
  if (!primaryCommand) {
    primaryCommand = process.stdin.isTTY ? 'chat' : 'stdin-prompt';
  }

  switch (primaryCommand) {
    case 'config':
      await handleConfig();
      break;
    case 'status':
    case 'tier':
      await handleStatus();
      break;
    case 'models':
      await handleModels();
      break;
    case 'balance':
    case 'credits': {
      banner();
      const cfg = loadCliConfig();
      const endpoint = (cfg.endpoint || 'https://jevbrain.world').replace(/\/+$/, '');
      const summary = await fetchCreditSummary(endpoint, cfg.apiKey || process.env.JEV_API_KEY);
      if (summary) {
        console.log(`  ${BOLD}💳 Credit Balance:${RESET} ${C_EMERALD}${BOLD}${Number(summary.availableCredits || 0).toLocaleString()}${RESET} credits available`);
        if (summary.eligibility) {
          console.log(`  ${GRAY}Accrual Rate: +${summary.eligibility.creditRatePerHour || 0} credits/hr · Tier: [${summary.eligibility.tier || 'Holder'}]${RESET}\n`);
        }
      } else {
        console.log(`  ${YELLOW}Could not fetch credit balance. Run jevbrain status or check your key.${RESET}\n`);
      }
      break;
    }
    case 'chat':
      await handleChat(requestedModel, { auto: cleanArgs.includes('--auto'), plain: cleanArgs.includes('--plain') });
      break;
    case 'do':
    case 'agent':
    case 'run':
      await handleAgentTask(cleanArgs.slice(1), requestedModel);
      break;
    case 'arena':
    case 'battle': {
      const interactive = process.stdin.isTTY;
      let arl = null;
      try {
        await handleArena(cleanArgs.slice(1), {
          model: requestedModel,
          ask: interactive ? (q) => { if (!arl) arl = readline.createInterface({ input: process.stdin, output: process.stdout }); return promptLine(arl, q); } : null
        });
      } finally {
        if (arl) arl.close();
      }
      break;
    }
    case 'skill':
    case 'skills':
      await handleSkillCommand(cleanArgs.slice(1).length ? cleanArgs.slice(1) : ['list']);
      break;
    case 'stdin-prompt': {
      const stdinData = await readAllStdin();
      if (stdinData.trim()) {
        await streamAiResponse(stdinData, requestedModel);
      } else {
        showHelp();
      }
      break;
    }
    case 'repo':
    case 'branch':
    case 'commit':
    case 'push':
    case 'pr':
    case 'ship':
      await handleGitTopLevel(primaryCommand, cleanArgs.slice(1), requestedModel);
      break;
    case 'init':
      await handleInit();
      break;
    case 'hook':
      await handleHook();
      break;
    case 'audit':
      await handleAudit();
      break;
    case 'classify':
      await handleClassify();
      break;
    case 'route':
      await handleRoute();
      break;
    case 'warden':
      await handleWarden();
      break;
    case 'mobile':
      await handleMobile();
      break;
    case 'serve':
      await handleServe();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      if (cleanArgs.length > 0) {
        let promptText = cleanArgs.join(' ');
        const stdinData = await readAllStdin();
        if (stdinData) {
          promptText = `${promptText}\n\nInput Context:\n\`\`\`\n${stdinData}\n\`\`\``;
        }
        await streamAiResponse(promptText, requestedModel);
      } else {
        showHelp();
      }
      break;
  }
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err.message);
  process.exit(1);
});

