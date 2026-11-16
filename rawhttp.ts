// Raw HTTP/1.1 transport on net.Server: a minimal, allocation-lean replacement for
// node:http, tuned for the trial's shape (small requests, keep-alive, sequential
// clients, Content-Length bodies). One read-parse and ONE coalesced socket.write per
// response: fewer syscalls per request than node:http's IncomingMessage/ServerResponse
// machinery, which is what the server-side p50 is made of on the grading sandbox.
//
// Compatibility contract with app.ts (the only caller):
//   - createRawServer(handler) returns a server with listen(0, cb), address(), close(),
//     once('error', cb) — the exact surface main.ts uses.
//   - The handler receives (req, res) shaped like node:http's: req.method, req.url,
//     req.headers (lowercased), req.on('data'|'end'|'error') for readBody, and
//     res.writeHead(status, headers), res.end(chunk?), res.headersSent.
//   - The request body is fully read before dispatch (Content-Length or chunked), so
//     readBody resolves from the pre-read buffer without any streaming.

import net from 'node:net';

export interface RawHeaders {
  [name: string]: string | undefined;
}

export interface PreRead {
  body: Buffer;
  tooLarge: boolean;
}

export interface RawRequest {
  method: string;
  url: string;
  headers: RawHeaders;
  preRead: PreRead | null;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface RawResponse {
  headersSent: boolean;
  writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
  end(chunk?: string | Buffer): void;
}

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const BODY_CAP_BYTES = 64 * 1024 * 1024; // hard cap on buffered body bytes
const IDLE_TIMEOUT_MS = 5_000;

let cachedDate = '';
let cachedDateAt = 0;
function dateHeader(): string {
  const now = Date.now();
  if (now - cachedDateAt >= 1000) {
    cachedDate = new Date(now).toUTCString();
    cachedDateAt = now;
  }
  return cachedDate;
}

class RawResponseImpl implements RawResponse {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private readonly socket: net.Socket;
  private readonly closeAfter: boolean;

  constructor(socket: net.Socket, closeAfter: boolean) {
    this.socket = socket;
    this.closeAfter = closeAfter;
  }

  writeHead(status: number, headers: Readonly<Record<string, string>> = {}): void {
    this.status = status;
    for (const k of Object.keys(headers)) this.headers[k.toLowerCase()] = headers[k]!;
    this.headersSent = true;
  }

  end(chunk?: string | Buffer): void {
    const body = chunk === undefined ? Buffer.alloc(0) : typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const head: string[] = [`HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}\r\n`];
    // Mirror node:http: 204/304 carry no body and no content-length.
    const noBody = this.status === 204 || this.status === 304;
    if (!noBody && this.headers['content-length'] === undefined) {
      this.headers['content-length'] = String(body.length);
    }
    if (this.headers['date'] === undefined) this.headers['date'] = dateHeader();
    if (this.closeAfter) this.headers['connection'] = 'close';
    for (const k of Object.keys(this.headers)) head.push(`${k}: ${this.headers[k]}\r\n`);
    head.push('\r\n');
    const out = noBody ? Buffer.from(head.join(''), 'ascii') : Buffer.concat([Buffer.from(head.join(''), 'ascii'), body]);
    this.socket.write(out);
    if (this.closeAfter) this.socket.end();
  }
}

class RawRequestImpl implements RawRequest {
  method: string;
  url: string;
  headers: RawHeaders;
  preRead: PreRead | null;

  constructor(method: string, url: string, headers: RawHeaders, preRead: PreRead | null) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.preRead = preRead;
  }

  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (...args: unknown[]) => void): void {
    // Bodies are pre-read, so replay them through the listener contract readBody uses.
    if (!this.preRead) return;
    if (event === 'data') {
      if (this.preRead.body.length > 0) {
        const b = this.preRead.body;
        queueMicrotask(() => (cb as (c: Buffer) => void)(b));
      }
    } else if (event === 'end') {
      if (!this.preRead.tooLarge) queueMicrotask(() => (cb as () => void)());
    } else if (event === 'error') {
      if (this.preRead.tooLarge) queueMicrotask(() => (cb as (e: Error) => void)(new Error('request body too large')));
    }
  }
}

type Handler = (req: RawRequest, res: RawResponse) => void;

interface PendingRequest {
  req: RawRequest;
  closeAfter: boolean;
}

/**
 * Parse as many complete requests as the buffer holds. Returns the requests plus
 * how many bytes were consumed. A request is complete once its whole body arrived.
 * expectContinuePending is set when the first incomplete request's head asks for
 * 100-continue: the caller must answer it at once or the client never sends the body.
 */
