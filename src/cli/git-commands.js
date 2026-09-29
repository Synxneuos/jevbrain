/**
 * Jev Brain CLI — interactive git / GitHub flows
 *
 * Used both inside `jevbrain chat` (slash commands) and as top-level commands:
 *   jevbrain repo | branch | commit | push | pr | ship
 *
 * The caller injects:
 *   ai(prompt)      → Promise<string|null>   silent AI completion (uses the user's Jev credits)
 *   ask(question)   → Promise<string>        read one line from the user
 *   yes             → boolean                auto-confirm prompts (non-interactive / --yes)
 */

import * as G from './git-workflow.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

export const GIT_HELP = [
  ['/repo', 'Show branch, remote and changed files'],
  ['/diff [--staged]', 'Show the current diff'],
  ['/log', 'Show the last 10 commits'],
  ['/add <file…>', 'Attach files so the AI can read them'],
  ['/files | /drop [file|all]', 'List / remove attached files'],
  ['/branch [name | description]', 'List branches, or create & switch to one'],
  ['/switch <branch>', 'Switch to an existing branch'],
  ['/commit [message]', 'Stage (Warden-checked) + commit; AI writes the message if omitted'],
  ['/push', 'Push the current branch and set upstream'],
  ['/pr [title] [--draft]', 'Push + open a GitHub pull request (AI-written title/body)'],
  ['/ship [description]', 'Branch (if on main) → commit → push → PR in one step']
];

function ensureRepo(cwd) {
  if (!G.isGitRepo(cwd)) {
    console.log(`${YELLOW}Not inside a git repository. Run jevbrain from your project folder (or \`git init\`).${RESET}\n`);
    return false;
  }
  return true;
}

