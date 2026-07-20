import { type ChildProcess, execFile as execFileCb, spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../lib/logger'

const execFile = promisify(execFileCb)

// libkrun panics when an env var contains non-printable ASCII (Norwegian
// `æøå` was the original repro). Bet constraint #1.
const PRINTABLE_ASCII_RE = /[^\x20-\x7E]/g

// libkrun's env handshake fails when a single value exceeds ~1500 chars; the
// agent-base entrypoint sources the spill file at boot. Bet constraint #2.
const ENV_OVERFLOW_THRESHOLD = 1500

// Overflow keys are written as `export KEY='value'` bash lines — only valid
// POSIX identifiers are safe here. This is the same allowlist rule that
// `.claude/rules/input-validation.md` requires for any env-var key that
// reaches a shell context.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Whitelist on sessionId before it reaches an `msb` arg list or a host path.
// Same shape as T8's session-workspace.ts so the two halves stay aligned.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

// msb v0.5.4 `--net-rule allow@host:tcp:<port>` lets a microVM reach the
// agent-server on the host loopback directly. Replaces the v0.3.12 public-IP
// hairpin. Bet constraint #7.
const HOST_RULE_HOST = 'host'

// When any explicit --net-rule is present msb drops the implicit allow@public
// fallback, so sessions lose access to public internet. Re-add it so sessions
// can reach the Maskin API (maskin.io), external MCP servers, etc.
// Private addresses remain blocked by default (msb's "public" group covers
// only globally-routable IPs).
const PUBLIC_EGRESS_RULE = 'allow@public'

// microsandbox intercepts DNS queries at the smoltcp layer before they ever
// reach the IP routing stage, so `allow@private` (or any IP-based rule) has
// no effect on DNS. The DNS forwarder runs its own policy check via
// decide_dns_action() which only honours explicit protocol/port rules.
// `allow@any:udp:53` and `allow@any:tcp:53` are the rules it recognises.
const DNS_UDP_RULE = 'allow@any:udp:53'
const DNS_TCP_RULE = 'allow@any:tcp:53'

// SSH-relay networking: when a session or the browser sidecar needs to reach
// a sibling microVM's port (CDP, a dev-server preview port), agent-server
// opens `msb ssh serve <target> --host 127.0.0.1 --port <sshPort>` plus a
// real `ssh -L` tunnel from a host-loopback port into the target's own
// guest-local port — see startSshRelay() below. Verified against production
// msb 0.5.7 to reach a --no-net guest's own 127.0.0.1 with zero other network
// exposure. This replaces the old `allow@private` blanket RFC1918 grant: the
// only net-rule either VM needs now is a single `allow@host:tcp:<relayPort>`
// scoped to the one relay port it's meant to reach.
const SSH_RELAY_BIND_HOST = '127.0.0.1'
const SSH_RELAY_POLL_INTERVAL_MS = 250
const SSH_RELAY_CONNECT_TIMEOUT_MS = 1_000
const SSH_SERVE_READY_TIMEOUT_MS = 15_000
const SSH_TUNNEL_READY_TIMEOUT_MS = 15_000
const DEFAULT_SSH_BIN = 'ssh'
const DEFAULT_SSH_KEYGEN_BIN = 'ssh-keygen'

// Default Chromium CDP sidecar image. Production can override this with the
// registry tag published by the browser-sidecar Docker workflow.
const DEFAULT_BROWSER_SIDECAR_IMAGE = 'browser-sidecar:latest'

// CDP listener inside the browser-sidecar container (socat bridge target).
const BROWSER_CDP_GUEST_PORT = 9222

// DNS name a session VM (and the browser sidecar) use to reach the physical
// host over their own allow@host:tcp:<port> net-rule — matches how
// AGENT_SERVER_URL is constructed in index.ts. Overridden via
// provisionBrowserSidecar's agentServerInternalHost option when
// AGENT_SERVER_INTERNAL_HOST is set.
const DEFAULT_AGENT_SERVER_INTERNAL_HOST = 'host.microsandbox.internal'

// Bigger memory budget than a session VM: Xvfb + headed Chromium is heavier
// than the agent-base image and Chromium tabs eat into the budget fast.
const BROWSER_SIDECAR_MEMORY_MIB = 1536
const BROWSER_SIDECAR_CPUS = 1
const BROWSER_SIDECAR_CREATE_TIMEOUT_MS = 90_000

// CDP polling: how long to wait for Chrome/socat to accept connections after
// `msb exec` starts the sidecar entrypoint.
const BROWSER_SIDECAR_CDP_POLL_TIMEOUT_MS = 30_000
const BROWSER_SIDECAR_CDP_POLL_INTERVAL_MS = 500

// AC-T5: cap how long `cleanupBrowserSidecar` waits for `msb list` to stop
// reporting the sidecar after `msb remove -f`. `remove -f` should be
// synchronous, but a slow agentd can briefly keep the row visible; the SLA
// bounds the leak window before we surface it as an error.
const BROWSER_SIDECAR_TEARDOWN_SLA_MS = 60_000
const BROWSER_SIDECAR_TEARDOWN_POLL_INTERVAL_MS = 1_000
const BROWSER_SIDECAR_REMOVE_TIMEOUT_MS = 15_000
const BROWSER_SIDECAR_LIST_TIMEOUT_MS = 5_000

const SESSION_GUEST_PATH = '/agent'
const SKELETON_SUBDIRS = ['workspace', 'skills', 'learnings', 'memory'] as const

const DEFAULT_MEMORY_MIB = 1024
const DEFAULT_CPUS = 1
const STATUS_POLL_INTERVAL_MS = 500
const STATUS_POLL_TIMEOUT_MS = 90_000
const CREATE_TIMEOUT_MS = 60_000

// `always` re-pulls every spawn; `missing` skips the network round-trip when the
// image is already cached locally (image-warmer hits use this). `never` is the
// libkrun-equivalent of an air-gap for tests.
export type PullPolicy = 'always' | 'if-missing' | 'never'

// A single SSH-relay forward: a host-loopback port that tunnels into one of
// the session's own guest-local app ports, so the browser sidecar (given a
// narrow allow@host:tcp:<relayPort> grant) can reach a dev server running
// inside the session (e.g. `pnpm run dev`). See startSshRelay().
export type PreviewPortMapping = {
	guestPort: number
	relayPort: number
}

export type SpawnSessionInput = {
	sessionId: string
	image: string
	env: Record<string, string>
	memoryMib?: number
	cpus?: number
	hostPort: number
	publicHost?: string
	sessionDir: string
	pullPolicy?: PullPolicy
	maxDuration?: string
	// Extra host-loopback ports (beyond `hostPort`) this session VM may reach
	// via `--net-rule allow@host:tcp:<port>`. Used to grant access to the
	// browser sidecar's CDP SSH-relay port when the session needs browser
	// capability — the narrow replacement for the old allow@private grant.
	extraAllowedHostPorts?: readonly number[]
}

export type SpawnSessionResult = {
	sandboxName: string
	connection: {
		host: string
		port: number
	}
	envOverflowSpilled: number
	envSanitized: number
}

export type CommandRunner = (
	bin: string,
	args: readonly string[],
	options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>

// Shape of the two long-running background spawns in startSshRelay (`msb ssh
// serve` and the real `ssh -L` tunnel client) — unlike the one-shot commands
// behind CommandRunner, these are fire-and-forget processes we keep a handle
// to (for safeKill/stop), so they can't go through `run`.
export type ProcessSpawner = (
	bin: string,
	args: readonly string[],
	options: { stdio: 'ignore' },
) => ChildProcess

export type MicrosandboxDeps = {
	msbBin: string
	run?: CommandRunner
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	// Overrideable in tests: allocate a free TCP port on the given bind address.
	findPort?: (host: string) => Promise<number>
	// Overrideable in tests: wait for the CDP endpoint to accept connections.
	cdpPollReady?: (port: number) => Promise<void>
	// Overrideable in tests: path to the `ssh` binary used for relay tunnels.
	sshBin?: string
	// Overrideable in tests: path to the `ssh-keygen` binary used for relay
	// key generation.
	sshKeygenBin?: string
	// Overrideable in tests: wait for a bare TCP listener to accept
	// connections.
	tcpPollReady?: (host: string, port: number, timeoutMs: number) => Promise<void>
	// Overrideable in tests: spawn the long-running `msb ssh serve` / `ssh -L`
	// background processes started by startSshRelay. Defaults to the real
	// node:child_process spawn. Tests MUST override this — unlike msbBin
	// (always a fake path in tests), sshBin often resolves to a real,
	// installed `ssh` binary (explicit '/usr/bin/ssh', or the 'ssh' PATH
	// default), so without this override a "unit" test launches a real OS
	// subprocess. That subprocess is harmless in isolation, but with 70+
	// tests spawning one apiece in rapid succession it can exhaust CI runner
	// resources — see the CI-only OOM/SIGKILL this override fixes.
	spawnProcess?: ProcessSpawner
}

export function assertValidSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`)
	}
}

export function sanitizeEnvForMicroVM(env: Record<string, string>): {
	inline: Record<string, string>
	overflow: Array<{ key: string; value: string }>
	sanitizedCount: number
} {
	const inline: Record<string, string> = {}
	const overflow: Array<{ key: string; value: string }> = []
	let sanitizedCount = 0
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_KEY_RE.test(key)) {
			throw new Error(`Invalid env var key: ${JSON.stringify(key)}`)
		}
		const cleaned = value.replace(PRINTABLE_ASCII_RE, '')
		if (cleaned !== value) sanitizedCount += 1
		if (cleaned.length > ENV_OVERFLOW_THRESHOLD) {
			overflow.push({ key, value: cleaned })
		} else {
			inline[key] = cleaned
		}
	}
	return { inline, overflow, sanitizedCount }
}

export function formatOverflowEnvFile(
	entries: ReadonlyArray<{ key: string; value: string }>,
): string {
	const lines = entries.map(({ key, value }) => {
		const escaped = value.replace(/'/g, `'\\''`)
		return `export ${key}='${escaped}'`
	})
	return `${lines.join('\n')}\n`
}

