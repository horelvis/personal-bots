import { accessTokenFor, NotConnected } from '../oauth/connections.js';
import { readMessage, searchMessages, sendMessage } from '../google/gmail.js';
import { createEvent, deleteEvent, listEvents, updateEvent } from '../google/calendar.js';
import type { ToolDef, ToolResult } from './tools.js';

/**
 * Gmail and Google Calendar for the bots, through the user's own Google connection. Reading runs at
 * once; anything that sends or changes carries `approval`, so it waits for the user's card.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const list = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

/** Run with the service's access token. A missing connection is an answer for the agent, not a failure. */
async function withToken(userId: string, service: 'gmail' | 'calendar', work: (token: string) => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work(await accessTokenFor(userId, 'google', service));
  } catch (e) {
    if (e instanceof NotConnected) return { output: e.message, summary: 'Not connected' };
    throw e;
  }
}

const json = (v: unknown) => JSON.stringify(v, null, 1);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()) : undefined);
const DATES = 'A day (2026-11-20) or a date-time with its offset (2026-11-20T10:00:00+01:00).';

export const googleTools: ToolDef[] = [
  {
    name: 'gmail_search',
    description: "Search the user's Gmail. Uses Gmail's search syntax, e.g. \"from:ana@example.com newer_than:7d\", \"is:unread\", \"subject:invoice has:attachment\". Returns id, sender, subject, date and a snippet for each message; use gmail_read for the full text.",
    parameters: obj({ query: str('Gmail search query. Empty for the latest messages.'), max: { type: 'integer', description: 'How many to return (1-25, default 10).' } }),
    activity: 'connecting_service',
    label: 'Searching Gmail',
    impl: (a, ctx) => withToken(ctx.userId, 'gmail', async (token) => {
      const found = await searchMessages(token, String(a.query ?? ''), Number(a.max) || 10);
      return { output: json({ messages: found }), summary: `Found ${found.length} message${found.length === 1 ? '' : 's'}` };
    }),
  },
  {
    name: 'gmail_read',
    description: 'Read one Gmail message in full: headers and text. Take the id from gmail_search.',
    parameters: obj({ id: str('Message id from gmail_search.') }, ['id']),
    activity: 'connecting_service',
    label: 'Reading an email',
    impl: (a, ctx) => withToken(ctx.userId, 'gmail', async (token) => {
      const msg = await readMessage(token, String(a.id));
      return { output: json(msg), summary: `Read "${msg.subject.slice(0, 60)}"` };
    }),
  },
  {
    name: 'gmail_send',
    description: "Send an email from the user's Gmail. The user is asked to approve it first. To reply inside a thread, pass the original message's threadId and messageId (both come from gmail_search or gmail_read) and keep its subject with \"Re: \".",
    parameters: obj({
      to: list('Recipient addresses.'), cc: list('Cc addresses.'), bcc: list('Bcc addresses.'),
      subject: str('Subject line.'), body: str('Plain-text body.'),
      thread_id: str('threadId of the message being answered.'), in_reply_to: str('messageId of the message being answered, like <id@host>.'),
    }, ['to', 'subject', 'body']),
    activity: 'connecting_service',
    label: 'Sending an email',
    approval: { toolkit: 'gmail', title: 'Gmail: send an email', needs: { provider: 'google', service: 'gmail' } },
    impl: (a, ctx) => withToken(ctx.userId, 'gmail', async (token) => {
      const sent = await sendMessage(token, { to: strings(a.to) ?? [], cc: strings(a.cc), bcc: strings(a.bcc), subject: String(a.subject ?? ''), body: String(a.body ?? ''), threadId: a.thread_id ? String(a.thread_id) : undefined, inReplyTo: a.in_reply_to ? String(a.in_reply_to) : undefined });
      return { output: json({ ok: true, ...sent }), summary: 'Email sent' };
    }),
  },
  {
    name: 'calendar_list_events',
    description: "List events on the user's primary Google Calendar between two moments (default: the next seven days), in order. Repeating events are listed one by one.",
    parameters: obj({ from: str(`Start of the range. ${DATES}`), to: str(`End of the range. ${DATES}`), query: str('Only events matching this text.'), max: { type: 'integer', description: 'How many to return (1-50, default 20).' } }),
    activity: 'connecting_service',
    label: 'Checking the calendar',
    impl: (a, ctx) => withToken(ctx.userId, 'calendar', async (token) => {
      const events = await listEvents(token, { from: a.from ? String(a.from) : undefined, to: a.to ? String(a.to) : undefined, query: a.query ? String(a.query) : undefined, max: Number(a.max) || undefined });
      return { output: json({ events }), summary: `Found ${events.length} event${events.length === 1 ? '' : 's'}` };
    }),
  },
  {
    name: 'calendar_create_event',
    description: "Create an event on the user's primary Google Calendar. The user is asked to approve it first. Attendees get an invitation.",
    parameters: obj({
      summary: str('Title.'), start: str(`When it starts. ${DATES}`), end: str(`When it ends. ${DATES} For whole days, the day after the last one.`),
      time_zone: str('IANA time zone (e.g. Europe/Madrid) for date-times given without an offset.'),
      description: str('Details.'), location: str('Place or link.'), attendees: list('Email addresses to invite.'),
    }, ['summary', 'start', 'end']),
    activity: 'connecting_service',
    label: 'Creating an event',
    approval: { toolkit: 'googlecalendar', title: 'Google Calendar: create an event', needs: { provider: 'google', service: 'calendar' } },
    impl: (a, ctx) => withToken(ctx.userId, 'calendar', async (token) => {
      const ev = await createEvent(token, { summary: String(a.summary ?? ''), start: String(a.start ?? ''), end: String(a.end ?? ''), timeZone: a.time_zone ? String(a.time_zone) : undefined, description: a.description !== undefined ? String(a.description) : undefined, location: a.location !== undefined ? String(a.location) : undefined, attendees: strings(a.attendees) });
      return { output: json({ ok: true, event: ev }), summary: 'Event created' };
    }),
  },
  {
    name: 'calendar_update_event',
    description: "Change an event on the user's primary Google Calendar: only the fields you pass change. The user is asked to approve it first. Take the id from calendar_list_events. Passing attendees replaces the whole list.",
    parameters: obj({
      id: str('Event id from calendar_list_events.'), summary: str('New title.'), start: str(`New start. ${DATES}`), end: str(`New end. ${DATES}`),
      time_zone: str('IANA time zone for date-times given without an offset.'), description: str('New details.'), location: str('New place or link.'), attendees: list('The full new list of attendee addresses.'),
    }, ['id']),
    activity: 'connecting_service',
    label: 'Changing an event',
    approval: { toolkit: 'googlecalendar', title: 'Google Calendar: change an event', needs: { provider: 'google', service: 'calendar' } },
    impl: (a, ctx) => withToken(ctx.userId, 'calendar', async (token) => {
      const text = (v: unknown) => (v !== undefined ? String(v) : undefined);
      const ev = await updateEvent(token, String(a.id), { summary: text(a.summary), start: text(a.start), end: text(a.end), timeZone: text(a.time_zone), description: text(a.description), location: text(a.location), attendees: a.attendees !== undefined ? strings(a.attendees) ?? [] : undefined });
      return { output: json({ ok: true, event: ev }), summary: 'Event changed' };
    }),
  },
  {
    name: 'calendar_delete_event',
    description: "Delete an event from the user's primary Google Calendar. The user is asked to approve it first. Attendees are told it was cancelled.",
    parameters: obj({ id: str('Event id from calendar_list_events.') }, ['id']),
    activity: 'connecting_service',
    label: 'Deleting an event',
    approval: { toolkit: 'googlecalendar', title: 'Google Calendar: delete an event', needs: { provider: 'google', service: 'calendar' } },
    impl: (a, ctx) => withToken(ctx.userId, 'calendar', async (token) => {
      await deleteEvent(token, String(a.id));
      return { output: json({ ok: true }), summary: 'Event deleted' };
    }),
  },
];
