import { useAutoSave } from '@/hooks/use-auto-save'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** The server refused a save because the file changed since the editor loaded it (409). */
export class FileConflictError extends Error {
	constructor() {
		super('The file changed since it was loaded')
		this.name = 'FileConflictError'
	}
}

/** A lock wait or storage timeout: the same save is safe to send again. */
export class FileRetryableError extends Error {
	constructor(message = 'The save timed out') {
		super(message)
		this.name = 'FileRetryableError'
	}
}

export interface FileSaveClient {
	/** Save the text if the stored file still has the hash the editor loaded. Returns the new hash. */
	save(text: string, ifMatch: string): Promise<{ hash: string }>
	/** Fetch the stored file as it is now. */
	fetchLatest(): Promise<{ text: string; hash: string }>
}

export type FileSaveStatus = 'idle' | 'failed' | 'conflict'

export interface FileConflict {
	text: string
	hash: string
}

// 1s, 2s, 4s then give up (tech spec: retryable errors, three tries).
const RETRY_DELAYS_MS = [1000, 2000, 4000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Autosave for a markdown file the person is editing.
 *
 * - Saves 500ms after the last real edit through useAutoSave, so opening a
 *   file and not editing sends nothing.
 * - One save in flight at a time: the next waits for the previous reply and
 *   sends the hash from it.
 * - Every save carries if_match. A 409 never resends the old copy on its own:
 *   autosave pauses, the person's text stays, the latest file is fetched, and
 *   either the two agree (carry on) or the person chooses.
 */
export function useMarkdownFileSave({
	client,
	initialText,
	initialHash,
	readText,
	savedForm,
	onConflictShown,
}: {
	client: FileSaveClient
	/** The file text as loaded. */
	initialText: string
	/** The content hash returned with the load. */
	initialHash: string
	/** The editor's current text for the whole file (touched blocks only). */
	readText: () => string
	/** The editor's own saved form of a text, for the "same as mine" comparison. */
	savedForm: (text: string) => Promise<string>
	onConflictShown?: () => void
}) {
	const [status, setStatus] = useState<FileSaveStatus>('idle')
	const [conflict, setConflict] = useState<FileConflict | null>(null)
	// Bumped on every edit so the autosave debounce restarts; bumped on retry so
	// an identical payload is sent again.
	const [editVersion, setEditVersion] = useState(0)
	const [retryNonce, setRetryNonce] = useState(0)
	// The editor remounts on Load the new version.
	const [editorKey, setEditorKey] = useState(0)
	const [baseText, setBaseText] = useState(initialText)

	const hashRef = useRef(initialHash)
	const savedTextRef = useRef(initialText)
	const chainRef = useRef<Promise<unknown>>(Promise.resolve())
	const clientRef = useRef(client)
	clientRef.current = client
	const readTextRef = useRef(readText)
	readTextRef.current = readText
	const savedFormRef = useRef(savedForm)
	savedFormRef.current = savedForm
	const conflictShownRef = useRef(onConflictShown)
	conflictShownRef.current = onConflictShown
	const readyRef = useRef(false)

	const showConflict = useCallback(async (mine: string) => {
		const latest = await clientRef.current.fetchLatest()
		const [latestForm, mineForm] = await Promise.all([
			savedFormRef.current(latest.text),
			savedFormRef.current(mine),
		])
		if (latestForm === mineForm) {
			// Same document, only the formatting differs: adopt the new version and carry on.
			hashRef.current = latest.hash
			savedTextRef.current = latest.text
			return true
		}
		setConflict(latest)
		setStatus('conflict')
		conflictShownRef.current?.()
		return false
	}, [])

	// Send text, retrying timeouts. Resolves when stored (or already equal);
	// rejects after surfacing the conflict or failed banner.
	const send = useCallback(
		async (text: string, ifMatch?: string): Promise<void> => {
			if (ifMatch !== undefined) hashRef.current = ifMatch
			else if (text === savedTextRef.current) return
			for (let attempt = 0; ; attempt++) {
				try {
					const { hash } = await clientRef.current.save(text, hashRef.current)
					hashRef.current = hash
					savedTextRef.current = text
					setStatus('idle')
					return
				} catch (err) {
					if (err instanceof FileConflictError) {
						if (await showConflict(text)) return
						throw err
					}
					const delay = RETRY_DELAYS_MS[attempt]
					if (err instanceof FileRetryableError && delay !== undefined) {
						await sleep(delay)
						continue
					}
					setStatus('failed')
					throw err
				}
			}
		},
		[showConflict],
	)

	const enqueue = useCallback(
		(text: string, ifMatch?: string) => {
			const next = chainRef.current.then(
				() => send(text, ifMatch),
				() => send(text, ifMatch),
			)
			chainRef.current = next.catch(() => undefined)
			return next
		},
		[send],
	)

	const buildPayload = useCallback(() => {
		// A new function per edit restarts the autosave debounce; the text itself
		// is read here, once per save, rather than on every keystroke.
		void editVersion
		// Before the first edit the payload is the loaded text, which is what
		// keeps opening a file from saving it.
		const text = readyRef.current ? readTextRef.current() : baseText
		return { text, retryNonce }
	}, [baseText, retryNonce, editVersion])

	const { showSaved } = useAutoSave<{ text: string; retryNonce: number }>({
		isActive: status !== 'conflict',
		isValid: true,
		buildPayload,
		onSave: useCallback((payload: { text: string }) => enqueue(payload.text), [enqueue]),
	})

	const markEdited = useCallback(() => {
		readyRef.current = true
		setEditVersion((v) => v + 1)
	}, [])

	const retry = useCallback(() => {
		setStatus('idle')
		setRetryNonce((n) => n + 1)
	}, [])

	const loadNewVersion = useCallback(() => {
		if (!conflict) return
		hashRef.current = conflict.hash
		savedTextRef.current = conflict.text
		readyRef.current = false
		setBaseText(conflict.text)
		setEditorKey((k) => k + 1)
		setConflict(null)
		setStatus('idle')
	}, [conflict])

	const keepMineAndOverwrite = useCallback(() => {
		if (!conflict) return
		const mine = readTextRef.current()
		const ifMatch = conflict.hash
		setConflict(null)
		setStatus('idle')
		void enqueue(mine, ifMatch).catch(() => undefined)
	}, [conflict, enqueue])

	const copyMine = useCallback(() => {
		void navigator.clipboard?.writeText(readTextRef.current())
	}, [])

	// Unsaved edits are held while a conflict or failed save is showing.
	useEffect(() => {
		if (status === 'idle') return
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault()
		}
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	}, [status])

	return useMemo(
		() => ({
			status,
			conflict,
			showSaved,
			editorKey,
			baseText,
			markEdited,
			retry,
			loadNewVersion,
			keepMineAndOverwrite,
			copyMine,
		}),
		[
			status,
			conflict,
			showSaved,
			editorKey,
			baseText,
			markEdited,
			retry,
			loadNewVersion,
			keepMineAndOverwrite,
			copyMine,
		],
	)
}
