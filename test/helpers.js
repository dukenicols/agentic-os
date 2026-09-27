'use strict';
// Sandbox helpers: a throwaway git repo with this framework installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const GOV = path.join(SRC, '.governance', 'bin', 'gov');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.GOV_MODE;
  for (const k of Object.keys(extra)) env[k] = extra[k];
  return env;
}

function sandbox(configPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-test-'));
  for (const sub of ['bin', 'lib', 'hooks', 'templates']) {
    fs.cpSync(path.join(SRC, '.governance', sub), path.join(dir, '.governance', sub), { recursive: true });
  }
  const config = JSON.parse(fs.readFileSync(path.join(SRC, '.governance', 'config.json'), 'utf8'));
  config.commands = { build: ['node check.js'], test: ['node test.js'] };
  Object.assign(config, configPatch);
  fs.writeFileSync(path.join(dir, '.governance', 'config.json'), JSON.stringify(config, null, 2));

  write(dir, 'check.js', "require('./app.js');\n");
  write(dir, 'test.js', "const a = require('./app.js'); if (a.add(2, 2) !== 4) process.exit(1);\n");
  write(dir, 'app.js', 'exports.add = (a, b) => a - b;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function git(dir, ...args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Run the CLI. as: 'human' (default) or 'agent' (CLAUDECODE=1). */
function gov(dir, args, as = 'human') {
  const r = spawnSync(process.execPath, [path.join(dir, '.governance', 'bin', 'gov'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(as === 'agent' ? { CLAUDECODE: '1' } : {}),
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function hook(dir, name, input) {
  const r = spawnSync(process.execPath, [path.join(dir, '.governance', 'hooks', `${name}.js`)], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv({ CLAUDECODE: '1' }),
    input: JSON.stringify({ cwd: dir, ...input }),
  });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function preTool(dir, tool_name, tool_input) {
  const out = hook(dir, 'pre-tool-use', { hook_event_name: 'PreToolUse', tool_name, tool_input });
  return out ? out.hookSpecificOutput.permissionDecision : 'allow';
}

function activeRun(dir) {
  const id = JSON.parse(fs.readFileSync(path.join(dir, '.governance', 'state.json'), 'utf8')).activeTask;
  return path.join(dir, '.governance', 'runs', id);
}

const GOOD_PLAN = `# Plan: fix add

## Goal
add() returns the sum.

## Scope
app.js only.

## Acceptance Criteria
- AC1: add(2, 2) returns 4

## Approach
1. Replace subtraction with addition.

## Risks
Callers relying on the bug.

## Rollback
Revert the commit.
`;

const reviewDoc = (verdict, files, extra = '') => `# Review
Reviewer: gov-reviewer
Verdict: ${verdict}

## Files reviewed
${files.map((f) => `- ${f} — ok`).join('\n')}

## Findings
${extra || 'None.'}
`;

const VERIFICATION = '- AC1: PASS — evidence: test.js asserts add(2,2)===4 (gov run test)\n';

module.exports = { SRC, GOV, sandbox, write, git, gov, hook, preTool, activeRun, GOOD_PLAN, reviewDoc, VERIFICATION };
