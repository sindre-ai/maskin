import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import Docker from 'dockerode'
import tar from 'tar-stream'
import { logger } from '../lib/logger'

export interface ContainerCreateOptions {
	image: string
	name: string
	env: Record<string, string>
	memoryMb: number
	cpuShares: number
	binds: string[]
	networkMode?: string
}

export interface LogChunk {
	stream: 'stdout' | 'stderr' | 'system'
	data: string
}

export interface ContainerStatus {
	running: boolean
	exitCode: number | null
	startedAt: string | null
	finishedAt: string | null
}

export class ContainerManager {
	private docker: Docker

	constructor() {
		this.docker = new Docker()
	}

	async ensureImage(image: string, buildContext: string): Promise<void> {
		logger.info(`Building image: ${image} from ${buildContext}`)

		// Pack build context into a tar stream for dockerode
		const pack = tar.pack()
		const addDir = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const fullPath = join(dir, entry.name)
				const relPath = relative(buildContext, fullPath)
				if (entry.isDirectory()) {
					addDir(fullPath)
				} else {
					const content = readFileSync(fullPath)
					const stat = statSync(fullPath)
					pack.entry({ name: relPath, size: content.length, mode: stat.mode }, content)
				}
			}
		}
		addDir(buildContext)
		pack.finalize()

		const stream = await this.docker.buildImage(pack as unknown as NodeJS.ReadableStream, {
			t: image,
		})

		// Wait for build to complete
		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(stream, (err: Error | null) => {
				if (err) reject(err)
				else resolve()
			})
		})

		logger.info(`Image built: ${image}`)
	}

	async create(options: ContainerCreateOptions): Promise<string> {
		const env = Object.entries(options.env).map(([k, v]) => `${k}=${v}`)

		const container = await this.docker.createContainer({
			Image: options.image,
			name: options.name,
			Env: env,
			HostConfig: {
				Memory: options.memoryMb * 1024 * 1024,
				CpuShares: options.cpuShares,
				Binds: options.binds,
				NetworkMode: options.networkMode ?? 'bridge',
				ExtraHosts: ['host.docker.internal:host-gateway'],
			},
		})

		logger.info(`Container created: ${container.id}`, { name: options.name })
		return container.id
	}

	async start(containerId: string): Promise<void> {
		const container = this.docker.getContainer(containerId)
		await container.start()
		logger.info(`Container started: ${containerId}`)
	}

	async stop(containerId: string, timeoutSeconds = 10): Promise<void> {
		const container = this.docker.getContainer(containerId)
		try {
			await container.stop({ t: timeoutSeconds })
			logger.info(`Container stopped: ${containerId}`)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes('is not running')) return
			throw err
		}
	}

	async remove(containerId: string): Promise<void> {
		const container = this.docker.getContainer(containerId)
		try {
			await container.remove({ force: true })
			logger.info(`Container removed: ${containerId}`)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes('No such container')) return
			throw err
		}
	}

	async *logs(containerId: string, follow = true): AsyncGenerator<LogChunk> {
		const container = this.docker.getContainer(containerId)
		// biome-ignore lint/suspicious/noExplicitAny: dockerode overload types don't resolve cleanly
		const stream: AsyncIterable<Buffer> = await (container as any).logs({
			follow,
			stdout: true,
			stderr: true,
			timestamps: false,
		})

		// Docker multiplexes stdout/stderr with an 8-byte header per frame:
		// byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
		// bytes 4-7: frame size (big-endian uint32)
		let buffer = Buffer.alloc(0)

		for await (const chunk of stream) {
			buffer = Buffer.concat([buffer, chunk])

			while (buffer.length >= 8) {
				const streamType = buffer[0]
				const frameSize = buffer.readUInt32BE(4)

				if (buffer.length < 8 + frameSize) break

				const data = buffer.subarray(8, 8 + frameSize).toString('utf-8')
				buffer = buffer.subarray(8 + frameSize)

				yield {
					stream: streamType === 2 ? 'stderr' : 'stdout',
					data,
				}
			}
		}
	}

	async inspect(containerId: string): Promise<ContainerStatus> {
		const container = this.docker.getContainer(containerId)
		const info = await container.inspect()
		return {
			running: info.State.Running,
			exitCode: info.State.ExitCode ?? null,
			startedAt: info.State.StartedAt ?? null,
			finishedAt: info.State.FinishedAt ?? null,
		}
	}

	async exec(containerId: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
		const container = this.docker.getContainer(containerId)
		const exec = await container.exec({
			Cmd: cmd,
			AttachStdout: true,
			AttachStderr: true,
		})

		const stream = await exec.start({ Detach: false, Tty: false })
		const chunks: Buffer[] = []

		for await (const chunk of stream as AsyncIterable<Buffer>) {
			chunks.push(chunk)
		}

		const inspectResult = await exec.inspect()
		return {
			exitCode: inspectResult.ExitCode ?? 1,
			output: Buffer.concat(chunks).toString('utf-8'),
		}
	}

	async copyTo(
		containerId: string,
		destPath: string,
		tarStream: NodeJS.ReadableStream,
	): Promise<void> {
		const container = this.docker.getContainer(containerId)
		await container.putArchive(tarStream, { path: destPath })
	}

	async copyFrom(containerId: string, srcPath: string): Promise<NodeJS.ReadableStream> {
		const container = this.docker.getContainer(containerId)
		return container.getArchive({ path: srcPath })
	}

	async listByPrefix(
		prefix: string,
	): Promise<Array<{ id: string; name: string; state: string }>> {
		const containers = await this.docker.listContainers({
			all: true,
			filters: { name: [prefix] },
		})
		return containers.map((c) => ({
			id: c.Id,
			name: c.Names[0]?.replace(/^\//, '') ?? '',
			state: c.State,
		}))
	}
}
