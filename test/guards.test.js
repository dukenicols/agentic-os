'use strict';
// Regression tests for task 20260927-212630 (revision 4): no cross-repo release exemption, a built-in release
// detector, tamper-check hardening, fail-closed config / input / errors. Cases come from reviews #8 and #14.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sandbox, write, git, gov, hook, preTool, activeRun, GOOD_PLAN, reviewDoc, VERIFICATION } = require('./helpers');
const { splitSegments, shellWords, hasBuiltinRelease } = require('../.governance/hooks/pre-tool-use');

const bash = (dir, command) => preTool(dir, 'Bash', { command });
const outsideDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gov-outside-')));
const expectAll = (dir, cmds, want) => cmds.forEach((cmd) => assert.equal(bash(dir, cmd), want, cmd));

/** Run a hook with raw stdin and a chosen environment. */
function rawHook(dir, name, stdin, env = {}) {
  const e = { ...process.env, CLAUDECODE: '1', ...env };
  delete e.GOV_MODE;
  if (!('CLAUDE_PROJECT_DIR' in env)) delete e.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [path.join(dir, '.governance', 'hooks', `${name}.js`)], { cwd: os.tmpdir(), encoding: 'utf8', env: e, input: stdin });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null };
}

function toShip(dir) {
  gov(dir, ['start', 'fix add']);
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  gov(dir, ['approve', 'plan']);
  gov(dir, ['advance'], 'agent');
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  gov(dir, ['run', 'build'], 'agent');
  gov(dir, ['advance'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'review.md'), reviewDoc('PASS', ['app.js']));
  gov(dir, ['record', 'review'], 'agent');
  gov(dir, ['advance'], 'agent');
  gov(dir, ['run', 'test'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'verification.md'), VERIFICATION);
  gov(dir, ['record', 'verification'], 'agent');
  gov(dir, ['advance'], 'agent');
}

test('AC1: no cross-repo exemption — releases are gated in any directory', () => {
  const dir = sandbox();
  const out = outsideDir();
  git(dir, 'worktree', 'add', '-q', path.join(out, 'wt'));
  expectAll(dir, [
    `cd ${out} && git push -u origin x`,
    `git -C ${out} push origin x`,
    `cd ${out} && gh pr create --draft --fill`,
    `cd ${out}/wt && git push`,
  ], 'deny');
  assert.match(hook(dir, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: `cd ${out} && git push` } }).hookSpecificOutput.permissionDecisionReason, /in any directory/);
});

test('AC1: in SHIP with a passing gate, releases are allowed', () => {
  const dir = sandbox();
  toShip(dir);
  assert.equal(bash(dir, 'git push origin main'), 'deny'); // no human ship approval yet
  gov(dir, ['approve', 'ship']);
  assert.equal(bash(dir, 'git push origin main'), 'allow');
  assert.equal(bash(dir, 'git -c x.y=z push origin main'), 'allow');
});

test('AC2: the built-in release detector sees through flags and indirection', () => {
  const dir = sandbox();
  expectAll(dir, [
    'git --work-tree . push',
    'git --namespace x push',
    'git --config-env user.name=HOME push',
    'git -c x.y="a b" push',
    'git -C . push',
    'git --no-pager push',
    'git --git-dir .git push',
    'git \\\npush origin main',
    'terraform -chdir=infra apply',
    'kubectl -n prod apply -f k.yaml',
    'docker --context prod push img',
    'npm --workspace a publish',
    'gh pr -R o/x create',
    'gh pr merge https://github.com/o/x/pull/1',
    'vercel deploy --prod',
    "bash -c 'git -C x push'",
    'echo $(git -C . push)',
    'env git push',
    '/usr/bin/git push',
    // documented aliases and long forms (review #20)
    'gh pr new --fill',
    'gh release new v1.0.0',
    'vercel deploy --target=production',
    'vercel deploy --target production',
    'vercel --target=production',
    'vercel --prod=true',
    'docker build --push -t img .',
    'docker buildx build --push -t img .',
    'GIT push',
  ], 'deny');
  expectAll(dir, [
    'git status',
    'git log --oneline',
    'git commit -m "push the fix"',
    'git config push.default simple',
    'npm test',
    'npm run build',
    'gh pr view 1',
    'grep -rn constructor src',
    'git log -S Constructor',
    'echo __proto__ toString hasOwnProperty',
  ], 'allow');
  assert.equal(hasBuiltinRelease("git commit -m 'push it'"), false);
  // The built-in detector itself (config regexes would mask a regression in these):
  for (const cmd of ['GIT push', 'vercel --prod=true', 'vercel --target=production', 'docker build --push .', 'gh pr new']) {
    assert.equal(hasBuiltinRelease(cmd), true, cmd);
  }
  assert.equal(hasBuiltinRelease('grep constructor'), false);
  assert.equal(hasBuiltinRelease("sh -c \"git commit -m 'x' && git push\""), true);
});