export async function ensureSessionSkeleton(sessionDir: string): Promise<void> {
	await mkdir(sessionDir, { recursive: true })
	for (const sub of SKELETON_SUBDIRS) {
		await mkdir(join(sessionDir, sub), { recursive: true })
	}
}

export function buildMsbCreateArgs(input: {
	sessionId: string
	image: string
	memoryMib: number
	cpus: number
	hostPort: number
	env: Record<string, string>
	sessionDir: string
	pullPolicy?: PullPolicy
	maxDuration?: string
	extraAllowedHostPorts?: readonly number[]
}): string[] {
	const args: string[] = [
		'create',
		'--name',
		input.sessionId,
		'--memory',
		`${input.memoryMib}M`,
		'--cpus',
		String(input.cpus),
		'--replace',
		'--pull',
		input.pullPolicy ?? 'always',
		'--quiet',
		'--net-rule',
		`allow@${HOST_RULE_HOST}:tcp:${input.hostPort}`,
		'--net-rule',
		PUBLIC_EGRESS_RULE,
		'--net-rule',
		DNS_UDP_RULE,
		'--net-rule',
		DNS_TCP_RULE,
		'-v',
		`${input.sessionDir}:${SESSION_GUEST_PATH}`,
	]
	// Extra host-loopback ports this session needs beyond its own hostPort —
	// e.g. the browser sidecar's CDP SSH-relay port — granted narrowly per
	// port rather than the old allow@private blanket RFC1918 grant.
	if (input.extraAllowedHostPorts) {
		for (const port of input.extraAllowedHostPorts) {
			args.push('--net-rule', `allow@${HOST_RULE_HOST}:tcp:${port}`)
		}
	}
	// Backstop only: a `create`d microVM is persistent and won't power off when its
	// entrypoint exits, so without a cap a wedged/crashed session sits "running"
	// forever. The normal teardown is the /sessions/:id/complete signal (see index.ts).
	if (input.maxDuration && input.maxDuration !== '0') {
		args.push('--max-duration', input.maxDuration)
	}
	for (const [key, value] of Object.entries(input.env)) {
		args.push('-e', `${key}=${value}`)
	}
	args.push(input.image)
	return args
}

