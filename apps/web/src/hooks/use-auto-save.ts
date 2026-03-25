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
	onSave: ((payload: T) => void) | undefined
}) {
	const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const onSaveRef = useRef(onSave)
	onSaveRef.current = onSave
	const [showSaved, setShowSaved] = useState(false)
	const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
	const lastPayloadRef = useRef<string>('')
	const isFirstRender = useRef(true)

	const save = useCallback(() => {
		if (!isActive || !isValid || !onSaveRef.current) return
		const payload = buildPayload()
		if (!payload) return

		const serialized = JSON.stringify(payload)
		if (serialized === lastPayloadRef.current) return

		lastPayloadRef.current = serialized
		onSaveRef.current(payload)
		setShowSaved(true)
		clearTimeout(savedTimerRef.current)
		savedTimerRef.current = setTimeout(() => setShowSaved(false), SAVED_INDICATOR_MS)
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

	return { showSaved }
}
