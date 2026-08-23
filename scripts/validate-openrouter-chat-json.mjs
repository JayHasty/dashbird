/**
 * Offline checks for OpenRouter status retry policy.
 * Run: node scripts/validate-openrouter-chat-json.mjs
 */
import assert from 'node:assert/strict';
import { openRouterShouldRetryStatus } from '../src/lib/openrouter-chat-json.js';

assert.equal(openRouterShouldRetryStatus(403), true);
assert.equal(openRouterShouldRetryStatus(404), true);
assert.equal(openRouterShouldRetryStatus(402), true);
assert.equal(openRouterShouldRetryStatus(429), true);
assert.equal(openRouterShouldRetryStatus(500), true);
assert.equal(openRouterShouldRetryStatus(401), false);
assert.equal(openRouterShouldRetryStatus(200), false);

console.log('validate-openrouter-chat-json: ok');
