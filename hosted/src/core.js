export const DEFAULT = {
  business: 'Your business', style: 'Warm, professional and concise. Refer naturally to something specific in the review.',
  knowledge: '', examples: '', signoff: '', words_use: '', words_avoid: '', staff_names: '', emoji: 'none',
  length: '2–4 short sentences', auto_mode: 'off', publish_consent: false, threshold: 4,
  delay_minutes: 30, limit: 10, timezone: 'Europe/Dublin', start: '09:00', end: '18:00',
  weekdays: [1, 2, 3, 4, 5, 6, 7], auto_since: 0, synced_at: 0
};
const RISK = /\b(?:complain\w*|damage\w*|refund\w*|injur\w*|legal|solicitor|threat\w*|unsafe|terrible|disappoint\w*|poor|rude|discriminat\w*|harass\w*|late|delay\w*|dirty|broken|but|however|except|issue\w*|problem\w*|mistake\w*|wrong|overcharg\w*)\b/i;
const TOPICS = {cleanliness: ['clean', 'spotless', 'wash', 'stain', 'interior'], service: ['service', 'team', 'friendly', 'helpful'], timeliness: ['wait', 'late', 'time', 'quick', 'delay'], value: ['price', 'value', 'cost', 'expensive'], staff: ['staff', 'manager', 'employee']};
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function riskReason(r) {
  if (Number(r.rating) < 4) return 'Rating below four stars';
  if (RISK.test(r.text || '')) return 'Possible complaint or sensitive wording';
  return '';
}
export function eligible(r, s) { return Number(r.rating) >= s.threshold && !riskReason(r); }
export function replyGuard(reply, s) {
  if (/https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d\s().-]{7,}\d/.test(reply)) return 'Reply contains a link or contact detail; check it manually';
  for (const word of (s.words_avoid || '').split(/[,\n]+/)) {
    if (word.trim() && new RegExp(`\\b${escapeRegex(word.trim())}\\b`, 'i').test(reply)) return 'Reply contains a word marked to avoid';
  }
  return '';
}
export function localParts(s, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: s.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`};
}
export function withinHours(s, now = Date.now()) {
  const p = localParts(s, now);
  return s.weekdays.includes(p.day) && s.start <= p.time && p.time < s.end;
}
export function themeFor(value) {
  for (const [name, terms] of Object.entries(TOPICS)) if (terms.some(t => new RegExp(`\\b${escapeRegex(t)}\\b`, 'i').test(value || ''))) return name;
  return 'other';
}
export function analytics(reviews, s) {
  const real = reviews.filter(r => !r.demo), responded = real.filter(r => r.status === 'published');
  const themes = {}, compliments = {}, complaints = {}, staff = {}, timings = [];
  for (const r of real) {
    const t = themeFor(r.text), target = r.rating >= 4 ? compliments : complaints;
    themes[t] = (themes[t] || 0) + 1; target[t] = (target[t] || 0) + 1;
    for (const name of (s.staff_names || '').split(',').map(x => x.trim()).filter(Boolean)) if (new RegExp(`\\b${escapeRegex(name)}\\b`, 'i').test(r.text || '')) staff[name] = (staff[name] || 0) + 1;
  }
  for (const r of responded) {
    const a = Date.parse(r.created), b = Date.parse(r.published_at);
    if (Number.isFinite(a) && Number.isFinite(b)) timings.push(Math.max(0, (b - a) / 3600000));
  }
  const sorted = x => Object.entries(x).sort((a, b) => b[1] - a[1]);
  return {total: real.length, average: real.length ? Math.round(real.reduce((n, r) => n + r.rating, 0) / real.length * 10) / 10 : null,
    unanswered: real.length - responded.length, responded: responded.length, average_hours: timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length * 10) / 10 : null,
    positive: real.filter(r => r.rating >= 4).length, negative: real.filter(r => r.rating <= 2).length,
    themes: sorted(themes), compliments: sorted(compliments), complaints: sorted(complaints), staff: sorted(staff)};
}
export const REVIEW_NAME = /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;
export const LOCATION_NAME = /^accounts\/[^/]+\/locations\/[^/]+$/;
export function notificationReview(n, location) {
  if (!['NEW_REVIEW', 'UPDATED_REVIEW'].includes(n?.notificationType)) return null;
  if (!REVIEW_NAME.test(n.reviewName || '') || n.locationName !== location || !n.reviewName.startsWith(`${location}/reviews/`)) return null;
  return n.reviewName;
}
export function validateSettings(old, data) {
  const s = {...old, ...Object.fromEntries(Object.entries(data).filter(([k]) => Object.hasOwn(DEFAULT, k) && !['auto_since', 'synced_at', 'publish_consent'].includes(k)))};
  if (!['off', 'draft', 'publish'].includes(s.auto_mode) || !['none', 'sparingly', 'allowed'].includes(s.emoji)) throw Error('Invalid automation or emoji setting.');
  for (const [k, max] of Object.entries({business: 150, style: 5000, knowledge: 15000, examples: 10000, signoff: 150, words_use: 500, words_avoid: 500, staff_names: 500, length: 100})) {
    if (typeof s[k] !== 'string' || s[k].length > max) throw Error(`${k} must be text of at most ${max} characters.`);
  }
  for (const [k, lo, hi] of [['threshold', 4, 5], ['limit', 1, 100], ['delay_minutes', 0, 10080]]) if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw Error(`Invalid ${k}.`);
  try { new Intl.DateTimeFormat('en-GB', {timeZone: s.timezone}).format(); } catch { throw Error('Use an IANA timezone such as Europe/Dublin.'); }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) || s.start >= s.end) throw Error('Business hours must end after they start.');
  if (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.some(x => !Number.isInteger(x) || x < 1 || x > 7)) throw Error('Select at least one day.');
  if (s.auto_mode === 'publish') {
    if ((!old.publish_consent || old.auto_mode !== 'publish') && data.confirm_auto_publish !== true) throw Error('Confirm that eligible Google replies may publish automatically.');
    s.publish_consent = true;
  } else s.publish_consent = false;
  return s;
}
