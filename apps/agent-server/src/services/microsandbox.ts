import { type ChildProcess, execFile as execFileCb, spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { type GuestLogSink, createGuestLogSink, redactSecrets } from '../lib/guest-log-stream'
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
export const PUBLIC_EGRESS_RULE = 'allow@public'

// microsandbox intercepts DNS queries at the smoltcp layer before they ever
// reach the IP routing stage, so `allow@private` (or any IP-based rule) has
// no effect on DNS. The DNS forwarder runs its own policy check via
// decide_dns_action() which only honours explicit protocol/port rules.
// `allow@any:udp:53` and `allow@any:tcp:53` are the rules it recognises.
export const DNS_UDP_RULE = 'allow@any:udp:53'
export const DNS_TCP_RULE = 'allow@any:tcp:53'

// msb 0.5.7's `allow@host:tcp` guest-to-host forwarding resets the
// connection when `host.microsandbox.internal` resolves via IPv6 — the TCP
// handshake completes, then the first data send gets RST'd. Confirmed via
// live A/B testing on production (2026-08-17): 100% reproducible on the
// IPv6 leg, 0% on IPv4, across curl, Node `fetch()`, and and real Chromium.
// See https://github.com/superradcompany/microsandbox/issues/1327. Denying
// just the ULA range microsandbox synthesizes for the host alias (not a
// blanket `deny@[::/0]`) makes the IPv6 attempt fail immediately and
// cleanly with `Connection refused` at connect time instead of a
// mid-transfer reset, so any dual-stack client falls back to the working
// IPv4 leg automatically — verified live across all three client types
// above. Public IPv6 egress for the sandbox is untouched, since the deny is
// scoped to this ULA prefix rather than all of `::/0` (also verified live).
// Matches microsandbox's default `ipv6Pool` (fd42:6d73:62::/48) — checked
// against this deployment's actual guest addresses, not just the
// documented default. Must be listed before any `allow@host:tcp:*` rule
// (net-rules are first-match-wins).
export const DENY_HOST_ALIAS_IPV6_RESET_RULE = 'deny@[fd42:6d73:62::/48]'

// msb assigns the bridge host 10.0.1.1 by default; the workspace desktop
// overrides it via its bridgeGateway option when running a custom msb
// network config.
export const DEFAULT_BRIDGE_GATEWAY = '10.0.1.1'

// SSH-relay networking: a workspace desktop reaches a dev server running in an
// agent's session sandbox through a tunnel agent-server opens on the host:
// `msb ssh serve <sandbox>` plus a real `ssh -L` from a host-loopback port into
// the sandbox's own loopback port. The desktop is given a narrow
// `allow@host:tcp:<its own port block>` rule and reaches the host-loopback end
// at host.microsandbox.internal:<relayPort> (see workspace-desktop.ts).
const SSH_RELAY_BIND_HOST = '127.0.0.1'
const SSH_RELAY_POLL_INTERVAL_MS = 250
const SSH_RELAY_CONNECT_TIMEOUT_MS = 1_000
const SSH_SERVE_READY_TIMEOUT_MS = 15_000
const SSH_TUNNEL_READY_TIMEOUT_MS = 15_000
const DEFAULT_SSH_BIN = 'ssh'
const DEFAULT_SSH_KEYGEN_BIN = 'ssh-keygen'

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

// Shape of the long-running `msb exec` spawn in launchSessionExec — unlike the
// one-shot commands behind CommandRunner, it is a fire-and-forget process we
// keep a handle to, so it can't go through `run`.
export type ProcessSpawner = (
	bin: string,
	args: readonly string[],
	options: { stdio: 'ignore' | readonly ('ignore' | 'pipe')[] },
) => ChildProcess

export type MicrosandboxDeps = {
	msbBin: string
	run?: CommandRunner
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	// Overrideable in tests: allocate a free TCP port on the given bind address.
	findPort?: (host: string) => Promise<number>
	// Overrideable in tests: path to the `ssh` binary used for relay tunnels.
	sshBin?: string
	// Overrideable in tests: path to the `ssh-keygen` binary used for relay keys.
	sshKeygenBin?: string
	// Overrideable in tests: wait for a bare TCP listener to accept connections.
	tcpPollReady?: (host: string, port: number, timeoutMs: number) => Promise<void>
	// Overrideable in tests: spawn the long-running `msb exec` process that
	// runs a session. Defaults to the real node:child_process spawn. Tests MUST
	// override this so a "unit" test never launches a real OS subprocess.
	spawnProcess?: ProcessSpawner
	// Overrideable in tests: builds the sink that turns `msb exec` guest
	// console output into structured log lines (lib/guest-log-stream.ts).
	createGuestLogSink?: (sessionId: string) => GuestLogSink
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
		// Must precede every allow@host:tcp rule below — see
		// DENY_HOST_ALIAS_IPV6_RESET_RULE (first-match-wins).
		'--net-rule',
		DENY_HOST_ALIAS_IPV6_RESET_RULE,
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

export function defaultSleep(ms: number): Promise<void> {
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
	})

	logger.info('msb create starting', { sessionId: input.sessionId, image: input.image })
	try {
		await run(deps.msbBin, args, { timeoutMs: CREATE_TIMEOUT_MS })
	} catch (err) {
		const e = err as { stderr?: unknown; stdout?: unknown; message?: string }
		// execFile's message embeds the full command line, including every
		// `-e KEY=value` env arg (AGENT_SECRET_*, tokens), so redact before logging
		// or rethrowing.
		const stderr = e.stderr ? redactSecrets(String(e.stderr)) : ''
		const message = redactSecrets(e.message ?? 'unknown')
		logger.error('msb create failed', {
			sessionId: input.sessionId,
			stderr,
			message,
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
		throw new Error(`msb create failed for ${input.sessionId}: ${stderr || message}`)
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

export async function waitForRunning(
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
 * stdout/stderr are piped and forwarded, line-buffered and redacted, into the
 * structured logger as `source: 'msb-exec'` (see lib/guest-log-stream.ts).
 * The *agent's* own output does not come through here — agent-run.sh ships that
 * via HTTP POST to /sessions/:id/logs/ingest — but the guest helper processes'
 * stderr does (input-stream.js, output-stream.js, and the two /tmp-logged
 * helpers now mirrored to stderr). That is the only host-side view of whether
 * those helpers are alive, and it used to be discarded into empty callbacks.
 */
export function launchSessionExec(sessionId: string, deps: MicrosandboxDeps): void {
	assertValidSessionId(sessionId)
	const spawnProcess = deps.spawnProcess ?? spawn
	const proc = spawnProcess(deps.msbBin, ['exec', sessionId], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const guestLogs = deps.createGuestLogSink?.(sessionId) ?? createGuestLogSink({ sessionId })
	proc.stdout?.on('data', (chunk: Buffer) => guestLogs.push('stdout', chunk))
	proc.stderr?.on('data', (chunk: Buffer) => guestLogs.push('stderr', chunk))
	proc.on('error', (err) => {
		guestLogs.close()
		logger.error('msb exec spawn error', { sessionId, error: String(err) })
	})
	proc.on('close', (code, sig) => {
		guestLogs.close()
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
// port to a second concurrent probe before the first caller's consumer (a
// workspace desktop) has actually claimed it. Ports
// resolved via an injected deps.findPort (tests) never populate this map, so
// releaseHostPort() is a safe no-op there.
const heldHostPorts = new Map<number, ReturnType<typeof createServer>>()

/**
 * Allocate a free TCP port on a host bind address and hold it open (see
 * heldHostPorts above). Used to pick the host-side ports of a workspace
 * desktop. Callers must call releaseHostPort(port)
 * once the invocation that consumes the port has run (success or failure) —
 * releasing earlier re-opens the TOCTOU window this exists to close.
 */
export function findFreeHostPort(host: string): Promise<number> {
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
export function releaseHostPort(port: number): void {
	const srv = heldHostPorts.get(port)
	if (!srv) return
	heldHostPorts.delete(port)
	srv.close()
}

/**
 * Reserve one specific host-loopback port by binding and holding it (see
 * heldHostPorts), so two concurrent relays can't both pick it. Returns false if
 * something else already listens there. Release with releaseHostPort().
 */
export function reserveHostPort(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer()
		srv.once('error', () => resolve(false))
		srv.listen(port, host, () => {
			heldHostPorts.set(port, srv)
			resolve(true)
		})
	})
}

export type SshRelay = {
	relayPort: number
	targetName: string
	targetGuestPort: number
	stop: () => void
}

export type SshKeyInfo = {
	privateKeyPath: string
	publicKeyPath: string
}

/**
 * Poll a bare TCP listener at host:port until it accepts a connection, or the
 * timeout elapses. Used to confirm both `msb ssh serve`'s listener and the
 * `ssh -L` tunnel's local bind have actually come up before handing the port
 * to a caller.
 */
export async function defaultTcpPollReady(
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
 * repeat, and it re-heals the grant if that file was wiped between restarts.
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

// ChildProcess.kill() throws when the process never actually spawned (e.g. a
// bad binary path), which is a real failure mode for msb/ssh, so every kill of
// a relay's processes must tolerate it.
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
 * Open an SSH-relay tunnel from a host-loopback port into a single TCP port
 * inside a running msb sandbox. Two chained child processes:
 *
 *   1. `msb ssh serve <targetName> --host 127.0.0.1 --port <sshPort>` — an
 *      sshd-like listener microsandbox exposes for a running sandbox. Its
 *      inactivity timeout is off: a tunnel carrying nothing for a while (a
 *      page left open) must not be dropped.
 *   2. `ssh -N -L 127.0.0.1:<relayPort>:127.0.0.1:<targetGuestPort>` — a real
 *      SSH client with the persistent agent-server keypair, forwarding the
 *      host-loopback relayPort into the sandbox's OWN loopback.
 *
 * `relayPort` must already be reserved by the caller (reserveHostPort); it is
 * released here just before ssh binds it. Returns null (and tears down
 * whatever was started) on any failure — never throws past this boundary.
 */
export async function startSshRelay(
	targetName: string,
	targetGuestPort: number,
	relayPort: number,
	sshKeyPath: string,
	deps: MicrosandboxDeps,
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

	let sshPort: number
	try {
		sshPort = await findPort(SSH_RELAY_BIND_HOST)
	} catch (err) {
		logger.error('ssh relay: failed to allocate ssh serve port', { targetName, error: String(err) })
		releaseHostPort(relayPort)
		return null
	}

	const serveProc = spawnProcess(
		deps.msbBin,
		[
			'ssh',
			'serve',
			targetName,
			'--host',
			SSH_RELAY_BIND_HOST,
			'--port',
			String(sshPort),
			'--no-inactivity-timeout',
		],
		{ stdio: 'ignore' },
	)
	serveProc.on('error', (err) => {
		logger.error('msb ssh serve spawn error', { targetName, error: String(err) })
	})
	serveProc.on('close', (code, sig) => {
		logger.info('msb ssh serve process exited', { targetName, code, signal: sig })
	})
	serveProc.unref()
	// The probe socket has served its purpose once `msb ssh serve` binds the port.
	releaseHostPort(sshPort)

	try {
		await tcpPollReady(SSH_RELAY_BIND_HOST, sshPort, SSH_SERVE_READY_TIMEOUT_MS)
	} catch (err) {
		logger.error('msb ssh serve did not become ready', { targetName, sshPort, error: String(err) })
		safeKill(serveProc)
		releaseHostPort(relayPort)
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
			'-o',
			'ServerAliveInterval=30',
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
	// Release before polling: a reservation socket left open would still accept
	// connections on relayPort and report success even if ssh failed to bind.
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