test('AC3: the tamper check denies every known quote/comment trick', () => {
  assert.deepEqual(splitSegments(`a && b || c; d | e`), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitSegments(`sed -i "" -e "s/a || b/x/" f`), [`sed -i "" -e "s/a || b/x/" f`]);
  assert.deepEqual(shellWords(`cd "a b" 'c'd`), ['cd', 'a b', 'cd']);
  assert.equal(shellWords(`cd "unterminated`), null);

  const dir = sandbox();
  gov(dir, ['start', 'x']);
  const run = path.relative(dir, activeRun(dir));
  expectAll(dir, [
    ...['||', ';', '&&', '|'].map((sep) => `sed -i "" -e "s/a ${sep} b/x/" .governance/lib/core.js`),
    `echo gov status # '\nrm .governance/state.json`,
    `echo gov status # '\necho x > .governance/lib/core.js`,
    `echo $'\\'' ; echo gov status ; rm .governance/lib/core.js`,
    `echo "x || y" > .governance/state.json`,
    `printf 'a; b' >> ${run}/ledger.jsonl`,
    `.governance/bin/gov status; rm .governance/state.json`,
    `.governance/bin/gov status > .governance/state.json`,
  ], 'deny');
  expectAll(dir, ['.governance/bin/gov run build 2>&1 | tail -20', '.governance/bin/gov status > status.txt'], 'allow');
});

test('AC4: invalid or wrongly shaped config fails closed everywhere', () => {
  const cases = [
    (c) => JSON.stringify(c).replace('"AGENTS.md",', '// "AGENTS.md",'),
    (c) => JSON.stringify({ ...c, protectedPaths: 'x' }),
    (c) => JSON.stringify({ ...c, guardrails: { ...c.guardrails, bashDeny: [{ pattern: '(' }] } }),
    (c) => JSON.stringify({ ...c, guardrails: { ...c.guardrails, bashDeny: [{ reason: 'no pattern' }] } }),
    (c) => JSON.stringify({ ...c, guardrails: { ...c.guardrails, shipGated: ['[unclosed'] } }),
    (c) => JSON.stringify({ ...c, commands: { test: 'npm test' } }),
  ];
  for (const corrupt of cases) {
    const dir = sandbox();
    gov(dir, ['start', 'x']);
    const cfgPath = path.join(dir, '.governance', 'config.json');
    fs.writeFileSync(cfgPath, corrupt(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))));

    const status = gov(dir, ['status']);
    assert.equal(status.code, 2);
    assert.match(status.out, /config\.json is invalid .*failing closed/);
    assert.equal(status.out.trim().split('\n').length, 1, 'one-line message');
    assert.equal(gov(dir, ['help']).code, 0);

    const target = path.join(dir, 'app.js');
    for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.equal(preTool(dir, tool, { file_path: target }), 'deny', tool);
    assert.equal(preTool(dir, 'NotebookEdit', { notebook_path: path.join(dir, 'n.ipynb') }), 'deny');
    assert.equal(preTool(dir, 'Bash', { command: 'ls' }), 'deny');
    assert.equal(preTool(dir, 'Read', { file_path: cfgPath }), 'allow');

    const ctx = hook(dir, 'session-start', { hook_event_name: 'SessionStart' }).hookSpecificOutput.additionalContext;
    assert.match(ctx, /CONFIG ERROR/);
    assert.equal(hook(dir, 'stop', { hook_event_name: 'Stop', stop_hook_active: false }), null);
  }
});