export function defaultRunner(): CommandRunner {
	return async (bin, args, options) => {
		const result = await execFile(bin, args as string[], {
			timeout: options?.timeoutMs,
			encoding: 'utf8',
		})
		return {
			stdout: result.stdout,
			stderr: result.stderr,
		}
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

type MsbStatusRow = { name: string; status: string }

export async function spawnSession(
	input: SpawnSessionInput,
	deps: MicrosandboxDeps,
): Promise<SpawnSessionResult> {
	assertValidSessionId(input.sessionId)

	const run = deps.run ?? defaultRunner()
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now

	// Bet constraint #3: bind-mounting /agent wipes WORKDIR, so the four agent
	// harness subdirs must exist on the host before boot.
	await ensureSessionSkeleton(input.sessionDir)

	const { inline, overflow, sanitizedCount } = sanitizeEnvForMicroVM(input.env)
	if (sanitizedCount > 0) {
		logger.warn('sanitized non-printable-ASCII from env', {
			sessionId: input.sessionId,
			sanitizedCount,
		})
	}

	if (overflow.length > 0) {
		const spill = formatOverflowEnvFile(overflow)
		// 0o600 — overflow file lives inside the bind-mounted /agent and can
		// contain credentials passed through env.
		await writeFile(join(input.sessionDir, '.env-overflow.sh'), spill, { mode: 0o600 })
		logger.info('spilled overflow env vars to /agent/.env-overflow.sh', {
			sessionId: input.sessionId,
			count: overflow.length,
			keys: overflow.map((e) => e.key),
		})
	}

	const args = buildMsbCreateArgs({
		sessionId: input.sessionId,
		image: input.image,
		memoryMib: input.memoryMib ?? DEFAULT_MEMORY_MIB,
		cpus: input.cpus ?? DEFAULT_CPUS,
		hostPort: input.hostPort,
		env: inline,
		sessionDir: input.sessionDir,
		...(input.pullPolicy !== undefined && { pullPolicy: input.pullPolicy }),
		...(input.maxDuration !== undefined && { maxDuration: input.maxDuration }),
		...(input.extraAllowedHostPorts !== undefined && {
			extraAllowedHostPorts: input.extraAllowedHostPorts,
		}),
	})

	logger.info('msb create starting', { sessionId: input.sessionId, image: input.image })
	try {
		await run(deps.msbBin, args, { timeoutMs: CREATE_TIMEOUT_MS })
	} catch (err) {
		const e = err as { stderr?: unknown; stdout?: unknown; message?: string }
		const stderr = e.stderr ? String(e.stderr) : ''
		logger.error('msb create failed', {
			sessionId: input.sessionId,
			stderr,
			message: e.message ?? 'unknown',
		})
		// Best-effort cleanup so a half-booted sandbox doesn't sit around with
		// the same name on retry. Non-fatal — the original create error is the
		// real signal — but a failed cleanup is still logged, not swallowed.
		try {
			await run(deps.msbBin, ['remove', '-f', '--quiet', input.sessionId], { timeoutMs: 15_000 })
		} catch (cleanupErr) {
			logger.warn('session cleanup after create failure did not confirm removal', {
				sessionId: input.sessionId,
				error: String(cleanupErr),
			})
		}
		throw new Error(`msb create failed for ${input.sessionId}: ${stderr || e.message || 'unknown'}`)
	}

	try {
		await waitForRunning(deps.msbBin, input.sessionId, { run, sleep, now })
	} catch (err) {
		logger.error('msb sandbox did not reach Running, cleaning up', {
			sessionId: input.sessionId,
			error: String(err),
		})
		try {
			await run(deps.msbBin, ['remove', '-f', '--quiet', input.sessionId], { timeoutMs: 15_000 })
		} catch (cleanupErr) {
			logger.warn('session cleanup after waitForRunning failure did not confirm removal', {
				sessionId: input.sessionId,
				error: String(cleanupErr),
			})
		}
		throw err
	}

	logger.info('msb sandbox running', { sessionId: input.sessionId })

	return {
		sandboxName: input.sessionId,
		connection: {
			host: input.publicHost ?? '127.0.0.1',
			port: input.hostPort,
		},
		envOverflowSpilled: overflow.length,
		envSanitized: sanitizedCount,
	}
}

async function waitForRunning(
	msbBin: string,
	sessionId: string,
	deps: { run: CommandRunner; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
	const deadline = deps.now() + STATUS_POLL_TIMEOUT_MS
	let lastStatus = ''
	while (deps.now() < deadline) {
		try {
			const { stdout } = await deps.run(msbBin, ['list', '--format', 'json'], { timeoutMs: 5_000 })
			const list = JSON.parse(stdout) as MsbStatusRow[]
			const entry = list.find((s) => s.name === sessionId)
			if (entry?.status?.toLowerCase() === 'running') return
			if (entry && entry.status !== lastStatus) {
				lastStatus = entry.status
				logger.info('msb status', { sessionId, status: entry.status })
			}
		} catch {
			/* transient — keep polling */
		}
		await deps.sleep(STATUS_POLL_INTERVAL_MS)
	}
	throw new Error(
		`msb sandbox ${sessionId} did not reach Running within ${STATUS_POLL_TIMEOUT_MS}ms (last status: ${lastStatus || 'unknown'})`,
	)
}

const COMPLETION_POLL_INTERVAL_MS = 5_000
const COMPLETION_TIMEOUT_MS = 8 * 60 * 60_000

/**
 * Resolves when the sandbox is no longer listed as Running — either it exited
 * naturally, was removed externally, or the timeout elapsed. The 8-hour timeout
 * is a safety valve so the background watcher doesn't run forever on a stuck VM.
 */
export async function waitForCompletion(
	msbBin: string,
	sessionId: string,
	deps: { run: CommandRunner; sleep: (ms: number) => Promise<void>; now: () => number },
	timeoutMs = COMPLETION_TIMEOUT_MS,
): Promise<void> {
	const deadline = deps.now() + timeoutMs
	while (deps.now() < deadline) {
		await deps.sleep(COMPLETION_POLL_INTERVAL_MS)
		try {
			const { stdout } = await deps.run(msbBin, ['list', '--format', 'json'], { timeoutMs: 5_000 })
			const list = JSON.parse(stdout) as MsbStatusRow[]
			const entry = list.find((s) => s.name === sessionId)
			if (!entry || entry.status.toLowerCase() !== 'running') return
		} catch {
			/* transient — keep polling */
		}
	}
	logger.warn('session completion watch timed out', { sessionId, timeoutMs })
}

/**
 * Launch `msb exec <sessionId>` as a fire-and-forget background process.
 *
 * microsandbox's TCP proxy (allow@host:tcp:PORT) is only active while an exec
 * session is in progress — not during the VM's create-time boot. Calling this
 * after spawnSession writes the .exec-trigger file causes entrypoint.sh to skip
 * the sleep path and run agent-run.sh with the proxy active.
 *
 * stdout/stderr are piped and drained silently; we don't need PTY output here
 * because agent-run.sh streams logs via HTTP POST to /sessions/:id/logs/ingest.
 */
export function launchSessionExec(sessionId: string, deps: MicrosandboxDeps): void {
	assertValidSessionId(sessionId)
	const proc = spawn(deps.msbBin, ['exec', sessionId], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	proc.stdout?.on('data', () => {})
	proc.stderr?.on('data', () => {})
	proc.on('error', (err) => {
		logger.error('msb exec spawn error', { sessionId, error: String(err) })
	})
	proc.on('close', (code, sig) => {
		logger.info('msb exec process exited', { sessionId, code, signal: sig })
	})
	proc.unref()
}

export async function removeSandbox(name: string, deps: MicrosandboxDeps): Promise<void> {
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	await run(deps.msbBin, ['remove', '-f', '--quiet', name], { timeoutMs: 15_000 })
}

/**
 * Gracefully stop a sandbox (`msb stop`, SIGTERM + grace) so the bind-mounted
 * /agent workspace is flushed to the host before it is pushed to S3 — a force
 * `remove -f` can skip that flush. Used by the VM-facing /sessions/:id/complete
 * signal: a `create`d microVM is persistent and does NOT power off when
 * agent-run.sh exits, so we stop it explicitly. Idempotent enough for retries —
 * stopping an already-stopped/absent sandbox is a no-op error the caller swallows.
 */
export async function stopSandbox(name: string, deps: MicrosandboxDeps): Promise<void> {
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	await run(deps.msbBin, ['stop', name], { timeoutMs: 20_000 })
}

/**
 * Every sandbox name `msb` currently knows about (any status), regardless of
 * whether this process has a live in-memory monitor for it. Used by the
 * boot-time reconcile pass (see reconcileOnBoot in index.ts) to tell apps/dev
 * which sessions actually survived a restart.
 */
export async function listSandboxNames(deps: MicrosandboxDeps): Promise<string[]> {
	const run = deps.run ?? defaultRunner()
	const { stdout } = await run(deps.msbBin, ['list', '--format', 'json'], { timeoutMs: 10_000 })
	const list = JSON.parse(stdout) as MsbStatusRow[]
	return list.map((s) => s.name)
}

export async function readMsbVersion(deps: { msbBin: string; run?: CommandRunner }): Promise<
	string | null
> {
	const run = deps.run ?? defaultRunner()
	try {
		const { stdout } = await run(deps.msbBin, ['--version'], { timeoutMs: 5_000 })
		const m = stdout.match(/(\d+\.\d+\.\d+)/)
		return m?.[1] ?? null
	} catch {
		return null
	}
}

// Sockets opened by the default findFreeHostPort() below, keyed by the port
// they're bound to. Held open (not closed immediately after the bind probe)
// until releaseHostPort() is called, so the OS can't hand the same "free"
// port to a second concurrent probe before the first caller's consumer (an
// SSH relay tunnel, `msb ssh serve`, ...) has actually claimed it. Ports
// resolved via an injected deps.findPort (tests) never populate this map, so
// releaseHostPort() is a safe no-op there.
const heldHostPorts = new Map<number, ReturnType<typeof createServer>>()

/**
 * Allocate a free TCP port on a host bind address and hold it open (see
 * heldHostPorts above). Used to pick host-loopback ports for SSH-relay
 * tunnels — the browser sidecar's CDP relay, a session's preview-port relays
 * (via resolvePreviewPortMappings), and the intermediate `msb ssh serve`
 * listener port (via startSshRelay). Callers must call releaseHostPort(port)
 * once the invocation that consumes the port has run (success or failure) —
 * releasing earlier re-opens the TOCTOU window this exists to close.
 */
function findFreeHostPort(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.on('error', reject)
		srv.listen(0, host, () => {
			const addr = srv.address()
			if (addr && typeof addr === 'object') {
				heldHostPorts.set(addr.port, srv)
				resolve(addr.port)
			} else {
				srv.close(() => reject(new Error('could not determine free host port')))
			}
		})
	})
}

/**
 * Release a port reserved by the default findFreeHostPort(), closing the
 * socket holding it open. No-op for ports not tracked here — e.g. a
 * test-injected deps.findPort value, or a port already released — so it's
 * safe to call unconditionally from a finally block.
 */
function releaseHostPort(port: number): void {
	const srv = heldHostPorts.get(port)
	if (!srv) return
	heldHostPorts.delete(port)
	srv.close()
}

export type PreviewPortResolution = {
	mappings: PreviewPortMapping[]
	/**
	 * Releases the host-port reservations backing these mappings. Call only
	 * after the SSH relay(s) that consume them have actually been started
	 * (success or failure) — see findFreeHostPort's TOCTOU note above.
	 */
	release: () => void
}

/**
 * Resolve one free host-loopback port per requested guest port, reserved for
 * an eventual SSH-relay tunnel into that session port (see startSshRelay()
 * below). Call this before provisioning the browser sidecar so the reserved
 * port numbers are known ahead of baking them into the sidecar's own
 * `allow@host:tcp:<port>` net-rules — the sidecar's create-time rules must be
 * set before the session VM exists, even though the relay itself can only be
 * started once the session is Running.
 *
 * The returned reservations stay open (not just "looked free a moment ago")
 * until the caller invokes release() — hold it through provisionBrowserSidecar
 * and the eventual spawnSession + startSshRelay calls, then release once the
 * relay(s) have actually been started against these port numbers (success or
 * failure). See findFreeHostPort for why.
 */
export async function resolvePreviewPortMappings(
	guestPorts: readonly number[],
	deps: MicrosandboxDeps,
): Promise<PreviewPortResolution> {
	const findPort = deps.findPort ?? findFreeHostPort
	const mappings: PreviewPortMapping[] = []
	try {
		for (const guestPort of guestPorts) {
			const relayPort = await findPort(SSH_RELAY_BIND_HOST)
			mappings.push({ guestPort, relayPort })
		}
	} catch (err) {
		for (const m of mappings) releaseHostPort(m.relayPort)
		throw err
	}
	return {
		mappings,
		release: () => {
			for (const m of mappings) releaseHostPort(m.relayPort)
		},
	}
}

export type SshKeyInfo = {
	privateKeyPath: string
	publicKeyPath: string
}

export type SshRelay = {
	relayPort: number
	targetName: string
	targetGuestPort: number
	stop: () => void
}

/**
 * Poll a bare TCP listener at host:port until it accepts a connection, or the
 * timeout elapses. Used to confirm both `msb ssh serve`'s listener and the
 * `ssh -L` tunnel's local bind have actually come up before handing the port
 * to a caller.
 */
async function defaultTcpPollReady(
	host: string,
	port: number,
	timeoutMs: number,
	deps: { sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
	const deadline = deps.now() + timeoutMs
	while (deps.now() < deadline) {
		const ready = await new Promise<boolean>((resolve) => {
			const socket = connect({ host, port })
			const finish = (ok: boolean): void => {
				socket.removeAllListeners()
				socket.destroy()
				resolve(ok)
			}
			socket.setTimeout(SSH_RELAY_CONNECT_TIMEOUT_MS)
			socket.once('connect', () => finish(true))
			socket.once('error', () => finish(false))
			socket.once('timeout', () => finish(false))
		})
		if (ready) return
		await deps.sleep(SSH_RELAY_POLL_INTERVAL_MS)
	}
	throw new Error(`TCP listener on ${host}:${port} did not become ready within ${timeoutMs}ms`)
}

/**
 * Idempotently ensure agent-server has a persistent SSH keypair at `keyPath`,
 * generating one with `ssh-keygen` only on first boot, and (re-)authorizing
 * its public half with `msb ssh authorize` on every call — cheap and safe to
 * repeat since duplicate `authorized_keys` lines are harmless, and it re-heals
 * the grant if that file was wiped externally between restarts.
 */
export async function ensureAgentServerSshKey(
	keyPath: string,
	deps: MicrosandboxDeps,
): Promise<SshKeyInfo> {
	const run = deps.run ?? defaultRunner()
	const sshKeygenBin = deps.sshKeygenBin ?? DEFAULT_SSH_KEYGEN_BIN
	const publicKeyPath = `${keyPath}.pub`

	const exists = await access(keyPath)
		.then(() => true)
		.catch(() => false)
	if (!exists) {
		await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
		await run(sshKeygenBin, ['-t', 'ed25519', '-N', '', '-f', keyPath], { timeoutMs: 15_000 })
		logger.info('generated agent-server ssh relay keypair', { keyPath })
	}

	await run(deps.msbBin, ['ssh', 'authorize', '--file', publicKeyPath], { timeoutMs: 15_000 })

	return { privateKeyPath: keyPath, publicKeyPath }
}

// ChildProcess.kill() throws (EINVAL on Windows, and platform-dependent
// elsewhere) when the process never actually spawned — e.g. spawn() failed
// synchronously with ENOENT for a bad/missing binary path. That's a real
// failure mode for msb/ssh, not just a test artifact, so every kill() on a
// relay's serve/tunnel process must tolerate it rather than let it crash the
// caller (startSshRelay's own failure paths, and cleanupBrowserSidecar via
// the returned stop()).
function safeKill(proc: ChildProcess): void {
	try {
		proc.kill()
	} catch (err) {
		logger.warn('failed to kill relay child process (already exited or never spawned)', {
			error: String(err),
		})
	}
}

/**
 * Open a narrow SSH-relay tunnel from a host-loopback port into a single TCP
 * port inside a running msb sandbox — the replacement for the old
 * allow@private / bridge `-p` publish mechanism. Two chained child processes:
 *
 *   1. `msb ssh serve <targetName> --host 127.0.0.1 --port <sshPort>` — an
 *      sshd-like listener microsandbox exposes for a running sandbox,
 *      proxying SSH sessions into the guest.
 *   2. `ssh -N -L 127.0.0.1:<relayPort>:127.0.0.1:<targetGuestPort> ...` — a
 *      real SSH client using the persistent agent-server keypair, forwarding
 *      the host-loopback relayPort into the guest's OWN loopback at
 *      targetGuestPort. Verified against production msb 0.5.7 to work even
 *      for a --no-net guest with zero other network exposure.
 *
 * `opts.relayPort`, when provided, must already be a live TOCTOU-safe
 * reservation (see findFreeHostPort / resolvePreviewPortMappings) that the
 * caller pre-baked into a sibling VM's --net-rule before this sandbox
 * existed — startSshRelay does NOT release it; the caller owns that
 * reservation's lifecycle. When omitted, startSshRelay self-allocates and
 * self-releases its own relayPort (the CDP-relay case, which has no such
 * ordering constraint).
 *
 * Returns null (and tears down whatever was started) on any failure — never
 * throws past this boundary, matching provisionBrowserSidecar's convention.
 */
export async function startSshRelay(
	targetName: string,
	targetGuestPort: number,
	sshKeyPath: string,
	deps: MicrosandboxDeps,
	opts: { relayPort?: number } = {},
): Promise<SshRelay | null> {
	assertValidSessionId(targetName)
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now
	const findPort = deps.findPort ?? findFreeHostPort
	const sshBin = deps.sshBin ?? DEFAULT_SSH_BIN
	const spawnProcess = deps.spawnProcess ?? spawn
	const tcpPollReady =
		deps.tcpPollReady ??
		((host: string, port: number, timeoutMs: number) =>
			defaultTcpPollReady(host, port, timeoutMs, { sleep, now }))

	const selfAllocatedRelay = opts.relayPort === undefined
	let relayPort: number
	try {
		relayPort = opts.relayPort ?? (await findPort(SSH_RELAY_BIND_HOST))
	} catch (err) {
		logger.error('ssh relay: failed to allocate relay port', { targetName, error: String(err) })
		return null
	}

	let sshPort: number
	try {
		sshPort = await findPort(SSH_RELAY_BIND_HOST)
	} catch (err) {
		logger.error('ssh relay: failed to allocate ssh serve port', { targetName, error: String(err) })
		if (selfAllocatedRelay) releaseHostPort(relayPort)
		return null
	}

	const serveProc = spawnProcess(
		deps.msbBin,
		['ssh', 'serve', targetName, '--host', SSH_RELAY_BIND_HOST, '--port', String(sshPort)],
		{ stdio: 'ignore' },
	)
	serveProc.on('error', (err) => {
		logger.error('msb ssh serve spawn error', { targetName, error: String(err) })
	})
	serveProc.on('close', (code, sig) => {
		logger.info('msb ssh serve process exited', { targetName, code, signal: sig })
	})
	serveProc.unref()
	// The probe socket has served its purpose once `msb ssh serve` has
	// actually bound (or failed to bind) the port — release right after
	// spawn, mirroring the create-arg release convention used elsewhere in
	// this file (e.g. provisionBrowserSidecar's old hostPort release).
	releaseHostPort(sshPort)

	try {
		await tcpPollReady(SSH_RELAY_BIND_HOST, sshPort, SSH_SERVE_READY_TIMEOUT_MS)
	} catch (err) {
		logger.error('msb ssh serve did not become ready', { targetName, sshPort, error: String(err) })
		safeKill(serveProc)
		if (selfAllocatedRelay) releaseHostPort(relayPort)
		return null
	}

	const tunnelProc = spawnProcess(
		sshBin,
		[
			'-N',
			'-L',
			`${SSH_RELAY_BIND_HOST}:${relayPort}:${SSH_RELAY_BIND_HOST}:${targetGuestPort}`,
			'-p',
			String(sshPort),
			'-i',
			sshKeyPath,
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-o',
			'ExitOnForwardFailure=yes',
			'-o',
			'BatchMode=yes',
			`root@${SSH_RELAY_BIND_HOST}`,
		],
		{ stdio: 'ignore' },
	)
	tunnelProc.on('error', (err) => {
		logger.error('ssh tunnel spawn error', { targetName, error: String(err) })
	})
	tunnelProc.on('close', (code, sig) => {
		logger.info('ssh tunnel process exited', { targetName, code, signal: sig })
	})
	tunnelProc.unref()
	// Always release here, even for a caller-supplied relayPort: if we left the
	// reservation socket open, it would still accept connections on relayPort and
	// fool the tcpPollReady check below into reporting success even when the real
	// bind above failed (EADDRINUSE against our own reservation, exiting ssh
	// immediately under ExitOnForwardFailure). releaseHostPort is a no-op if
	// already released, so the caller's own cleanup stays safe to call afterward.
	releaseHostPort(relayPort)

	try {
		await tcpPollReady(SSH_RELAY_BIND_HOST, relayPort, SSH_TUNNEL_READY_TIMEOUT_MS)
	} catch (err) {
		logger.error('ssh tunnel did not become ready', { targetName, relayPort, error: String(err) })
		safeKill(tunnelProc)
		safeKill(serveProc)
		return null
	}

	logger.info('ssh relay established', { targetName, targetGuestPort, relayPort, sshPort })

	return {
		relayPort,
		targetName,
		targetGuestPort,
		stop: () => {
			safeKill(tunnelProc)
			safeKill(serveProc)
		},
	}
}

/**
 * Fire-and-forget `msb exec <name>` to start the browser sidecar entrypoint
 * (Xvfb + Chromium + socat). `msb create` boots the VM but does NOT execute
 * CMD/ENTRYPOINT — `msb exec` is required. Mirrors `launchSessionExec`.
 */
function launchSidecarExec(name: string, deps: MicrosandboxDeps): void {
	assertValidSessionId(name)
	const proc = spawn(deps.msbBin, ['exec', name], {
		stdio: 'ignore',
	})
	proc.on('error', (err) => {
		logger.error('browser sidecar exec spawn error', { name, error: String(err) })
	})
	proc.on('close', (code, sig) => {
		logger.info('browser sidecar exec process exited', { name, code, signal: sig })
	})
	proc.unref()
}

/**
 * Poll `http://<host>:<port>/json/version` until Chrome's CDP endpoint
 * responds with HTTP 200, or the timeout elapses. Called after `msb exec`
 * starts the sidecar entrypoint so we don't hand a CDP URL to the session
 * before socat is forwarding connections.
 */
async function defaultPollCdpReady(
	host: string,
	port: number,
	deps: { sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
	const deadline = deps.now() + BROWSER_SIDECAR_CDP_POLL_TIMEOUT_MS
	while (deps.now() < deadline) {
		const ready = await new Promise<boolean>((resolve) => {
			const req = httpGet(`http://${host}:${port}/json/version`, (res) => {
				res.on('error', () => resolve(false))
				resolve(res.statusCode === 200)
				res.resume()
			})
			req.on('error', () => resolve(false))
			req.setTimeout(1_000, () => {
				req.destroy()
				resolve(false)
			})
		})
		if (ready) return
		await deps.sleep(BROWSER_SIDECAR_CDP_POLL_INTERVAL_MS)
	}
	throw new Error(
		`CDP endpoint on ${host}:${port} did not become ready within ${BROWSER_SIDECAR_CDP_POLL_TIMEOUT_MS}ms`,
	)
}

export type BrowserSidecar = {
	name: string
	cdpUrl: string
	// Present only for sidecars provisioned by this process; absent when
	// reattached via reconcileOnBoot (see index.ts) — SSH relay child
	// processes are owned by this process (not the msb daemon), so they don't
	// survive an agent-server restart and cannot be recovered.
	cdpRelay?: SshRelay
}

/**
 * Provision a Chromium-only sidecar microVM running `browser-sidecar` for
 * browser-enabled sessions. Returns the sidecar name and a CDP URL the session
 * VM can hand to `@playwright/mcp`.
 *
 * Strategy: `msb create` boots the sidecar with no CDP port published at all —
 * `msb exec` starts Xvfb + Chromium + socat, then startSshRelay() opens an
 * SSH-relay tunnel (`msb ssh serve` + `ssh -L`) from a host-loopback port into
 * the sidecar's own guest-local CDP port. This replaces the old
 * `-p <bridgeGateway>:<port>:9222` bridge publish + allow@private grant —
 * verified against production msb 0.5.7 to reach a guest's own 127.0.0.1 even
 * with zero other network exposure (no bridge, no --net-rule beyond DNS/public
 * egress). The session VM reaches the relay port via the same
 * `allow@host:tcp:<port>` / `host.microsandbox.internal` mechanism used for
 * AGENT_SERVER_URL, narrowly scoped to exactly that one port (see
 * extraAllowedHostPorts on spawnSession).
 *
 * The URL must be http:// (not ws://) — `@playwright/mcp --cdp-endpoint` performs
 * CDP discovery via `GET {url}/json/version` to find the browser's real
 * `webSocketDebuggerUrl` before opening a WebSocket, the same discovery this
 * function's own readiness poll (`defaultPollCdpReady`) relies on above.
 *
 * Returns `null` on any failure — the caller falls back without browser
 * capability. We never throw past the session boundary.
 */
export async function provisionBrowserSidecar(
	prefix: string,
	deps: MicrosandboxDeps,
	options: {
		image?: string
		sshKeyPath: string
		agentServerInternalHost?: string
		extraAllowedHostPorts?: readonly number[]
	},
): Promise<BrowserSidecar | null> {
	const name = `anko-browser-${prefix}`
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now
	const image = options.image ?? DEFAULT_BROWSER_SIDECAR_IMAGE
	const agentServerInternalHost =
		options.agentServerInternalHost ?? DEFAULT_AGENT_SERVER_INTERNAL_HOST

	const createArgs: string[] = [
		'create',
		'--name',
		name,
		'--memory',
		`${BROWSER_SIDECAR_MEMORY_MIB}M`,
		'--cpus',
		String(BROWSER_SIDECAR_CPUS),
		'--pull',
		'always',
		'--quiet',
		// Sidecar needs public egress (Chromium asset fetches) and DNS.
		'--net-rule',
		PUBLIC_EGRESS_RULE,
		'--net-rule',
		DNS_UDP_RULE,
		'--net-rule',
		DNS_TCP_RULE,
	]

	// Lets the sidecar reach a session's own preview-relay port(s) on the host
	// loopback — the SSH-relay replacement for the old allow@private blanket
	// RFC1918 grant. Each entry is scoped to exactly one port.
	if (options.extraAllowedHostPorts) {
		for (const port of options.extraAllowedHostPorts) {
			createArgs.push('--net-rule', `allow@${HOST_RULE_HOST}:tcp:${port}`)
		}
	}
	createArgs.push(image)

	try {
		await run(deps.msbBin, createArgs, { timeoutMs: BROWSER_SIDECAR_CREATE_TIMEOUT_MS })
	} catch (err) {
		const e = err as { stderr?: unknown; message?: string }
		const stderr = e.stderr ? String(e.stderr) : ''
		logger.error('browser sidecar create failed', {
			name,
			stderr,
			message: e.message ?? 'unknown',
		})
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], {
			timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS,
		}).catch((cleanupErr) => {
			logger.warn('browser sidecar cleanup after create failure did not confirm removal', {
				name,
				error: String(cleanupErr),
			})
		})
		return null
	}

	try {
		await waitForRunning(deps.msbBin, name, { run, sleep, now })
	} catch (err) {
		logger.error('browser sidecar did not reach Running', { name, error: String(err) })
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], {
			timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS,
		}).catch((cleanupErr) => {
			logger.warn('browser sidecar cleanup after waitForRunning failure did not confirm removal', {
				name,
				error: String(cleanupErr),
			})
		})
		return null
	}

	// Start the entrypoint (Xvfb + Chromium + socat). `msb create` boots the
	// VM kernel but does NOT execute ENTRYPOINT/CMD — `msb exec` is required.
	launchSidecarExec(name, deps)

	const cdpRelay = await startSshRelay(name, BROWSER_CDP_GUEST_PORT, options.sshKeyPath, deps)
	if (!cdpRelay) {
		logger.error('browser sidecar CDP relay failed to establish', { name })
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], {
			timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS,
		}).catch((cleanupErr) => {
			logger.warn('browser sidecar cleanup after CDP relay failure did not confirm removal', {
				name,
				error: String(cleanupErr),
			})
		})
		return null
	}

	const pollReady =
		deps.cdpPollReady ??
		((port: number) => defaultPollCdpReady(SSH_RELAY_BIND_HOST, port, { sleep, now }))
	try {
		await pollReady(cdpRelay.relayPort)
	} catch (err) {
		logger.error('browser sidecar CDP did not become ready', {
			name,
			port: cdpRelay.relayPort,
			error: String(err),
		})
		cdpRelay.stop()
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], {
			timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS,
		}).catch((cleanupErr) => {
			logger.warn('browser sidecar cleanup after CDP-not-ready failure did not confirm removal', {
				name,
				error: String(cleanupErr),
			})
		})
		return null
	}

	const cdpUrl = `http://${agentServerInternalHost}:${cdpRelay.relayPort}`
	logger.info('browser sidecar started', { name, cdpUrl })
	return { name, cdpUrl, cdpRelay }
}

