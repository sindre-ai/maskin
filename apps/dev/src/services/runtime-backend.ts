/**
 * RuntimeBackend — abstraction over container/sandbox runtimes.
 *
 * Implementations:
 *  - DockerBackend   (Docker via dockerode)
 *  - MicrosandboxBackend (microsandbox microVMs) — future
 */

export interface SandboxCreateOptions {
	image: string
	name: string
	env: Record<string, string>
	memoryMb: number
	cpuShares: number
	binds: string[]
	networkMode?: string
	maxDurationSecs?: number
}

export interface LogChunk {
	stream: 'stdout' | 'stderr' | 'system'
	data: string
}

export interface SandboxStatus {
	running: boolean
	exitCode: number | null
	startedAt: string | null
	finishedAt: string | null
}

export interface ExecResult {
	exitCode: number
	output: string
}

export interface RuntimeBackend {
	/** Ensure the image is available (build or pull). */
	ensureImage(image: string, buildContext?: string): Promise<void>

	/** Create a new sandbox/container and return its ID. */
	create(options: SandboxCreateOptions): Promise<string>

	/** Start a previously created sandbox. */
	start(sandboxId: string): Promise<void>

	/** Stop a running sandbox. */
	stop(sandboxId: string): Promise<void>

	/** Remove a sandbox and clean up resources. */
	remove(sandboxId: string): Promise<void>

	/** Stream logs from the sandbox. */
	logs(sandboxId: string): AsyncGenerator<LogChunk>

	/** Inspect the current status of a sandbox. */
	inspect(sandboxId: string): Promise<SandboxStatus>

	/** Execute a command inside the sandbox. */
	exec(sandboxId: string, cmd: string[]): Promise<ExecResult>

	/** Copy a file from the sandbox to the host. */
	copyFileOut(sandboxId: string, guestPath: string, hostPath: string): Promise<void>

	/** Copy a file from the host into the sandbox. */
	copyFileIn(sandboxId: string, hostPath: string, guestPath: string): Promise<void>

	/** Return the address the sandbox should use to reach the host. */
	getHostAddress(): string

	/** Optional event-driven exit detection. Resolves when the sandbox process exits. */
	onExit?(sandboxId: string): Promise<{ exitCode: number }>
}

/**
 * Factory — reads RUNTIME_BACKEND env var and returns the appropriate backend.
 * Defaults to 'docker' if not set.
 */
export async function createRuntimeBackend(): Promise<RuntimeBackend> {
	const type = process.env.RUNTIME_BACKEND ?? 'docker'

	switch (type) {
		case 'docker': {
			const { DockerBackend } = await import('./docker-backend')
			return new DockerBackend()
		}
		case 'microsandbox': {
			const { MicrosandboxBackend } = await import('./microsandbox-backend')
			return new MicrosandboxBackend()
		}
		default:
			throw new Error(`Unknown RUNTIME_BACKEND: ${type}. Expected 'docker' or 'microsandbox'.`)
	}
}