test('AC5: guard errors and unreadable input fail closed', () => {
  const dir = sandbox();
  assert.equal(preTool(dir, 'Edit', { file_path: 42 }), 'deny');
  assert.equal(preTool(dir, 'Bash', { command: { toString: null } }), 'deny');
  assert.equal(preTool(dir, 'Read', { file_path: 42 }), 'allow');

  for (const bad of ['not json', '[]', '']) {
    const r = rawHook(dir, 'pre-tool-use', bad, { CLAUDE_PROJECT_DIR: dir });
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(bad));
    assert.equal(rawHook(dir, 'stop', bad, { CLAUDE_PROJECT_DIR: dir }).code, 0);
    assert.equal(rawHook(dir, 'session-start', bad, { CLAUDE_PROJECT_DIR: dir }).code, 0);
  }
});

test('AC6: a cwd outside the governed tree falls back to CLAUDE_PROJECT_DIR', () => {
  const dir = sandbox();
  const input = JSON.stringify({ cwd: os.tmpdir(), tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'app.js') } });
  assert.equal(rawHook(dir, 'pre-tool-use', input, { CLAUDE_PROJECT_DIR: dir }).out.hookSpecificOutput.permissionDecision, 'deny');
  const push = JSON.stringify({ cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert.equal(rawHook(dir, 'pre-tool-use', push, { CLAUDE_PROJECT_DIR: dir }).out.hookSpecificOutput.permissionDecision, 'deny');
});

test('AC7: installs always protect the framework code, whatever the source config says', () => {
  const src = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.governance', 'config.json'), 'utf8'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-install-'));
  const r = spawnSync(path.join(__dirname, '..', 'install.sh'), [target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(target, '.governance', 'config.json'), 'utf8'));
  for (const p of ['.governance/bin/', '.governance/lib/', '.governance/hooks/']) assert.ok(cfg.protectedPaths.includes(p), p);
  for (const p of src.protectedPaths || []) assert.ok(cfg.protectedPaths.includes(p), p);
});

test('AC8: .idea is ignored and untracked', () => {
  const root = path.join(__dirname, '..');
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('.idea/'));
  assert.ok(!lines.includes('.idea/.idea/'));
  const tracked = spawnSync('git', ['ls-files', '.idea'], { cwd: root, encoding: 'utf8' });
  if (tracked.status === 0) assert.equal(tracked.stdout.trim(), '');
});

test('AC9: stop does not block when only human approvals are missing', () => {
  const stop = (dir) => hook(dir, 'stop', { hook_event_name: 'Stop', stop_hook_active: false });
  const dir = sandbox();
  gov(dir, ['start', 'x']);
  const plan = path.join(activeRun(dir), 'plan.md');
  fs.writeFileSync(plan, GOOD_PLAN);
  assert.equal(stop(dir), null); // plan never approved

  gov(dir, ['approve', 'plan']);
  fs.appendFileSync(plan, '\n- AC2: more scope\n');
  assert.match(gov(dir, ['check', 'plan']).out, /human must re-approve/);
  assert.equal(stop(dir), null); // plan approval went stale

  fs.writeFileSync(plan, '# empty\n');
  assert.equal(stop(dir).decision, 'block'); // real work missing again

  const ship = sandbox();
  toShip(ship);
  assert.equal(stop(ship), null); // in SHIP, waiting only for `gov approve ship`
  gov(ship, ['approve', 'ship']);
  write(ship, 'app.js', 'exports.add = (a, b) => b + a;\n');
  // A ship approval can only go stale by changing code, which also stales build/review/test: real work.
  assert.equal(stop(ship).decision, 'block');
  // ...but the stale approval itself is still classified as the human's to resolve.
  const { Gov } = require('../.governance/lib/core');
  const g = new Gov(ship).gates();
  assert.deepEqual(g.ship.human, ['code changed after ship approval — human must re-approve']);
  assert.ok(new Gov(ship).blockers({ ...new Gov(ship).task() }).some((b) => b.human && /ship approval/.test(b.message)));
});

test('AC10: an unknown mode denies instead of asking', () => {
  const dir = sandbox({ mode: 'enforced' });
  assert.equal(preTool(dir, 'Edit', { file_path: path.join(dir, 'app.js') }), 'deny');
});
