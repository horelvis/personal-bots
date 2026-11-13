/**
 * Google Calendar through the user's own Google connection: the events of the primary calendar.
 * The functions that talk to Google take an access token; the rest is plain data handling.
 */

import { safeId } from './gmail.js';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const realDay = (day: string) => !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export type EventTime = { date: string } | { dateTime: string; timeZone?: string };

/** "2026-11-20" is a whole day; "2026-11-20T10:00:00+01:00" a moment; without an offset it needs a time zone. */
export function eventTime(value: string, timeZone?: string): EventTime {
  const v = String(value ?? '').trim();
  if (DAY.test(v)) {
    if (!realDay(v)) throw new Error(`"${v}" is not a real date`);
    return { date: v };
  }
  const m = DATE_TIME.exec(v);
  if (!m || !realDay(m[1])) throw new Error(`"${v.slice(0, 60)}" is not a date (use 2026-11-20 or 2026-11-20T10:00:00+01:00)`);
  const dateTime = `${m[1]}T${m[2]}${m[3] ?? ':00'}${m[4] ?? ''}`;
  if (m[4]) return { dateTime };
  if (!timeZone) throw new Error(`"${v}" has no offset: add one (for example +01:00) or give a time zone such as Europe/Madrid`);
  return { dateTime, timeZone };
}

/** A number to order two times of the same kind by. Times without an offset share one zone, so reading them as UTC keeps their order. */
const instant = (t: EventTime) => ('date' in t ? Date.parse(`${t.date}T00:00:00Z`) : Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`));

export interface EventInput { summary?: string; description?: string; location?: string; start?: string; end?: string; timeZone?: string; attendees?: string[] }

/** The fields of an event as the API wants them. Only what was given is included, so it also serves a partial change. */
export function eventBody(e: EventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (e.summary !== undefined) body.summary = String(e.summary);
  if (e.description !== undefined) body.description = String(e.description);
  if (e.location !== undefined) body.location = String(e.location);
  if ((e.start === undefined) !== (e.end === undefined)) throw new Error('Give both start and end, or neither');
  if (e.start !== undefined && e.end !== undefined) {
    const start = eventTime(e.start, e.timeZone);
    const end = eventTime(e.end, e.timeZone);
    if ('date' in start !== 'date' in end) throw new Error('Start and end must both be days or both be date-times');
    if (!(instant(end) > instant(start))) throw new Error('The end must be after the start');
    body.start = start;
    body.end = end;
  }
  if (e.attendees !== undefined) {
    const list = e.attendees.map((a) => String(a).trim()).filter(Boolean);
    for (const a of list) if (!ADDRESS.test(a)) throw new Error(`"${a.slice(0, 80)}" is not an email address`);
    body.attendees = list.map((email) => ({ email }));
  }
  return body;
}

export function eventSummary(ev: any) {
  const allDay = !!ev?.start?.date;
  const out: Record<string, unknown> = {
    id: String(ev.id), summary: ev.summary ? String(ev.summary) : '(no title)',
    start: String(ev?.start?.dateTime ?? ev?.start?.date ?? ''), end: String(ev?.end?.dateTime ?? ev?.end?.date ?? ''), allDay,
  };
  if (ev.location) out.location = String(ev.location);
  if (Array.isArray(ev.attendees) && ev.attendees.length) out.attendees = ev.attendees.map((a: any) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`);
  if (ev.organizer?.email) out.organizer = String(ev.organizer.email);
  if (ev.htmlLink) out.link = String(ev.htmlLink);
  return out;
}

/** An event's description on one line of the card: invitees receive it, so the user sees it (the start of it when long). */
function details(v: unknown): string {
  const flat = String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return flat.length > 600 ? `${flat.slice(0, 600)} [+${flat.length - 600} more characters]` : flat;
}

const people = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);

/**
 * What the approval card shows before an event is created, changed or deleted: which event, when,
 * and who gets an invitation or a cancellation. `existing` is the event as it is now, when it could
 * be looked up.
 */
export function describeEventChange(kind: 'create' | 'update' | 'delete', a: any, existing?: Record<string, any>): string {
  const lines: string[] = [];
  if (kind === 'create') {
    lines.push(`Create: ${String(a?.summary ?? '(no title)')}`);
    if (a?.start && a?.end) lines.push(`When: ${a.start} to ${a.end}`);
    if (a?.location) lines.push(`Where: ${a.location}`);
    if (a?.description) lines.push(`Details: ${details(a.description)}`);
    if (people(a?.attendees).length) lines.push(`Invites: ${people(a.attendees).join(', ')}`);
    return lines.join('\n');
  }
  const verb = kind === 'delete' ? 'Delete' : 'Change';
  if (!existing) lines.push(`${verb}: event ${String(a?.id ?? '')} (could not be looked up)`);
  else {
    lines.push(`${verb}: ${existing.summary}`, `${kind === 'delete' ? 'When' : 'Now'}: ${existing.start} to ${existing.end}`);
    if (kind === 'delete' && existing.attendees?.length) lines.push(`Invited: ${existing.attendees.join(', ')}`);
  }
  if (kind === 'update') {
    if (a?.summary !== undefined) lines.push(`New title: ${a.summary}`);
    if (a?.start && a?.end) lines.push(`New time: ${a.start} to ${a.end}`);
    if (a?.location !== undefined) lines.push(`New place: ${a.location}`);
    if (a?.description !== undefined) lines.push(`New details: ${details(a.description)}`);
    if (a?.attendees !== undefined) lines.push(`New invite list: ${people(a.attendees).join(', ') || '(nobody)'}`);
  }
  return lines.join('\n');
}

async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return null;
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Google Calendar: ${data?.error?.message ?? res.statusText} (${res.status})`);
  return data;
}

/** Events between two moments (default: the next seven days), in order, repeating events expanded. */
export async function listEvents(token: string, a: { from?: string; to?: string; query?: string; max?: number }) {
  const from = a.from ? new Date(a.from) : new Date();
  const to = a.to ? new Date(a.to) : new Date(from.getTime() + 7 * 24 * 3600 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('from and to must be dates (for example 2026-11-20 or 2026-11-20T10:00:00+01:00)');
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.max(1, Math.min(50, a.max ?? 20))) });
  if (a.query) q.set('q', a.query);
  const r = await call(token, `?${q}`);
  return ((r.items ?? []) as any[]).filter((e) => e.status !== 'cancelled').map(eventSummary);
}

export const createEvent = async (token: string, e: EventInput) => eventSummary(await call(token, '?sendUpdates=all', { method: 'POST', body: eventBody(e) }));

export const getEvent = async (token: string, id: string) => eventSummary(await call(token, `/${safeId(id)}`));

export const updateEvent = async (token: string, id: string, e: EventInput) => eventSummary(await call(token, `/${safeId(id)}?sendUpdates=all`, { method: 'PATCH', body: eventBody(e) }));

export const deleteEvent = async (token: string, id: string) => { await call(token, `/${safeId(id)}?sendUpdates=all`, { method: 'DELETE' }); };
