import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const hash = value => createHash('sha256').update(value).digest('hex');
function extract(path) {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      calls.push({ title: node.arguments[0].getText(file), source: text.slice(node.getStart(file), node.end) });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { path, sha256: hash(text), calls };
}
const original = extract('tests/integrate.test.ts');
const retained = extract('tests/integrate-retained.test.ts');
const identities = [8,19,64,66,68,69,72,77,104,122,126,134];
assert.equal(original.calls.length, 144);
assert.equal(retained.calls.length, 12);
const rows = retained.calls.map((call, index) => {
  const identity = identities[index];
  const expected = original.calls[identity - 1];
  assert.equal(call.title, expected.title, `identity ${identity} title`);
  assert.equal(call.source, expected.source, `identity ${identity} exact source`);
  return { identity, title: call.title, sha256: hash(call.source), bytes: Buffer.byteLength(call.source) };
});
console.log(JSON.stringify({ original: {path: original.path, sha256: original.sha256, count: original.calls.length}, retained: {path: retained.path, sha256: retained.sha256, count: retained.calls.length}, rows, byteIdentity: true }, null, 2));
