/**
 * Tag Events Finder listings only when Anthropic *employees* are confirmed
 * in the listing (not community ambassadors). Logistics notes go on the event.
 */
const EMPLOYEE_HINT_RE =
  /\b(anthropic staff|anthropic teammates|teammates from anthropic|anthropic recruiters?|members? of (the )?anthropic|@ anthropic|beneficial deployments @ anthropic)\b/i;

const AMBASSADOR_ONLY_RE =
  /\b(claude community ambassador|ambassadors? to anthropic|hosted by ambassadors?)\b/i;

/** BD / CS names we already know from the application packet. */
const KNOWN_EMPLOYEES = [
  'Elizabeth Kelly',
  'Melissa Heinz',
  'Alex Lyons',
  'Alisa Feng',
  'Canute Haroldson',
  'Ariana Younai',
  'Shad Ahmed',
  'Drew Bent',
  'Jonah Cool',
  'Anne Stake',
  'Aarushi Karandikar',
  'Aarushi K',
  'Grace Rochford Everitt',
  'Federico Velarde',
];

/**
 * @param {object} event
 */
function eventBlob(event) {
  return [
    event?.title,
    event?.description,
    event?.host,
    event?.hosts,
    Array.isArray(event?.speakers) ? event.speakers.join(' ') : event?.speakers,
    event?.planningNotes,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {object} event
 * @returns {string[]}
 */
export function extractConfirmedAnthropicEmployees(event) {
  const blob = eventBlob(event);
  /** @type {Set<string>} */
  const names = new Set();
  for (const name of KNOWN_EMPLOYEES) {
    if (new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blob)) {
      names.add(name);
    }
  }
  const atMatches = blob.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+@\s+Anthropic/g);
  for (const m of atMatches) {
    if (m[1]) names.add(m[1].trim());
  }
  if (!names.size && EMPLOYEE_HINT_RE.test(blob) && !AMBASSADOR_ONLY_RE.test(blob)) {
    names.add('Anthropic staff (unnamed)');
  }
  return [...names];
}

/**
 * @param {object} event
 * @param {string[]} employees
 */
export function anthropicLogisticsNotes(event, employees) {
  const who = employees.length ? employees.join(', ') : 'unconfirmed';
  const title = String(event?.title || 'Untitled event');
  const city = String(event?.city || event?.venue || 'location TBD');
  const ambassadorOnly = AMBASSADOR_ONLY_RE.test(eventBlob(event));
  let usefulness = 'Medium — product fluency, weak BD hiring signal.';
  if (employees.some((n) => /heinz|lyons|feng|haroldson|kelly|younai|ahmed/i.test(n))) {
    usefulness = 'High — Beneficial Deployments / CS people in the room.';
  } else if (ambassadorOnly || who === 'unconfirmed') {
    usefulness = 'Low for hiring. Community / GTM only unless an employee is named.';
  }
  return [
    `Who: ${who}`,
    `Why: ${title} (${city}).`,
    `Usefulness: ${usefulness}`,
    ambassadorOnly
      ? 'Do not treat ambassadors as Anthropic employees.'
      : 'Employee presence confirmed from the listing copy.',
  ].join('\n');
}

/**
 * Only returns a tagged copy when employees are confirmed.
 * @param {object} event
 */
export function annotateAnthropicEmployeeEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const employees = extractConfirmedAnthropicEmployees(event);
  if (!employees.length) {
    const tags = Array.isArray(event.tags) ? event.tags.filter((t) => t !== 'anthropic') : [];
    return tags.length ? { ...event, tags } : event;
  }
  const tags = [...new Set([...(Array.isArray(event.tags) ? event.tags : []), 'anthropic'])];
  return {
    ...event,
    tags,
    anthropicEmployees: employees,
    logistics: true,
    planningNotes: event.planningNotes || anthropicLogisticsNotes(event, employees),
  };
}

/**
 * @param {object[]} events
 */
export function annotateAnthropicEmployeeEvents(events) {
  return (Array.isArray(events) ? events : []).map(annotateAnthropicEmployeeEvent);
}
