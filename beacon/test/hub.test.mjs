import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachHub, Buffers } from '../lib/hub.mjs';

const TAG_A = 'a'.repeat(32);
const TAG_B = 'b'.repeat(40);

// one plain http server per hub configuration; no certificates involved.
async function startHub(opts = {}) {
  const server = createServer((req, res) => { res.statusCode = 404; res.end(); });
  const mounted = attachHub(server, { helloMs: 500, ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  return {
    url,
    hub: mounted.hub,
    async stop() {
      await mounted.close();
      server.close();
    },
  };
}

// small client wrapper with a queue so tests can await messages in order.
function client(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closed = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on('error', () => {});
  const c = {
    ws,
    open: () => (ws.readyState === WebSocket.OPEN ? Promise.resolve() : once(ws, 'open')),
    send: (o) => ws.send(JSON.stringify(o)),
    next(ms = 1500) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
        waiters.push((m) => { clearTimeout(t); resolve(m); });
      });
    },
    async nextMatching(pred, ms) {
      for (;;) {
        const m = await c.next(ms);
        if (pred(m)) return m;
      }
    },
    async settle(ms = 150) {
      await new Promise((r) => setTimeout(r, ms));
      return queue.splice(0);
    },
    closedInfo: () => closed,
    waitClose: (ms = 1500) =>
      closed ? Promise.resolve(closed) : Promise.race([
        once(ws, 'close').then(([code, reason]) => ({ code, reason: reason.toString() })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('no close')), ms)),
      ]),
    close: () => ws.close(),
  };
  return c;
}

async function join(url, pw, tags) {
  const c = client(url);
  await c.open();
  c.send({ t: 'hello', v: 1, ...(pw !== undefined && { pw }) });
  const w = await c.next();
  assert.equal(w.t, 'welcome');
  if (tags) {
    c.send({ t: 'sub', tags });
    // drain the initial count frames so tests start clean
    for (const tag of tags) await c.nextMatching((m) => m.t === 'count' && m.tag === tag);
  }
  return c;
}

let open; // default hub, no password
before(async () => { open = await startHub({ name: 'room 12', tiles: true }); });
after(async () => { await open.stop(); });

test('hello: welcome shape', async () => {
  const c = client(open.url);
  await c.open();
  c.send({ t: 'hello', v: 1 });
  const w = await c.next();
  assert.equal(w.t, 'welcome');
  assert.equal(w.v, 1);
  assert.match(w.id, /^[0-9a-f]{16}$/);
  assert.equal(w.name, 'room 12');
  assert.equal(w.tiles, true);
  assert.equal(w.buffer, 200);
  assert.equal(w.ttl, 86400);
  assert.ok(Math.abs(w.now - Date.now()) < 5000);
  c.close();
});

test('hello: not sent in time closes 4000', async () => {
  const h = await startHub({ helloMs: 100 });
  try {
    const c = client(h.url);
    await c.open();
    const cl = await c.waitClose();
    assert.equal(cl.code, 4000);
  } finally {
    await h.stop();
  }
});

test('hello: another frame first closes 4000', async () => {
  const c = client(open.url);
  await c.open();
  c.send({ t: 'sub', tags: [TAG_A] });
  assert.equal((await c.waitClose()).code, 4000);
});

test('hello: wrong version closes 4002', async () => {
  const c = client(open.url);
  await c.open();
  c.send({ t: 'hello', v: 2 });
  assert.deepEqual(await c.next(), { t: 'error', code: 'version' });
  assert.equal((await c.waitClose()).code, 4002);
});

test('auth: wrong or missing password -> error auth + 4001; right one -> welcome', async () => {
  const h = await startHub({ password: 'hunter2' });
  try {
    for (const pw of ['nope', undefined, 42]) {
      const c = client(h.url);
      await c.open();
      c.send({ t: 'hello', v: 1, pw });
      assert.deepEqual(await c.next(), { t: 'error', code: 'auth' });
      assert.equal((await c.waitClose()).code, 4001);
    }
    const ok = await join(h.url, 'hunter2');
    ok.close();
  } finally {
    await h.stop();
  }
});

