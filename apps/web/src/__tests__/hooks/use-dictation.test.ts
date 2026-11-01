import { useDictation } from '@/hooks/use-dictation'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreate, mockToast } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockToast: { error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/api', () => ({ api: { transcriptions: { create: mockCreate } } }))
vi.mock('sonner', () => ({ toast: mockToast }))
// Decoding and re-encoding real audio is covered in wav.test.ts; here the
// recording is just bytes that flow through.
vi.mock('@/lib/wav', () => ({
	blobToWav16k: vi.fn(async () => new Blob(['wav'])),
	blobToBase64: vi.fn(async () => 'BASE64'),
	concatWav: vi.fn(async () => new Blob(['wav'])),
}))

const WORKSPACE = 'workspace-1'

let recorders: FakeRecorder[] = []
let trackStop: ReturnType<typeof vi.fn>

class FakeRecorder {
	state: 'inactive' | 'recording' = 'inactive'
	mimeType = 'audio/webm'
	ondataavailable: ((e: { data: Blob }) => void) | null = null
	onstop: (() => void) | null = null
	constructor() {
		recorders.push(this)
	}
	start() {
		this.state = 'recording'
	}
	stop() {
		this.state = 'inactive'
		this.ondataavailable?.({ data: new Blob(['audio']) })
		this.onstop?.()
	}
}

function installMic(opts: { deny?: boolean } = {}) {
	trackStop = vi.fn()
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: {
			getUserMedia: vi.fn(async () => {
				if (opts.deny) throw new Error('denied')
				return { getTracks: () => [{ stop: trackStop }] }
			}),
		},
	})
	vi.stubGlobal('MediaRecorder', FakeRecorder)
}

beforeEach(() => {
	recorders = []
	mockCreate.mockReset()
	mockToast.error.mockReset()
	mockToast.info.mockReset()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
})

