/**
 * How a screen id maps onto the computer: its X display and the ports that follow from it.
 * The default screen is display :99; "screen-100" is :100, and so on.
 */

export interface Screen { id: string; display: string; width: number; height: number; default: boolean }

export const DEFAULT_DISPLAY = 99;

export const displayFor = (screenId?: string | null) => (!screenId || screenId === 'default' ? `:${DEFAULT_DISPLAY}` : `:${screenId.replace('screen-', '')}`);

export const displayNumber = (screenId?: string | null) => Number(displayFor(screenId).slice(1));

export const screenIdFor = (display: number) => (display === DEFAULT_DISPLAY ? 'default' : `screen-${display}`);

/** DevTools port of the browser we run on a screen: 9200 + display number (default screen: 9299). */
export const cdpPortFor = (screenId?: string | null) => 9200 + displayNumber(screenId);

/** VNC port of a display inside the local box: 5900 + display number, as VNC servers number them. */
export const boxVncPort = (display: number) => 5900 + display;

/**
 * Port on this machine where a local-box screen's VNC server is published: 59000 + display number
 * (default screen: 59099). Not 5900 + display, which lands in 6000-6063, the ports X11 uses.
 */
export const vncPortFor = (screenId?: string | null) => 59000 + displayNumber(screenId);

/** Output of `hq-display list` ("<display> <width> <height>" per line) as screens, default first. */
export function parseDisplayList(output: string): Screen[] {
  const screens: Screen[] = [];
  for (const line of output.split('\n')) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    screens.push({ id: screenIdFor(n), display: `:${n}`, width: Number(m[2]), height: Number(m[3]), default: n === DEFAULT_DISPLAY });
  }
  return screens.sort((a, b) => Number(b.default) - Number(a.default) || a.display.localeCompare(b.display, undefined, { numeric: true }));
}
