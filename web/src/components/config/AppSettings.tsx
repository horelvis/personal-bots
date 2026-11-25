import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpendingReport, Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { Glyph } from './glyphs';
import { ConfirmButton } from './ui';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'spending', label: 'Spending' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'account', label: 'Account' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'spending' && <SpendingSection />}
          {section === 'telegram' && <TelegramSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  // The server says how many screens the computer can hold; 4 until it does.
  const maxScreens = computer?.maxScreens ?? details?.computer.maxScreens ?? 4;

  return (
    <>
      <PageHead title="Computer" sub="Your Bots share one cloud computer. Each Bot works on its own screen." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details && maxScreens ? ` · ${details.screens.length} of ${maxScreens}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time.{maxScreens ? ` Up to ${maxScreens} Bots can have a screen at once${details && details.screens.length >= maxScreens ? '; reset one to free it for another Bot' : ''}.` : ''}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function RulesCard() {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => { configApi.trustRules().then((r) => { setSaved(r.rules); setDraft(r.rules); }).catch(() => setSaved('')); }, []);
  const save = () => {
    setState('saving');
    configApi.setTrustRules(draft).then((r) => { setSaved(r.rules); setDraft(r.rules); setState('saved'); }).catch(() => setState('error'));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-card">
        <div className="cfg-row cfg-row--stack">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Your rules</div>
            <div className="cfg-row__sub">Before a Bot does something that changes anything, the app checks it against what you asked and these rules. Write them in your own words, for example “Always ask before emailing anyone outside my company” or “No need to ask before reading files in a Bot’s own folder”. A rule to ask always wins. Only you can change them.</div>
          </div>
          <textarea className="text-input cfg-rules" rows={5} value={draft} disabled={saved === null} onChange={(e) => { setDraft(e.target.value); setState('idle'); }} aria-label="Your rules" placeholder="One rule per line" />
          <div className="cfg-row__actions">
            <button type="button" className="cfg-btn" disabled={saved === null || draft === saved || state === 'saving'} onClick={save}>{state === 'saving' ? 'Saving…' : 'Save rules'}</button>
            {state === 'saved' && <span className="cfg-row__sub">Saved</span>}
            {state === 'error' && <span className="cfg-row__sub">Couldn’t save. Try again.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Link a Telegram account to talk to the Bots there (R11). */
function TelegramSection() {
  const [status, setStatus] = useState<{ configured: boolean; botUsername: string | null; linked: boolean } | null>(null);
  const [link, setLink] = useState<{ code: string; url: string | null } | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => { configApi.telegram().then((s) => { setStatus(s); setError(false); }).catch(() => setError(true)); }, []);
  useEffect(load, [load]);
  // While a link is open, notice when it was used.
  useEffect(() => {
    if (!link || status?.linked) return;
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [link, status?.linked, load]);
  return (
    <>
      <PageHead title="Telegram" sub="Talk to your Bots from Telegram and answer their approvals there. Messages go to your main Bot; start one with a Bot’s name and a colon, like “Alice: …”, to talk to another. Sign-ins still happen here in the app." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row cfg-row--stack">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{!status ? (error ? 'Couldn’t load.' : 'Loading…') : !status.configured ? 'Not set up on this server' : status.linked ? `Linked to @${status.botUsername ?? 'your bot'}` : 'Not linked'}</div>
              <div className="cfg-row__sub">
                {status && !status.configured && 'Create a bot with @BotFather in Telegram, put its token in the server’s .env as TELEGRAM_BOT_TOKEN, and restart the server.'}
                {status?.configured && !status.linked && !link && 'Only the Telegram account you link can talk to your Bots there.'}
                {status?.configured && !status.linked && link && (link.url ? <>Open <a href={link.url} target="_blank" rel="noreferrer">this link</a> in Telegram and press Start. It works once, for 10 minutes.</> : <>Send <code>/start {link.code}</code> to your bot in Telegram. It works once, for 10 minutes.</>)}
                {status?.linked && 'Your messages there reach your Bots, and their approval cards come to you with buttons.'}
              </div>
            </div>
            {status?.configured && (
              <div className="cfg-row__actions">
                {!status.linked && <button type="button" className="cfg-btn" onClick={() => configApi.linkTelegram().then(setLink).catch(() => setError(true))}>{link ? 'New link' : 'Link Telegram'}</button>}
                {status.linked && <button type="button" className="cfg-btn" onClick={() => configApi.unlinkTelegram().then((s) => { setStatus(s); setLink(null); }).catch(() => setError(true))}>Unlink</button>}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

const usd = (n: number) => `US$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const KIND_LABEL: Record<SpendingReport['byKind'][number]['kind'], string> = { turn: 'Bot turns', check: 'Action checks', search: 'X searches', voice: 'Voice calls' };
const unknownNote = (n: number) => (n ? ` · ${n} without a known cost` : '');

/** This month's spending at list price, per bot and routine, and the monthly limit (R9). */
function SpendingSection() {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { configApi.spending(month).then((r) => { setReport(r); setFailed(false); }).catch(() => setFailed(true)); }, [month]);
  useEffect(load, [load]);
  const shift = (by: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <>
      <PageHead title="Spending" sub="What the Bots’ work cost, at the models’ list prices. With a subscription you are not billed per call; these figures are what the same use would cost through the API. Months run in UTC." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <button type="button" className="cfg-btn" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{label}: {report ? usd(report.total) : '…'}{report?.limit !== null && report?.limit !== undefined && month === thisMonth ? ` of ${usd(report.limit)}` : ''}</div>
              <div className="cfg-row__sub">{failed ? 'Couldn’t load the spending.' : report ? `Costs not known count as nothing${unknownNote(report.unknown)}` : 'Loading…'}</div>
            </div>
            <button type="button" className="cfg-btn" disabled={month >= thisMonth} onClick={() => shift(1)} aria-label="Next month">›</button>
          </div>
        </div>
      </section>
      {report && (
        <>
          <SpendList title="By Bot" empty="Nothing recorded this month." rows={report.byBot.map((b) => ({ key: b.botId, name: b.name, sub: `${b.turns} turn${b.turns === 1 ? '' : 's'}${unknownNote(b.unknown)}`, cost: b.cost }))} />
          <SpendList title="By routine" empty="No routine ran this month." rows={report.byRoutine.map((r) => ({ key: r.routineId, name: r.name, sub: `${r.botName ? `${r.botName} · ` : ''}${r.runs} run${r.runs === 1 ? '' : 's'}${unknownNote(r.unknown)}`, cost: r.cost }))} />
          <SpendList title="By kind" empty="" rows={report.byKind.map((k) => ({ key: k.kind, name: KIND_LABEL[k.kind] ?? k.kind, sub: `${k.count}${unknownNote(k.unknown)}`, cost: k.cost }))} />
        </>
      )}
      <LimitCard limit={report?.limit ?? null} ready={report !== null} onSaved={load} />
    </>
  );
}

function SpendList({ title, empty, rows }: { title: string; empty: string; rows: { key: string; name: string; sub: string; cost: number }[] }) {
  if (!rows.length && !empty) return null;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">{title}</div>
      <div className="cfg-card">
        {!rows.length && <div className="cfg-row"><div className="cfg-row__sub">{empty}</div></div>}
        {rows.map((r) => (
          <div key={r.key} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{r.name}</div>
              <div className="cfg-row__sub">{r.sub}</div>
            </div>
            <div className="cfg-row__title">{usd(r.cost)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LimitCard({ limit, ready, onSaved }: { limit: number | null; ready: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => { setDraft(limit === null ? '' : String(limit)); }, [limit]);
  const value = draft.trim() === '' ? null : Number(draft);
  const valid = value === null || (Number.isFinite(value) && value >= 0 && value <= 100000);
  const save = (v: number | null) => {
    setState('saving');
    configApi.setSpendLimit(v).then(() => { setState('saved'); onSaved(); }).catch(() => setState('error'));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-card">
        <div className="cfg-row cfg-row--stack">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Monthly limit</div>
            <div className="cfg-row__sub">When this month’s spending reaches it, routines, check-ins and other work nobody is watching stop, and a Bot you write to says so instead of answering. A run that would likely pass it does not start either. Leave it empty for no limit.</div>
          </div>
          <input className="text-input" inputMode="decimal" value={draft} disabled={!ready} placeholder="No limit" aria-label="Monthly limit in US dollars" onChange={(e) => { setDraft(e.target.value); setState('idle'); }} />
          <div className="cfg-row__actions">
            <button type="button" className="cfg-btn" disabled={!ready || !valid || value === limit || state === 'saving'} onClick={() => save(value)}>{state === 'saving' ? 'Saving…' : 'Save limit'}</button>
            {limit !== null && <button type="button" className="cfg-btn" disabled={state === 'saving'} onClick={() => save(null)}>Remove limit</button>}
            {!valid && <span className="cfg-row__sub">Enter an amount in US dollars, from 0 to 100000.</span>}
            {state === 'saved' && <span className="cfg-row__sub">Saved</span>}
            {state === 'error' && <span className="cfg-row__sub">Couldn’t save. Try again.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

const NO_LONGER_ALWAYS = ['cli_bash', 'cli_read', 'create_routine', 'create_event_routine', 'update_routine', 'delete_routine', 'set_checkins', 'memory_note'];

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  // "Always allow" no longer applies to shell commands, reads and routine changes (R6), so they are not listed.
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies.filter((p) => !NO_LONGER_ALWAYS.includes(p.tool)))).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="What your Bots may do without asking first: your rules, and the actions you chose to always allow." />
      <RulesCard />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" sub="Apps your Bots can use for you, like email, calendar and docs." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Bots ask before doing anything that changes data in an app.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>{apps?.length ? 'Manage apps' : 'Connect apps'}</button>
          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
