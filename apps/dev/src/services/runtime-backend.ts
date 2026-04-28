/**
 * RuntimeBackend type interfaces.
 *
 * Implementations have moved to @maskin/agent-server.
 * This file retains only the type exports used by session-manager.
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
	ensureImage(image: string, buildContext?: string): Promise<void>
	create(options: SandboxCreateOptions): Promise<string>
	start(sandboxId: string): Promise<void>
	stop(sandboxId: string): Promise<void>
	remove(sandboxId: string): Promise<void>
	logs(sandboxId: string): AsyncGenerator<LogChunk>
	inspect(sandboxId: string): Promise<SandboxStatus>
	exec(sandboxId: string, cmd: string[]): Promise<ExecResult>
	copyFileOut(sandboxId: string, guestPath: string, hostPath: string): Promise<void>
	copyFileIn(sandboxId: string, hostPath: string, guestPath: string): Promise<void>
	getHostAddress(): string
	onExit?(sandboxId: string): Promise<{ exitCode: number }>
}