test('sub/pub: fan-out to other subscribers only, ack to publisher, counts', async () => {
  const a = await join(open.url, undefined, [TAG_A]);
  const b = client(open.url);
  await b.open();
  b.send({ t: 'hello', v: 1 });
  await b.next();
  b.send({ t: 'sub', tags: [TAG_A] });
  assert.deepEqual(await b.next(), { t: 'count', tag: TAG_A, n: 2 });
  assert.deepEqual(await a.next(), { t: 'count', tag: TAG_A, n: 2 });
  const c = await join(open.url, undefined, [TAG_A]);
  assert.equal((await a.next()).n, 3);
  assert.equal((await b.next()).n, 3);

  a.send({ t: 'pub', tag: TAG_A, data: 'opaque-1', id: 'client-7' });
  const ack = await a.next();
  assert.deepEqual(ack, { t: 'ack', id: 'client-7' });
  const mb = await b.next();
  const mc = await c.next();
  assert.equal(mb.t, 'msg');
  assert.equal(mb.tag, TAG_A);
  assert.equal(mb.data, 'opaque-1');
  assert.match(mb.id, /^[0-9a-f]{16}$/);
  assert.equal(typeof mb.ts, 'number');
  assert.equal(mb.replay, undefined);
  assert.deepEqual(mc, mb);
  assert.deepEqual(await a.settle(), [], 'publisher must not receive its own frame');

  // without a client id the ack carries the server-generated one
  b.send({ t: 'pub', tag: TAG_A, data: 'opaque-2' });
  const ack2 = await b.next();
  const ma = await a.next();
  await c.next();
  assert.equal(ack2.t, 'ack');
  assert.equal(ack2.id, ma.id);

  // a publisher need not be subscribed; a tag nobody listens to still acks
  a.send({ t: 'pub', tag: TAG_B, data: 'x' });
  assert.equal((await a.next()).t, 'ack');

  // unsub and disconnect both notify the remaining subscribers
  c.send({ t: 'unsub', tags: [TAG_A] });
  assert.deepEqual(await a.next(), { t: 'count', tag: TAG_A, n: 2 });
  assert.deepEqual(await b.next(), { t: 'count', tag: TAG_A, n: 2 });
  assert.deepEqual(await c.settle(), []);
  b.close();
  assert.deepEqual(await a.next(), { t: 'count', tag: TAG_A, n: 1 });
  a.close();
  c.close();
});

test('keep: replayed in order to late subscribers, keep=false is not', async () => {
  const tag = 'c'.repeat(64);
  const p = await join(open.url);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    p.send({ t: 'pub', tag, data: `k${i}`, keep: true });
    ids.push((await p.next()).id);
  }
  p.send({ t: 'pub', tag, data: 'transient', keep: false });
  await p.next();
  p.send({ t: 'pub', tag, data: 'no-keep-field' });
  await p.next();

  const late = await join(open.url);
  late.send({ t: 'sub', tags: [tag] });
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await late.next());
  assert.deepEqual(got.map((m) => m.data), ['k0', 'k1', 'k2', 'k3', 'k4']);
  assert.deepEqual(got.map((m) => m.id), ids);
  assert.ok(got.every((m) => m.t === 'msg' && m.tag === tag && m.replay === true));
  assert.ok(got.every((m, i) => i === 0 || m.ts >= got[i - 1].ts));
  assert.deepEqual(await late.next(), { t: 'count', tag, n: 1 });
  assert.deepEqual(await late.settle(), []);
  p.close();
  late.close();
});

test('buffers: ring size, ttl sweep, idle eviction', () => {
  const b = new Buffers(3, 1000, 2);
  for (let i = 0; i < 5; i++) b.push('t1', { data: String(i), ts: 100 + i, id: 'x' });
  assert.deepEqual(b.get('t1', 500).map((f) => f.data), ['2', '3', '4']);
  b.push('t2', { data: 'a', ts: 200, id: 'y' });
  b.push('t1', { data: '5', ts: 300, id: 'z' }); // touches t1, so t2 is now the idle one
  b.push('t3', { data: 'b', ts: 400, id: 'w' });
  assert.equal(b.count, 2);
  assert.deepEqual(b.get('t2', 500), []);
  assert.equal(b.get('t1', 500).length, 3);
  b.sweep(1250); // ttl 1000: frames with ts < 250 go
  assert.deepEqual(b.get('t1', 1250).map((f) => f.data), ['5']);
  b.sweep(2000);
  assert.equal(b.count, 0);
});

