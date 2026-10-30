'use strict';

// KubePulse - a tiny, dependency-free cloud-native web service.
// Serves the dashboard UI and exposes pod metadata, health probes and metrics
// so that Kubernetes behaviour (load balancing, self-healing, rolling updates)
// can be observed live from the browser.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const config = {
  appName: process.env.APP_NAME || 'KubePulse',
  version: process.env.APP_VERSION || '1.0.0',
  environment: process.env.APP_ENV || 'local',
  accent: process.env.APP_ACCENT || '#7c5cff',
  chaosEnabled: (process.env.ENABLE_CHAOS || 'true') === 'true',
};

// Downward API values (injected by the Deployment); fall back to container data.
const pod = {
  name: process.env.POD_NAME || os.hostname(),
  ip: process.env.POD_IP || firstIPv4(),
  node: process.env.NODE_NAME || 'docker-host',
  namespace: process.env.POD_NAMESPACE || 'none',
  cpuRequest: process.env.CPU_REQUEST || 'n/a',
  memLimit: process.env.MEM_LIMIT || 'n/a',
};

const startedAt = Date.now();
const stats = { requests: 0, hits: 0, byPath: {} };
let ready = false;
let shuttingDown = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function firstIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function log(level, msg, extra = {}) {
  // Structured JSON logs - easy to read with `kubectl logs` and to ship to a log stack.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, pod: pod.name, msg, ...extra }));
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'X-Served-By': pod.name,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function info() {
  const mem = process.memoryUsage();
  return {
    app: config,
    pod,
    runtime: {
      node: process.version,
      platform: `${os.platform()}/${os.arch()}`,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      rssMB: +(mem.rss / 1048576).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      loadAvg: os.loadavg().map((n) => +n.toFixed(2)),
    },
    stats: { requests: stats.requests, hits: stats.hits },
    ready,
  };
}

function metrics() {
  const mem = process.memoryUsage();
  const lines = [
    '# HELP kubepulse_requests_total Total HTTP requests handled by this pod.',
    '# TYPE kubepulse_requests_total counter',
    `kubepulse_requests_total{pod="${pod.name}"} ${stats.requests}`,
    '# HELP kubepulse_uptime_seconds Seconds since the process started.',
    '# TYPE kubepulse_uptime_seconds gauge',
    `kubepulse_uptime_seconds{pod="${pod.name}"} ${Math.round((Date.now() - startedAt) / 1000)}`,
    '# HELP kubepulse_memory_rss_bytes Resident memory of the process.',
    '# TYPE kubepulse_memory_rss_bytes gauge',
    `kubepulse_memory_rss_bytes{pod="${pod.name}"} ${mem.rss}`,
  ];
  for (const [p, n] of Object.entries(stats.byPath)) {
    lines.push(`kubepulse_path_requests_total{pod="${pod.name}",path="${p}"} ${n}`);
  }
  return lines.join('\n') + '\n';
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found', path: urlPath });
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Served-By': pod.name,
    });
    res.end(data);
  });
}

function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  stats.requests++;
  stats.byPath[pathname] = (stats.byPath[pathname] || 0) + 1;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  switch (pathname) {
    // Liveness: the process is alive and the event loop responds.
    case '/healthz':
      return sendJSON(res, 200, { status: 'ok', pod: pod.name });

    // Readiness: only receive Service traffic once warmed up and not draining.
    case '/readyz':
      return ready && !shuttingDown
        ? sendJSON(res, 200, { status: 'ready', pod: pod.name })
        : sendJSON(res, 503, { status: 'not-ready', pod: pod.name });

    case '/api/info':
      return sendJSON(res, 200, info());

    // Lightweight endpoint for the load-balancing visualiser. `Connection: close`
    // forces a new TCP connection per request so kube-proxy re-balances each hit.
    case '/api/hit':
      stats.hits++;
      return sendJSON(res, 200, { pod: pod.name, ip: pod.ip, node: pod.node, hits: stats.hits, t: Date.now() }, { Connection: 'close' });

    case '/metrics':
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return res.end(metrics());

    // Chaos button: crash this pod on purpose to demonstrate self-healing.
    case '/api/chaos':
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'use POST' });
      if (!config.chaosEnabled) return sendJSON(res, 403, { error: 'chaos disabled by ConfigMap' });
      log('warn', 'chaos requested - terminating process so Kubernetes restarts the container');
      sendJSON(res, 202, { pod: pod.name, message: 'Pod is crashing; Kubernetes will restart it.' }, { Connection: 'close' });
      return setTimeout(() => process.exit(1), 300);

    default:
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, pathname);
  }
}

const server = http.createServer(handler);
server.keepAliveTimeout = 5000;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `received ${signal}, draining connections`);
  // Readiness now fails, so the endpoint is removed before we stop accepting.
  setTimeout(() => server.close(() => { log('info', 'shutdown complete'); process.exit(0); }), 2000).unref();
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  server.listen(PORT, () => {
    log('info', `${config.appName} v${config.version} listening`, { port: PORT, node: pod.node, ip: pod.ip });
    // Simulated warm-up so the readiness probe has something meaningful to wait for.
    setTimeout(() => { ready = true; log('info', 'pod is ready to receive traffic'); }, 1500);
  });
}

module.exports = { server, markReady: () => { ready = true; } };
