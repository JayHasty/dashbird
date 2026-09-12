import assert from 'node:assert/strict';
import { applyTaskListOrder } from '../src/lib/task-list-order-store.js';
import { comparePanelTodoOrder, tallyOpenTopLevelTasksByProject } from '../src/lib/vikunja-client.js';

const a = { id: '10', position: 0 };
const b = { id: '20', position: 0 };
assert.ok(comparePanelTodoOrder(a, b) > 0, 'equal position → newer id first');

const items = [
  { id: '10', text: 'old' },
  { id: '20', text: 'newer' },
  { id: '30', text: 'newest' },
];

const defaultOrder = applyTaskListOrder(items, []);
assert.deepEqual(
  defaultOrder.map((t) => t.id),
  ['30', '20', '10'],
  'no saved order → newest first',
);

const custom = applyTaskListOrder(items, ['10', '30']);
assert.deepEqual(
  custom.map((t) => t.id),
  ['20', '10', '30'],
  'unsaved tasks stay on top; saved order follows',
);

const counts = tallyOpenTopLevelTasksByProject([
  { id: 1, title: 'open', project_id: 10, done: false },
  { id: 2, title: 'done', project_id: 10, done: true },
  { id: 3, title: 'other', project_id: 11, done: false },
  { id: 4, title: 'sub', project_id: 11, done: false, related_tasks: { parenttask: [{ id: 3 }] } },
]);
assert.equal(counts.get(10), 1, 'open top-level tasks count');
assert.equal(counts.get(11), 1, 'nested subtasks do not count');
assert.equal(counts.has(99), false, 'empty projects omitted');

console.log('test-todo-order: ok');
