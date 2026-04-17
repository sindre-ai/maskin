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
	attach: vi.fn(),
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
	default: vi.fn().mockImplementation(() => mockDocker),
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

function makeStream(
	overrides: Partial<{
		write: (line: string, cb: (err?: Error | null) => void) => void
		end: () => void
	}> = {},
) {
	const listeners = new Map<string, Array<(arg?: unknown) => void>>()
	const stream = {
		write: overrides.write ?? vi.fn((_line: string, cb: (err?: Error | null) => void) => cb()),
		end: overrides.end ?? vi.fn(),
		on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
			const list = listeners.get(event) ?? []
			list.push(cb)
			listeners.set(event, list)
			return stream
		}),
		emit: (event: string, arg?: unknown) => {
			for (const cb of listeners.get(event) ?? []) cb(arg)
		},
	}
	return stream
}

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

		it('attaches stdin and sets INTERACTIVE=1 when interactive is true', async () => {
			mockDocker.createContainer.mockResolvedValue({ id: 'interactive-container' })

			await manager.create({
				image: 'test-image',
				name: 'interactive',
				env: { FOO: 'bar' },
				memoryMb: 256,
				cpuShares: 512,
				binds: [],
				interactive: true,
			})

			expect(mockDocker.createContainer).toHaveBeenCalledWith(
				expect.objectContaining({
					Env: expect.arrayContaining(['FOO=bar', 'INTERACTIVE=1']),
					AttachStdin: true,
					OpenStdin: true,
					StdinOnce: false,
					Tty: false,
				}),
			)
		})

		it('does not set stdin flags or INTERACTIVE when interactive is false/unset', async () => {
			mockDocker.createContainer.mockResolvedValue({ id: 'regular-container' })

			await manager.create({
				image: 'test-image',
				name: 'regular',
				env: { FOO: 'bar' },
				memoryMb: 256,
				cpuShares: 512,
				binds: [],
			})

			const call = mockDocker.createContainer.mock.calls[0][0]
			expect(call).not.toHaveProperty('AttachStdin')
			expect(call).not.toHaveProperty('OpenStdin')
			expect(call).not.toHaveProperty('StdinOnce')
			expect(call).not.toHaveProperty('Tty')
			expect(call.Env).not.toContain('INTERACTIVE=1')
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

	describe('attachStdin() / getStdinStream() / detachStdin()', () => {
		it('attaches stdin and stores the stream keyed by sessionId', async () => {
			const stream = makeStream()
			mockContainer.attach.mockResolvedValue(stream)

			await manager.attachStdin('session-1', 'container-xyz')

			expect(mockDocker.getContainer).toHaveBeenCalledWith('container-xyz')
			expect(mockContainer.attach).toHaveBeenCalledWith({
				stream: true,
				stdin: true,
				hijack: true,
			})
			expect(manager.getStdinStream('session-1')).toBe(stream)
		})

		it('getStdinStream returns undefined when no stream is attached', () => {
			expect(manager.getStdinStream('unknown')).toBeUndefined()
		})

		it('detachStdin ends the stream and removes it from the map', async () => {
			const stream = makeStream()
			mockContainer.attach.mockResolvedValue(stream)

			await manager.attachStdin('session-2', 'container-xyz')
			manager.detachStdin('session-2')

			expect(stream.end).toHaveBeenCalled()
			expect(manager.getStdinStream('session-2')).toBeUndefined()
		})

		it('detachStdin is a no-op when no stream is attached', () => {
			expect(() => manager.detachStdin('unknown')).not.toThrow()
		})

		it('detachStdin swallows errors from stream.end()', async () => {
			const stream = makeStream({
				end: vi.fn(() => {
					throw new Error('already closed')
				}),
			})
			mockContainer.attach.mockResolvedValue(stream)

			await manager.attachStdin('session-3', 'container-xyz')

			expect(() => manager.detachStdin('session-3')).not.toThrow()
			expect(manager.getStdinStream('session-3')).toBeUndefined()
		})
	})

	describe('write() reconnect/retry', () => {
		const payload = {
			type: 'user' as const,
			message: { role: 'user' as const, content: 'hello' },
		}

		it('writes the serialized payload to the attached stream on the happy path', async () => {
			const stream = makeStream()
			mockContainer.attach.mockResolvedValue(stream)

			await manager.attachStdin('s', 'c-1')
			await manager.write('s', payload)

			expect(stream.write).toHaveBeenCalledTimes(1)
			const writtenLine = (stream.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect(writtenLine).toBe(`${JSON.stringify(payload)}\n`)
		})

		it('throws when no stream was ever attached for the session', async () => {
			await expect(manager.write('never-attached', payload)).rejects.toThrow(
				'No stdin stream attached for session never-attached',
			)
		})

		it('reconnects and retries once when the stream write fails, then succeeds', async () => {
			const failingStream = makeStream({
				write: vi.fn((_line: string, cb: (err?: Error | null) => void) =>
					cb(new Error('stdin write EPIPE')),
				),
			})
			const recoveredStream = makeStream()
			mockContainer.attach
				.mockResolvedValueOnce(failingStream)
				.mockResolvedValueOnce(recoveredStream)

			await manager.attachStdin('s', 'c-1')
			await manager.write('s', payload)

			// First attach for attachStdin, second attach for reconnect.
			expect(mockContainer.attach).toHaveBeenCalledTimes(2)
			expect(recoveredStream.write).toHaveBeenCalledTimes(1)
			// After reconnect, getStdinStream returns the new stream.
			expect(manager.getStdinStream('s')).toBe(recoveredStream)
		})

		it('reconnects when the attached stream has already ended before write', async () => {
			const endedStream = makeStream()
			const recoveredStream = makeStream()
			mockContainer.attach.mockResolvedValueOnce(endedStream).mockResolvedValueOnce(recoveredStream)

			await manager.attachStdin('s', 'c-1')
			// Simulate unexpected end event on the original stream.
			endedStream.emit('end')

			await manager.write('s', payload)

			expect(mockContainer.attach).toHaveBeenCalledTimes(2)
			expect(endedStream.write).not.toHaveBeenCalled()
			expect(recoveredStream.write).toHaveBeenCalledTimes(1)
		})

		it('reconnects when the attached stream errored before write', async () => {
			const erroredStream = makeStream()
			const recoveredStream = makeStream()
			mockContainer.attach
				.mockResolvedValueOnce(erroredStream)
				.mockResolvedValueOnce(recoveredStream)

			await manager.attachStdin('s', 'c-1')
			erroredStream.emit('error', new Error('connection reset'))

			await manager.write('s', payload)

			expect(mockContainer.attach).toHaveBeenCalledTimes(2)
			expect(recoveredStream.write).toHaveBeenCalledTimes(1)
		})

		it('propagates the error if the retried write also fails', async () => {
			const firstStream = makeStream({
				write: vi.fn((_line: string, cb: (err?: Error | null) => void) =>
					cb(new Error('first write failed')),
				),
			})
			const secondStream = makeStream({
				write: vi.fn((_line: string, cb: (err?: Error | null) => void) =>
					cb(new Error('retry write failed')),
				),
			})
			mockContainer.attach.mockResolvedValueOnce(firstStream).mockResolvedValueOnce(secondStream)

			await manager.attachStdin('s', 'c-1')
			await expect(manager.write('s', payload)).rejects.toThrow('retry write failed')

			// Retry happened exactly once (two total writes: original + retry).
			expect(firstStream.write).toHaveBeenCalledTimes(1)
			expect(secondStream.write).toHaveBeenCalledTimes(1)
			expect(mockContainer.attach).toHaveBeenCalledTimes(2)
		})

		it('propagates the error if reconnecting itself fails', async () => {
			const firstStream = makeStream({
				write: vi.fn((_line: string, cb: (err?: Error | null) => void) =>
					cb(new Error('initial write failed')),
				),
			})
			mockContainer.attach
				.mockResolvedValueOnce(firstStream)
				.mockRejectedValueOnce(new Error('container gone'))

			await manager.attachStdin('s', 'c-1')
			await expect(manager.write('s', payload)).rejects.toThrow('container gone')
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