test('tags: validation and the 64-subscription cap', async () => {
  const c = await join(open.url);
  const bad = [['ABCDEF0123456789ABCDEF0123456789'], ['abc'], ['g'.repeat(32)], ['a'.repeat(65)], [], 'nope', [123]];
  for (const tags of bad) {
    c.send({ t: 'sub', tags });
    assert.deepEqual(await c.next(), { t: 'error', code: 'bad_tag' }, JSON.stringify(tags));
  }
  c.close();

  // a fresh connection: every violation counts toward the 10/min close
  const e = await join(open.url);
  e.send({ t: 'pub', tag: 'ZZ', data: 'x' });
  assert.deepEqual(await e.next(), { t: 'error', code: 'bad_tag' });
  e.send({ t: 'pub', tag: TAG_A, data: 5 });
  assert.deepEqual(await e.next(), { t: 'error', code: 'bad_data' });
  e.send({ t: 'pub', tag: TAG_A, data: 'x'.repeat(200_001) });
  assert.deepEqual(await e.next(), { t: 'error', code: 'bad_data' });
  e.send({ t: 'pub', tag: TAG_A, data: 'x', id: 'y'.repeat(41) });
  assert.deepEqual(await e.next(), { t: 'error', code: 'bad_id' });
  e.close();

  const d = await join(open.url);
  const many = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(32, '0'));
  d.send({ t: 'sub', tags: many });
  for (let i = 0; i < 64; i++) assert.equal((await d.next()).t, 'count');
  d.send({ t: 'sub', tags: ['f'.repeat(32)] });
  assert.deepEqual(await d.next(), { t: 'error', code: 'rate' });
  d.close();
});

test('frames: bad json, unknown type, ping/pong, binary closes 1003', async () => {
  const c = await join(open.url);
  c.ws.send('{not json');
  assert.deepEqual(await c.next(), { t: 'error', code: 'bad_frame' });
  c.send({ t: 'wat' });
  assert.deepEqual(await c.next(), { t: 'error', code: 'bad_type' });
  c.send({ t: 'ping' });
  const pong = await c.next();
  assert.equal(pong.t, 'pong');
  assert.equal(typeof pong.now, 'number');
  c.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await c.waitClose()).code, 1003);
});

test('rate: bucket exhausted -> error rate, ten violations -> 4008', async () => {
  const h = await startHub({ pubRate: 0, pubBurst: 5 });
  try {
    const c = await join(h.url);
    for (let i = 0; i < 15; i++) c.send({ t: 'pub', tag: TAG_A, data: 'd' });
    const seen = { ack: 0, error: 0 };
    for (let i = 0; i < 15; i++) {
      const m = await c.next();
      seen[m.t]++;
      if (m.t === 'error') assert.equal(m.code, 'rate');
    }
    assert.deepEqual(seen, { ack: 5, error: 10 });
    assert.equal((await c.waitClose()).code, 4008);
  } finally {
    await h.stop();
  }
});

test('limits: connection cap refuses the upgrade', async () => {
  const h = await startHub({ maxConnections: 1 });
  try {
    const a = await join(h.url);
    const b = client(h.url);
    const err = await new Promise((resolve) => b.ws.once('error', resolve));
    assert.match(err.message, /503/);
    a.close();
  } finally {
    await h.stop();
  }
});

test('shutdown: close() sends 1001 to every socket', async () => {
  const h = await startHub();
  const a = await join(h.url);
  const b = await join(h.url);
  await h.stop();
  assert.equal((await a.waitClose()).code, 1001);
  assert.equal((await b.waitClose()).code, 1001);
});
