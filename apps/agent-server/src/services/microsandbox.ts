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
// can reach the Maskin API (maskin.sindre.ai), external MCP servers, etc.
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
 * Stream session output from the log file written by agent-run.sh.
 * agent-run.sh tees all claude/codex output to /agent/session.log inside the
 * VM, which maps to <sessionDir>/session.log on the host via the bind mount.
 * Uses `tail -F` so it tolerates the file not yet existing at call time (the
 * VM may still be booting). Resolves when `signal` is aborted. Rejects only
 * if `tail` cannot be spawned.
 */
export function streamSessionLogFile(
	logPath: string,
	onLine: (stream: 'stdout' | 'stderr', line: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn('tail', ['-F', '-n', '+1', logPath], { signal })

		const readLines = (data: Buffer, buf: { val: string }): void => {
			buf.val += data.toString('utf8')
			for (;;) {
				const nl = buf.val.indexOf('\n')
				if (nl === -1) break
				const line = buf.val.slice(0, nl + 1)
				buf.val = buf.val.slice(nl + 1)
				if (line.trimEnd()) onLine('stdout', line)
			}
		}

		const stdoutBuf = { val: '' }

		proc.stdout.on('data', (chunk: Buffer) => readLines(chunk, stdoutBuf))
		proc.stderr.on('data', () => {}) // tail's "file not found" warnings are noise

		proc.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
				resolve()
			} else {
				reject(err)
			}
		})

		proc.on('close', () => {
			if (stdoutBuf.val.trimEnd()) onLine('stdout', stdoutBuf.val)
			resolve()
		})
	})
}

/**
 * Stream stdout/stderr from a running microsandbox VM via `msb logs -f`.
 * Calls `onLine` for each newline-delimited output line. Resolves when the
 * process exits or `signal` is aborted. Rejects if the process cannot be
 * spawned (e.g. `msb` not found) — callers should catch and log.
 *
 * NOTE: microsandbox VMs run in PTY mode so application stdout goes through
 * the PTY, not the log buffer. This function only captures system/relay
 * messages. Use streamSessionLogFile() for actual session output.
 */
export function streamMsbLogs(
	msbBin: string,
	sessionId: string,
	onLine: (stream: 'stdout' | 'stderr', line: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	assertValidSessionId(sessionId)
	return new Promise((resolve, reject) => {
		const proc = spawn(msbBin, ['logs', '-f', '--source', 'all', sessionId], { signal })

		const readLines = (data: Buffer, stream: 'stdout' | 'stderr', buf: { val: string }): void => {
			buf.val += data.toString('utf8')
			for (;;) {
				const nl = buf.val.indexOf('\n')
				if (nl === -1) break
				const line = buf.val.slice(0, nl + 1)
				buf.val = buf.val.slice(nl + 1)
				if (line.trimEnd()) onLine(stream, line)
			}
		}

		const stdoutBuf = { val: '' }
		const stderrBuf = { val: '' }

		proc.stdout.on('data', (chunk: Buffer) => readLines(chunk, 'stdout', stdoutBuf))
		proc.stderr.on('data', (chunk: Buffer) => readLines(chunk, 'stderr', stderrBuf))

		proc.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
				resolve()
			} else {
				reject(err)
			}
		})

		proc.on('close', () => {
			if (stdoutBuf.val.trimEnd()) onLine('stdout', stdoutBuf.val)
			if (stderrBuf.val.trimEnd()) onLine('stderr', stderrBuf.val)
			resolve()
		})
	})
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