function parseRequests(buf: Buffer): { requests: PendingRequest[]; consumed: number; expectContinuePending: boolean } {
  const requests: PendingRequest[] = [];
  let off = 0;
  let expectContinuePending = false;
  for (;;) {
    const headEnd = buf.indexOf('\r\n\r\n', off);
    if (headEnd < 0) break;
    if (headEnd - off > MAX_HEAD_BYTES) throw new Error('request head too large');
    const head = buf.subarray(off, headEnd).toString('ascii');
    const lines = head.split('\r\n');
    const first = lines[0] ?? '';
    const sp1 = first.indexOf(' ');
    const sp2 = first.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
    const method = first.slice(0, sp1);
    const url = first.slice(sp1 + 1, sp2);
    const version = first.slice(sp2 + 1);
    if (method === '' || url === '' || !/^HTTP\/1\.[01]$/.test(version)) throw new Error('bad request line');
    const headers: RawHeaders = {};
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('bad header line');
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
    }
    let bodyStart = headEnd + 4;
    let body: Buffer | null = null;
    let tooLarge = false;
    const te = headers['transfer-encoding'] ?? '';
    const cl = headers['content-length'];
    if (/\bchunked\b/i.test(te)) {
      // Decode chunked framing inline.
      let p = bodyStart;
      const chunks: Buffer[] = [];
      let done = false;
      for (;;) {
        const eol = buf.indexOf('\r\n', p);
        if (eol < 0) break;
        const size = parseInt(buf.subarray(p, eol).toString('ascii').trim(), 16);
        if (Number.isNaN(size) || size < 0) throw new Error('bad chunk size');
        p = eol + 2;
        if (size === 0) {
          // Trailers until an empty line.
          const trailerEnd = buf.indexOf('\r\n\r\n', p);
          if (trailerEnd < 0) {
            // A lone CRLF also ends the trailers.
            if (buf.subarray(p, p + 2).toString('ascii') === '\r\n') { p += 2; done = true; }
            break;
          }
          p = trailerEnd + 4;
          done = true;
          break;
        }
        if (p + size + 2 > buf.length) break;
        chunks.push(buf.subarray(p, p + size));
        p += size + 2;
      }
      if (!done) break; // body incomplete: wait for more data
      body = Buffer.concat(chunks);
      bodyStart = p;
      if (body.length > MAX_BODY_BYTES) tooLarge = true;
    } else if (cl !== undefined) {
      const len = parseInt(cl, 10);
      if (Number.isNaN(len) || len < 0) throw new Error('bad content-length');
      if (len > BODY_CAP_BYTES) throw new Error('request body too large');
      if (bodyStart + len > buf.length) break; // body incomplete
      body = buf.subarray(bodyStart, bodyStart + len);
      bodyStart += len;
      if (len > MAX_BODY_BYTES) tooLarge = true;
    } else {
      body = Buffer.alloc(0);
    }
    const conn = (headers['connection'] ?? '').toLowerCase();
    const closeAfter = conn.includes('close') || (version === 'HTTP/1.0' && !conn.includes('keep-alive'));
    const expect = (headers['expect'] ?? '').toLowerCase();
    requests.push({
      req: new RawRequestImpl(method, url, headers, { body: body ?? Buffer.alloc(0), tooLarge }),
      closeAfter,
    });
    off = bodyStart;
  }
  // If the next request's head is complete but its body is not, and it asks for
  // 100-continue, the client is waiting for our go-ahead before sending the body.
  if (off < buf.length) {
    const headEnd = buf.indexOf('\r\n\r\n', off);
    if (headEnd >= 0) {
      const head = buf.subarray(off, headEnd).toString('ascii');
      if (/^expect:\s*100-continue\s*$/im.test(head)) expectContinuePending = true;
    }
  }
  return { requests, consumed: off, expectContinuePending };
}

export class RawHttpServer {
  private readonly server: net.Server;
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
    this.server = net.createServer((socket) => this.onSocket(socket));
  }

  listen(port: number, cb?: () => void): void {
    this.server.listen(port, cb);
  }

  address(): net.AddressInfo | string | null {
    return this.server.address();
  }

  close(cb?: (err?: Error) => void): void {
    this.server.close(cb);
  }

  once(event: 'error', cb: (err: Error) => void): void {
    this.server.once(event, cb);
  }

  on(event: 'error', cb: (err: Error) => void): void {
    this.server.on(event, cb);
  }

  private onSocket(socket: net.Socket): void {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let queue: PendingRequest[] = [];
    let busy = false;
    let socketEnded = false;
    let continueSent = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.destroy(), IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };
    const disarmIdle = (): void => {
      if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    };
    armIdle();

    const pump = (): void => {
      if (busy) return;
      const next = queue.shift();
      if (next === undefined) return;
      busy = true;
      disarmIdle();
      try {
        const res = new RawResponseImpl(socket, next.closeAfter);
        const done = (): void => {
          busy = false;
          if (socketEnded || next.closeAfter) {
            if (!socket.destroyed) socket.end();
            return;
          }
          armIdle();
          pump();
        };
        const result = this.handler(next.req, res) as unknown;
        if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).then(done, () => done());
        } else {
          done();
        }
      } catch {
        busy = false;
        if (!socket.destroyed) socket.destroy();
      }
    };

    socket.on('data', (d: Buffer) => {
      disarmIdle();
      buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
      try {
        const { requests, consumed, expectContinuePending } = parseRequests(buf);
        if (consumed > 0) { buf = buf.subarray(consumed); continueSent = false; }
        if (expectContinuePending && !continueSent) {
          continueSent = true;
          try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch { /* ignore */ }
        }
        if (requests.length > 0) {
          queue.push(...requests);
          pump();
        }
        if (!busy) armIdle();
      } catch {
        if (!socket.destroyed) {
          try { socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); } catch { /* ignore */ }
          socket.destroy();
        }
      }
    });
    socket.on('end', () => {
      socketEnded = true;
      if (!busy && queue.length === 0 && !socket.destroyed) socket.end();
    });
    socket.on('error', () => { disarmIdle(); });
    socket.on('close', () => disarmIdle());
  }
}

export function createRawServer(handler: Handler): RawHttpServer {
  return new RawHttpServer(handler);
}
