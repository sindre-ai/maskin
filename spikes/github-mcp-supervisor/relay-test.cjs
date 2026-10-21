// Scripted client through the relay: init once, 401 call, forced restart, call again, count init responses.
const { spawn } = require('child_process');
process.env.SPIKE_RELAY_LOG = '/agent/workspace/spike/relay-init.log';
require('fs').rmSync(process.env.SPIKE_RELAY_LOG, { force: true });
const r = spawn('node', ['/agent/workspace/spike/relay.cjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', initResponses = 0; const waiters = new Map();
r.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); if (m.id === 1) initResponses++; if (waiters.has(m.id) && m.id !== 1) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
let n = 1; const send = (o) => r.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const call = () => new Promise((res) => { const id = ++n; waiters.set(id, res); send({ id, method: 'tools/call', params: { name: 'list_branches', arguments: { owner: 'vaerksted-ai', repo: 'skjald', perPage: 1 } } }); });
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const txt = (m) => (m.result.content || []).map((c) => c.text).join('').slice(0, 110);
(async () => {
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  await sleep(1000);
  let m = await call(); console.log('before restart: isError=%s %s', m.result.isError, txt(m));
  r.kill('SIGUSR1'); await sleep(3000);
  m = await call(); console.log('after restart: isError=%s %s', m.result.isError, txt(m));
  await sleep(300);
  console.log('initialize responses seen by client:', initResponses);
  r.stdin.end(); await sleep(500);
  console.log(require('fs').readFileSync(process.env.SPIKE_RELAY_LOG, 'utf8').split('\n').filter((l) => /initialize|restart|swallow|exited/.test(l)).map((l) => l.replace(/^\S+ /, '')).join('\n'));
})();
