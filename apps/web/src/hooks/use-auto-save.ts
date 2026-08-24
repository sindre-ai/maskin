import { useCallback, useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 500
const SAVED_INDICATOR_MS = 2000

export function useAutoSave<T>({
	isActive,
	isValid,
	buildPayload,
	onSave,
}: {
	isActive: boolean
	isValid: boolean
	buildPayload: () => T | null
	/** Return a promise to have the "Saved" indicator wait on the real outcome —
	 *  a rejection is reported as `error` and never shows the checkmark. A `void`
	 *  return is treated as fire-and-forget success. */
	onSave: ((payload: T) => unknown) | undefined
}) {
	const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const onSaveRef = useRef(onSave)
	onSaveRef.current = onSave
	const [showSaved, setShowSaved] = useState(false)
	const [error, setError] = useState<Error | null>(null)
	const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const lastPayloadRef = useRef<string>('')
	const isFirstRender = useRef(true)

	const save = useCallback(() => {
		if (!isActive || !isValid || !onSaveRef.current) return
		const payload = buildPayload()
		if (!payload) return

		const serialized = JSON.stringify(payload)
		if (serialized === lastPayloadRef.current) return

		// Marked as in-flight so a debounce tick mid-request doesn't re-send the
		// same payload; cleared again below if the save fails, so the next edit
		// (or the same one) can retry rather than being deduped away forever.
		lastPayloadRef.current = serialized
		const result = onSaveRef.current(payload)

		const succeed = () => {
			setError(null)
			setShowSaved(true)
			clearTimeout(savedTimerRef.current)
			savedTimerRef.current = setTimeout(() => setShowSaved(false), SAVED_INDICATOR_MS)
		}

		if (!(result instanceof Promise)) {
			succeed()
			return
		}

		result.then(succeed, (err: unknown) => {
			// The save did not land: drop the dedup key so the edit is retryable,
			// and surface the failure instead of a checkmark.
			if (lastPayloadRef.current === serialized) lastPayloadRef.current = ''
			setShowSaved(false)
			setError(err instanceof Error ? err : new Error('Could not save'))
		})
	}, [isActive, isValid, buildPayload])

	// Initialize lastPayloadRef on first valid payload to avoid saving on load
	useEffect(() => {
		if (!isFirstRender.current) return
		isFirstRender.current = false
		if (isActive && isValid) {
			const payload = buildPayload()
			if (payload) lastPayloadRef.current = JSON.stringify(payload)
		}
	}, [isActive, isValid, buildPayload])

	// Debounced save on payload changes
	useEffect(() => {
		if (!isActive || !isValid) return
		clearTimeout(saveTimerRef.current)
		saveTimerRef.current = setTimeout(save, DEBOUNCE_MS)
		return () => clearTimeout(saveTimerRef.current)
	}, [isActive, isValid, save])

	return { showSaved, error }
}
