// KubePulse front-end
(() => {
  const $ = (s) => document.querySelector(s);
  const COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#4b5563', '#65a30d'];
  const podColors = new Map();
  const colorFor = (name) => {
    if (!podColors.has(name)) podColors.set(name, COLORS[podColors.size % COLORS.length]);
    return podColors.get(name);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtUptime = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
  };

  // theme
  const setTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $('#themeBtn').textContent = t === 'dark' ? 'Light' : 'Dark';
  };
  try { setTheme(localStorage.getItem('kp-theme') || 'light'); } catch { setTheme('light'); }
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('kp-theme', next); } catch { /* ignore */ }
  });

  // pod info
  const latencies = [];
  function drawSpark() {
    if (latencies.length < 2) return;
    const max = Math.max(...latencies, 10);
    const step = 300 / (latencies.length - 1);
    const pts = latencies.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(48 - (v / max) * 44).toFixed(1)}`).join(' ');
    $('#spark').innerHTML = `<path class="area" d="${pts} L300 50 L0 50Z"/><path class="line" d="${pts}"/>`;
  }

  function identityCards(d) {
    const items = [
      ['Pod name', d.pod.name, 'metadata.name'],
      ['Pod IP', d.pod.ip, 'status.podIP'],
      ['Node', d.pod.node, 'spec.nodeName'],
      ['Namespace', d.pod.namespace, 'metadata.namespace'],
      ['CPU request', d.pod.cpuRequest === 'n/a' ? 'n/a' : `${d.pod.cpuRequest}m`, 'requests.cpu'],
      ['Memory limit', d.pod.memLimit === 'n/a' ? 'n/a' : `${d.pod.memLimit}Mi`, 'limits.memory'],
      ['Runtime', `Node.js ${d.runtime.node}`, d.runtime.platform],
      ['Started at', new Date(d.runtime.startedAt).toLocaleTimeString(), `PID ${d.runtime.pid}`],
    ];
    $('#identityGrid').innerHTML = items
      .map(([l, v, s]) => `<div class="id-card"><label>${l}</label><b>${v}</b><small>${s}</small></div>`)
      .join('');
  }

  let lastPod = null;
  async function refreshInfo() {
    const t0 = performance.now();
    try {
      const d = await (await fetch('/api/info', { cache: 'no-store' })).json();
      const ms = Math.round(performance.now() - t0);
      latencies.push(ms);
      if (latencies.length > 40) latencies.shift();
      drawSpark();

      $('#servedPod').textContent = d.pod.name;
      $('#heroIp').textContent = d.pod.ip;
      $('#heroNode').textContent = d.pod.node;
      $('#heroNs').textContent = d.pod.namespace;
      $('#kUptime').textContent = fmtUptime(d.runtime.uptimeSec);
      $('#kReq').textContent = d.stats.requests;
      $('#kMem').textContent = `${d.runtime.rssMB} MB`;
      $('#kVer').textContent = d.app.version;
      $('#footVer').textContent = d.app.version;
      $('#latency').textContent = `${ms} ms`;
      $('#envPill').textContent = `env: ${d.app.environment}`;
      $('#footMeta').textContent = `served by ${d.pod.name}`;
      $('#readyBadge').textContent = d.ready ? 'READY' : 'STARTING';
      $('#readyBadge').className = `badge ${d.ready ? 'ok' : 'bad'}`;
      if (!d.app.chaosEnabled) {
        $('#chaosBtn').disabled = true;
        $('#chaosNote').textContent = 'Disabled (ENABLE_CHAOS=false in the ConfigMap).';
      }
      if (d.pod.name !== lastPod) { identityCards(d); lastPod = d.pod.name; }
    } catch {
      $('#readyBadge').textContent = 'OFFLINE';
      $('#readyBadge').className = 'badge bad';
    }
  }
  refreshInfo();
  setInterval(refreshInfo, 2000);

  // load balancing test
  const counts = new Map();
  let total = 0, errors = 0, running = false;

  function renderPods() {
    const wrap = $('#podCards');
    if (!counts.size) {
      wrap.innerHTML = '<div class="empty">No data yet. Click "Send requests".</div>';
      return;
    }
    const max = Math.max(...[...counts.values()].map((c) => c.n));
    wrap.innerHTML = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, c]) => `<div class="pod-card" style="--c:${colorFor(name)}">
          <div class="name">${name}</div>
          <div class="count">${c.n}</div>
          <div class="bar"><i style="width:${(c.n / max) * 100}%"></i></div>
          <div class="meta"><span>${((c.n / total) * 100).toFixed(1)}%</span><span>${c.ip}</span></div>
        </div>`)
      .join('');
    const vals = [...counts.values()].map((c) => c.n);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    $('#distinct').textContent = counts.size;
    $('#total').textContent = total;
    $('#errors').textContent = errors;
    $('#spread').textContent = vals.length > 1 ? `${((sd / mean) * 100).toFixed(0)}%` : '-';
  }

  async function hit() {
    const res = await fetch(`/api/hit?r=${Math.random()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  $('#fireBtn').addEventListener('click', async () => {
    if (running) return;
    running = true;
    $('#fireBtn').disabled = true;
    const n = Number($('#burstSel').value);
    let done = 0, left = n;
    const worker = async () => {
      while (left > 0) {
        left--;
        try {
          const d = await hit();
          const c = counts.get(d.pod) || { n: 0, ip: d.ip };
          c.n++;
          counts.set(d.pod, c);
          total++;
        } catch {
          errors++;
        }
        done++;
        $('#lbBar').style.width = `${(done / n) * 100}%`;
        $('#lbStatus').textContent = `${done}/${n}`;
        renderPods();
        await sleep(20);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    $('#lbStatus').textContent = `done (${counts.size} pods)`;
    $('#fireBtn').disabled = false;
    running = false;
  });

  $('#resetBtn').addEventListener('click', () => {
    counts.clear(); total = 0; errors = 0;
    $('#lbBar').style.width = '0';
    $('#lbStatus').textContent = 'idle';
    ['#distinct', '#total', '#errors'].forEach((s) => ($(s).textContent = '0'));
    $('#spread').textContent = '-';
    renderPods();
  });

  // self-healing test
  const row = $('#uptimeRow');
  const CELLS = 60;
  row.innerHTML = '<i></i>'.repeat(CELLS);
  let cellIdx = 0;
  const pushCell = (cls) => {
    if (cellIdx >= CELLS) {
      row.appendChild(row.firstElementChild);
      row.lastElementChild.className = cls;
    } else {
      row.children[cellIdx++].className = cls;
    }
  };
  const tl = $('#timeline');
  const logEvent = (tag, cls, text) => {
    if (tl.querySelector('.muted')) tl.innerHTML = '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date().toLocaleTimeString()}</td><td><span class="tag ${cls}">${tag}</span></td><td>${text}</td>`;
    tl.prepend(tr);
  };

  $('#chaosBtn').addEventListener('click', async () => {
    const btn = $('#chaosBtn');
    btn.disabled = true;
    let victim;
    try {
      const res = await fetch('/api/chaos', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
      victim = d.pod;
      logEvent('CRASH', 'bad', `${victim} exited with code 1`);
      toast(`${victim} crashed`);
    } catch (e) {
      logEvent('ERROR', 'bad', `request failed: ${e.message}`);
      btn.disabled = false;
      return;
    }

    let otherSeen = false, back = false, fails = 0;
    const until = Date.now() + 45000;
    while (Date.now() < until && !back) {
      try {
        const d = await hit();
        if (d.pod === victim) {
          back = true;
          pushCell('ok');
          logEvent('RECOVERED', 'ok', `${victim} restarted and is ready again`);
        } else {
          pushCell('alt');
          if (!otherSeen) {
            otherSeen = true;
            logEvent('FAILOVER', 'info', `traffic served by ${d.pod}`);
          }
        }
      } catch {
        fails++;
        pushCell('bad');
      }
      await sleep(450);
    }
    if (!back) logEvent('INFO', 'info', 'crashed pod not reached yet, check RESTARTS with kubectl');
    logEvent('RESULT', fails ? 'bad' : 'ok', `${fails} failed request(s) during the test`);
    btn.disabled = false;
  });

  setInterval(async () => {
    try { await hit(); pushCell('ok'); } catch { pushCell('bad'); }
  }, 3000);

  // commands
  const CMDS = [
    ['Build image', 'docker build -t kubepulse:1.0 .'],
    ['Run container', 'docker run -d -p 8080:8080 --name kubepulse kubepulse:1.0'],
    ['Start minikube', 'minikube start --driver=docker'],
    ['Load image into minikube', 'minikube image load kubepulse:1.0'],
    ['Apply manifests', 'kubectl apply -f k8s/'],
    ['Check pods', 'kubectl get pods -n kubepulse -o wide'],
    ['Open service', 'minikube service kubepulse-service -n kubepulse'],
    ['Scale', 'kubectl scale deployment/kubepulse --replicas=5 -n kubepulse'],
    ['Logs', 'kubectl logs -l app=kubepulse -n kubepulse --tail=20'],
  ];
  $('#cmds').innerHTML = CMDS.map(([d, c]) =>
    `<div class="cmd"><div><small>${d}</small><code>${c}</code></div><button data-c="${c}">Copy</button></div>`).join('');
  $('#cmds').addEventListener('click', async (e) => {
    const c = e.target.dataset && e.target.dataset.c;
    if (!c) return;
    try { await navigator.clipboard.writeText(c); toast('Copied'); } catch { toast(c); }
  });
})();
