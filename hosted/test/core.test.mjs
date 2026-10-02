import test from 'node:test';
import assert from 'node:assert/strict';
import {riskReason, eligible, replyGuard, withinHours, analytics, notificationReview} from '../src/core.js';

const settings = {threshold: 4, words_avoid: 'perfect', timezone: 'Europe/Dublin', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', staff_names: 'John'};
test('complaints and contact details need a person', () => {
  assert.match(riskReason({rating: 5, text: 'Great clean but my door was damaged'}), /complaint/i);
  assert.equal(eligible({rating: 2, text: 'Nice'}, settings), false);
  assert.match(replyGuard('Call +353 123 456 789', settings), /contact/i);
  assert.match(replyGuard('It was perfect', settings), /avoid/i);
});
test('business hours respect the local timezone and weekdays', () => {
  assert.equal(withinHours(settings, Date.parse('2026-10-02T09:00:00Z')), true);
  assert.equal(withinHours(settings, Date.parse('2026-10-02T19:00:00Z')), false);
  assert.equal(withinHours(settings, Date.parse('2026-10-03T09:00:00Z')), false);
});
test('insights use recent live reviews, not samples', () => {
  const a = analytics([{rating: 5, text: 'John made the car spotless', status: 'published', demo: 0, created: '2026-10-02T09:00:00Z', published_at: '2026-10-02T10:00:00Z'}, {rating: 1, text: 'dirty', status: 'new', demo: 1}], settings);
  assert.equal(a.total, 1);
  assert.deepEqual(a.staff, [['John', 1]]);
  assert.deepEqual(a.themes, [['cleanliness', 1]]);
  assert.equal(a.average_hours, 1);
});
test('Pub/Sub only routes a valid review event on an enabled location', () => {
  assert.equal(notificationReview({notificationType: 'NEW_REVIEW', reviewName: 'accounts/1/locations/2/reviews/3', locationName: 'accounts/1/locations/2'}, 'accounts/1/locations/2'), 'accounts/1/locations/2/reviews/3');
  assert.equal(notificationReview({notificationType: 'UPDATED_REVIEW', reviewName: 'accounts/1/locations/4/reviews/3', locationName: 'accounts/1/locations/4'}, 'accounts/1/locations/2'), null);
  assert.equal(notificationReview({notificationType: 'GOOGLE_UPDATE', reviewName: 'accounts/1/locations/2/reviews/3'}, 'accounts/1/locations/2'), null);
});
