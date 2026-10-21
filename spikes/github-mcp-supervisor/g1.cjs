// G1 probe: drive github-mcp-server stdio directly with JSON-RPC.
// Usage: node g1.cjs bad|good   (token never printed; "good" is minted via the Maskin route)
const { spawn } = require('child_process');
const mode = process.argv[2] || 'bad';
const INTEGRATION = process.env.SPIKE_INTEGRATION_ID;

async function mint() {
  const r = await fetch(`${process.env.MASKIN_API_URL}/api/integrations/${INTEGRATION}/github-token`, {
    headers: { Authorization: `Bearer ${process.env.MASKIN_API_KEY}`, 'X-Workspace-Id': process.env.MASKIN_WORKSPACE_ID },
  });
  const j = await r.json().catch(() => ({}));
  console.log('mint status', r.status, 'keys', Object.keys(j));
  return j.token;
}

function start(token) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_PERSONAL_ACCESS_TOKEN: token };
  const c = spawn('github-mcp-server', ['stdio', '--toolsets=default'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  let stderr = '';
  c.stderr.on('data', (d) => (stderr += d));
  let n = 0;
  const req = (method, params) => new Promise((res) => {
    const id = ++n; waiters.set(id, res);
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { c, req, notify, stderr: () => stderr };
}

const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spike', version: '0' } };
const redact = (s) => String(s).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '<redacted>');

(async () => {
  const token = mode === 'bad' ? ['gh', 's_', 'INVALID'.repeat(5)].join('') : await mint();
  const s = start(token);
  const ir = await s.req('initialize', init);
  console.log('initialize ok:', !!ir.result, 'server', ir.result && ir.result.serverInfo.name + " " + ir.result.serverInfo.version);
  s.notify('notifications/initialized');
  const tl = await s.req('tools/list', {});
  const names = tl.result.tools.map((t) => t.name);
  console.log('tool count', names.length);
  console.log('tools:', names.join(','));
  const calls = [
    ['REST get_me', 'get_me', {}],
    ['GraphQL list_issues', 'list_issues', { owner: 'vaerksted-ai', repo: 'skjald' }],
    ['file-read get_file_contents', 'get_file_contents', { owner: 'vaerksted-ai', repo: 'skjald', path: 'README.md' }],
  ];
  for (const [label, name, args] of calls) {
    if (!names.includes(name)) { console.log(label, 'TOOL MISSING'); continue; }
    const r = await s.req('tools/call', { name, arguments: args });
    const txt = r.result ? (r.result.content || []).map((c) => c.text || c.type).join(' | ') : JSON.stringify(r.error);
    console.log(`[${label}] isError=${r.result && r.result.isError} text=${redact(txt).slice(0, 300)}`);
  }
  console.log('child still alive after calls:', s.c.exitCode === null);
  console.log('stderr (redacted, first 300):', redact(s.stderr()).slice(0, 300));
  s.c.kill();
})();
