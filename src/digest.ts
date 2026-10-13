import * as crypto from 'node:crypto';
import * as http from 'node:http';

const md5 = (text: string): string => crypto.createHash('md5').update(text).digest('hex');

/** Parse one WWW-Authenticate challenge ("Digest realm=..., nonce=..." or "Basic realm=..."). */
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } {
  const scheme = header.trim().split(/\s+/)[0].toLowerCase();
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)=("([^"]*)"|([^,\s]*))/g)) params[match[1].toLowerCase()] = match[3] ?? match[4];
  return { scheme, params };
}

/** Pick the strongest challenge out of one or more WWW-Authenticate headers. */
export function pickChallenge(headers: string[]): { scheme: string; params: Record<string, string> } | undefined {
  const parsed = headers.map(parseChallenge);
  return parsed.find((c) => c.scheme === 'digest') ?? parsed.find((c) => c.scheme === 'basic');
}

/** The Authorization header for a request, from a challenge (RFC 2617, with or without qop=auth). */
export function authorization(challenge: { scheme: string; params: Record<string, string> }, method: string, uri: string, user: string, pass: string, nc = 1): string {
  if (challenge.scheme === 'basic') return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const { realm = '', nonce = '', qop, opaque, algorithm } = challenge.params;
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  let header = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  if (qop && qop.split(',').map((q) => q.trim()).includes('auth')) {
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ncHex = nc.toString(16).padStart(8, '0');
    header += `, qop=auth, nc=${ncHex}, cnonce="${cnonce}", response="${md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`)}"`;
  } else {
    header += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  if (opaque) header += `, opaque="${opaque}"`;
  if (algorithm) header += `, algorithm=${algorithm}`;
  return header;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // A fixed length: small camera web servers often reject chunked requests
    const allHeaders = body ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } : headers;
    const req = http.request(url, { method, headers: allHeaders, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** HTTP request that answers a Basic or Digest challenge with the given credentials. */
export async function httpRequest(urlText: string, options: { method?: string; headers?: Record<string, string>; body?: string; user?: string; pass?: string; timeoutMs?: number } = {}): Promise<HttpResult> {
  const url = new URL(urlText);
  const user = options.user ?? decodeURIComponent(url.username);
  const pass = options.pass ?? decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  const timeoutMs = options.timeoutMs ?? 8000;
  const first = await request(url, method, headers, options.body, timeoutMs);
  if (first.status !== 401 || !user) return first;
  const raw = first.headers['www-authenticate'];
  const challenge = pickChallenge(Array.isArray(raw) ? raw : raw ? [raw] : []);
  if (!challenge) return first;
  headers.Authorization = authorization(challenge, method, url.pathname + url.search, user, pass);
  return request(url, method, headers, options.body, timeoutMs);
}
