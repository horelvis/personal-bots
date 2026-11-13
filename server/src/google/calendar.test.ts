import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEventChange, eventBody, eventSummary, eventTime } from './calendar.js';

test('a day is an all-day time, a date-time keeps its offset or takes the given zone', () => {
  assert.deepEqual(eventTime('2026-11-20'), { date: '2026-11-20' });
  assert.deepEqual(eventTime('2026-11-20T10:00:00+01:00'), { dateTime: '2026-11-20T10:00:00+01:00' });
  assert.deepEqual(eventTime('2026-11-20T10:00:00Z'), { dateTime: '2026-11-20T10:00:00Z' });
  assert.deepEqual(eventTime('2026-11-20T10:00:00', 'Europe/Madrid'), { dateTime: '2026-11-20T10:00:00', timeZone: 'Europe/Madrid' });
  assert.deepEqual(eventTime('2026-11-20T10:00', 'Europe/Madrid'), { dateTime: '2026-11-20T10:00:00', timeZone: 'Europe/Madrid' });
  assert.throws(() => eventTime('2026-11-20T10:00:00'), /time zone/i);
  assert.throws(() => eventTime('tomorrow at ten'), /date/i);
  assert.throws(() => eventTime('2026-13-40'), /date/i);
});

test('an event body carries only what was given, and refuses mixed or backwards times', () => {
  assert.deepEqual(eventBody({ summary: 'Sync', start: '2026-11-20T10:00:00+01:00', end: '2026-11-20T10:30:00+01:00', attendees: ['ana@example.com'] }), {
    summary: 'Sync', start: { dateTime: '2026-11-20T10:00:00+01:00' }, end: { dateTime: '2026-11-20T10:30:00+01:00' }, attendees: [{ email: 'ana@example.com' }],
  });
  assert.deepEqual(eventBody({ location: 'Room 2' }), { location: 'Room 2' });
  assert.throws(() => eventBody({ summary: 'x', start: '2026-11-20', end: '2026-11-20T10:00:00Z' }), /both/i);
  assert.throws(() => eventBody({ summary: 'x', start: '2026-11-20T11:00:00Z', end: '2026-11-20T10:00:00Z' }), /after/i);
  assert.throws(() => eventBody({ summary: 'x', start: '2026-11-20T11:00:00Z' }), /start and end/i);
  assert.throws(() => eventBody({ attendees: ['not-an-address'] }), /address/i);
});

test('an event is summarised with its times, people and link', () => {
  assert.deepEqual(eventSummary({ id: 'e1', summary: 'Sync', status: 'confirmed', htmlLink: 'https://calendar.google.com/e1', location: 'Room 2', start: { dateTime: '2026-11-20T10:00:00+01:00' }, end: { dateTime: '2026-11-20T10:30:00+01:00' }, attendees: [{ email: 'ana@example.com', responseStatus: 'accepted' }], organizer: { email: 'me@example.com' } }),
    { id: 'e1', summary: 'Sync', start: '2026-11-20T10:00:00+01:00', end: '2026-11-20T10:30:00+01:00', allDay: false, location: 'Room 2', attendees: ['ana@example.com (accepted)'], organizer: 'me@example.com', link: 'https://calendar.google.com/e1' });
  assert.deepEqual(eventSummary({ id: 'e2', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }),
    { id: 'e2', summary: '(no title)', start: '2026-11-20', end: '2026-11-21', allDay: true });
});

test('what the user is asked to approve says which event, when, and who is invited', () => {
  assert.equal(describeEventChange('create', { summary: 'Sync', start: '2026-11-20T10:00:00+01:00', end: '2026-11-20T10:30:00+01:00', location: 'Room 2', attendees: ['ana@example.com', 'luis@example.com'] }),
    'Create: Sync\nWhen: 2026-11-20T10:00:00+01:00 to 2026-11-20T10:30:00+01:00\nWhere: Room 2\nInvites: ana@example.com, luis@example.com');
  const existing = { id: 'e1', summary: 'Sync', start: '2026-11-20T10:00:00+01:00', end: '2026-11-20T10:30:00+01:00', allDay: false, attendees: ['ana@example.com (accepted)'] };
  assert.equal(describeEventChange('delete', { id: 'e1' }, existing), 'Delete: Sync\nWhen: 2026-11-20T10:00:00+01:00 to 2026-11-20T10:30:00+01:00\nInvited: ana@example.com (accepted)');
  assert.equal(describeEventChange('update', { id: 'e1', start: '2026-11-21T10:00:00+01:00', end: '2026-11-21T10:30:00+01:00', attendees: ['eva@example.com'] }, existing),
    'Change: Sync\nNow: 2026-11-20T10:00:00+01:00 to 2026-11-20T10:30:00+01:00\nNew time: 2026-11-21T10:00:00+01:00 to 2026-11-21T10:30:00+01:00\nNew invite list: eva@example.com');
  assert.equal(describeEventChange('delete', { id: 'e9' }), 'Delete: event e9 (could not be looked up)');
  assert.equal(describeEventChange('update', { id: 'e1', attendees: [] }, existing), 'Change: Sync\nNow: 2026-11-20T10:00:00+01:00 to 2026-11-20T10:30:00+01:00\nNew invite list: (nobody)');
});

test('the card for a new event shows the details that invitees will receive', () => {
  assert.equal(describeEventChange('create', { summary: 'Sync', start: '2026-11-20', end: '2026-11-21', description: 'Agenda:\n1. Budget', attendees: ['ana@example.com'] }),
    'Create: Sync\nWhen: 2026-11-20 to 2026-11-21\nDetails: Agenda: 1. Budget\nInvites: ana@example.com');
  assert.match(describeEventChange('create', { summary: 'Sync', description: 'x'.repeat(900) }), /Details: x{600} \[\+300 more characters\]$/);
});
