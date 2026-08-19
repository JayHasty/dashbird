/**
 * Target Google Calendar for Events finder “Add to calendar” links.
 */

const DEFAULT_NAME = 'Random Events';
const DEFAULT_AUTHUSER = '';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   name: string,
 *   authuser: string,
 *   src: string,
 * }}
 */
export function resolveEventsFinderGoogleCalendar(env = process.env) {
  const name =
    String(env.EVENTS_FINDER_GOOGLE_CALENDAR_NAME || '').trim() || DEFAULT_NAME;
  const authuser =
    String(env.EVENTS_FINDER_GOOGLE_CALENDAR_AUTHUSER || '').trim()
    || DEFAULT_AUTHUSER;
  const src = String(env.EVENTS_FINDER_GOOGLE_CALENDAR_SRC || '').trim();
  return { name, authuser, src };
}
