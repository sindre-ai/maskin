import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAutoSave } from '@/hooks/use-auto-save'

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('useAutoSave', () => {
	it('does not save on first render', () => {
		const onSave = vi.fn()
		renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => ({ title: 'Hello' }),
				onSave,
			}),
		)

		act(() => {
			vi.advanceTimersByTime(1000)
		})

		expect(onSave).not.toHaveBeenCalled()
	})

	it('calls onSave after debounce when payload changes', () => {
		const onSave = vi.fn()
		let payload = { title: 'Initial' }

		const { rerender } = renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => payload,
				onSave,
			}),
		)

		// First render initializes lastPayload, no save
		act(() => {
			vi.advanceTimersByTime(600)
		})
		expect(onSave).not.toHaveBeenCalled()

		// Change payload and re-render
		payload = { title: 'Changed' }
		rerender()

		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).toHaveBeenCalledWith({ title: 'Changed' })
	})

	it('does not save when payload is unchanged', () => {
		const onSave = vi.fn()
		const payload = { title: 'Same' }

		const { rerender } = renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => payload,
				onSave,
			}),
		)

		// Initial render + debounce
		act(() => {
			vi.advanceTimersByTime(600)
		})

		// Re-render with same payload
		rerender()
		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).not.toHaveBeenCalled()
	})

	it('does not save when isActive is false', () => {
		const onSave = vi.fn()
		let payload = { title: 'Initial' }

		const { rerender } = renderHook(
			({ isActive }) =>
				useAutoSave({
					isActive,
					isValid: true,
					buildPayload: () => payload,
					onSave,
				}),
			{ initialProps: { isActive: false } },
		)

		payload = { title: 'Changed' }
		rerender({ isActive: false })
		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).not.toHaveBeenCalled()
	})

	it('does not save when isValid is false', () => {
		const onSave = vi.fn()
		let payload = { title: 'Initial' }

		const { rerender } = renderHook(
			({ isValid }) =>
				useAutoSave({
					isActive: true,
					isValid,
					buildPayload: () => payload,
					onSave,
				}),
			{ initialProps: { isValid: true } },
		)

		// First render initializes
		act(() => {
			vi.advanceTimersByTime(600)
		})

		payload = { title: 'Changed' }
		rerender({ isValid: false })
		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).not.toHaveBeenCalled()
	})

	it('does not save when onSave is undefined', () => {
		let payload = { title: 'Initial' }

		const { rerender } = renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => payload,
				onSave: undefined,
			}),
		)

		payload = { title: 'Changed' }
		rerender()
		act(() => {
			vi.advanceTimersByTime(600)
		})

		// No error thrown, no save
	})

	it('does not save when buildPayload returns null', () => {
		const onSave = vi.fn()
		let returnNull = false

		const { rerender } = renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => (returnNull ? null : { title: 'Init' }),
				onSave,
			}),
		)

		// First render initializes
		act(() => {
			vi.advanceTimersByTime(600)
		})

		returnNull = true
		rerender()
		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).not.toHaveBeenCalled()
	})

	it('showSaved becomes true after save, then resets after 2000ms', () => {
		const onSave = vi.fn()
		let payload = { title: 'Initial' }

		const { result, rerender } = renderHook(() =>
			useAutoSave({
				isActive: true,
				isValid: true,
				buildPayload: () => payload,
				onSave,
			}),
		)

		expect(result.current.showSaved).toBe(false)

		// First render initializes
		act(() => {
			vi.advanceTimersByTime(600)
		})

		// Change payload
		payload = { title: 'Changed' }
		rerender()

		act(() => {
			vi.advanceTimersByTime(600)
		})

		expect(onSave).toHaveBeenCalled()
		expect(result.current.showSaved).toBe(true)

		act(() => {
			vi.advanceTimersByTime(2000)
		})

		expect(result.current.showSaved).toBe(false)
	})
})