/**
 * Tear down a sidecar provisioned by `provisionBrowserSidecar`. Idempotent —
 * a missing or already-removed sandbox returns cleanly. Called from
 * `monitorSession` after the session VM exits so we don't leave Chromium VMs
 * (or their SSH relay child processes) orphaned on the host.
 *
 * After firing `msb remove -f` this polls `msb list` until the sidecar row is
 * gone or the AC-T5 SLA elapses. A `remove -f` that returns OK while the row
 * lingers (we have seen this on a busy agentd) would otherwise leave a
 * Chromium VM behind silently — the wait turns that into a logged error
 * instead of a leak.
 */
export async function cleanupBrowserSidecar(
	sidecar: BrowserSidecar | null,
	deps: MicrosandboxDeps,
): Promise<void> {
	if (!sidecar) return
	sidecar.cdpRelay?.stop()
	const run = deps.run ?? defaultRunner()
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now
	const start = now()

	try {
		await run(deps.msbBin, ['remove', '-f', '--quiet', sidecar.name], {
			timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS,
		})
	} catch (err) {
		// The remove call may legitimately fail when the sandbox is already
		// gone (idempotent retries, crash recovery). Don't return — fall
		// through to the verification poll so a real leak still gets caught.
		logger.warn('browser sidecar removal failed', { name: sidecar.name, error: String(err) })
	}

	const deadline = start + BROWSER_SIDECAR_TEARDOWN_SLA_MS
	while (now() < deadline) {
		if (await isSidecarAbsent(deps.msbBin, sidecar.name, run)) {
			logger.info('browser sidecar teardown complete', {
				name: sidecar.name,
				elapsedMs: now() - start,
			})
			return
		}
		await sleep(BROWSER_SIDECAR_TEARDOWN_POLL_INTERVAL_MS)
	}

	if (await isSidecarAbsent(deps.msbBin, sidecar.name, run)) {
		logger.info('browser sidecar teardown complete', {
			name: sidecar.name,
			elapsedMs: now() - start,
		})
		return
	}

	logger.error('browser sidecar still present after teardown SLA', {
		name: sidecar.name,
		elapsedMs: now() - start,
		slaMs: BROWSER_SIDECAR_TEARDOWN_SLA_MS,
	})
}

/**
 * Returns true when `msb list` no longer reports the sidecar name. A failure
 * of the list call itself is treated as "unknown" (not absent) so a transient
 * msb hiccup doesn't trick the caller into declaring the sidecar gone.
 */
async function isSidecarAbsent(msbBin: string, name: string, run: CommandRunner): Promise<boolean> {
	try {
		const { stdout } = await run(msbBin, ['list', '--format', 'json'], {
			timeoutMs: BROWSER_SIDECAR_LIST_TIMEOUT_MS,
		})
		const list = JSON.parse(stdout) as MsbStatusRow[]
		return !list.some((s) => s.name === name)
	} catch {
		return false
	}
}
