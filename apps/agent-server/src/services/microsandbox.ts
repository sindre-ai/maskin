import { execFile as execFileCb } from 'node:child_process'
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

// Whitelist on sessionId before it reaches an `msb` arg list or a host path.
// Same shape as T8's session-workspace.ts so the two halves stay aligned.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

// msb v0.5.4 `--net-rule allow@host:tcp:<port>` lets a microVM reach the
// agent-server on the host loopback directly. Replaces the v0.3.12 public-IP
// hairpin. Bet constraint #7.
const HOST_RULE_HOST = 'host'

const SESSION_GUEST_PATH = '/agent'
const SKELETON_SUBDIRS = ['workspace', 'skills', 'learnings', 'memory'] as const

const DEFAULT_MEMORY_MIB = 1024
const DEFAULT_CPUS = 1
const STATUS_POLL_INTERVAL_MS = 500
const STATUS_POLL_TIMEOUT_MS = 90_000
const CREATE_TIMEOUT_MS = 60_000

// `always` re-pulls every spawn; `missing` skips the network round-trip when the
// image is already cached locally (warm-pool hits use this). `never` is the
// libkrun-equivalent of an air-gap for tests.
export type PullPolicy = 'always' | 'missing' | 'never'

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
		'-v',
		`${input.sessionDir}:${SESSION_GUEST_PATH}`,
	]
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

	await waitForRunning(deps.msbBin, input.sessionId, { run, sleep, now })

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

export async function removeSandbox(name: string, deps: MicrosandboxDeps): Promise<void> {
	assertValidSessionId(name)
	const run = deps.run ?? defaultRunner()
	await run(deps.msbBin, ['remove', '-f', '--quiet', name], { timeoutMs: 15_000 })
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
