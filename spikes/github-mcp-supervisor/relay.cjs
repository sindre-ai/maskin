// Spike relay (throwaway): stable stdio pipe in front of github-mcp-server.
// Restart on SIGUSR1: mint a fresh token, kill child, respawn, replay cached initialize + initialized,
// swallow the duplicate initialize response, flush queued client messages in order.
// Never logs a token or header. Child env carries no MASKIN_* variable.
const { spawn } = require('child_process');
const fs = require('fs');

const LOG = process.env.SPIKE_RELAY_LOG || '/agent/workspace/spike/relay.log';
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${m}\n`);

const API = process.env.MASKIN_API_URL;
const KEY = process.env.MASKIN_API_KEY;
const WS = process.env.MASKIN_WORKSPACE_ID;
const IID = process.env.SPIKE_INTEGRATION_ID;
const envOk = !!(API && KEY && WS && IID);
log(`start env ${envOk ? 'ok' : 'MISSING'} MASKIN_API_URL=${!!API} MASKIN_API_KEY=${!!KEY} MASKIN_WORKSPACE_ID=${!!WS}`);

async function mint() {
  const r = await fetch(`${API}/api/integrations/${IID}/github-token`, {
    headers: { Authorization: `Bearer ${KEY}`, 'X-Workspace-Id': WS },
  });
  if (!r.ok) throw new Error(`mint status ${r.status}`);
  return (await r.json()).token;
}

let child = null;
let restarts = 0;
let restarting = false;
let initReq = null; // cached initialize request line
let initedLine = null; // cached initialized notification line
let swallowId = null;
const queue = [];

function spawnChild(token) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('MASKIN_') && !k.startsWith('SPIKE_')) env[k] = v;
  env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
  const c = spawn('github-mcp-server', ['stdio', '--toolsets=default'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i + 1); buf = buf.slice(i + 1);
      if (swallowId !== null) {
        try { if (JSON.parse(line).id === swallowId) { swallowId = null; log('swallowed duplicate initialize response'); continue; } } catch (_) {}
      }
      process.stdout.write(line);
    }
  });
  c.on('exit', (code) => {
    if (c !== child) return; // old child killed on purpose
    log(`child exited code=${code}; relay exiting`);
    process.exit(code || 1);
  });
  return c;
}

function initialToken() {
  return process.env.SPIKE_INITIAL_TOKEN || ['gh', 's_', 'INVALID'.repeat(5)].join('');
}

async function restart() {
  if (restarting) return;
  restarting = true;
  try {
    const token = await mint();
    const old = child;
    child = null;
    if (old) old.kill();
    child = spawnChild(token);
    restarts += 1;
    if (initReq) {
      swallowId = JSON.parse(initReq).id;
      child.stdin.write(initReq);
      if (initedLine) child.stdin.write(initedLine);
    }
    log(`restart #${restarts} done: new child pid=${child.pid}, init replayed=${!!initReq}`);
  } catch (e) {
    log(`restart failed: ${e.message}`);
  } finally {
    restarting = false;
    while (queue.length && !restarting) child.stdin.write(queue.shift());
  }
}

child = spawnChild(initialToken());
log(`child pid=${child.pid} started with ${process.env.SPIKE_INITIAL_TOKEN ? 'provided' : 'invalid'} token`);

let ibuf = '';
let initCount = 0;
process.stdin.on('data', (d) => {
  ibuf += d;
  let i;
  while ((i = ibuf.indexOf('\n')) >= 0) {
    const line = ibuf.slice(0, i + 1); ibuf = ibuf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch (_) { m = {}; }
    log('client msg method=' + (m.method || ('response/id=' + m.id)) + ' id=' + m.id);
    if (m.method === 'initialize') { initReq = line; log('client sent initialize (count=' + (++initCount) + ')'); }
    if (m.method === 'notifications/initialized') initedLine = line;
    if (restarting) queue.push(line); else child.stdin.write(line);
  }
});
process.stdin.on('end', () => { log('client closed stdin; killing child'); if (child) child.kill(); process.exit(0); });
process.on('SIGUSR1', () => { log('SIGUSR1: forced restart'); restart(); });
