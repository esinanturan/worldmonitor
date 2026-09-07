import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as weather from '../scripts/_weather-alert-select.mjs';
import { __testing__ as health } from '../api/health.js';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const weatherLoop = relay.slice(relay.indexOf('const WEATHER_SEED_INTERVAL_MS ='), relay.indexOf('async function startWeatherSeedLoop()'));
const envelopes = relay.slice(relay.indexOf('function buildEnvelope('), relay.indexOf('function notifySimpleHash('));
const KEY = 'weather:alerts:v1';
const META = 'seed-meta:weather:alerts';
const MINUTE = 60_000;
const START = Date.parse('2026-09-07T01:41:21Z');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function fixture(source, index, expires) {
  const id = `${source}-${index}`;
  const geometry = { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] };
  if (source === 'nws') return { id, geometry, properties: { severity: 'Severe', event: 'Flood', expires } };
  if (source === 'eccc') return { id, geometry, properties: { status_en: 'issued', risk_colour_en: 'red', alert_name_en: 'Flood', expiration_datetime: expires } };
  return { id, url: 'gb-alert', mid: '1', s: 3, u: 3, c: 3, event: 'Flood', lat: 51, lon: 0, expires };
}

function harness({ store = new Map() } = {}) {
  let now = START;
  let failed = [];
  let empty = [];
  let expires = new Date(START + 120 * MINUTE).toISOString();
  const logs = [];
  const requests = [];
  const notifications = [];
  const writes = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    weatherAlertSelectPromise: Promise.resolve(weather),
    CHROME_UA: 'H4 fixture', PROXY_URL: 'http://fixture.invalid',
    parseProxyUrl: () => ({ host: 'fixture.invalid', port: 8080 }),
    require: (name) => {
      assert.equal(name, './_proxy-utils.cjs');
      return { proxyFetch: async () => { requests.push('nws-proxy'); throw new Error('Proxy CONNECT HTTP/1.1 522 Server Error'); } };
    },
    fetch: async (url, options) => {
      const source = url.includes(weather.NWS_HOST) ? 'nws' : url.includes(weather.ECCC_HOST) ? 'eccc' : 'swic';
      requests.push(source);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      if (failed.includes(source)) throw new Error(source === 'nws' ? 'The operation was aborted due to timeout' : 'HTTP 503');
      if (url === weather.SWIC_MEMBERS_URL) return Response.json([{ members: [{ mid: '1', code: 'GBR' }] }]);
      const count = empty.includes(source) ? 0 : source === 'nws' ? 227 : source === 'eccc' ? (url.includes('continued') ? 0 : 207) : 946;
      const items = Array.from({ length: count }, (_, i) => fixture(source, i, expires));
      return Response.json(source === 'swic' ? { items } : { features: items });
    },
    upstashGet: async (key) => clone(store.get(key)),
    upstashSet: async (key, value, ttl) => { store.set(key, clone(value)); writes.push({ key, ttl }); return true; },
    nwsVtec: () => undefined,
    publishNotificationEvent: async (event) => notifications.push(clone(event)),
  };
  const seed = runInNewContext(`${envelopes}\n${weatherLoop}\nseedWeatherAlerts`, context);
  return {
    store, logs, requests, notifications, writes,
    async run({ at = now, failures = [], emptySources = [], expiry = expires } = {}) {
      now = at; failed = failures; empty = emptySources; expires = expiry;
      await seed();
      assert.ok(!logs.some((line) => line.startsWith('[Weather] Seed error:')), logs.join('\n'));
      return { payload: clone(store.get(KEY)?.data), meta: clone(store.get(META)) };
    },
    classify(at = now) {
      return health.classifyKey('weatherAlerts', KEY, { allowOnDemand: false }, {
        now: at,
        keyStrens: new Map([[KEY, store.has(KEY) ? JSON.stringify(store.get(KEY)).length : 0]]),
        keyErrors: new Map(), keyMetaErrors: new Map(),
        keyMetaValues: new Map([[META, JSON.stringify(store.get(META))]]),
      });
    },
  };
}

test('characterizes relay healthy -> NWS timeout/proxy 522 -> recovery through health', async () => {
  const h = harness();
  const good = await h.run();
  assert.equal(good.payload.alerts.length, 50);
  assert.equal(h.classify().status, 'OK');
  const failed = await h.run({ at: START + 15 * MINUTE, failures: ['nws'] });
  assert.ok(h.requests.includes('nws-proxy'));
  assert.ok(h.logs.some((line) => line.includes('522')));
  assert.equal(failed.meta.sourceState, 'degraded');
  assert.equal(failed.payload.alerts.length, 50);
  assert.ok(failed.payload.alerts.some((alert) => alert.source === 'nws'));
  assert.equal(h.classify().status, 'SEED_ERROR');
  assert.equal(health.healthStatusBucket(h.classify(), START + 15 * MINUTE), 'warn');
  const recovered = await h.run({ at: START + 30 * MINUTE });
  assert.equal(recovered.meta.sourceState, 'ok');
  assert.equal(h.classify().status, 'OK');
  assert.equal(h.writes.find(({ key }) => key === KEY).ttl, 5400);
});
