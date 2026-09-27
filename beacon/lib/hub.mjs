// websocket relay. connections subscribe to tags and publish opaque strings;
// the hub fans each string out to the other subscribers of its tag and, on
// request, keeps a short per-tag replay buffer in memory. it never inspects
// data and never writes anything to disk.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { TokenBucket, WindowCounter } from './limits.mjs';

const TAG = /^[0-9a-f]{32,64}$/;
const hex16 = () => randomBytes(8).toString('hex');

export const defaults = {
  password: '',
  name: 'beacon',
  tiles: false,
  bufferSize: 200,
  ttlMs: 86_400_000,
  sweepMs: 60_000,
  maxConnections: 2000,
  maxTags: 20_000,
  maxSubs: 256,
  pubRate: 30,
  pubBurst: 60,
  bytesPerMin: 8 * 1024 * 1024,   // a 1.5 mb photo or file is thirteen frames; two a minute must fit
  maxViolations: 10,
  maxData: 200_000,
  maxFrame: 256 * 1024,
  maxBuffered: 16 * 1024 * 1024,
  maxBufferBytes: 64 * 1024 * 1024,   // all replay buffers together
  maxConnsPerAddress: 64,
  helloFailLimit: 5,                   // failed hellos per address per minute...
  helloFailBlockMs: 60_000,            // ...then upgrades from it are refused this long
  helloMs: 5000,
  pingMs: 30_000,
  log: () => {},
};

// per-tag ring buffers. the Map is kept in least-recently-touched order so
// eviction beyond maxTags is O(1): delete-and-reinsert on every push.
export class Buffers {
  constructor(size, ttlMs, maxTags, maxBytes = Infinity) {
    this.size = size;
    this.ttlMs = ttlMs;
    this.maxTags = maxTags;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  push(tag, frame) {
    let b = this.map.get(tag);
    if (b) this.map.delete(tag);
    else b = [];
    b.push(frame);
    this.bytes += frame.data.length;
    if (b.length > this.size) this.bytes -= b.shift().data.length;
    this.map.set(tag, b);
    // least recently touched tags go first, by count and then by total bytes
    while (this.map.size > this.maxTags || (this.bytes > this.maxBytes && this.map.size > 1)) this.evictOldest();
  }

  evictOldest() {
    const tag = this.map.keys().next().value;
    const b = this.map.get(tag);
    for (const f of b) this.bytes -= f.data.length;
    this.map.delete(tag);
  }

  get(tag, now) {
    const b = this.map.get(tag);
    if (!b) return [];
    const cutoff = now - this.ttlMs;
    return b.filter((f) => f.ts >= cutoff);
  }

  sweep(now) {
    const cutoff = now - this.ttlMs;
    for (const [tag, b] of this.map) {
      let i = 0;
      while (i < b.length && b[i].ts < cutoff) i++;
      if (i) for (const f of b.splice(0, i)) this.bytes -= f.data.length;
      if (!b.length) this.map.delete(tag);
    }
  }

  get count() {
    return this.map.size;
  }
}

function sameSecret(a, b) {
  const h = (s) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(a), h(b));
}

