'use strict';

// Smoke tests — executed inside the Docker build (stage "test"), so a broken
// build never produces an image.
const test = require('node:test');
const assert = require('node:assert');
const { server, markReady } = require('../app/server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('liveness probe returns 200', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200);
});

test('readiness probe is 503 until warm, then 200', async () => {
  assert.strictEqual((await fetch(`${base}/readyz`)).status, 503);
  markReady();
  assert.strictEqual((await fetch(`${base}/readyz`)).status, 200);
});

test('/api/info reports pod metadata', async () => {
  const body = await (await fetch(`${base}/api/info`)).json();
  assert.ok(body.pod.name);
  assert.ok(body.app.version);
  assert.ok(body.runtime.uptimeSec >= 0);
});

test('/api/hit identifies the serving pod', async () => {
  const res = await fetch(`${base}/api/hit`);
  const body = await res.json();
  assert.strictEqual(res.headers.get('x-served-by'), body.pod);
});

test('dashboard is served', async () => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /KubePulse/);
});

test('path traversal is blocked', async () => {
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notStrictEqual(res.status, 200);
});

test('metrics are exposed in Prometheus format', async () => {
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /kubepulse_requests_total/);
});
