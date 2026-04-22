import { vi } from 'vitest'

// Mock dockerode
const mockContainer = {
	start: vi.fn(),
	stop: vi.fn(),
	remove: vi.fn(),
	inspect: vi.fn(),
	exec: vi.fn(),
	logs: vi.fn(),
	putArchive: vi.fn(),
	getArchive: vi.fn(),
}

const mockDocker = {
	createContainer: vi.fn().mockResolvedValue({ id: 'container-123' }),
	getContainer: vi.fn().mockReturnValue(mockContainer),
	buildImage: vi.fn(),
	modem: {
		followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
	},
}

vi.mock('dockerode', () => ({
	default: vi.fn().mockImplementation(function () {
		return mockDocker
	}),
}))

vi.mock('tar-stream', () => ({
	default: {
		pack: vi.fn().mockReturnValue({
			entry: vi.fn(),
			finalize: vi.fn(),
		}),
	},
}))

import { ContainerManager } from '../../services/container-manager'

describe('ContainerManager', () => {
	let manager: ContainerManager

	beforeEach(() => {
		vi.clearAllMocks()
		manager = new ContainerManager()
	})

	describe('create()', () => {
		it('creates a container with correct options', async () => {
			mockDocker.createContainer.mockResolvedValue({ id: 'new-container' })

			const id = await manager.create({
				image: 'test-image',
				name: 'test-container',
				env: { FOO: 'bar', BAZ: 'qux' },
				memoryMb: 512,
				cpuShares: 1024,
				binds: ['/host:/container'],
			})

			expect(id).toBe('new-container')
			expect(mockDocker.createContainer).toHaveBeenCalledWith({
				Image: 'test-image',
				name: 'test-container',
				Env: ['FOO=bar', 'BAZ=qux'],
				HostConfig: {
					Memory: 512 * 1024 * 1024,
					CpuShares: 1024,
					Binds: ['/host:/container'],
					NetworkMode: 'bridge',
					ExtraHosts: ['host.docker.internal:host-gateway'],
				},
			})
		})

		it('uses custom network mode', async () => {
			mockDocker.createContainer.mockResolvedValue({ id: 'c1' })

			await manager.create({
				image: 'img',
				name: 'c',
				env: {},
				memoryMb: 256,
				cpuShares: 512,
				binds: [],
				networkMode: 'host',
			})

			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({
					HostConfig: expect.objectContaining({ NetworkMode: 'host' }),
				}),
			)
		})
	})

	describe('start()', () => {
		it('starts the container', async () => {
			await manager.start('container-123')
			expect(mockContainer.start).toHaveBeenCalled()
		})
	})

	describe('stop()', () => {
		it('stops the container', async () => {
			await manager.stop('container-123')
			expect(mockContainer.stop).toHaveBeenCalledWith({ t: 10 })
		})

		it('handles "not running" error gracefully', async () => {
			mockContainer.stop.mockRejectedValue(new Error('container is not running'))

			await expect(manager.stop('container-123')).resolves.toBeUndefined()
		})

		it('rethrows other errors', async () => {
			mockContainer.stop.mockRejectedValue(new Error('network error'))

			await expect(manager.stop('container-123')).rejects.toThrow('network error')
		})
	})

	describe('remove()', () => {
		it('removes the container', async () => {
			await manager.remove('container-123')
			expect(mockContainer.remove).toHaveBeenCalledWith({ force: true })
		})

		it('handles "No such container" gracefully', async () => {
			mockContainer.remove.mockRejectedValue(new Error('No such container'))

			await expect(manager.remove('container-123')).resolves.toBeUndefined()
		})

		it('rethrows other errors', async () => {
			mockContainer.remove.mockRejectedValue(new Error('permission denied'))

			await expect(manager.remove('container-123')).rejects.toThrow('permission denied')
		})
	})

	describe('inspect()', () => {
		it('returns container status', async () => {
			mockContainer.inspect.mockResolvedValue({
				State: {
					Running: true,
					ExitCode: 0,
					StartedAt: '2024-01-01T00:00:00Z',
					FinishedAt: null,
				},
			})

			const status = await manager.inspect('container-123')

			expect(status).toEqual({
				running: true,
				exitCode: 0,
				startedAt: '2024-01-01T00:00:00Z',
				finishedAt: null,
			})
		})
	})

	describe('exec()', () => {
		it('runs command and returns output', async () => {
			const mockExec = {
				start: vi.fn().mockResolvedValue({
					[Symbol.asyncIterator]: async function* () {
						yield Buffer.from('hello world')
					},
				}),
				inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
			}
			mockContainer.exec.mockResolvedValue(mockExec)

			const result = await manager.exec('container-123', ['echo', 'hello'])

			expect(result.exitCode).toBe(0)
			expect(result.output).toContain('hello world')
			expect(mockContainer.exec).toHaveBeenCalledWith({
				Cmd: ['echo', 'hello'],
				AttachStdout: true,
				AttachStderr: true,
			})
		})
	})

	describe('logs()', () => {
		function buildDockerFrame(streamType: number, data: string): Buffer {
			const payload = Buffer.from(data, 'utf-8')
			const header = Buffer.alloc(8)
			header[0] = streamType // 1 = stdout, 2 = stderr
			header.writeUInt32BE(payload.length, 4)
			return Buffer.concat([header, payload])
		}

		it('demultiplexes stdout and stderr frames', async () => {
			const frames = Buffer.concat([
				buildDockerFrame(1, 'stdout line\n'),
				buildDockerFrame(2, 'stderr line\n'),
			])

			mockContainer.logs.mockResolvedValue({
				[Symbol.asyncIterator]: async function* () {
					yield frames
				},
			})

			const chunks: Array<{ stream: string; data: string }> = []
			for await (const chunk of manager.logs('container-123')) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2)
			expect(chunks[0]).toEqual({ stream: 'stdout', data: 'stdout line\n' })
			expect(chunks[1]).toEqual({ stream: 'stderr', data: 'stderr line\n' })
		})

		it('handles split frames across chunks', async () => {
			const frame = buildDockerFrame(1, 'complete')
			const part1 = frame.subarray(0, 4)
			const part2 = frame.subarray(4)

			mockContainer.logs.mockResolvedValue({
				[Symbol.asyncIterator]: async function* () {
					yield part1
					yield part2
				},
			})

			const chunks: Array<{ stream: string; data: string }> = []
			for await (const chunk of manager.logs('container-123')) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(1)
			expect(chunks[0].data).toBe('complete')
		})
	})

	describe('copyTo()', () => {
		it('copies tar stream to container', async () => {
			const stream = {} as NodeJS.ReadableStream
			await manager.copyTo('container-123', '/dest', stream)
			expect(mockContainer.putArchive).toHaveBeenCalledWith(stream, { path: '/dest' })
		})
	})

	describe('copyFrom()', () => {
		it('gets archive from container', async () => {
			const mockStream = {} as NodeJS.ReadableStream
			mockContainer.getArchive.mockResolvedValue(mockStream)

			const result = await manager.copyFrom('container-123', '/src')
			expect(result).toBe(mockStream)
			expect(mockContainer.getArchive).toHaveBeenCalledWith({ path: '/src' })
		})
	})
})
