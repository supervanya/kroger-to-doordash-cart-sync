import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff, toCartMap, stripSize } from './sync.js';

const cart = (obj) => new Map(Object.entries(obj).map(([g, qty]) => [g, { qty, name: g }]));

test('adds, changes, removes', () => {
  const d = computeDiff(cart({ a: 1, b: 2, c: 1 }), cart({ b: 1, c: 1, x: 3 }));
  assert.deepEqual(d.add, [{ gtin: 'a', name: 'a', qty: 1 }]);
  assert.deepEqual(d.change, [{ gtin: 'b', name: 'b', from: 1, to: 2 }]);
  assert.deepEqual(d.remove, [{ gtin: 'x', name: 'x', qty: 3 }]);
  assert.deepEqual(d.unmatched, []);
});

test('items unavailable at target are unmatched, not added', () => {
  const d = computeDiff(cart({ a: 1, b: 1 }), cart({}), (g) => g !== 'b');
  assert.deepEqual(d.add.map((x) => x.gtin), ['a']);
  assert.deepEqual(d.unmatched.map((x) => x.gtin), ['b']);
});

test('identical carts produce no ops', () => {
  const d = computeDiff(cart({ a: 2 }), cart({ a: 2 }));
  assert.equal(d.add.length + d.change.length + d.remove.length + d.unmatched.length, 0);
});

test('toCartMap sums duplicate lines', () => {
  const m = toCartMap([
    { gtin: 'a', qty: 1, name: 'A' },
    { gtin: 'a', qty: 2, name: 'A' },
  ]);
  assert.deepEqual(m.get('a'), { qty: 3, name: 'A' });
});

test('stripSize removes trailing size', () => {
  assert.equal(stripSize('Kerrygold Pure Irish Butter (8 oz)'), 'Kerrygold Pure Irish Butter');
  assert.equal(stripSize('Banana'), 'Banana');
});

test('add mode only adds and raises quantities', () => {
  const d = computeDiff(cart({ a: 1, b: 3, c: 1 }), cart({ b: 1, c: 5, x: 2 }), () => true, 'add');
  assert.deepEqual(d.add.map((x) => x.gtin), ['a']);
  assert.deepEqual(d.change, [{ gtin: 'b', name: 'b', from: 1, to: 3 }]);
  assert.deepEqual(d.remove, []);
});
