import assert from 'node:assert/strict';
import {
  CONTACT_TASKS_PROJECT_TITLE,
  contactParentDescription,
  contactTaskDescription,
  contactTaskTextFromVikunjaTitle,
  formatContactParentTitle,
  formatContactSubtaskTitle,
  formatContactTaskTitle,
  isFriendTasksProjectTitle,
  parseContactParentDescription,
  parseContactTaskDescription,
} from '../src/lib/contact-task-title.js';

assert.equal(CONTACT_TASKS_PROJECT_TITLE, 'Friend Tasks');
assert.equal(isFriendTasksProjectTitle('Friend Tasks'), true);
assert.equal(isFriendTasksProjectTitle('Contact Tasks'), true);
assert.equal(isFriendTasksProjectTitle('Inbox'), false);

assert.equal(formatContactParentTitle({ displayName: 'Jane Doe', nickname: 'Jay' }), 'Jane Doe (Jay)');
assert.equal(formatContactParentTitle({ displayName: 'Jane Doe' }), 'Jane Doe');
assert.equal(formatContactParentTitle({ displayName: 'Jay', nickname: 'Jay' }), 'Jay');

assert.equal(formatContactSubtaskTitle('Call about lunch'), 'Call about lunch');
assert.ok(formatContactSubtaskTitle('x'.repeat(400)).length <= 280);

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

const parentDesc = contactParentDescription('783');
assert.equal(parentDesc, 'dashbird:contact-parent:783');
assert.deepEqual(parseContactParentDescription(`notes\n${parentDesc}\n`), { contactId: '783' });
assert.equal(parseContactParentDescription(desc), null);
assert.equal(parseContactParentDescription('unrelated'), null);

assert.equal(
  contactTaskTextFromVikunjaTitle('Jane Doe (Jay) — Call about lunch'),
  'Call about lunch',
);

console.log('test-contact-task-title: ok');
