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
	private startTimes = new Map<string, string>()
	private finishTimes = new Map<string, string>()

	async ensureImage(_image: string, _buildContext?: string): Promise<void> {
		// Microsandbox pulls OCI images automatically in Sandbox.create().
		// No-op for now — first sandbox creation will pull the image.
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

		this.exitPromises.set(sandboxId, this.watchExecHandle(sandboxId, handle))

		logger.info(`Microsandbox started: ${sandboxId}`)
	}

	private async watchExecHandle(sandboxId: string, handle: ExecHandle): Promise<{ exitCode: number }> {
		try {
			while (true) {
				const event = await handle.recv()
				if (!event) break
				if (event.type === 'exited') {
					const exitCode = event.exitCode ?? 1
					this.exitCodes.set(sandboxId, exitCode)
					this.finishTimes.set(sandboxId, new Date().toISOString())
					logger.info(`Microsandbox process exited: ${sandboxId}`, { exitCode })
					return { exitCode }
				}
			}
		} catch (err) {
			logger.error(`Microsandbox exec handle error: ${sandboxId}`, { error: err })
			this.exitCodes.set(sandboxId, 1)
			this.finishTimes.set(sandboxId, new Date().toISOString())
		}
		return { exitCode: this.exitCodes.get(sandboxId) ?? 1 }
	}

	async onExit(sandboxId: string): Promise<{ exitCode: number }> {
		const promise = this.exitPromises.get(sandboxId)
		if (!promise) {
			const exitCode = this.exitCodes.get(sandboxId)
			if (exitCode !== undefined) {
				return { exitCode }
			}
			throw new Error(`No exit promise for sandbox: ${sandboxId}`)
		}
		return promise
	}

	async stop(_sandboxId: string): Promise<void> {
		throw new Error('MicrosandboxBackend.stop() is not yet implemented.')
	}

	async remove(_sandboxId: string): Promise<void> {
		throw new Error('MicrosandboxBackend.remove() is not yet implemented.')
	}

	async *logs(_sandboxId: string): AsyncGenerator<LogChunk> {
		throw new Error('MicrosandboxBackend.logs() is not yet implemented.')
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
		// Microsandbox VMs use hypervisor isolation — host.docker.internal does not exist.
		// The correct host address depends on the microsandbox network config and needs testing.
		throw new Error('MicrosandboxBackend.getHostAddress() is not yet implemented.')
	}
}
