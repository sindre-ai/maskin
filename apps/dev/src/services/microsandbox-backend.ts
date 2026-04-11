import { type ExecHandle, Mount, Sandbox } from 'microsandbox'
import { logger } from '../lib/logger'
import type {
	ExecResult,
	LogChunk,
	RuntimeBackend,
	SandboxCreateOptions,
	SandboxStatus,
} from './runtime-backend'

export class MicrosandboxBackend implements RuntimeBackend {
	private sandboxes = new Map<string, Sandbox>()
	private execHandles = new Map<string, ExecHandle>()
	private exitCodes = new Map<string, number>()
	private exitPromises = new Map<string, Promise<{ exitCode: number }>>()
	private exitResolvers = new Map<string, (result: { exitCode: number }) => void>()
	private startTimes = new Map<string, string>()
	private finishTimes = new Map<string, string>()
	private logsConsuming = new Set<string>()

	async ensureImage(_image: string, _buildContext?: string): Promise<void> {
		// Microsandbox pulls OCI images automatically in Sandbox.create().
	}

	async create(options: SandboxCreateOptions): Promise<string> {
		const sandbox = await Sandbox.create({
			name: options.name,
			image: options.image,
			memoryMib: options.memoryMb,
			cpus: Math.max(1, Math.round(options.cpuShares / 1024)),
			env: options.env,
			volumes: this.parseBinds(options.binds),
			cmd: ['sleep', 'infinity'],
			maxDurationSecs: options.maxDurationSecs,
		})
		this.sandboxes.set(options.name, sandbox)
		logger.info(`Microsandbox created: ${options.name}`, { image: options.image })
		return options.name
	}

	parseBinds(binds: string[]): Record<string, Mount> {
		const volumes: Record<string, Mount> = {}
		for (const bind of binds) {
			const parts = bind.split(':')
			if (parts.length < 2) continue
			const hostPath = parts[0]
			const guestPath = parts[1]
			const mode = parts[2] ?? 'rw'
			volumes[guestPath] = Mount.bind(hostPath, { readonly: mode === 'ro' })
		}
		return volumes
	}

	async start(sandboxId: string): Promise<void> {
		const sandbox = this.sandboxes.get(sandboxId)
		if (!sandbox) {
			throw new Error(`Sandbox not found: ${sandboxId}`)
		}

		const handle = await sandbox.execStream('/entrypoint.sh')
		this.execHandles.set(sandboxId, handle)
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
		const handle = this.execHandles.get(sandboxId)
		if (!handle) return

		this.logsConsuming.add(sandboxId)
		try {
			while (true) {
				const event = await handle.recv()
				if (!event) break
				if (event.type === 'stdout') {
					yield { stream: 'stdout', data: event.data.toString() }
				} else if (event.type === 'stderr') {
					yield { stream: 'stderr', data: event.data.toString() }
				} else if (event.type === 'exited') {
					this.resolveExit(sandboxId, event.exitCode ?? 1)
					break
				}
			}
		} catch (err) {
			logger.error(`Log streaming error: ${sandboxId}`, { error: err })
			this.resolveExit(sandboxId, 1)
		} finally {
			this.logsConsuming.delete(sandboxId)
		}
	}

	async onExit(sandboxId: string): Promise<{ exitCode: number }> {
		const exitCode = this.exitCodes.get(sandboxId)
		if (exitCode !== undefined) {
			return { exitCode }
		}

		if (!this.logsConsuming.has(sandboxId)) {
			this.drainEvents(sandboxId)
		}

		const promise = this.exitPromises.get(sandboxId)
		if (!promise) {
			throw new Error(`No exit promise for sandbox: ${sandboxId}`)
		}
		return promise
	}

	private async drainEvents(sandboxId: string): Promise<void> {
		const handle = this.execHandles.get(sandboxId)
		if (!handle) return

		try {
			while (true) {
				const event = await handle.recv()
				if (!event) break
				if (event.type === 'exited') {
					this.resolveExit(sandboxId, event.exitCode ?? 1)
					break
				}
			}
		} catch (err) {
			logger.error(`Drain events error: ${sandboxId}`, { error: err })
			this.resolveExit(sandboxId, 1)
		}
	}

	async stop(_sandboxId: string): Promise<void> {
		throw new Error('MicrosandboxBackend.stop() is not yet implemented.')
	}

	async remove(_sandboxId: string): Promise<void> {
		throw new Error('MicrosandboxBackend.remove() is not yet implemented.')
	}

	async inspect(_sandboxId: string): Promise<SandboxStatus> {
		throw new Error('MicrosandboxBackend.inspect() is not yet implemented.')
	}

	async exec(_sandboxId: string, _cmd: string[]): Promise<ExecResult> {
		throw new Error('MicrosandboxBackend.exec() is not yet implemented.')
	}

	async copyFileOut(_sandboxId: string, _guestPath: string, _hostPath: string): Promise<void> {
		throw new Error('MicrosandboxBackend.copyFileOut() is not yet implemented.')
	}

	async copyFileIn(_sandboxId: string, _hostPath: string, _guestPath: string): Promise<void> {
		throw new Error('MicrosandboxBackend.copyFileIn() is not yet implemented.')
	}

	getHostAddress(): string {
		throw new Error('MicrosandboxBackend.getHostAddress() is not yet implemented.')
	}
}