async function confirm(ctx, question, defaultYes = true) {
  if (ctx.yes) return true;
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = String(await ctx.ask(`${question} ${GRAY}${hint}${RESET} `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans === 'y' || ans === 'yes';
}

function baseRef(base, cwd) {
  return G.git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`], cwd).ok ? `origin/${base}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────

export function showRepo(cwd) {
  if (!ensureRepo(cwd)) return;
  const st = G.status(cwd);
  const gh = G.githubRepo(cwd);
  console.log(`\n  ${BOLD}Repository:${RESET} ${CYAN}${gh ? `${gh.owner}/${gh.repo}` : G.repoRoot(cwd)}${RESET}`);
  console.log(`  ${BOLD}Branch:${RESET}     ${CYAN}${st.branch || '(no commits yet)'}${RESET}${st.upstream ? ` ${GRAY}→ ${st.upstream}${RESET}` : ` ${GRAY}(not pushed)${RESET}`}` +
    `${st.ahead ? ` ${GREEN}↑${st.ahead}${RESET}` : ''}${st.behind ? ` ${YELLOW}↓${st.behind}${RESET}` : ''}`);
  console.log(`  ${BOLD}Base:${RESET}       ${G.defaultBranch(cwd)}`);
  if (st.clean) {
    console.log(`  ${GREEN}✔ Working tree clean${RESET}\n`);
    return;
  }
  for (const s of st.staged) console.log(`    ${GREEN}${s.code} ${s.file}${RESET}`);
  for (const s of st.unstaged) console.log(`    ${YELLOW}${s.code} ${s.file}${RESET}`);
  for (const f of st.untracked) console.log(`    ${RED}? ${f}${RESET}`);
  console.log();
}

export function showDiff(cwd, staged = false) {
  if (!ensureRepo(cwd)) return;
  const stat = G.diff({ staged, stat: true }, cwd);
  if (!stat) {
    console.log(`${GRAY}No ${staged ? 'staged ' : ''}changes.${RESET}\n`);
    return;
  }
  console.log(`\n${stat}\n`);
  console.log(G.truncate(G.diff({ staged }, cwd), 8000));
  console.log();
}

export function showLog(cwd) {
  if (!ensureRepo(cwd)) return;
  console.log(`\n${G.recentLog(cwd, 10) || `${GRAY}No commits yet.${RESET}`}\n`);
}

export function doSwitch(name, cwd) {
  if (!ensureRepo(cwd)) return false;
  if (!name) {
    console.log(`${YELLOW}Usage: /switch <branch>${RESET}\n`);
    return false;
  }
  const r = G.git(['switch', name], cwd);
  console.log(r.ok ? `${GREEN}✔ Switched to ${CYAN}${name}${RESET}\n` : `${RED}✖ ${r.stderr}${RESET}\n`);
  return r.ok;
}

export function doBranch(arg, cwd) {
  if (!ensureRepo(cwd)) return null;
  if (!arg) {
    const r = G.git(['branch', '--sort=-committerdate', '--format=%(HEAD) %(refname:short) %(upstream:track)'], cwd);
    console.log(`\n${r.stdout || `${GRAY}No branches yet.${RESET}`}\n`);
    return null;
  }
  const name = G.isValidBranchName(arg, cwd) ? arg : G.toBranchName(arg);
  const r = G.createBranch(name, cwd);
  if (!r.ok) {
    console.log(`${RED}✖ ${r.error}${RESET}\n`);
    return null;
  }
  console.log(`${GREEN}✔ ${r.created ? 'Created and switched to' : 'Switched to'} ${CYAN}${name}${RESET}\n`);
  return name;
}

export async function doCommit(message, ctx) {
  const { cwd } = ctx;
  if (!ensureRepo(cwd)) return null;
  const before = G.status(cwd);

  // Respect a hand-picked index; otherwise stage everything.
  const alreadyStaged = before.staged.length > 0;
  const staging = G.stageSafely([], cwd, { add: !alreadyStaged });
  if (!staging.ok) {
    console.log(`${RED}✖ Staging failed: ${staging.error}${RESET}\n`);
    return null;
  }
  if (staging.blocked.length) {
    console.log(`${YELLOW}⚠ Agent Warden kept these out of the commit:${RESET}`);
    staging.blocked.forEach(b => console.log(`    ${YELLOW}• ${b.file}${RESET} ${GRAY}(${b.reason})${RESET}`));
    console.log(`  ${GRAY}Stage them yourself with git if you really intend to commit them.${RESET}`);
  }
  if (!staging.staged.length) {
    console.log(`${GRAY}Nothing to commit.${RESET}\n`);
    return null;
  }
  console.log(`${GRAY}Staged ${staging.staged.length} file(s)${alreadyStaged ? ' (using your existing index)' : ''}.${RESET}`);

  let msg = (message || '').trim();
  if (!msg) {
    process.stdout.write(`${GRAY}✍  Writing commit message…${RESET}\n`);
    const d = G.truncate(G.diff({ staged: true }, cwd), 12000);
    const stat = G.diff({ staged: true, stat: true }, cwd);
    const aiText = await ctx.ai(
      'Write a git commit message for the staged changes below using the Conventional Commits format.\n' +
      'Rules: first line "type(scope): summary" under 72 characters, imperative mood; ' +
      'then a blank line and at most 5 short "- " bullet points explaining what changed and why. ' +
      'Reply with ONLY the commit message — no code fences, no preamble.\n\n' +
      `Diff stat:\n${stat}\n\nDiff:\n${d}`
    );
    msg = G.cleanAiText(aiText);
    if (!msg) msg = `chore: update ${staging.staged.length} file(s)`;
  }

  console.log(`\n${BOLD}Commit message:${RESET}\n${CYAN}${msg}${RESET}\n`);
  if (!ctx.yes) {
    const ans = String(await ctx.ask(`Commit? ${GRAY}[Y/n/e = edit]${RESET} `)).trim().toLowerCase();
    if (ans === 'n' || ans === 'no') {
      console.log(`${GRAY}Commit cancelled — changes are still staged.${RESET}\n`);
      return null;
    }
    if (ans === 'e' || ans === 'edit') {
      const edited = String(await ctx.ask('New commit message: ')).trim();
      if (edited) msg = edited;
    }
  }

  const c = G.commit(msg, cwd);
  if (!c.ok) {
    console.log(`${RED}✖ Commit failed:${RESET} ${c.error}\n`);
    return null;
  }
  console.log(`${GREEN}✔ Committed ${BOLD}${c.sha}${RESET}${GREEN} on ${CYAN}${G.currentBranch(cwd)}${RESET}\n`);
  return c.sha;
}

export async function doPush(ctx) {
  const { cwd } = ctx;
  if (!ensureRepo(cwd)) return false;
  const branch = G.currentBranch(cwd);
  if (!branch) {
    console.log(`${YELLOW}No commits to push yet.${RESET}\n`);
    return false;
  }
  if (!G.remoteUrl(cwd)) {
    console.log(`${YELLOW}No "origin" remote configured. Add one with: git remote add origin <url>${RESET}\n`);
    return false;
  }
  const base = G.defaultBranch(cwd);
  if (branch === base && !(await confirm(ctx, `${YELLOW}You are on ${base}. Push directly to ${base}?${RESET}`, false))) {
    console.log(`${GRAY}Tip: /branch <name> or /ship to work on a feature branch.${RESET}\n`);
    return false;
  }
  process.stdout.write(`${GRAY}⇡ Pushing ${branch}…${RESET}\n`);
  const r = G.push(branch, cwd);
  if (!r.ok) {
    console.log(`${RED}✖ Push failed:${RESET} ${r.error}\n`);
    if (/rejected|non-fast-forward|fetch first/i.test(r.error)) {
      console.log(`${YELLOW}The remote has commits you don't have. Run: git pull --rebase origin ${branch}${RESET}\n`);
    }
    return false;
  }
  console.log(`${GREEN}✔ Pushed ${CYAN}${branch}${GREEN} to origin${RESET}\n`);
  return true;
}

function parsePrFlags(arg) {
  let text = String(arg || '');
  const draft = /(^|\s)--draft(\s|$)/.test(text);
  text = text.replace(/(^|\s)--draft(\s|$)/g, ' ').trim();
  return { title: text, draft };
}

export async function doPr(arg, ctx) {
  const { cwd } = ctx;
  if (!ensureRepo(cwd)) return null;
  const { title: givenTitle, draft } = parsePrFlags(arg);
  const branch = G.currentBranch(cwd);
  const base = G.defaultBranch(cwd);
  const gh = G.githubRepo(cwd);

  if (!gh) {
    console.log(`${YELLOW}origin is not a GitHub remote, so a PR can't be opened from here.${RESET}\n`);
    return null;
  }
  if (!branch || branch === base) {
    console.log(`${YELLOW}You're on ${base}. Create a feature branch first (/branch <name>) or use /ship.${RESET}\n`);
    return null;
  }
  const st = G.status(cwd);
  if (!st.clean) {
    console.log(`${YELLOW}⚠ You have uncommitted changes — they won't be in the PR. Use /commit first (or /ship).${RESET}`);
  }

  const ref = baseRef(base, cwd);
  const commits = G.commitsSince(ref, cwd);
  if (!commits) {
    console.log(`${YELLOW}${branch} has no commits ahead of ${base}. Commit something first.${RESET}\n`);
    return null;
  }

  const pushed = await doPush(ctx);
  if (!pushed) return null;

  let title = givenTitle;
  let body = '';
  process.stdout.write(`${GRAY}✍  Drafting pull request…${RESET}\n`);
  const stat = G.diff({ base: ref, stat: true }, cwd);
  const aiText = await ctx.ai(
    `Write a GitHub pull request for merging branch "${branch}" into "${base}".\n` +
    'Format exactly:\nTITLE: <concise title under 70 chars>\n\n<markdown body with sections "## Summary" (2-4 bullets) and "## Changes" (bullets)>\n' +
    'Reply with only that — no code fences.\n\n' +
    `Commits:\n${commits}\n\nDiff stat:\n${stat}\n\nDiff (truncated):\n${G.truncate(G.diff({ base: ref }, cwd), 10000)}`
  );
  const cleaned = G.cleanAiText(aiText);
  const m = cleaned.match(/^TITLE:\s*(.+)\n?([\s\S]*)$/i);
  if (m) {
    if (!title) title = m[1].trim();
    body = m[2].trim();
  } else if (cleaned) {
    body = cleaned;
  }
  if (!title) title = commits.split('\n')[0].replace(/^- /, '') || branch;
  if (!body) body = `## Changes\n${commits}`;
  body += `\n\n---\n_Opened from the Jev Brain CLI_`;

  console.log(`\n${BOLD}PR:${RESET} ${CYAN}${title}${RESET}  ${GRAY}(${branch} → ${base}${draft ? ', draft' : ''})${RESET}\n${GRAY}${body}${RESET}\n`);
  if (!(await confirm(ctx, 'Open this pull request?'))) {
    console.log(`${GRAY}PR not created. Branch is pushed — you can run /pr again anytime.${RESET}\n`);
    return null;
  }

  const r = await G.createPullRequest({ cwd, head: branch, base, title, body, draft });
  if (!r.ok) {
    console.log(`${RED}✖ Could not open PR:${RESET} ${r.error}\n`);
    return null;
  }
  console.log(`${GREEN}✔ ${r.existed ? 'PR already open' : 'Pull request opened'}:${RESET} ${CYAN}${r.url}${RESET}\n`);
  return r.url;
}

export async function doShip(desc, ctx) {
  const { cwd } = ctx;
  if (!ensureRepo(cwd)) return null;
  const base = G.defaultBranch(cwd);
  let branch = G.currentBranch(cwd);
  const st = G.status(cwd);

  if (!branch || branch === base) {
    let name = desc ? G.toBranchName(desc) : '';
    if (!name) {
      if (st.clean) {
        console.log(`${YELLOW}Nothing to ship: no changes and you're on ${base}.${RESET}\n`);
        return null;
      }
      const stat = G.diff({ stat: true }, cwd) || st.untracked.join('\n');
      const suggestion = G.cleanAiText(await ctx.ai(
        'Suggest one git branch name for these changes, like "fix/login-timeout" or "feat/github-pr-flow". ' +
        `Reply with only the branch name.\n\n${stat}`
      )).split(/\s+/)[0];
      name = G.isValidBranchName(suggestion, cwd) ? suggestion : G.toBranchName(suggestion || 'update');
    }
    if (!ctx.yes) {
      const ans = String(await ctx.ask(`Branch name ${GRAY}[${name}]${RESET}: `)).trim();
      if (ans) name = G.isValidBranchName(ans, cwd) ? ans : G.toBranchName(ans);
    }
    branch = doBranch(name, cwd);
    if (!branch) return null;
  }

  if (!G.status(cwd).clean) {
    const sha = await doCommit('', ctx);
    if (!sha && !G.commitsSince(baseRef(base, cwd), cwd)) return null;
  }
  return doPr('', ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher for chat slash commands. Returns true when the input was handled.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleGitSlashCommand(input, ctx) {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/repo':
    case '/git':
      showRepo(ctx.cwd);
      return true;
    case '/diff':
      showDiff(ctx.cwd, /--staged|--cached/.test(arg));
      return true;
    case '/log':
      showLog(ctx.cwd);
      return true;
    case '/branch':
      doBranch(arg, ctx.cwd);
      return true;
    case '/switch':
    case '/checkout':
      doSwitch(arg, ctx.cwd);
      return true;
    case '/commit':
      await doCommit(arg, ctx);
      return true;
    case '/push':
      await doPush(ctx);
      return true;
    case '/pr':
      await doPr(arg, ctx);
      return true;
    case '/ship':
      await doShip(arg, ctx);
      return true;
    default:
      return false;
  }
}
