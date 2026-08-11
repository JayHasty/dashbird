import assert from 'node:assert/strict';
import {
  isCaliforniaLocation,
  compareContactLocationLabels,
} from '../public/js/lib/network-california-location.js';
import { collectContactLocationOptions } from '../public/js/lib/network-people-filters.js';

assert.equal(isCaliforniaLocation('Oakland'), true);
assert.equal(isCaliforniaLocation('Berkeley, CA'), true);
assert.equal(isCaliforniaLocation('San Francisco'), true);
assert.equal(isCaliforniaLocation('SF'), true);
assert.equal(isCaliforniaLocation('LA'), true);
assert.equal(isCaliforniaLocation('La Habra'), true);
assert.equal(isCaliforniaLocation('California, USA'), true);
assert.equal(isCaliforniaLocation('Bay Area'), true);
assert.equal(isCaliforniaLocation('Mountain House'), true);
assert.equal(isCaliforniaLocation('Brooklyn, NY'), false);
assert.equal(isCaliforniaLocation('Austin, TX'), false);
assert.equal(isCaliforniaLocation('Portland, OR'), false);
assert.equal(isCaliforniaLocation('Baton Rouge, LA'), false);
assert.equal(isCaliforniaLocation('Out of town'), false);
assert.equal(isCaliforniaLocation(''), false);

const opts = collectContactLocationOptions([
  { location: 'Brooklyn, NY' },
  { location: 'oakland' },
  { location: 'Austin, TX' },
  { location: 'Berkeley, CA' },
  { location: 'Oakland' },
  { location: '  ' },
  { location: 'Out of town' },
]);
assert.deepEqual(opts, ['Berkeley, CA', 'oakland', 'Austin, TX', 'Brooklyn, NY', 'Out of town']);

assert.ok(compareContactLocationLabels('Oakland', 'Austin, TX') < 0);
assert.ok(compareContactLocationLabels('Berkeley', 'Oakland') < 0);

console.log('test-contact-location-options: ok');
