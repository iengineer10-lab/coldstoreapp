import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretOrder } from './order_interpreter.js';

const products = [
  { id: 'egg', name: 'Egg', nameAr: 'بيض', unit: 'tray', unitAr: 'طبق', aliases: ['بيض'], stock: 3 },
  { id: 'milk', name: 'Milk', nameAr: 'حليب', unit: 'bottle', unitAr: 'زجاجة', aliases: [], stock: 0 },
];

function run(result) {
  return interpretOrder({
    text: 'بيض وحليب',
    products,
    model: 'test',
    generate: async () => ({ text: JSON.stringify(result) }),
  });
}

test('returns database products and unmatched requests', async () => {
  const result = await run({
    items: [{ productId: 'egg', quantity: 2 }],
    unresolved: ['حليب؟'],
  });
  assert.deepEqual(result, {
    items: [{ product: products[0], quantity: 2 }],
    unresolved: ['حليب؟'],
  });
});

test('rejects invented IDs, duplicates, bad quantities and malformed output', async () => {
  for (const items of [
    [{ productId: 'unknown', quantity: 1 }],
    [{ productId: 'egg', quantity: 0 }],
    [{ productId: 'egg', quantity: 1.234 }],
    [{ productId: 'egg', quantity: 1 }, { productId: 'egg', quantity: 1 }],
  ]) {
    await assert.rejects(run({ items, unresolved: [] }));
  }
  await assert.rejects(run({ items: [], unresolved: [1] }));
  await assert.rejects(interpretOrder({
    text: 'test', products, model: 'test', generate: async () => ({ text: 'not json' }),
  }));
});

test('propagates provider failures without creating matches', async () => {
  await assert.rejects(interpretOrder({
    text: 'test', products, model: 'test', generate: async () => { throw new Error('offline'); },
  }), /offline/);
});
