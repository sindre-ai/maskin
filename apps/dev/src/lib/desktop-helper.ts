// Bringing the helper (desktopd) on a running agent computer up to date. A computer keeps the
// image it was created from, and re-opening it wipes its saved logins, so a helper that gained
// a feature (type_secret, for saved passwords) never reaches a computer that already exists.
// Like the settings files in desktop-settings.ts, the server builds the commands here and
// nowhere else: the caller never names a file, a path or a value.
//
// The helper is sent in pieces because one exec command may be at most 10,000 characters, and
// the whole file does not fit. The pieces are compressed text, put in a temporary file, and a
// last command checks them against a hash, installs the file and restarts the helper.

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { DESKTOP_HELPER_SOURCE } from './desktop-helper-source'

/** Where the image puts the helper (docker/desktop/Dockerfile). */
export const HELPER_PATH = '/usr/local/bin/desktopd.py'
/** The browser flags file the image writes. It carries the debugging port the helper reads. */
export const CHROMIUM_FLAGS_PATH = '/etc/chromium.d/desktop-flags'
// Same line as docker/desktop/Dockerfile. Only written when the file lacks the debugging port,
// so the next time Chromium starts it opens the port. A Chromium that is already running is
// not touched.
export const CHROMIUM_FLAGS_LINE =
	'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1"'
export const CHROMIUM_DEBUG_PORT = 9222

const STAGING_PATH = '/tmp/maskin-desktopd.b64'
// Base64 characters per command. Well under the 10,000 limit with the shell around it.
const CHUNK_SIZE = 7_000

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export const helperSha256 = (source: string = DESKTOP_HELPER_SOURCE) =>
	createHash('sha256').update(source).digest('hex')

/** Where the helper's files go. Defaults are the computer's own; tests point them at a folder. */
export type HelperTargets = {
	helperPath: string
	flagsPath: string
	stagingPath: string
	/** Install with sudo (the computer's files are owned by root). */
	sudo: boolean
	/** Start the new helper after installing. Off in tests. */
	restart: boolean
	debugPort: number
}

const DEFAULT_TARGETS: HelperTargets = {
	helperPath: HELPER_PATH,
	flagsPath: CHROMIUM_FLAGS_PATH,
	stagingPath: STAGING_PATH,
	sudo: true,
	restart: true,
	debugPort: CHROMIUM_DEBUG_PORT,
}

// Runs on the computer under python3. One argument, a JSON list: [staging file, helper path,
// flags path, flags line, expected sha256, sudo, restart, debug port]. Prints key=value lines.
// Never prints the helper's text, and the helper holds no secret of its own. The restart is a
// separate process that outlives this one: this command is run by the helper itself, so
// stopping the helper here would cut off the reply.
const INSTALL_SCRIPT = `
import base64, hashlib, json, os, socket, subprocess, sys, tempfile, zlib
staging, helper, flags, flags_line, want_sha, use_sudo, restart, port = json.loads(sys.argv[1])
elevate = ["sudo", "-n"] if use_sudo else []

with open(staging) as f:
    source = zlib.decompress(base64.b64decode(f.read()))
os.remove(staging)
if hashlib.sha256(source).hexdigest() != want_sha:
    print("error=helper_hash_mismatch")
    sys.exit(3)

def read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None

def install(path, data, mode):
    fd, tmp = tempfile.mkstemp()
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        subprocess.run(elevate + ["install", "-D", "-m", mode, tmp, path], check=True)
    finally:
        os.remove(tmp)

helper_changed = read(helper) != source
if helper_changed:
    install(helper, source, "755")

flags_data = read(flags)
flags_changed = flags_data is None or b"--remote-debugging-port" not in flags_data
if flags_changed:
    install(flags, (flags_line + "\\n").encode(), "644")

try:
    socket.create_connection(("127.0.0.1", port), timeout=1).close()
    debug_port_open = True
except OSError:
    debug_port_open = False

restarting = False
if helper_changed and restart:
    # The running helper is the process whose command line is exactly: python3 <helper path>.
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            with open("/proc/" + name + "/cmdline", "rb") as f:
                argv = f.read().split(b"\\0")
        except OSError:
            continue
        if len(argv) >= 2 and argv[1] == helper.encode() and os.path.basename(argv[0]).startswith(b"python"):
            pids.append(name)
    if len(pids) == 1:
        pid = pids[0]
        script = ('sleep 0.5; kill ' + pid + '; i=0; while kill -0 ' + pid
                  + ' 2>/dev/null && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done; exec python3 "$0"')
        subprocess.Popen(["sh", "-c", script, helper], start_new_session=True, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        restarting = True

print("helper_changed=" + ("1" if helper_changed else "0"))
print("helper_restarting=" + ("1" if restarting else "0"))
print("flags_changed=" + ("1" if flags_changed else "0"))
print("debug_port_open=" + ("1" if debug_port_open else "0"))
`

/** The commands that bring a computer's helper up to date, to run one after another. */
export function buildRefreshHelperCommands(
	overrides: Partial<HelperTargets> = {},
	source: string = DESKTOP_HELPER_SOURCE,
): string[] {
	const t = { ...DEFAULT_TARGETS, ...overrides }
	const payload = deflateSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64')
	const commands: string[] = []
	for (let at = 0; at < payload.length; at += CHUNK_SIZE) {
		const redirect = at === 0 ? '>' : '>>'
		commands.push(
			`printf %s ${shellQuote(payload.slice(at, at + CHUNK_SIZE))} ${redirect} ${shellQuote(t.stagingPath)}`,
		)
	}
	const args = JSON.stringify([
		t.stagingPath,
		t.helperPath,
		t.flagsPath,
		CHROMIUM_FLAGS_LINE,
		helperSha256(source),
		t.sudo,
		t.restart,
		t.debugPort,
	])
	commands.push(`python3 -c ${shellQuote(INSTALL_SCRIPT)} ${shellQuote(args)}`)
	return commands
}