export class Hub {
  constructor(opts = {}) {
    this.o = { ...defaults, ...opts };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.o.maxFrame });
    this.conns = new Set();
    this.subs = new Map(); // tag -> Set<conn>
    this.buffers = new Buffers(this.o.bufferSize, this.o.ttlMs, this.o.maxTags, this.o.maxBufferBytes);
    this.perAddress = new Map();   // address -> { conns, fails: WindowCounter, blockedUntil }
    this.timers = [
      setInterval(() => this.pingAll(), this.o.pingMs),
      setInterval(() => { const now = Date.now(); this.buffers.sweep(now); this.sweepAddresses(now); }, this.o.sweepMs),
    ];
    for (const t of this.timers) t.unref();
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  // take over upgrades on `path` from an http or https server.
  attach(server, path = '/ws') {
    server.on('upgrade', (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://x').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== path) return reject(socket, '404 Not Found');
      if (this.conns.size >= this.o.maxConnections) return reject(socket, '503 Service Unavailable');
      const a = this.address(req.socket.remoteAddress);
      if (a.blockedUntil > Date.now() || a.conns >= this.o.maxConnsPerAddress) return reject(socket, '429 Too Many Requests');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    return this;
  }

  stats() {
    return { connections: this.conns.size, tags: this.subs.size, buffers: this.buffers.count, bufferBytes: this.buffers.bytes };
  }

  address(addr) {
    const key = addr || 'unknown';
    let a = this.perAddress.get(key);
    if (!a) this.perAddress.set(key, (a = { conns: 0, fails: new WindowCounter(60_000), blockedUntil: 0 }));
    return a;
  }

  // addresses that hold no connection, no block and no recent failure are forgotten
  sweepAddresses(now) {
    for (const [key, a] of this.perAddress) {
      if (!a.conns && a.blockedUntil < now && !a.fails.add(0, now)) this.perAddress.delete(key);
    }
  }

  onConnection(ws, req) {
    const addr = req && req.socket ? req.socket.remoteAddress : 'unknown';
    const a = this.address(addr);
    a.conns += 1;
    const c = {
      ws,
      addr,
      id: hex16(),
      authed: false,
      alive: true,
      subs: new Set(),
      pubs: new TokenBucket(this.o.pubRate, this.o.pubBurst),
      bytes: new WindowCounter(60_000),
      violations: new WindowCounter(60_000),
      helloTimer: setTimeout(() => ws.close(4000, 'hello timeout'), this.o.helloMs),
    };
    this.conns.add(c);
    this.o.log(`ws open connections=${this.conns.size}`);
    c.replayed = new Map(); // tag -> when this connection last received the buffer
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(c, data, isBinary));
    ws.on('close', (code) => this.onClose(c, code));
    ws.on('error', () => {}); // 'close' follows; nothing else to do
  }

  onClose(c, code) {
    clearTimeout(c.helloTimer);
    this.conns.delete(c);
    const a = this.address(c.addr);
    a.conns = Math.max(0, a.conns - 1);
    if (!a.conns && a.blockedUntil < Date.now() && !a.fails.add(0, Date.now())) this.perAddress.delete(c.addr);
    for (const tag of c.subs) {
      this.drop(c, tag);
      this.count(tag);
    }
    this.o.log(`ws close code=${code} connections=${this.conns.size}`);
  }

  onMessage(c, data, isBinary) {
    // a socket we have told to close may still deliver frames until the peer
    // answers the close handshake, up to thirty seconds; none of them count
    if (c.ws.readyState !== 1) return;
    if (isBinary) return c.ws.close(1003, 'text frames only');
    const now = Date.now();
    if (c.bytes.add(data.length, now) > this.o.bytesPerMin) return this.fail(c, 'rate', now);
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return this.fail(c, 'bad_frame', now);
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return this.fail(c, 'bad_frame', now);
    if (!c.authed) return this.hello(c, m, now);
    switch (m.t) {
      // subscriptions and publications share one budget: a subscribe replays a
      // buffer, which can cost more than a publish
      case 'sub': return c.pubs.take(now) ? this.sub(c, m, now) : this.fail(c, 'rate', now);
      case 'unsub': return c.pubs.take(now) ? this.unsub(c, m, now) : this.fail(c, 'rate', now);
      case 'pub': return this.pub(c, m, now);
      case 'ping': return send(c, { t: 'pong', now });
      case 'hello': return; // already greeted; ignore
      default: return this.fail(c, 'bad_type', now);
    }
  }

  hello(c, m, now) {
    if (m.t !== 'hello') return closeNow(c.ws, 4000, 'hello first');
    if (m.v !== 1) {
      send(c, { t: 'error', code: 'version' });
      return closeNow(c.ws, 4002, 'unsupported version');
    }
    if (this.o.password && !(typeof m.pw === 'string' && sameSecret(m.pw, this.o.password))) {
      // a wrong password is counted per address; past the limit that address
      // is refused at the upgrade for a while, so guessing runs at one try a minute
      const a = this.address(c.addr);
      if (a.fails.add(1, now) >= this.o.helloFailLimit) a.blockedUntil = now + this.o.helloFailBlockMs;
      send(c, { t: 'error', code: 'auth' });
      return closeNow(c.ws, 4001, 'bad password');
    }
    clearTimeout(c.helloTimer);
    c.authed = true;
    send(c, {
      t: 'welcome',
      v: 1,
      id: c.id,
      name: this.o.name,
      tiles: !!this.o.tiles,
      buffer: this.o.bufferSize,
      ttl: Math.floor(this.o.ttlMs / 1000),
      now,
    });
  }

  sub(c, m, now) {
    const tags = this.tags(c, m, now);
    if (!tags) return;
    const fresh = tags.filter((t) => !c.subs.has(t));
    if (c.subs.size + fresh.length > this.o.maxSubs) return this.fail(c, 'rate', now);
    for (const tag of fresh) {
      c.subs.add(tag);
      let set = this.subs.get(tag);
      if (!set) this.subs.set(tag, (set = new Set()));
      set.add(c);
      // the buffer is replayed once a minute per tag and connection at most: a
      // client flipping sub and unsub cannot make the relay stream it endlessly
      const last = c.replayed.get(tag) || 0;
      if (now - last > 60_000) {
        c.replayed.set(tag, now);
        if (c.replayed.size > this.o.maxSubs * 2) c.replayed.delete(c.replayed.keys().next().value);
        for (const f of this.buffers.get(tag, now)) { if (!send(c, { t: 'msg', tag, ...f, replay: true }, this.o.maxBuffered)) break; }
      }
      this.count(tag);
    }
  }

  unsub(c, m, now) {
    const tags = this.tags(c, m, now);
    if (!tags) return;
    for (const tag of tags) {
      if (!c.subs.delete(tag)) continue;
      this.drop(c, tag);
      this.count(tag);
    }
  }

  pub(c, m, now) {
    const id = typeof m.id === 'string' && m.id.length <= 40 ? m.id : undefined;
    if (typeof m.tag !== 'string' || !TAG.test(m.tag)) return this.fail(c, 'bad_tag', now, id);
    if (typeof m.data !== 'string' || m.data.length > this.o.maxData) return this.fail(c, 'bad_data', now, id);
    if (m.id !== undefined && id === undefined) return this.fail(c, 'bad_id', now);
    if (!c.pubs.take(now)) return this.fail(c, 'rate', now, id);
    const frame = { data: m.data, ts: now, id: hex16() };
    const set = this.subs.get(m.tag);
    if (set && set.size > (set.has(c) ? 1 : 0)) {
      const out = JSON.stringify({ t: 'msg', tag: m.tag, ...frame });
      for (const s of set) {
        if (s === c) continue;
        deliver(s.ws, out, this.o.maxBuffered);
      }
    }
    if (m.keep === true) this.buffers.push(m.tag, frame);
    // the ack carries the client's own id when it sent one; the fan-out id stays ours
    send(c, { t: 'ack', id: m.id ?? frame.id });
  }

  // validate and dedupe m.tags; on failure report bad_tag and return null.
  tags(c, m, now) {
    const t = m.tags;
    if (!Array.isArray(t) || !t.length || t.length > this.o.maxSubs) return this.fail(c, 'bad_tag', now);
    if (!t.every((x) => typeof x === 'string' && TAG.test(x))) return this.fail(c, 'bad_tag', now);
    return [...new Set(t)];
  }

  drop(c, tag) {
    const set = this.subs.get(tag);
    if (!set) return;
    set.delete(c);
    if (!set.size) this.subs.delete(tag);
  }

  count(tag) {
    const set = this.subs.get(tag);
    if (!set) return;
    const out = JSON.stringify({ t: 'count', tag, n: set.size });
    for (const s of set) deliver(s.ws, out, this.o.maxBuffered);
  }

  // the error names the client's own frame id when it had one, so a publisher
  // learns at once that this publication was refused instead of waiting for an ack
  fail(c, code, now, id) {
    send(c, id === undefined ? { t: 'error', code } : { t: 'error', code, id });
    if (c.violations.add(1, now) >= this.o.maxViolations) closeNow(c.ws, 4008, 'too many bad frames');
    return null;
  }

  pingAll() {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      if (c.ws.readyState === 1) c.ws.ping();
    }
  }

  // close every socket and stop timers; resolves once they are gone or after graceMs.
  close(code = 1001, reason = 'beacon shutting down', graceMs = 2000) {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.conns) c.ws.close(code, reason);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        this.wss.close();
        resolve();
      };
      const poll = setInterval(() => { if (!this.conns.size) done(); }, 20);
      const timer = setTimeout(() => {
        for (const c of this.conns) c.ws.terminate();
        done();
      }, graceMs);
      if (!this.conns.size) done();
    });
  }
}

// mount a hub on an http or https server. `opts` takes any Hub option plus
// `path` (default /ws). returns { hub, stats, close }.
export function attachHub(server, { path = '/ws', ...opts } = {}) {
  const hub = new Hub(opts).attach(server, path);
  return { hub, stats: () => hub.stats(), close: (code, reason) => hub.close(code, reason) };
}

// every write goes through here: nothing is queued for a reader that never
// drains. past the buffer limit the socket is terminated instead.
function deliver(ws, str, maxBuffered) {
  if (ws.readyState !== 1) return false;
  if (ws.bufferedAmount > maxBuffered) { ws.terminate(); return false; }
  ws.send(str);
  return true;
}
function send(c, obj, maxBuffered = 16 * 1024 * 1024) {
  return deliver(c.ws, JSON.stringify(obj), maxBuffered);
}
// close for cause: the close frame is sent, and the socket is torn down shortly
// after whether or not the peer answers, so nothing more from it is read
function closeNow(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* already closing */ }
  const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000);
  if (t.unref) t.unref();
}

function reject(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
