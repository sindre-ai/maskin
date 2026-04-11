import { type BaseSandbox, NodeSandbox } from 'microsandbox'
import { logger } from '../lib/logger'
import type {
	ExecResult,
	LogChunk,
	RuntimeBackend,
	SandboxCreateOptions,
	SandboxStatus,
} from './runtime-backend'

export class MicrosandboxBackend implements RuntimeBackend {
	private sandboxes = new Map<string, BaseSandbox>()
	private exitCodes = new Map<string, number>()
	private exitPromises = new Map<string, Promise<{ exitCode: number }>>()
	private exitResolvers = new Map<string, (result: { exitCode: number }) => void>()
	private startTimes = new Map<string, string>()
	private finishTimes = new Map<string, string>()
	private createOptions = new Map<string, SandboxCreateOptions>()

	async ensureImage(_image: string, _buildContext?: string): Promise<void> {
		// Microsandbox pulls OCI images automatically on start.
	}

	async create(options: SandboxCreateOptions): Promise<string> {
		const sandbox = await NodeSandbox.create({
			name: options.name,
			image: options.image,
			memory: options.memoryMb,
			cpus: Math.max(1, Math.round(options.cpuShares / 1024)),
		})
		this.sandboxes.set(options.name, sandbox)
		this.createOptions.set(options.name, options)
		logger.info(`Microsandbox created: ${options.name}`, { image: options.image })
		return options.name
	}

	async start(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}

		const options = this.createOptions.get(sandboxId)
		await sandbox.start(
			options?.image,
			options?.memoryMb,
			options ? Math.max(1, Math.round(options.cpuShares / 1024)) : undefined,
		)
		this.startTimes.set(sandboxId, new Date().toISOString())

		this.exitPromises.set(
			sandboxId,
			new Promise((resolve) => {
				this.exitResolvers.set(sandboxId, resolve)
			}),
		)

		logger.info(`Microsandbox started: ${sandboxId}`)
	}

	private resolveExit(sandboxId: string, exitCode: number): void {
		this.exitCodes.set(sandboxId, exitCode)
		this.finishTimes.set(sandboxId, new Date().toISOString())
		const resolver = this.exitResolvers.get(sandboxId)
		if (resolver) {
			resolver({ exitCode })
			this.exitResolvers.delete(sandboxId)
		}
	}

	async *logs(sandboxId: string): AsyncGenerator<LogChunk> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) return

		try {
			const result = await sandbox.command.run('/entrypoint.sh')
			const stdout = await result.output()
			const stderr = await result.error()
			if (stdout) {
				yield { stream: 'stdout', data: stdout }
			}
			if (stderr) {
				yield { stream: 'stderr', data: stderr }
			}
			this.resolveExit(sandboxId, result.exitCode)
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

		const promise = this.exitPromises.get(sandboxId)
		if (!promise) {
			throw new Error(`No exit promise for sandbox: ${sandboxId}`)
		}
		return promise
	}

	async stop(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}
		await sandbox.stop()
		this.resolveExit(sandboxId, 137)
		logger.info(`Microsandbox stopped: ${sandboxId}`)
	}

	async remove(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (sandbox) {
			try {
				await sandbox.stop()
			} catch {
				// Already stopped
			}
		}
		if (!this.exitCodes.has(sandboxId)) {
			this.resolveExit(sandboxId, 137)
		}
		this.sandboxes.delete(sandboxId)
		this.exitCodes.delete(sandboxId)
		this.exitPromises.delete(sandboxId)
		this.exitResolvers.delete(sandboxId)
		this.startTimes.delete(sandboxId)
		this.finishTimes.delete(sandboxId)
		this.createOptions.delete(sandboxId)
		logger.info(`Microsandbox removed: ${sandboxId}`)
	}

	async inspect(sandboxId: string): Promise<SandboxStatus> {
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
		const result = await sandbox.command.run(cmd[0], cmd.slice(1))
		const stdout = await result.output()
		const stderr = await result.error()
		return {
			exitCode: result.exitCode,
			output: stdout + stderr,
		}
	}

	async copyFileOut(sandboxId: string, guestPath: string, hostPath: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}

		const result = await sandbox.command.run('base64', [guestPath])
		const encoded = await result.output()
		if (result.exitCode !== 0) {
			throw new Error(`Failed to read file ${guestPath}: exit code ${result.exitCode}`)
		}

		const { writeFile } = await import('node:fs/promises')
		await writeFile(hostPath, Buffer.from(encoded.trim(), 'base64'))
	}

	async copyFileIn(sandboxId: string, hostPath: string, guestPath: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}

		const { readFile } = await import('node:fs/promises')
		const data = await readFile(hostPath)
		const encoded = data.toString('base64')

		const safeGuestPath = guestPath.replace(/'/g, "'\\''")
		await sandbox.command.run('sh', ['-c', `echo '${encoded}' | base64 -d > '${safeGuestPath}'`])
	}

	getHostAddress(): string {
		return '172.17.0.1'
	}
}
