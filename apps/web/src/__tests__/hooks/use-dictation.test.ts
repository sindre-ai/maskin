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
