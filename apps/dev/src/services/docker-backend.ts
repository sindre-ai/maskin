import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import Docker from 'dockerode'
import tar from 'tar-stream'
import { logger } from '../lib/logger'
import type {
	ExecResult,
	LogChunk,
	RuntimeBackend,
	SandboxCreateOptions,
	SandboxStatus,
} from './runtime-backend'

export class DockerBackend implements RuntimeBackend {
	private docker: Docker

	constructor() {
		this.docker = new Docker()
	}

	private async imageExists(image: string): Promise<boolean> {
		try {
			await this.docker.getImage(image).inspect()
			return true
		} catch {
			return false
		}
	}

	async ensureImage(image: string, buildContext?: string): Promise<void> {
		if (await this.imageExists(image)) {
			logger.info(`Image already exists: ${image}`)
			return
		}

		if (!buildContext) {
			logger.info(`Pulling image: ${image}`)
			const stream = await this.docker.pull(image)
			await new Promise<void>((resolve, reject) => {
				this.docker.modem.followProgress(stream, (err: Error | null) => {
					if (err) reject(err)
					else resolve()
				})
			})
			logger.info(`Image pulled: ${image}`)
			return
		}

		logger.info(`Building image: ${image} from ${buildContext}`)

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

		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(stream, (err: Error | null) => {
				if (err) reject(err)
				else resolve()
			})
		})

		logger.info(`Image built: ${image}`)
	}

	async create(options: SandboxCreateOptions): Promise<string> {
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

	async start(sandboxId: string): Promise<void> {
		const container = this.docker.getContainer(sandboxId)
		await container.start()
		logger.info(`Container started: ${sandboxId}`)
	}

	async stop(sandboxId: string): Promise<void> {
		const container = this.docker.getContainer(sandboxId)
		try {
			await container.stop({ t: 10 })
			logger.info(`Container stopped: ${sandboxId}`)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes('is not running')) return
			throw err
		}
	}

	async remove(sandboxId: string): Promise<void> {
		const container = this.docker.getContainer(sandboxId)
		try {
			await container.remove({ force: true })
			logger.info(`Container removed: ${sandboxId}`)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes('No such container')) return
			throw err
		}
	}

	async *logs(sandboxId: string): AsyncGenerator<LogChunk> {
		const container = this.docker.getContainer(sandboxId)
		// biome-ignore lint/suspicious/noExplicitAny: dockerode overload types don't resolve cleanly
		const stream: AsyncIterable<Buffer> = await (container as any).logs({
			follow: true,
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

	async inspect(sandboxId: string): Promise<SandboxStatus> {
		const container = this.docker.getContainer(sandboxId)
		const info = await container.inspect()
		return {
			running: info.State.Running,
			exitCode: info.State.ExitCode ?? null,
			startedAt: info.State.StartedAt ?? null,
			finishedAt: info.State.FinishedAt ?? null,
		}
	}

	async exec(sandboxId: string, cmd: string[]): Promise<ExecResult> {
		const container = this.docker.getContainer(sandboxId)
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

	async copyFileOut(sandboxId: string, guestPath: string, hostPath: string): Promise<void> {
		const container = this.docker.getContainer(sandboxId)
		const archiveStream = await container.getArchive({ path: guestPath })
		const targetName = basename(guestPath)

		await mkdir(dirname(hostPath), { recursive: true })

		const extract = tar.extract()
		const result = new Promise<void>((resolve, reject) => {
			extract.on('entry', (header, stream, next) => {
				if (header.name === targetName || header.name === `./${targetName}`) {
					const chunks: Buffer[] = []
					stream.on('data', (chunk: Buffer) => chunks.push(chunk))
					stream.on('end', async () => {
						await writeFile(hostPath, Buffer.concat(chunks))
						next()
					})
				} else {
					stream.resume()
					next()
				}
			})
			extract.on('finish', resolve)
			extract.on('error', reject)
		})
		;(archiveStream as unknown as NodeJS.ReadableStream).pipe(extract)
		await result
	}

	async copyFileIn(sandboxId: string, hostPath: string, guestPath: string): Promise<void> {
		const container = this.docker.getContainer(sandboxId)
		const destDir = dirname(guestPath)
		const destName = basename(guestPath)

		const pack = tar.pack()
		const fileStream = createReadStream(hostPath)
		const stat = statSync(hostPath)

		const entry = pack.entry({ name: destName, size: stat.size, mode: stat.mode })
		fileStream.pipe(entry)
		await new Promise<void>((resolve, reject) => {
			entry.on('finish', () => {
				pack.finalize()
				resolve()
			})
			entry.on('error', reject)
		})

		await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: destDir })
	}

	getHostAddress(): string {
		return 'host.docker.internal'
	}
}
