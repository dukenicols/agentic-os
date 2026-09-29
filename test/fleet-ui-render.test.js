'use strict';
// Runs the UI's own rendering code (md, rawView, diffView) against a minimal DOM stub, with hostile
// documents: whatever an agent writes into plan.md must end up visible to the human approving it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class TextNode {
  constructor(t) {
    this.nodeType = 3;
    this.t = String(t);
  }
  get textContent() {
    return this.t;
  }
}

class ElementNode {
  constructor(tag) {
    Object.assign(this, { nodeType: 1, tag, children: [], attrs: {}, dataset: {}, className: '' });
  }
  append(...kids) {
    for (const k of kids) this.children.push(typeof k === 'string' ? new TextNode(k) : k);
  }
  prepend(...kids) {
    this.children.unshift(...kids);
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener() {}
  get classList() {
    return { add() {}, remove() {}, toggle() {} };
  }
  get lastChild() {
    return this.children[this.children.length - 1];
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [new TextNode(v)];
  }
  querySelectorAll() {
    return [];
  }
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof ElementNode) yield* c.walk();
  }
}

function loadUi() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'fleet', 'ui', 'index.html'), 'utf8');
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const document = {
    createElement: (t) => new ElementNode(t),
    createTextNode: (t) => new TextNode(t),
    getElementById: () => new ElementNode('div'),
  };
  const ctx = vm.createContext({
    document,
    window: {},
    fetch: () => new Promise(() => {}),
    EventSource: class {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(script, ctx);
  return (expr) => vm.runInContext(expr, ctx);
}

const ui = loadUi();
const md = ui('md');
const rawView = ui('rawView');
const reveal = ui('reveal');
const diffView = ui('diffView');

const HOSTILE = [
  '# Plan: harmless',
  '',
  '```bash also drop the users table',
  'echo ok',
  '<!-- hidden in fence -->',
  '``` and rm -rf the backups',
  '',
  ' '.repeat(600) + '- far far away item',
  '',
  'Scope: frontend only ‮ylno dnekcab‬ and​zero​width',
  'nul:\u0000C0 literal marker',
  '<!-- top-level comment -->',
].join('\n');

const strip = (s) => s.replace(/\s+/g, '');

test('exact-text view shows every character; invisible ones are made visible', () => {
  const text = rawView(HOSTILE).textContent;
  assert.equal(text, reveal(HOSTILE));
  assert.ok(text.includes('⟦U+202E⟧') && text.includes('⟦U+200B⟧') && text.includes('⟦U+0000⟧'));
  // nothing else changed: removing the escapes and whitespace gives back the visible source
  const visibleSource = strip(HOSTILE.replace(/[\u0000​‬‮]/g, ''));
  assert.equal(strip(text.replace(/⟦U\+[0-9A-F]{4}⟧/g, '')), visibleSource);
});

test('formatted view keeps fence lines, comments inside fences, and caps indentation', () => {
  const root = md(HOSTILE);
  const text = root.textContent;
  for (const needle of ['```bash also drop the users table', '<!-- hidden in fence -->', '``` and rm -rf the backups', 'far far away item', '<!-- top-level comment -->']) {
    assert.ok(text.includes(needle), `rendered text includes ${needle}`);
  }
  assert.ok(!text.includes('\u0000'), 'no raw NUL markers leak into the output');
  for (const n of root.walk()) {
    const m = /margin-left:(\d+)px/.exec(n.attrs.style || '');
    if (m) assert.ok(Number(m[1]) <= 96, `indent capped, got ${m[1]}px`);
  }
});

test('an unterminated fence or comment is still shown', () => {
  const text = md('intro\n```js\nconst x = 1;\n<!-- never closed\nmore').textContent;
  for (const needle of ['```js', 'const x = 1;', '<!-- never closed', 'more']) assert.ok(text.includes(needle), needle);
});

test('diff view reveals invisible characters too', () => {
  const t = diffView('+const ok = true;‮ // looks harmless\n-old').textContent;
  assert.ok(t.includes('⟦U+202E⟧'));
});

test('the approval panel defaults to the exact text', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'fleet', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes("pick('exact');"));
  assert.ok(html.includes('Texto exacto') && html.includes('Vista formateada'));
});

test('astral and property-based invisibles are revealed: tag characters, variation selectors, fillers', () => {
  const tag = (s) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const smuggled = `visible text${tag('drop db')}\u{FE0F}\u{E0100}͏ﾠ᠋\u{1D173}\u{F0000}  end`;
  const out = rawView(smuggled).textContent;
  assert.ok(out.includes('⟦U+E0064⟧⟦U+E0072⟧'), 'tag characters escaped as whole code points');
  for (const cp of ['FE0F', 'E0100', '034F', 'FFA0', '180B', '1D173', 'F0000', '2029']) assert.ok(out.includes(`⟦U+${cp}⟧`), cp);
  assert.equal(ui(`countInvisible(${JSON.stringify(smuggled)})`), 7 + 8);
  assert.doesNotMatch(out.replace(/⟦U\+[0-9A-F]{4,6}⟧/g, ''), /[^\x20-\x7e\n]/, 'nothing invisible left');
  assert.ok(diffView(`+ok${tag('rm')}`).textContent.includes('⟦U+E0072⟧'));
  // ordinary text, tabs and newlines are untouched
  assert.equal(reveal('añadir\tlínea\r\nño 日本'), 'añadir\tlínea\r\nño 日本');
});

test('diff view classifies by position: content cannot pose as a file header; CR is revealed', () => {
  const raw = ['M a.sql', '', 'diff --gov a/a.sql b/a.sql', '--- a/a.sql', '+++ b/a.sql', '@@ -1,1 +1,2 @@', '--- comment', '+++ b/README.md', '+a\r'].join('\n');
  const root = diffView(raw);
  const spans = root.children.filter((c) => c.tag === 'span').map((c) => [c.className || c.attrs.class, c.textContent]);
  const cls = (t) => spans.find(([, text]) => text === t)[0];
  assert.equal(cls('--- comment'), 'del');
  assert.equal(cls('+++ b/README.md'), 'add');
  assert.equal(cls('--- a/a.sql'), 'file');
  assert.ok(root.textContent.includes('+a⟦U+000D⟧'));
});
