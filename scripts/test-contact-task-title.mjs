import assert from 'node:assert/strict';
import {
  contactTaskDescription,
  contactTaskTextFromVikunjaTitle,
  formatContactTaskTitle,
  parseContactTaskDescription,
} from '../src/lib/contact-task-title.js';

assert.equal(
  formatContactTaskTitle({ displayName: 'Jane Doe', nickname: 'Jay' }, 'Call about lunch'),
  'Jane Doe (Jay) — Call about lunch',
);
assert.equal(
  formatContactTaskTitle({ displayName: 'Jane Doe' }, 'Call about lunch'),
  'Jane Doe — Call about lunch',
);
assert.equal(
  formatContactTaskTitle({ displayName: 'Jay', nickname: 'Jay' }, 'Follow up'),
  'Jay — Follow up',
);

const long = 'x'.repeat(400);
const titled = formatContactTaskTitle({ displayName: 'A' }, long);
assert.ok(titled.length <= 280);
assert.ok(titled.startsWith('A — '));

const desc = contactTaskDescription('783', 'task_abc');
assert.equal(desc, 'dashbird:contact-task:783:task_abc');
assert.deepEqual(parseContactTaskDescription(`notes\n${desc}\n`), {
  contactId: '783',
  taskId: 'task_abc',
});
assert.equal(parseContactTaskDescription('unrelated'), null);

assert.equal(
  contactTaskTextFromVikunjaTitle('Jane Doe (Jay) — Call about lunch'),
  'Call about lunch',
);

console.log('test-contact-task-title: ok');
