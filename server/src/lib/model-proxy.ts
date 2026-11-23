import crypto from 'node:crypto';

/**
 * The model proxy for CLI bots that run in a container (R8). The container only holds a placeholder
 * token, one per bot; this proxy checks it and sends the request on with the user's real subscription
 * token, which never leaves the host.
 */

/** The provider paths Claude Code uses. Anything else is refused. */
export const MODEL_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/api/hello']);

/** Headers that are not passed on: the caller's credentials, cookies and hop-by-hop headers. */
const DROP_REQUEST = new Set(['authorization', 'x-api-key', 'cookie', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'proxy-authorization', 'content-length', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
/** fetch already decoded the body, so its length and encoding no longer apply. */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

/** The token a bot's container uses for the model. Shaped like a subscription token so the CLI accepts it. */
export function placeholderToken(secret: string, botId: string): string {
  return `sk-ant-oat01-hq-${crypto.createHmac('sha256', secret).update(`cli-model:${botId}`).digest('hex')}`;
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'permission_error', message } }), { status, headers: { 'content-type': 'application/json' } });

export interface ModelProxyOptions {
  botId: string;
  /** The provider path, after `/cli-model/<botId>`. */
  path: string;
  secret: string;
  /** The real subscription token; empty when none is set up. */
  token: string;
  /** The provider's base URL. */
  upstream: string;
}

/** Checks one request from a bot's container and forwards it to the provider with the real token. */
export async function forwardModelRequest(req: Request, o: ModelProxyOptions): Promise<Response> {
  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, placeholderToken(o.secret, o.botId))) return refuse(401, 'Not a token of this bot.');
  if (!MODEL_PATHS.has(o.path)) return refuse(403, 'This path is not available to bots.');
  if (!o.token) return refuse(503, 'No Claude subscription token is set up on the server. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.');

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!DROP_REQUEST.has(k.toLowerCase())) headers.set(k, v); });
  headers.set('authorization', `Bearer ${o.token}`);
  const query = new URL(req.url).search;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let res: Response;
  try {
    res = await fetch(`${o.upstream.replace(/\/+$/, '')}${o.path}${query}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Streams the request body through instead of reading it all first.
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
      signal: req.signal,
    } as RequestInit);
  } catch (e: any) {
    return refuse(502, `The model provider could not be reached (${String(e?.message ?? e).slice(0, 120)}).`);
  }
  const out = new Headers();
  res.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v); });
  return new Response(res.body, { status: res.status, headers: out });
}
