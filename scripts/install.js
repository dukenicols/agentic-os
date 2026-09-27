#!/usr/bin/env node
'use strict';
// Install the governance framework into a target repository.
//   node scripts/install.js <target-dir> [--mode enforce|advisory] [--force]
// Idempotent: re-running upgrades framework code but never touches the target's config or runs.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MARK = '<!-- governance:agents-md -->';
const FRAMEWORK_PATHS = ['.governance/bin/', '.governance/lib/', '.governance/hooks/'];

function main(argv) {
  const target = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');
  const mode = valueOf(argv, '--mode') || 'enforce';
  const force = argv.includes('--force');
  if (!fs.existsSync(target)) throw new Error(`No such directory: ${target}`);
  if (path.resolve(target) === path.resolve(SRC)) throw new Error('Refusing to install into the framework repo itself.');
  const log = (msg) => console.log(`  ${msg}`);
  console.log(`Installing governance into ${target}`);

  // 1. framework code (always refreshed)
  for (const sub of ['bin', 'lib', 'hooks', 'templates']) {
    fs.cpSync(path.join(SRC, '.governance', sub), path.join(target, '.governance', sub), { recursive: true });
  }
  fs.chmodSync(path.join(target, '.governance', 'bin', 'gov'), 0o755);
  fs.mkdirSync(path.join(target, '.governance', 'runs'), { recursive: true });
  log('✔ .governance/{bin,lib,hooks,templates}');

  // 2. config (created once, with detected commands)
  const cfgPath = path.join(target, '.governance', 'config.json');
  if (!fs.existsSync(cfgPath) || force) {
    const cfg = JSON.parse(fs.readFileSync(path.join(SRC, '.governance', 'config.json'), 'utf8'));
    cfg.mode = mode;
    // This repo's own config may leave the framework code editable for development; installs never do.
    cfg.protectedPaths = [...new Set([...(cfg.protectedPaths || []), ...FRAMEWORK_PATHS])];
    cfg.commands = detectCommands(target);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    log(`✔ .governance/config.json (mode ${mode}; build: ${fmt(cfg.commands.build)}; test: ${fmt(cfg.commands.test)})`);
    if (!cfg.commands.build.length || !cfg.commands.test.length) {
      log('! Could not detect every command — set "commands" in .governance/config.json before your first task.');
    }
  } else log('· .governance/config.json exists — kept');

  // 3. AGENTS.md (append a marked section if the repo already has one)
  const agents = fs.readFileSync(path.join(SRC, 'AGENTS.md'), 'utf8');
  const agentsPath = path.join(target, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, `${MARK}\n${agents}`);
    log('✔ AGENTS.md');
  } else {
    const cur = fs.readFileSync(agentsPath, 'utf8');
    const i = cur.indexOf(MARK);
    fs.writeFileSync(agentsPath, (i >= 0 ? cur.slice(0, i) : cur.trimEnd() + '\n\n') + `${MARK}\n${agents}`);
    log(`✔ AGENTS.md (governance section ${i >= 0 ? 'updated' : 'appended'})`);
  }

  // 4. CLAUDE.md imports AGENTS.md
  const claudePath = path.join(target, 'CLAUDE.md');
  const claude = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
  if (!/^@AGENTS\.md\s*$/m.test(claude)) {
    fs.writeFileSync(claudePath, claude ? `@AGENTS.md\n\n${claude}` : '@AGENTS.md\n');
    log('✔ CLAUDE.md imports @AGENTS.md');
  } else log('· CLAUDE.md already imports AGENTS.md');

  // 5. subagent + slash commands
  fs.cpSync(path.join(SRC, '.claude', 'agents', 'gov-reviewer.md'), path.join(target, '.claude', 'agents', 'gov-reviewer.md'));
  fs.cpSync(path.join(SRC, '.claude', 'commands', 'gov'), path.join(target, '.claude', 'commands', 'gov'), { recursive: true });
  log('✔ .claude/agents/gov-reviewer.md, .claude/commands/gov/*');

  // 6. settings.json: merge hooks and deny rules (last, so nothing above is blocked mid-install)
  const setPath = path.join(target, '.claude', 'settings.json');
  const ours = JSON.parse(fs.readFileSync(settingsSource(), 'utf8'));
  const theirs = fs.existsSync(setPath) ? JSON.parse(fs.readFileSync(setPath, 'utf8')) : {};
  fs.writeFileSync(setPath, JSON.stringify(mergeSettings(theirs, ours), null, 2) + '\n');
  log('✔ .claude/settings.json (hooks + deny rules merged)');

  console.log(`
Done. Next:
  1. Review .governance/config.json (commands, approvals, guardrails).
  2. Commit the framework files.
  3. Restart Claude Code in ${target}, then: /gov:plan <what to build>
  Humans approve with: .governance/bin/gov approve plan|ship   (in your own terminal)`);
}

function settingsSource() {
  const live = path.join(SRC, '.claude', 'settings.json');
  return fs.existsSync(live) ? live : `${live}.off`;
}

function mergeSettings(theirs, ours) {
  const out = { ...theirs };
  out.permissions = { ...(theirs.permissions || {}) };
  out.permissions.deny = [...new Set([...(theirs.permissions?.deny || []), ...(ours.permissions?.deny || [])])];
  out.hooks = { ...(theirs.hooks || {}) };
  for (const [event, groups] of Object.entries(ours.hooks || {})) {
    const existing = out.hooks[event] || [];
    const have = new Set(existing.flatMap((g) => (g.hooks || []).map((h) => h.command)));
    const add = groups.filter((g) => !g.hooks.every((h) => have.has(h.command)));
    out.hooks[event] = [...existing, ...add];
  }
  return out;
}

function detectCommands(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    const build = ['lint', 'typecheck', 'build'].filter((s) => scripts[s]).map(run);
    return { build, test: scripts.test ? [pm === 'npm' ? 'npm test' : `${pm} test`] : [] };
  }
  if (has('Cargo.toml')) return { build: ['cargo clippy -- -D warnings', 'cargo build'], test: ['cargo test'] };
  if (has('go.mod')) return { build: ['go vet ./...', 'go build ./...'], test: ['go test ./...'] };
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) {
    return { build: has('pyproject.toml') ? ['python -m compileall -q .'] : [], test: ['python -m pytest -q'] };
  }
  if (has('Makefile')) return { build: ['make'], test: ['make test'] };
  return { build: [], test: [] };
}

const fmt = (a) => (a.length ? a.join(', ') : '(none)');
const valueOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

module.exports = { mergeSettings, detectCommands, FRAMEWORK_PATHS };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`install: ${err.message}`);
    process.exitCode = 1;
  }
}
