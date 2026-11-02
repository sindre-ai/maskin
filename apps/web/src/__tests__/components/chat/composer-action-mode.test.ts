import { composerActionMode } from '@/components/chat/chat'
import { describe, expect, it } from 'vitest'

const base = {
	hasText: false,
	busy: false,
	dictationSupported: true,
	recording: false,
	transcribing: false,
}

describe('composerActionMode', () => {
	it('is the mic when the draft is empty and dictation works', () => {
		expect(composerActionMode(base)).toBe('mic')
	})

	it('is send once there is text', () => {
		expect(composerActionMode({ ...base, hasText: true })).toBe('send')
	})

	it('stays send while a send is in flight', () => {
		expect(composerActionMode({ ...base, busy: true })).toBe('send')
	})

	it('is listening while dictating, even with streamed text', () => {
		expect(composerActionMode({ ...base, hasText: true, recording: true })).toBe('listening')
	})

	it('is transcribing while the clean pass runs', () => {
		expect(composerActionMode({ ...base, transcribing: true })).toBe('transcribing')
	})

	it('is a (disabled) send when dictation is unsupported and the draft is empty', () => {
		expect(composerActionMode({ ...base, dictationSupported: false })).toBe('send')
	})
})