describe('useDictation', () => {
	it('reports unsupported when the browser cannot record audio', () => {
		const { result } = renderHook(() => useDictation(vi.fn(), WORKSPACE))
		expect(result.current.supported).toBe(false)
		expect(result.current.recording).toBe(false)
	})

	it('reports supported when getUserMedia and MediaRecorder exist', () => {
		installMic()
		const { result } = renderHook(() => useDictation(vi.fn(), WORKSPACE))
		expect(result.current.supported).toBe(true)
	})

	it('toggle() does nothing when unsupported', () => {
		const { result } = renderHook(() => useDictation(vi.fn(), WORKSPACE))
		act(() => result.current.toggle())
		expect(result.current.recording).toBe(false)
	})

	it('records, then sends the audio for transcription and delivers the text', async () => {
		installMic()
		mockCreate.mockResolvedValue({ text: ' catch me up ' })
		const onPhrase = vi.fn()
		const { result } = renderHook(() => useDictation(onPhrase, WORKSPACE))

		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.recording).toBe(true))

		act(() => result.current.toggle())
		await waitFor(() => expect(onPhrase).toHaveBeenCalledWith('catch me up'))
		expect(mockCreate).toHaveBeenCalledWith(WORKSPACE, { audio: 'BASE64' })
		expect(result.current.recording).toBe(false)
		expect(result.current.transcribing).toBe(false)
		expect(trackStop).toHaveBeenCalled()
	})

	it('tells the user when no speech was detected', async () => {
		installMic()
		mockCreate.mockResolvedValue({ text: '  ' })
		const onPhrase = vi.fn()
		const { result } = renderHook(() => useDictation(onPhrase, WORKSPACE))

		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.recording).toBe(true))
		act(() => result.current.toggle())

		await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('No speech detected'))
		expect(onPhrase).not.toHaveBeenCalled()
	})

	it('surfaces a transcription failure and leaves the draft alone', async () => {
		installMic()
		mockCreate.mockRejectedValue(new Error('Transcription failed'))
		const onPhrase = vi.fn()
		const { result } = renderHook(() => useDictation(onPhrase, WORKSPACE))

		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.recording).toBe(true))
		act(() => result.current.toggle())

		await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Transcription failed'))
		expect(onPhrase).not.toHaveBeenCalled()
		expect(result.current.transcribing).toBe(false)
	})

	describe('retry', () => {
		const apiError = (status: number, code?: string) =>
			Object.assign(new Error(`failed ${status}`), { status, code })

		async function dictateOnePhrase(onPhrase = vi.fn()) {
			installMic()
			const { result } = renderHook(() => useDictation(onPhrase, WORKSPACE))
			act(() => result.current.toggle())
			await waitFor(() => expect(result.current.recording).toBe(true))
			act(() => result.current.toggle())
			return { onPhrase, result }
		}

		it.each([
			['429', apiError(429, 'RATE_LIMITED')],
			['502', apiError(502, 'INTERNAL_ERROR')],
			['504', apiError(504, 'INTERNAL_ERROR')],
			['a gateway 503 with no error code', apiError(503)],
		])('retries a phrase once after a %s and delivers it', async (_name, failure) => {
			mockCreate.mockRejectedValueOnce(failure).mockResolvedValueOnce({ text: 'second try' })
			const { onPhrase } = await dictateOnePhrase()

			await waitFor(() => expect(onPhrase).toHaveBeenCalledWith('second try'), { timeout: 4000 })
			expect(mockCreate).toHaveBeenCalledTimes(2)
			expect(mockToast.error).not.toHaveBeenCalled()
		})

		it('shows the second failure and does not retry a third time', async () => {
			mockCreate.mockRejectedValue(apiError(502, 'INTERNAL_ERROR'))
			const { result } = await dictateOnePhrase()

			await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('failed 502'), {
				timeout: 4000,
			})
			expect(mockCreate).toHaveBeenCalledTimes(2)
			await waitFor(() => expect(result.current.transcribing).toBe(false))
		})

		it.each([
			['a 503 from the route (provider key or account refused)', apiError(503, 'INTERNAL_ERROR')],
			['a 401', apiError(401, 'UNAUTHORIZED')],
			['a 402', apiError(402, 'PLAN_CAP_EXCEEDED')],
		])('does not retry %s', async (_name, failure) => {
			mockCreate.mockRejectedValue(failure)
			await dictateOnePhrase()

			await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(failure.message))
			expect(mockCreate).toHaveBeenCalledTimes(1)
		})
	})

	it('streams each phrase into the composer while still recording', async () => {
		installMic()
		// A fake level meter: the test drives the microphone level by hand.
		let level = 0
		vi.stubGlobal(
			'AudioContext',
			class {
				resume = async () => {}
				close = async () => {}
				createAnalyser = () => ({
					fftSize: 1024,
					getFloatTimeDomainData: (out: Float32Array) => out.fill(level),
				})
				createMediaStreamSource = () => ({ connect: () => {} })
			},
		)
		mockCreate
			.mockResolvedValueOnce({ text: 'first' })
			.mockResolvedValueOnce({ text: 'second' })
			.mockResolvedValueOnce({ text: 'First, second.' })
		const onRefine = vi.fn()
		const onPhrase = vi.fn()
		const { result } = renderHook(() => useDictation(onPhrase, WORKSPACE, onRefine))

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
		try {
			act(() => result.current.toggle())
			await vi.waitFor(() => expect(result.current.recording).toBe(true))

			// Speak, then pause: the first phrase is sent without stopping.
			level = 0.2
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200)
			})
			level = 0
			await act(async () => {
				await vi.advanceTimersByTimeAsync(900)
			})
			await vi.waitFor(() => expect(onPhrase).toHaveBeenCalledWith('first'))
			expect(result.current.recording).toBe(true)
			expect(recorders).toHaveLength(2)

			// Speak a second phrase and pause: it is cleaned up without stopping.
			level = 0.2
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200)
			})
			level = 0
			await act(async () => {
				await vi.advanceTimersByTimeAsync(900)
			})
			await vi.waitFor(() => expect(onPhrase).toHaveBeenCalledWith('second'))
			await vi.waitFor(() =>
				expect(onRefine).toHaveBeenCalledWith('first second', 'First, second.'),
			)
			expect(result.current.recording).toBe(true)
			act(() => result.current.toggle())
		} finally {
			vi.useRealTimers()
		}

		expect(onPhrase.mock.calls.map(([text]) => text)).toEqual(['first', 'second'])
		expect(result.current.recording).toBe(false)
		expect(trackStop).toHaveBeenCalled()
	})

	it('does not send a pause that held no speech', async () => {
		installMic()
		vi.stubGlobal(
			'AudioContext',
			class {
				resume = async () => {}
				close = async () => {}
				createAnalyser = () => ({
					fftSize: 1024,
					// A tiny but non-zero hiss: the meter is alive and hears silence.
					getFloatTimeDomainData: (out: Float32Array) => out.fill(0.001),
				})
				createMediaStreamSource = () => ({ connect: () => {} })
			},
		)
		const { result } = renderHook(() => useDictation(vi.fn(), WORKSPACE))

		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.recording).toBe(true))
		act(() => result.current.toggle())

		await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('No speech detected'))
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it('stays idle and says so when microphone access is denied', async () => {
		installMic({ deny: true })
		const { result } = renderHook(() => useDictation(vi.fn(), WORKSPACE))

		act(() => result.current.toggle())

		await waitFor(() =>
			expect(mockToast.error).toHaveBeenCalledWith('Microphone access was blocked'),
		)
		expect(result.current.recording).toBe(false)
		expect(recorders).toHaveLength(0)
	})

	it('releases the microphone when unmounted mid-recording', async () => {
		installMic()
		const { result, unmount } = renderHook(() => useDictation(vi.fn(), WORKSPACE))
		act(() => result.current.toggle())
		await waitFor(() => expect(result.current.recording).toBe(true))

		unmount()

		expect(trackStop).toHaveBeenCalled()
	})
})
