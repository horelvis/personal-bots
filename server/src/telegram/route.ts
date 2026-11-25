/** Pure helpers for Telegram (R11): which bot a message is for, and an approval card as a message with buttons. */

export interface BotChoice { id: string; name: string; isPrimary: boolean }

/**
 * "@Name message" or "Name: message" is for that bot (names compared without case); anything else
 * goes to the main bot, or the first one. A name that is no bot stays part of the message.
 */
export function pickBot(raw: string, bots: BotChoice[]): { botId: string; text: string } | null {
  const text = raw.trim();
  if (!text || !bots.length) return null;
  const byName = (n: string) => bots.find((b) => b.name.trim().toLowerCase() === n.trim().toLowerCase());
  // Longest names first, so "Mary Jane:" is not read as "Mary".
  for (const b of [...bots].sort((x, y) => y.name.length - x.name.length)) {
    const name = b.name.trim();
    if (!name) continue;
    for (const prefix of [`@${name} `, `${name}: `, `${name}:`]) {
      if (text.toLowerCase().startsWith(prefix.toLowerCase()) && text.length > prefix.length) {
        const rest = text.slice(prefix.length).trim();
        if (rest && byName(name)) return { botId: b.id, text: rest };
      }
    }
  }
  const main = bots.find((b) => b.isPrimary) ?? bots[0];
  return { botId: main.id, text };
}

export type Decision = 'allow' | 'deny' | 'always';
export interface Button { label: string; data: string }

const MAX = 4096;

export function cardMessage(c: { botName: string; title: string; detail: string; approvalId: string; alwaysOffered: boolean }): { text: string; buttons: Button[][] } {
  const head = `${c.botName} asks: ${c.title}`;
  const room = MAX - head.length - 40;
  const detail = c.detail.length > room ? `${c.detail.slice(0, room)}\n[…more in the app]` : c.detail;
  const row: Button[] = [{ label: 'Allow', data: `ap:${c.approvalId}:allow` }, { label: 'Deny', data: `ap:${c.approvalId}:deny` }];
  return {
    text: detail ? `${head}\n\n${detail}` : head,
    buttons: c.alwaysOffered ? [row, [{ label: 'Always allow', data: `ap:${c.approvalId}:always` }]] : [row],
  };
}

/** The approval and the answer a button carries, or null when it is not one of ours. */
export function parseButton(data: string): { approvalId: string; decision: Decision } | null {
  const m = /^ap:([A-Za-z0-9_-]{1,64}):(allow|deny|always)$/.exec(data ?? '');
  return m ? { approvalId: m[1], decision: m[2] as Decision } : null;
}

const OUTCOME: Record<string, string> = { allowed: 'Allowed', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };
export const outcomeText = (status: string) => OUTCOME[status] ?? status;
