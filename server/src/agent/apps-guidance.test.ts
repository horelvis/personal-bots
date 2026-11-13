import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appsGuidance, serviceForToolkit, toolsStamp, type ServiceTools } from './apps-guidance.js';

const gmail: ServiceTools = { id: 'gmail', name: 'Gmail', provider: 'Google', connected: true, tools: ['gmail_search', 'gmail_read', 'gmail_send'] };
const calendar: ServiceTools = { id: 'calendar', name: 'Google Calendar', provider: 'Google', connected: false, tools: ['calendar_list_events', 'calendar_create_event'] };

test('a bot is told which tools reach a connected service, by name', () => {
  const text = appsGuidance({ owner: 'Ana', services: [gmail, calendar], composio: false });
  assert.match(text, /Gmail is connected through Ana's own Google account: use gmail_search, gmail_read, gmail_send\./);
  assert.match(text, /Google Calendar is not connected\. Its tools \(calendar_list_events, calendar_create_event\) will say so/);
  assert.match(text, /ask Ana to open "Connect Apps" in the app and connect Google Calendar under Google/);
});

test('without Composio a bot is told not to reach for it', () => {
  const text = appsGuidance({ owner: 'Ana', services: [gmail], composio: false });
  assert.equal(/COMPOSIO_SEARCH_TOOLS, then run/.test(text), false);
  assert.match(text, /No other connected apps are set up here: do not call COMPOSIO tools or request_app_connection/);
});

test('with Composio the other apps still go through it, and the own services are named as the exception', () => {
  const text = appsGuidance({ owner: 'Ana', services: [gmail], composio: true });
  assert.match(text, /Other connected apps \(Slack, GitHub, Notion and many more\): find the right action with COMPOSIO_SEARCH_TOOLS/);
  assert.match(text, /Not for Gmail: that goes through the tools above/);
});

test('with no services of its own, the guidance is the one bots always had', () => {
  const text = appsGuidance({ owner: 'Ana', services: [], composio: true });
  assert.match(text, /^- Connected apps \(Gmail, Calendar, Slack, GitHub, Notion and many more\): find the right action with COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL\./);
  assert.equal(appsGuidance({ owner: 'Ana', services: [], composio: false }), '- No connected apps are set up here: do not call COMPOSIO tools or request_app_connection.');
});

test('an app asked for by its usual names is recognised as one of the own services', () => {
  const services = [gmail, calendar];
  assert.equal(serviceForToolkit('gmail', services)?.id, 'gmail');
  assert.equal(serviceForToolkit('GoogleMail', services)?.id, 'gmail');
  assert.equal(serviceForToolkit('googlecalendar', services)?.id, 'calendar');
  assert.equal(serviceForToolkit('google_calendar', services)?.id, 'calendar');
  assert.equal(serviceForToolkit('calendar', services)?.id, 'calendar');
  assert.equal(serviceForToolkit('slack', services), undefined);
  assert.equal(serviceForToolkit('gmail', []), undefined);
});

test('the stamp of a tool set changes when a tool is added or described differently, not with their order', () => {
  const a = [{ name: 'x', description: 'one' }, { name: 'y', description: 'two' }];
  assert.equal(toolsStamp(a), toolsStamp([a[1], a[0]]));
  assert.notEqual(toolsStamp(a), toolsStamp([...a, { name: 'z', description: 'three' }]));
  assert.notEqual(toolsStamp(a), toolsStamp([{ name: 'x', description: 'changed' }, a[1]]));
  assert.match(toolsStamp(a), /^[0-9a-f]{16}$/);
});
