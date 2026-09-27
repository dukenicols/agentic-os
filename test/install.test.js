'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mergeSettings } = require('../scripts/install');

const install = (dir) => spawnSync(path.join(__dirname, '..', 'install.sh'), [dir], { encoding: 'utf8' });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('installs into a fresh repo, detects npm commands, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-install-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'x', build: 'x', test: 'x' } }));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project notes\n');
  assert.equal(install(dir).status, 0);
  assert.equal(install(dir).status, 0);

  const cfg = JSON.parse(read(dir, '.governance/config.json'));
  assert.deepEqual(cfg.commands, { build: ['npm run lint', 'npm run build'], test: ['npm test'] });
  assert.match(read(dir, 'CLAUDE.md'), /^@AGENTS\.md\n\n# Project notes/);
  assert.equal(read(dir, 'CLAUDE.md').match(/@AGENTS\.md/g).length, 1);
  assert.equal(read(dir, 'AGENTS.md').match(/governance:agents-md/g).length, 1);
  const settings = JSON.parse(read(dir, '.claude/settings.json'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.claude/agents/gov-reviewer.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/commands/gov/ship.md')));
});

test('existing AGENTS.md content is preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-install-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# House style\nUse tabs.\n');
  install(dir);
  install(dir);
  const md = read(dir, 'AGENTS.md');
  assert.match(md, /^# House style\nUse tabs\./);
  assert.equal(md.match(/governance:agents-md/g).length, 1);
});

test('mergeSettings keeps the user’s hooks and permissions', () => {
  const theirs = {
    model: 'x',
    permissions: { allow: ['Bash(ls)'], deny: ['Read(./secret)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] },
  };
  const ours = {
    permissions: { deny: ['Read(./.env)'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'gov' }] }], Stop: [{ hooks: [{ type: 'command', command: 's' }] }] },
  };
  const m = mergeSettings(theirs, ours);
  assert.equal(m.model, 'x');
  assert.deepEqual(m.permissions.allow, ['Bash(ls)']);
  assert.deepEqual(m.permissions.deny, ['Read(./secret)', 'Read(./.env)']);
  assert.deepEqual(m.hooks.PreToolUse.map((g) => g.hooks[0].command), ['mine', 'gov']);
  assert.deepEqual(mergeSettings(m, ours).hooks, m.hooks);
});
