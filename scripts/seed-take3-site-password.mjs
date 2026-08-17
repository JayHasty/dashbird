/**
 * Seed Take 3 site password into the events-finder passwords store.
 *
 *   node scripts/seed-take3-site-password.mjs
 */
import { upsertSitePassword } from '../src/lib/events-finder-site-passwords.js';

const result = await upsertSitePassword('https://www.take3presents.com/', 'sasquatch');
if (!result.ok) {
  console.error('Failed to seed Take 3 password:', result.error);
  process.exit(1);
}
console.log(`Logged site password for ${result.host} (sasquatch)`);
