import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExecEvent, Sandbox } from 'microsandbox'
import { logger } from '../lib/logger'
import type {
	ExecResult,
	LogChunk,
	RuntimeBackend,
	SandboxCreateOptions,
	SandboxStatus as SandboxStatusType,
} from './runtime-backend'

/**
 * Spawn sandbox creation in a child process.
 *
 * Sandbox.create() fails with a handshake timeout when called from
 * within the agent-server's long-running process, but works in standalone
 * scripts. As a workaround, we use Sandbox.createDetached() in a
 * short-lived child process, then reconnect from the parent via
 * Sandbox.get().connect().
 */
function spawnSandboxCreate(config: {
	name: string
	image: string
	memoryMib: number
	cpus: number
	env: Record<string, string>
	volumePaths: Array<{ guest: string; host: string; readonly: boolean }>
	maxDurationSecs?: number
}): void {
	const script = `
const { Sandbox, Mount, NetworkPolicy } = require('microsandbox');
const config = JSON.parse(process.argv[1]);
const volumes = {};
for (const v of config.volumePaths) {
  volumes[v.guest] = Mount.bind(v.host, { readonly: v.readonly });
}
const opts = {
  name: config.name,
  image: config.image,
  memoryMib: config.memoryMib,
  cpus: config.cpus,
  env: config.env,
  volumes,
  network: NetworkPolicy.allowAll(),
  replace: true,
  quietLogs: true,
  pullPolicy: 'always',
};
if (config.maxDurationSecs !== undefined) {
  opts.maxDurationSecs = config.maxDurationSecs;
}
Sandbox.createDetached(opts).then(() => {
  process.exit(0);
}).catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});
`
	execFileSync(
		process.execPath,
		['-e', script, JSON.stringify(config)],
		{ timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
	)
	// If we get here, the child exited successfully
}

export class MicrosandboxBackend implements RuntimeBackend {
	private sandboxes = new Map<string, Sandbox>()
	private exitCodes = new Map<string, number>()
	private startTimes = new Map<string, string>()
	private finishTimes = new Map<string, string>()
	private createOptions = new Map<string, SandboxCreateOptions>()

	async ensureImage(_image: string, _buildContext?: string): Promise<void> {
		// Microsandbox pulls OCI images automatically on create.
	}

	async create(options: SandboxCreateOptions): Promise<string> {
		// Store options — Sandbox.create() both creates and boots the VM,
		// so actual creation is deferred to start().
		this.createOptions.set(options.name, options)
		logger.info(`Microsandbox config stored: ${options.name}`, { image: options.image })
		return options.name
	}

	async start(sandboxId: string): Promise<void> {
		const options = this.createOptions.get(sandboxId)
		if (!options) {
			throw new Error(`No create options for sandbox: ${sandboxId}`)
		}

		const volumePaths: Array<{ guest: string; host: string; readonly: boolean }> = []
		let agentHostPath: string | undefined
		for (const bind of options.binds) {
			const [source, dest, mode] = bind.split(':')
			if (source && dest) {
				volumePaths.push({ guest: dest, host: source, readonly: mode === 'ro' })
				if (dest === '/agent') agentHostPath = source
			}
		}

		// agent-base image sets WORKDIR=/agent/workspace, but our bind mount
		// replaces /agent entirely. Pre-create the subdirs the image expects.
		if (agentHostPath) {
			for (const sub of ['workspace', 'skills', 'learnings', 'memory']) {
				mkdirSync(join(agentHostPath, sub), { recursive: true })
			}
		}

		// libkrun constraints on env vars:
		//  1. Values must be printable ASCII only.
		//  2. Values over ~1500 chars cause a handshake failure at boot.
		const OVERFLOW_THRESHOLD = 1500
		const sanitizedEnv: Record<string, string> = {}
		const overflowEntries: Array<{ key: string; value: string }> = []
		for (const [key, value] of Object.entries(options.env)) {
			const clean = value.replace(/[^\x20-\x7E]/g, '')
			if (clean !== value) {
				logger.warn(`Sanitized env var ${key}`, {
					originalLen: value.length,
					cleanLen: clean.length,
					removed: value.length - clean.length,
				})
			}
			if (clean.length > OVERFLOW_THRESHOLD && agentHostPath) {
				overflowEntries.push({ key, value: clean })
			} else {
				sanitizedEnv[key] = clean
			}
		}

		if (overflowEntries.length > 0 && agentHostPath) {
			const lines = overflowEntries.map(({ key, value }) => {
				const escaped = value.replace(/'/g, "'\\''")
				return `export ${key}='${escaped}'`
			})
			writeFileSync(join(agentHostPath, '.env-overflow.sh'), `${lines.join('\n')}\n`, {
				mode: 0o600,
			})
			logger.info(`Wrote ${overflowEntries.length} overflow env vars to /agent/.env-overflow.sh`, {
				keys: overflowEntries.map((e) => e.key),
			})
		}

		// Spawn sandbox creation in a child process. Sandbox.create() fails
		// with a handshake timeout when called from the agent-server process
		// but works in standalone scripts — likely a NAPI/libuv interaction.
		try {
			spawnSandboxCreate({
				name: options.name,
				image: options.image,
				memoryMib: options.memoryMb,
				cpus: Math.max(1, Math.round(options.cpuShares / 1024)),
				env: sanitizedEnv,
				volumePaths,
				...(options.maxDurationSecs !== undefined && {
					maxDurationSecs: options.maxDurationSecs,
				}),
			})
		} catch (err) {
			const stderr =
				err instanceof Error && 'stderr' in err
					? String((err as { stderr: unknown }).stderr)
					: String(err)
			throw new Error(`Sandbox creation failed: ${stderr}`)
		}

		// Reconnect to the detached sandbox from the parent process
		const handle = await Sandbox.get(options.name)
		const sandbox = await handle.connect()

		this.sandboxes.set(sandboxId, sandbox)
		this.startTimes.set(sandboxId, new Date().toISOString())
		logger.info(`Microsandbox started: ${sandboxId}`)
	}

	private resolveExit(sandboxId: string, exitCode: number): void {
		if (!this.exitCodes.has(sandboxId)) {
			this.exitCodes.set(sandboxId, exitCode)
			this.finishTimes.set(sandboxId, new Date().toISOString())
		}
	}

	async *logs(sandboxId: string): AsyncGenerator<LogChunk> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) return

		try {
			const handle = await sandbox.shellStream('/entrypoint.sh')
			let event: ExecEvent | null = await handle.recv()
			while (event !== null) {
				if (event.eventType === 'stdout' && event.data) {
					yield { stream: 'stdout', data: event.data.toString() }
				} else if (event.eventType === 'stderr' && event.data) {
					yield { stream: 'stderr', data: event.data.toString() }
				} else if (event.eventType === 'exited') {
					this.resolveExit(sandboxId, event.code ?? 1)
				}
				event = await handle.recv()
			}
			if (!this.exitCodes.has(sandboxId)) {
				this.resolveExit(sandboxId, 0)
			}
		} catch (err) {
			logger.error(`Log streaming error: ${sandboxId}`, { error: err })
			this.resolveExit(sandboxId, 1)
		}
	}

	async onExit(sandboxId: string): Promise<{ exitCode: number }> {
		const exitCode = this.exitCodes.get(sandboxId)
		if (exitCode !== undefined) {
			return { exitCode }
		}

		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}

		const status = await sandbox.wait()
		this.resolveExit(sandboxId, status.code)
		return { exitCode: status.code }
	}

	async stop(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}
		await sandbox.kill()
		this.resolveExit(sandboxId, 137)
		logger.info(`Microsandbox stopped: ${sandboxId}`)
	}

	async remove(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (sandbox) {
			try {
				await sandbox.kill()
			} catch {
				// Already stopped
			}
		}
		this.resolveExit(sandboxId, 137)
		try {
			await Sandbox.remove(sandboxId)
		} catch {
			// May already be removed
		}
		this.sandboxes.delete(sandboxId)
		this.exitCodes.delete(sandboxId)
		this.startTimes.delete(sandboxId)
		this.finishTimes.delete(sandboxId)
		this.createOptions.delete(sandboxId)
		logger.info(`Microsandbox removed: ${sandboxId}`)
	}

	async inspect(sandboxId: string): Promise<SandboxStatusType> {
		const running = this.sandboxes.has(sandboxId) && !this.exitCodes.has(sandboxId)
		const exitCode = this.exitCodes.get(sandboxId) ?? null
		const startedAt = this.startTimes.get(sandboxId) ?? null
		const finishedAt = this.finishTimes.get(sandboxId) ?? null

		return { running, exitCode, startedAt, finishedAt }
	}

	async exec(sandboxId: string, cmd: string[]): Promise<ExecResult> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}
		if (!cmd[0]) {
			throw new Error('Command array must not be empty')
		}

		const result = await sandbox.exec(cmd[0], cmd.slice(1))
		return {
			exitCode: result.code,
			output: result.stdout() + result.stderr(),
		}
	}

	async copyFileOut(sandboxId: string, guestPath: string, hostPath: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}
		await sandbox.fs().copyToHost(guestPath, hostPath)
	}

	async copyFileIn(sandboxId: string, hostPath: string, guestPath: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}
		await sandbox.fs().copyFromHost(hostPath, guestPath)
	}

	getHostAddress(): string {
		return '172.17.0.1'
	}
}
