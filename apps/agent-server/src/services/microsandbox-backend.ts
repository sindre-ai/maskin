import { type ExecEvent, Mount, NetworkPolicy, Sandbox } from 'microsandbox'
import { logger } from '../lib/logger'
import type {
	ExecResult,
	LogChunk,
	RuntimeBackend,
	SandboxCreateOptions,
	SandboxStatus as SandboxStatusType,
} from './runtime-backend'

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

		const volumes: Record<string, ReturnType<typeof Mount.bind>> = {}
		for (const bind of options.binds) {
			const [source, dest, mode] = bind.split(':')
			if (source && dest) {
				volumes[dest] = Mount.bind(source, { readonly: mode === 'ro' })
			}
		}

		// Diagnostic: log every env var's shape so we can find what libkrun rejects.
		const envDiag: Array<{ key: string; len: number; nonAscii: number; control: number }> = []
		for (const [key, value] of Object.entries(options.env)) {
			let nonAscii = 0
			let control = 0
			for (let i = 0; i < value.length; i++) {
				const code = value.charCodeAt(i)
				if (code > 0x7f) nonAscii++
				else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control++
			}
			envDiag.push({ key, len: value.length, nonAscii, control })
		}
		logger.info(`Sandbox env diagnostic for ${sandboxId}`, { vars: envDiag })

		// libkrun requires ASCII-only env var values — strip non-ASCII chars
		// (e.g. æøå in workspace names) to avoid InvalidAscii panic.
		const sanitizedEnv: Record<string, string> = {}
		for (const [key, value] of Object.entries(options.env)) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII filter
			const ascii = value.replace(/[^\x00-\x7F]/g, '')
			if (ascii !== value) {
				logger.warn(`Stripped non-ASCII chars from env var: ${key}`)
			}
			sanitizedEnv[key] = ascii
		}

		const sandbox = await Sandbox.create({
			name: options.name,
			image: options.image,
			memoryMib: options.memoryMb,
			cpus: Math.max(1, Math.round(options.cpuShares / 1024)),
			env: sanitizedEnv,
			volumes,
			network: NetworkPolicy.allowAll(),
			maxDurationSecs: options.maxDurationSecs,
			replace: true,
			quietLogs: true,
		})

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
