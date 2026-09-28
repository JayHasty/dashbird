import assert from 'node:assert/strict';
import { fillGoal } from '../src/lib/now-model.js';
import { rankNow } from '../src/lib/now-rank.js';

const now = new Date('2026-09-26T15:00:00Z');

const floor = {
  id: 'g-floor',
  kind: 'floor',
  statement: 'File taxes before a late bill becomes a lien',
  due: '2026-09-30',
  warnDays: 14,
};
const aimHeavy = {
  id: 'g-aim',
  kind: 'aim',
  statement: 'Make money',
  weight: 100,
  signal: { label: 'income', unit: 'usd', direction: 'up' },
};
const goals = [floor, aimHeavy];
const before = JSON.parse(JSON.stringify(goals));
const floorFirst = rankNow({
  now,
  goals,
  signals: [],
  pin: null,
  parents: [
    {
      id: 'p-floor',
      status: 'open',
      goalId: 'g-floor',
      commitment: { id: 'c-floor', owner: 'you', state: 'nominated', title: 'File' },
    },
    {
      id: 'p-aim',
      status: 'open',
      goalId: 'g-aim',
      commitment: { id: 'c-aim', owner: 'you', state: 'nominated', title: 'Sell' },
    },
  ],
});
assert.equal(floorFirst.now.parentId, 'p-floor', 'floor in the warning window outranks a heavier aim');
assert.deepEqual(goals, before, 'ranking does not rewrite the goal list');

const aimA = { id: 'a', kind: 'aim', statement: 'Health', weight: 5, signal: { label: 'gym', unit: 'visits', direction: 'up' } };
const aimB = { id: 'b', kind: 'aim', statement: 'Health longer', weight: 5, signal: { label: 'gym', unit: 'visits', direction: 'up' } };
const aimC = { id: 'c', kind: 'aim', statement: 'Side', weight: 1, signal: { label: 'pages', unit: 'count', direction: 'up' } };
const slipped = rankNow({
  now,
  goals: [aimA, aimB, aimC],
  pin: null,
  parents: [
    { id: 'pa', status: 'open', goalId: 'a', commitment: { id: 'c-a', owner: 'you', state: 'nominated' } },
    { id: 'pb', status: 'open', goalId: 'b', commitment: { id: 'c-b', owner: 'you', state: 'nominated' } },
    { id: 'pc', status: 'open', goalId: 'c', commitment: { id: 'c-c', owner: 'you', state: 'nominated' } },
  ],
  signals: [
    { goalId: 'a', at: '2026-09-15T12:00:00Z', value: 2 },
    { goalId: 'a', at: '2026-09-22T12:00:00Z', value: 5 },
    { goalId: 'b', at: '2026-09-08T12:00:00Z', value: 5 },
    { goalId: 'b', at: '2026-09-15T12:00:00Z', value: 3 },
    { goalId: 'b', at: '2026-09-22T12:00:00Z', value: 1 },
    { goalId: 'c', at: '2026-08-01T12:00:00Z', value: 9 },
    { goalId: 'c', at: '2026-09-22T12:00:00Z', value: 1 },
  ],
});
assert.deepEqual(
  slipped.ordered.map((row) => row.commitmentId),
  ['c-b', 'c-a', 'c-c'],
  'aims sort by weight, then by the longest slip',
);

const pinnedGoals = JSON.parse(JSON.stringify([aimA, aimB]));
const pinnedBefore = JSON.parse(JSON.stringify(pinnedGoals));
const pinned = rankNow({
  now,
  goals: pinnedGoals,
  signals: [],
  pin: { commitmentId: 'c-low' },
  parents: [
    { id: 'high', status: 'open', goalId: 'a', commitment: { id: 'c-high', owner: 'you', state: 'nominated' } },
    { id: 'low', status: 'open', goalId: 'b', commitment: { id: 'c-low', owner: 'you', state: 'nominated' } },
  ],
});
assert.equal(pinned.now.commitmentId, 'c-low');
assert.match(pinned.now.reason, /You moved this ahead of the ranking/);
assert.deepEqual(pinnedGoals, pinnedBefore, 'a pin does not rewrite goals');

const kept = { id: '1', kind: 'floor', statement: 'File taxes before a lien', due: '' };
fillGoal(kept, { due: '2026-04-15', statement: 'CHANGED', stake: { text: '5% per month' } });
assert.equal(kept.statement, 'File taxes before a lien');
assert.equal(kept.due, '2026-04-15');
assert.equal(kept.stake.text, '5% per month');

console.log('test-now-rank: ok');
