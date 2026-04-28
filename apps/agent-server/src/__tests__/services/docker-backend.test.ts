import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Make a duplex-like mock stream that records writes and exposes lifecycle hooks.
function createMockAttachStream() {
	const stream = new EventEmitter() as EventEmitter & {
		writes: Array<{ data: string; encoding: string }>
		write: (data: string | Buffer, encoding: BufferEncoding, cb: (err?: Error) => void) => boolean
		destroy: () => void
		destroyed: boolean
		writable: boolean
	}
	stream.writes = []
	stream.destroyed = false
	stream.writable = true
	stream.write = vi.fn((data, encoding, cb) => {
		stream.writes.push({ data: String(data), encoding: String(encoding) })
		cb()
		return true
	})
	stream.destroy = vi.fn(() => {
		stream.destroyed = true
		stream.writable = false
		stream.emit('close')
	})
	return stream
}

const mockContainer = {
	start: vi.fn(),
	stop: vi.fn(),
	remove: vi.fn(),
	attach: vi.fn(),
	logs: vi.fn(),
	inspect: vi.fn(),
	exec: vi.fn(),
}

const mockDocker = {
	createContainer: vi.fn(),
	getContainer: vi.fn(),
	getImage: vi.fn(),
	pull: vi.fn(),
	buildImage: vi.fn(),
	modem: { followProgress: vi.fn() },
}

vi.mock('dockerode', () => ({
	default: vi.fn().mockImplementation(() => mockDocker),
}))

// Import after the vi.mock above so the backend picks up the mocked module.
const { DockerBackend } = await import('../../services/docker-backend')

function resetMocks() {
	vi.clearAllMocks()
	mockContainer.attach.mockReset()
	mockContainer.stop.mockReset().mockResolvedValue(undefined)
	mockContainer.remove.mockReset().mockResolvedValue(undefined)
	mockDocker.createContainer.mockResolvedValue({ id: 'container-abc' })
	mockDocker.getContainer.mockReturnValue(mockContainer)
	mockDocker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) })
}

describe('DockerBackend.writeStdin', () => {
	let backend: InstanceType<typeof DockerBackend>

	beforeEach(() => {
		resetMocks()
		backend = new DockerBackend()
	})

	it('opens an attach stream with stdin-only options and writes the payload', async () => {
		const stream = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(stream)

		await backend.writeStdin('container-1', '{"type":"user"}\n')

		expect(mockContainer.attach).toHaveBeenCalledWith({
			stream: true,
			stdin: true,
			stdout: false,
			stderr: false,
			hijack: true,
		})
		expect(stream.writes).toHaveLength(1)
		expect(stream.writes[0]).toEqual({ data: '{"type":"user"}\n', encoding: 'utf-8' })
	})

	it('reuses the cached stream on subsequent writes', async () => {
		const stream = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(stream)

		await backend.writeStdin('container-1', 'first\n')
		await backend.writeStdin('container-1', 'second\n')

		expect(mockContainer.attach).toHaveBeenCalledTimes(1)
		expect(stream.writes.map((w) => w.data)).toEqual(['first\n', 'second\n'])
	})

	it('reconnects after the cached stream emits close', async () => {
		const first = createMockAttachStream()
		const second = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

		await backend.writeStdin('container-1', 'before-close\n')
		first.emit('close')

		await backend.writeStdin('container-1', 'after-reconnect\n')

		expect(mockContainer.attach).toHaveBeenCalledTimes(2)
		expect(first.writes.map((w) => w.data)).toEqual(['before-close\n'])
		expect(second.writes.map((w) => w.data)).toEqual(['after-reconnect\n'])
	})

	it('drops the cached stream on write error and rethrows wrapped', async () => {
		const stream = createMockAttachStream()
		stream.write = vi.fn((_data, _encoding, cb) => {
			cb(new Error('broken pipe'))
			return false
		})
		mockContainer.attach.mockResolvedValueOnce(stream)

		await expect(backend.writeStdin('container-1', 'fail\n')).rejects.toThrow(
			/writeStdin failed.*broken pipe/,
		)

		// next write should re-attach (cached stream was dropped)
		const fresh = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(fresh)
		await backend.writeStdin('container-1', 'retry\n')
		expect(mockContainer.attach).toHaveBeenCalledTimes(2)
	})

	it('destroys the cached attach stream on stop()', async () => {
		const stream = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(stream)
		mockContainer.stop.mockResolvedValueOnce(undefined)

		await backend.writeStdin('container-1', 'hi\n')
		await backend.stop('container-1')

		expect(stream.destroy).toHaveBeenCalled()
		expect(stream.destroyed).toBe(true)
	})

	it('destroys the cached attach stream on remove()', async () => {
		const stream = createMockAttachStream()
		mockContainer.attach.mockResolvedValueOnce(stream)
		mockContainer.remove.mockResolvedValueOnce(undefined)

		await backend.writeStdin('container-1', 'hi\n')
		await backend.remove('container-1')

		expect(stream.destroy).toHaveBeenCalled()
	})
})

describe('DockerBackend.create', () => {
	beforeEach(() => {
		resetMocks()
	})

	it('opens stdin on the container so writeStdin can attach later', async () => {
		const backend = new DockerBackend()
		await backend.create({
			image: 'agent-base:latest',
			name: 'anko-test',
			env: { FOO: 'bar' },
			memoryMb: 512,
			cpuShares: 1024,
			binds: [],
		})

		expect(mockDocker.createContainer).toHaveBeenCalledWith(
			expect.objectContaining({
				OpenStdin: true,
				StdinOnce: false,
			}),
		)
	})
})
