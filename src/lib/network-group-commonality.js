/**
 * Rank commonalities across a Network group and suggest other contacts to add.
 */
import { getGroupById, updateGroup } from './network-groups-store.js';
import { loadNetworkContacts } from './network-contacts-store.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const SYSTEM = `You analyze a personal CRM group of people and find shared commonalities.
Return JSON only:
{
  "commonalities": [
    { "label": string, "score": number, "evidence": string }
  ],
  "suggestions": [
    { "contactId": string | null, "displayName": string, "score": number, "reason": string }
  ]
}
Rules:
- commonalities: ranked high→low by score (0-1). Prefer concrete shared orgs, industries, places, circles, activities.
- suggestions: people from the provided candidate list who best fit the group's commonalities; ranked high→low. Use their contactId when provided.
- Do not invent people not in the candidate list.
- Keep lists concise (≤12 commonalities, ≤15 suggestions).`;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(env.NETWORK_ENRICH_MODEL || env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim();
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Compact contact card for the model.
 * @param {object} c
 */
function compactContact(c) {
  return {
    id: c.id,
    displayName: c.displayName,
    nickname: c.nickname || '',
    memoryJog: c.memoryJog || '',
    aliases: c.aliases || [],
    kinds: c.kinds || [],
    hasKids: Boolean(c.hasKids),
    kidsBirthYears: Array.isArray(c.kidsBirthYears) ? c.kidsBirthYears : [],
    org: c.org || null,
    title: c.title || null,
    location: c.location || null,
    sensitivity: c.sensitivity || null,
    summary: c.summary || null,
    howWeMet: c.howWeMet || null,
    networkCircles: c.networkCircles || null,
    alignedActivities: c.alignedActivities || [],
    bio: String(c.bio || '').slice(0, 400),
  };
}

/**
 * Analyze group when it has more than 2 members.
 * @param {string} groupId
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function analyzeGroupCommonalities(groupId, env = process.env) {
  const group = await getGroupById(groupId, env);
  if (!group) return { ok: false, error: 'not_found' };

  const memberIds = group.memberIds || [];
  if (memberIds.length <= 2) {
    return {
      ok: true,
      skipped: true,
      reason: 'need_more_than_two_members',
      group,
    };
  }

  if (!openRouterKey(env)) {
    return { ok: false, error: 'openrouter_not_configured', group };
  }

  const { contacts } = await loadNetworkContacts(env);
  const members = contacts.filter((c) => memberIds.includes(c.id));
  const candidates = contacts.filter((c) => !memberIds.includes(c.id));

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openRouterKey(env)}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-network-groups',
    },
    body: JSON.stringify({
      model: textModel(env),
      temperature: 0.2,
      // Free-tier OpenRouter rejects uncapped completion budgets (defaults to 16k → HTTP 402).
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Group: ${group.name}
Description: ${group.description || '(none)'}

Members (${members.length}):
${JSON.stringify(members.map(compactContact), null, 2)}

Candidate contacts to suggest (${candidates.length}):
${JSON.stringify(candidates.map(compactContact).slice(0, 80), null, 2)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!r.ok) return { ok: false, error: `openrouter_http_${r.status}`, group };
  const j = await r.json();
  const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'parse_failed', group };

  const commonalities = (Array.isArray(parsed.commonalities) ? parsed.commonalities : [])
    .map((c) => ({
      label: String(c?.label || '').trim().slice(0, 200),
      score: Math.max(0, Math.min(1, Number(c?.score) || 0)),
      evidence: String(c?.evidence || '').trim().slice(0, 500),
    }))
    .filter((c) => c.label)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const idSet = new Set(candidates.map((c) => c.id));
  const nameMap = new Map(candidates.map((c) => [String(c.displayName || '').toLowerCase(), c.id]));
  const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
    .map((s) => {
      let contactId = s?.contactId ? String(s.contactId) : null;
      const displayName = String(s?.displayName || '').trim();
      if (contactId && !idSet.has(contactId)) contactId = null;
      if (!contactId && displayName) contactId = nameMap.get(displayName.toLowerCase()) || null;
      return {
        contactId,
        displayName: displayName.slice(0, 200),
        score: Math.max(0, Math.min(1, Number(s?.score) || 0)),
        reason: String(s?.reason || '').trim().slice(0, 500),
      };
    })
    .filter((s) => s.displayName || s.contactId)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const updated = await updateGroup(
    groupId,
    {
      commonalities,
      suggestions,
      commonalitiesUpdatedAt: new Date().toISOString(),
    },
    env,
  );

  return { ok: true, group: updated, commonalities, suggestions };
}

/**
 * Fire-and-forget commonality refresh when membership crosses >2.
 * @param {string} groupId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scheduleGroupCommonalityRefresh(groupId, env = process.env) {
  setTimeout(() => {
    analyzeGroupCommonalities(groupId, env).catch((e) => {
      console.warn('[network-groups] commonality analysis failed', e?.message || e);
    });
  }, 50);
}
