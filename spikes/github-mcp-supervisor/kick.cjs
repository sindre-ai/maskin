// Send SIGUSR1 to every running relay.cjs (no pkill in this image).
const fs = require('fs');
for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
  try {
    const c = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
    if (c[0] === 'node' && c[1] && c[1].endsWith('relay.cjs') && +p !== process.pid) { process.kill(+p, 'SIGUSR1'); console.log('signalled relay pid', p); }
  } catch (_) {}
}
