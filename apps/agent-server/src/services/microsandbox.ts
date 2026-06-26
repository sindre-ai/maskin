import { execFile as execFileCb, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

// When a session needs to talk to a sibling msb microVM (the browser sidecar
// for bet-qa runs), the target IP is on the msb bridge — a private RFC1918
// range. `allow@private` opens that path without giving the session blanket
// access to the host network. Only added when explicitly requested.
const PRIVATE_NET_RULE = 'allow@private'

// Image used for the Chromium CDP sidecar — same tag as T1's local Docker path
// so the two halves of the bet stay in lockstep.
const BROWSER_SIDECAR_IMAGE = 'browser-sidecar:latest'

// CDP listener inside the browser-sidecar container.
const BROWSER_CDP_PORT = 9222

// Brief settle before we hand the CDP URL to the agent — Chromium's listener
// binds a beat after the VM reports Running.
const BROWSER_SIDECAR_SETTLE_MS = 2_000

// Bigger memory budget than a session VM: Xvfb + headed Chromium is heavier
// than the agent-base image and Chromium tabs eat into the budget fast.
const BROWSER_SIDECAR_MEMORY_MIB = 1536
const BROWSER_SIDECAR_CPUS = 1
const BROWSER_SIDECAR_CREATE_TIMEOUT_MS = 90_000
const BROWSER_SIDECAR_INSPECT_TIMEOUT_MS = 5_000

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
	// When true, the session VM gets `--net-rule allow@private` so it can reach
	// a sibling sidecar VM (the browser sidecar provisioned for bet-qa runs)
	// over the msb bridge. Off by default — only flagged sessions pay for it.
	allowPrivateNet?: boolean
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

export type MicrosandboxDeps = {
	msbBin: string
	run?: CommandRunner
	sleep?: (ms: number) => Promise<void>
	now?: () => number
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
	allowPrivateNet?: boolean
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
	if (input.allowPrivateNet) {
		args.push('--net-rule', PRIVATE_NET_RULE)
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
		...(input.allowPrivateNet !== undefined && { allowPrivateNet: input.allowPrivateNet }),
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
		// the same name on retry. Failures here are swallowed deliberately —
		// the original create error is the real signal.
		try {
			await run(deps.msbBin, ['remove', '-f', '--quiet', input.sessionId], { timeoutMs: 15_000 })
		} catch {
			/* ignored */
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
		} catch {
			/* ignored */
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

// IPv4 dotted-quad — what we expect to see in `msb inspect` output for a
// microVM on the msb bridge network. Used to find the sidecar's address
// without binding to a specific JSON shape (which has drifted between msb
// versions and is not part of any stable contract).
const IPV4_RE =
	/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/

// Loopback and link-local ranges that show up in `msb inspect` output but are
// not the bridge-routable address we want for sidecar-to-session traffic.
function isReachableBridgeIp(ip: string): boolean {
	if (ip.startsWith('127.') || ip === '0.0.0.0') return false
	if (ip.startsWith('169.254.')) return false
	return true
}

export type SandboxInspection = {
	ip: string
}

/**
 * Resolve a running sandbox's bridge IP via `msb inspect <name>`. msb's
 * inspect output is not a stable JSON contract across versions, so we scan
 * for the first reachable IPv4 address rather than parsing a known shape —
 * loopback (`127.x`) and link-local (`169.254.x`) addresses are skipped so we
 * don't hand the session a self-pointing URL.
 */
export async function inspectSandbox(
	name: string,
	deps: MicrosandboxDeps,
): Promise<SandboxInspection> {
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	const { stdout } = await run(deps.msbBin, ['inspect', name], {
		timeoutMs: BROWSER_SIDECAR_INSPECT_TIMEOUT_MS,
	})
	const matches = stdout.match(new RegExp(IPV4_RE.source, 'g')) ?? []
	const ip = matches.find(isReachableBridgeIp)
	if (!ip) {
		throw new Error(`msb inspect ${name}: no reachable bridge IP found`)
	}
	return { ip }
}

export type BrowserSidecar = {
	name: string
	cdpUrl: string
}

/**
 * Provision a Chromium-only sidecar microVM running `browser-sidecar`
 * for bet-qa sessions. Returns the sidecar name and a `ws://<ip>:9222` CDP
 * URL the session VM can hand to `@playwright/mcp`. The session VM must be
 * spawned with `allowPrivateNet: true` for the bridge address to be reachable.
 *
 * Returns `null` on any failure — the caller falls back to a session without
 * browser capability and reports the instrumentation gap. We never throw past
 * the session boundary: a failed sidecar must not take down an otherwise-fine
 * session, only the bet-qa step the agent would have run.
 */
export async function provisionBrowserSidecar(
	prefix: string,
	deps: MicrosandboxDeps,
	options: { settleMs?: number } = {},
): Promise<BrowserSidecar | null> {
	const name = `anko-browser-${prefix}`
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	const sleep = deps.sleep ?? defaultSleep
	const now = deps.now ?? Date.now
	const settleMs = options.settleMs ?? BROWSER_SIDECAR_SETTLE_MS

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
		// Sidecar reaches public IPs (Chromium fetches its own assets in some
		// flows) and DNS, but no other rules — it does NOT need allow@host.
		'--net-rule',
		PUBLIC_EGRESS_RULE,
		'--net-rule',
		DNS_UDP_RULE,
		'--net-rule',
		DNS_TCP_RULE,
		BROWSER_SIDECAR_IMAGE,
	]

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
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], { timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS }).catch(() => {})
		return null
	}

	try {
		await waitForRunning(deps.msbBin, name, { run, sleep, now })
	} catch (err) {
		logger.error('browser sidecar did not reach Running', { name, error: String(err) })
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], { timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS }).catch(() => {})
		return null
	}

	// Chromium's CDP listener binds a beat after the VM reports Running.
	await sleep(settleMs)

	let inspection: SandboxInspection
	try {
		inspection = await inspectSandbox(name, deps)
	} catch (err) {
		logger.error('browser sidecar inspect failed', { name, error: String(err) })
		await run(deps.msbBin, ['remove', '-f', '--quiet', name], { timeoutMs: BROWSER_SIDECAR_REMOVE_TIMEOUT_MS }).catch(() => {})
		return null
	}

	const cdpUrl = `ws://${inspection.ip}:${BROWSER_CDP_PORT}`
	logger.info('browser sidecar started', { name, cdpUrl })
	return { name, cdpUrl }
}

/**
 * Tear down a sidecar provisioned by `provisionBrowserSidecar`. Idempotent —
 * a missing or already-removed sandbox returns cleanly. Called from
 * `monitorSession` after the session VM exits so we don't leave Chromium VMs
 * orphaned on the host.
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
