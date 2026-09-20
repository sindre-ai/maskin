import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/feature-flags', () => ({
	getFlag: vi.fn(),
}))

import { ApiError } from '@/lib/api'
import { getFlag } from '@/lib/feature-flags'
import {
	InsufficientCreditsBlockedError,
	_resetInsufficientCredits,
	closeInsufficientCreditsModal,
	getInsufficientCreditsPayload,
	isInsufficientCreditsBlocked,
	openInsufficientCreditsModal,
	openInsufficientCreditsModalForError,
	subscribeInsufficientCredits,
} from '@/lib/insufficient-credits'

const PAYLOAD = { balance_cents: 42, min_reserve_cents: 50, topup_url: '/billing/credits' }

function creditError(payload = PAYLOAD): ApiError {
	const err = new ApiError(402, 'Workspace balance is below the minimum reserve')
	err.code = 'INSUFFICIENT_CREDITS'
	err.insufficientCreditsContext = payload
	return err
}

beforeEach(() => {
	vi.clearAllMocks()
	_resetInsufficientCredits()
})

describe('openInsufficientCreditsModal', () => {
	it('opens and notifies subscribers when the credit UX flag is on', () => {
		vi.mocked(getFlag).mockReturnValue(true)
		const listener = vi.fn()
		subscribeInsufficientCredits(listener)

		const opened = openInsufficientCreditsModal(PAYLOAD)

		expect(opened).toBe(true)
		expect(getInsufficientCreditsPayload()).toEqual(PAYLOAD)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('declines and leaves state untouched when the flag is off', () => {
		vi.mocked(getFlag).mockReturnValue(false)
		const listener = vi.fn()
		subscribeInsufficientCredits(listener)

		const opened = openInsufficientCreditsModal(PAYLOAD)

		expect(opened).toBe(false)
		expect(getInsufficientCreditsPayload()).toBeNull()
		expect(listener).not.toHaveBeenCalled()
	})

	it('stores a fresh object per open so a second open re-emits', () => {
		vi.mocked(getFlag).mockReturnValue(true)
		const listener = vi.fn()
		subscribeInsufficientCredits(listener)

		openInsufficientCreditsModal(PAYLOAD)
		const first = getInsufficientCreditsPayload()
		openInsufficientCreditsModal(PAYLOAD)
		const second = getInsufficientCreditsPayload()

		expect(second).not.toBe(first)
		expect(listener).toHaveBeenCalledTimes(2)
	})
})

describe('openInsufficientCreditsModalForError', () => {
	beforeEach(() => {
		vi.mocked(getFlag).mockReturnValue(true)
	})

	it('opens the modal for an INSUFFICIENT_CREDITS ApiError', () => {
		const opened = openInsufficientCreditsModalForError(creditError())

		expect(opened).toBe(true)
		expect(getInsufficientCreditsPayload()).toEqual(PAYLOAD)
	})

	it('declines a non-ApiError', () => {
		expect(openInsufficientCreditsModalForError(new Error('network down'))).toBe(false)
		expect(getInsufficientCreditsPayload()).toBeNull()
	})

	it('declines an ApiError carrying a different code', () => {
		const err = new ApiError(402, 'Plan cap exceeded')
		err.code = 'PLAN_CAP_EXCEEDED'

		expect(openInsufficientCreditsModalForError(err)).toBe(false)
		expect(getInsufficientCreditsPayload()).toBeNull()
	})

	it('declines when the credit context is absent', () => {
		const err = new ApiError(402, 'Workspace balance is below the minimum reserve')
		err.code = 'INSUFFICIENT_CREDITS'

		expect(openInsufficientCreditsModalForError(err)).toBe(false)
		expect(getInsufficientCreditsPayload()).toBeNull()
	})
})

describe('closeInsufficientCreditsModal', () => {
	it('clears the payload and notifies subscribers', () => {
		vi.mocked(getFlag).mockReturnValue(true)
		openInsufficientCreditsModal(PAYLOAD)
		const listener = vi.fn()
		subscribeInsufficientCredits(listener)

		closeInsufficientCreditsModal()

		expect(getInsufficientCreditsPayload()).toBeNull()
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('does not notify when nothing is open', () => {
		const listener = vi.fn()
		subscribeInsufficientCredits(listener)

		closeInsufficientCreditsModal()

		expect(listener).not.toHaveBeenCalled()
	})
})

describe('isInsufficientCreditsBlocked', () => {
	it('recognises the marker the composer throws so the chat stays quiet', () => {
		expect(isInsufficientCreditsBlocked(new InsufficientCreditsBlockedError())).toBe(true)
		expect(isInsufficientCreditsBlocked(new Error('nope'))).toBe(false)
		expect(isInsufficientCreditsBlocked(undefined)).toBe(false)
	})
})

describe('subscribeInsufficientCredits', () => {
	it('stops notifying after unsubscribe', () => {
		vi.mocked(getFlag).mockReturnValue(true)
		const listener = vi.fn()
		const unsubscribe = subscribeInsufficientCredits(listener)

		unsubscribe()
		openInsufficientCreditsModal(PAYLOAD)

		expect(listener).not.toHaveBeenCalled()
	})
})
