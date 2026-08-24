import { useDictation } from '@/hooks/use-dictation'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeRecognition {
	continuous: boolean
	interimResults: boolean
	lang: string
	start: () => void
	stop: () => void
	abort: () => void
	onresult: ((event: unknown) => void) | null
	onerror: (() => void) | null
	onend: (() => void) | null
}

let instances: FakeRecognition[] = []

function installFakeSpeechRecognition() {
	instances = []
	class FakeSpeechRecognition implements FakeRecognition {
		continuous = false
		interimResults = false
		lang = ''
		onresult: ((event: unknown) => void) | null = null
		onerror: (() => void) | null = null
		onend: (() => void) | null = null
		start = vi.fn()
		stop = vi.fn(() => {
			this.onend?.()
		})
		abort = vi.fn()
		constructor() {
			instances.push(this)
		}
	}
	;(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeSpeechRecognition
}

afterEach(() => {
	;(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = undefined
	;(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = undefined
})

describe('useDictation', () => {
	it('reports unsupported when the browser has no SpeechRecognition', () => {
		const { result } = renderHook(() => useDictation(vi.fn()))
		expect(result.current.supported).toBe(false)
		expect(result.current.recording).toBe(false)
	})

	it('toggle() does nothing when unsupported', () => {
		const { result } = renderHook(() => useDictation(vi.fn()))
		act(() => result.current.toggle())
		expect(result.current.recording).toBe(false)
	})

	it('reports supported when the webkit-prefixed global is present', () => {
		;(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = class {}
		const { result } = renderHook(() => useDictation(vi.fn()))
		expect(result.current.supported).toBe(true)
	})

	it('transitions into and out of recording', () => {
		installFakeSpeechRecognition()
		const { result } = renderHook(() => useDictation(vi.fn()))

		act(() => result.current.toggle())
		expect(result.current.recording).toBe(true)
		expect(instances[0].start).toHaveBeenCalled()
		expect(instances[0].continuous).toBe(true)

		act(() => result.current.toggle())
		expect(result.current.recording).toBe(false)
	})

	it('toggle() flips the recording state', () => {
		installFakeSpeechRecognition()
		const { result } = renderHook(() => useDictation(vi.fn()))

		act(() => result.current.toggle())
		expect(result.current.recording).toBe(true)
		act(() => result.current.toggle())
		expect(result.current.recording).toBe(false)
	})

	it('emits only finalised phrases', () => {
		installFakeSpeechRecognition()
		const onTranscript = vi.fn()
		const { result } = renderHook(() => useDictation(onTranscript))
		act(() => result.current.toggle())

		act(() => {
			instances[0].onresult?.({
				resultIndex: 0,
				results: { length: 1, 0: { isFinal: false, 0: { transcript: 'partial' } } },
			})
		})
		expect(onTranscript).not.toHaveBeenCalled()

		act(() => {
			instances[0].onresult?.({
				resultIndex: 0,
				results: { length: 1, 0: { isFinal: true, 0: { transcript: 'catch me up' } } },
			})
		})
		expect(onTranscript).toHaveBeenCalledWith('catch me up')
	})

	it('leaves recording when the recogniser errors out', () => {
		installFakeSpeechRecognition()
		const { result } = renderHook(() => useDictation(vi.fn()))
		act(() => result.current.toggle())
		act(() => instances[0].onerror?.())
		expect(result.current.recording).toBe(false)
	})
})
