import { SelectionChips } from '@/components/chat/selection-chips'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/chat/slash-picker'
import { UploadProgress } from '@/components/shared/upload-progress'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useUploadFile } from '@/hooks/use-files'
import { deriveEntryAgentRole, trackSpecialistSummonedManually } from '@/lib/analytics'
import type { ChatSelection, ChatSelectionAction } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { readFileAsBase64 } from '@/lib/file-utils'
import { Bot, Box, Paperclip, Send, X } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'

export type ChatSurface = 'sheet' | 'pulse-bar'

interface PendingUpload {
	tempId: string
	name: string
	sizeBytes: number
	mimeType?: string
	status: 'uploading' | 'failed'
	progress: number
	error?: string
}

function makeTempId() {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export interface ComposerProps {
	workspaceId: string
	onSend: (content: string) => Promise<void>
	disabled: boolean
	pending: boolean
	surface: ChatSurface
	placeholder: string
	selection: ChatSelection
	onDispatchSelection?: (action: ChatSelectionAction) => void
	onRemoveAgent: () => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
	onRemoveFile: (fileId: string) => void
	externalError?: string | null
	onDismissExternalError?: () => void
	/** Forwarded as `aria-label` on the textarea. Defaults to the surface placeholder. */
	textareaLabel?: string
}

/**
 * Chat composer. Enter sends, Shift+Enter inserts a newline, IME
 * composition swallows Enter. The textarea auto-resizes up to `max-h-40` and
 * scrolls beyond that. The send button shows a Spinner (and stays disabled)
 * while a turn is pending — i.e. after a send, until the caller flips
 * `pending` back to false.
 *
 * Exposes three entry points into the shared `<SlashPicker>`:
 *  - `/` typed at the start of the textarea (or immediately after whitespace)
 *    opens the picker at the top-level kind menu.
 *  - The **Agent** button opens the picker pre-filtered to the agent kind.
 *  - The **Objects** button opens the picker pre-filtered to the object kind.
 * All three share a single picker instance and an invisible `PopoverAnchor`
 * pinned to the composer so the popover always lands in the same place. When
 * a pick is committed we delete only the `/` that triggered the picker (if
 * still present) so the rest of the user's in-progress message is preserved.
 */
export function Composer({
	workspaceId,
	onSend,
	disabled,
	pending,
	placeholder,
	selection,
	onDispatchSelection,
	onRemoveAgent,
	onRemoveObject,
	onRemoveNotification,
	onRemoveFile,
	externalError,
	onDismissExternalError,
	textareaLabel,
}: ComposerProps) {
	const [value, setValue] = useState('')
	const [sending, setSending] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [pickerKind, setPickerKind] = useState<SlashKindId | null>(null)
	// In-flight + failed uploads. Only the resolved fileId enters `ChatSelection`
	// (high-frequency upload events would otherwise churn the selection reducer);
	// these are the chips shown while bytes are still transferring or after the
	// upload failed, removable in either state.
	const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
	const slashPosRef = useRef<number | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
	const uploadFile = useUploadFile(workspaceId)

	// Abort every in-flight upload when the composer unmounts so a closed
	// chat surface doesn't leave XHRs hanging (and doesn't race-dispatch
	// add_file into a selection state that's already been thrown away).
	useEffect(() => {
		const controllers = abortControllersRef.current
		return () => {
			for (const controller of controllers.values()) controller.abort()
			controllers.clear()
		}
	}, [])
	// Block send while any attachment is still uploading or has failed — the
	// user must let it resolve or remove it (AC-T3). Mirrors the comment input's
	// rule that send requires every chip to be in a final, sendable state.
	const canSend =
		value.trim().length > 0 && !disabled && !sending && !pending && pendingUploads.length === 0
	const showSpinner = sending || pending

	const handleSubmit = useCallback(
		async (e?: FormEvent<HTMLFormElement>) => {
			e?.preventDefault()
			if (!canSend) return
			const content = value.trim()
			setSending(true)
			setSendError(null)
			onDismissExternalError?.()
			let sent = false
			try {
				await onSend(content)
				sent = true
			} catch (err) {
				setSendError(err instanceof Error ? err.message : 'Failed to send')
			} finally {
				setSending(false)
			}
			// Only clear the composer after the send actually resolved without
			// error — a rejected send keeps the draft so the user can retry
			// without losing a carefully crafted prompt.
			if (sent) setValue('')
		},
		[canSend, onDismissExternalError, onSend, value],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter') return
			if (e.shiftKey) return
			if (e.nativeEvent.isComposing) return
			e.preventDefault()
			void handleSubmit()
		},
		[handleSubmit],
	)

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		const next = e.target.value
		setValue(next)
		// Open the picker when the user just typed a `/` at a qualifying
		// position: either at the very start of the input or immediately
		// after whitespace. Anything else (middle of a URL, inside a word,
		// etc.) is left alone so `/` remains a regular character.
		const pos = e.target.selectionStart
		if (typeof pos !== 'number' || pos <= 0) return
		if (next[pos - 1] !== '/') return
		const prev = pos >= 2 ? next[pos - 2] : ''
		if (prev !== '' && !/\s/.test(prev)) return
		slashPosRef.current = pos - 1
		setPickerKind(null)
		setPickerOpen(true)
	}, [])

	const openPickerForKind = useCallback((kind: SlashKindId) => {
		slashPosRef.current = null
		setPickerKind(kind)
		setPickerOpen(true)
	}, [])

	const consumeSlashTrigger = useCallback(() => {
		const pos = slashPosRef.current
		if (pos === null) return
		slashPosRef.current = null
		setValue((prev) => {
			if (prev[pos] !== '/') return prev
			return prev.slice(0, pos) + prev.slice(pos + 1)
		})
	}, [])

	const handlePickerSelect = useCallback(
		(result: SlashPickerResult) => {
			if (result.kind === 'agent') {
				onDispatchSelection?.({ type: 'add_agent', agent: result.ref })
				// Thinness event #2: the owner bypassed the default (Chief of
				// Staff, once T3 wires it) and pulled a specialist in directly.
				// The parent bet counts any hit as evidence the boundary agent
				// isn't holding.
				trackSpecialistSummonedManually({
					entity_id: result.ref.id,
					entity_type: 'agent',
					agent_role: deriveEntryAgentRole(result.ref.name),
				})
			} else if (result.kind === 'object') {
				onDispatchSelection?.({ type: 'add_object', object: result.ref })
			} else {
				onDispatchSelection?.({ type: 'add_notification', notification: result.ref })
			}
			// The `/` that triggered the picker (if any) is dropped as soon as
			// the user commits a pick — keeping the rest of the in-progress
			// message intact.
			consumeSlashTrigger()
		},
		[onDispatchSelection, consumeSlashTrigger],
	)

	const handlePickerOpenChange = useCallback((next: boolean) => {
		setPickerOpen(next)
		if (!next) {
			setPickerKind(null)
			slashPosRef.current = null
		}
	}, [])

	const uploadPickedFile = useCallback(
		async (tempId: string, file: File) => {
			const controller = new AbortController()
			abortControllersRef.current.set(tempId, controller)
			try {
				const content = await readFileAsBase64(file)
				const created = await uploadFile(
					{
						name: file.name,
						mime_type: file.type || 'application/octet-stream',
						content,
						encoding: 'base64',
					},
					{
						signal: controller.signal,
						onProgress: (progress) => {
							setPendingUploads((prev) =>
								prev.map((p) => (p.tempId === tempId ? { ...p, progress } : p)),
							)
						},
					},
				)
				// Cancel-vs-resolve race: if the user removed the chip between the
				// XHR completing on the wire and this microtask firing, the chip is
				// already gone and the abort fired — don't dispatch add_file so the
				// user's intent is honoured (closes T4 reviewer SHOULD).
				if (controller.signal.aborted) return
				console.info(
					'[chat] uploaded image attachment',
					JSON.stringify({ fileId: created.id, name: file.name, sizeBytes: file.size }),
				)
				setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId))
				onDispatchSelection?.({
					type: 'add_file',
					file: {
						fileId: created.id,
						name: file.name,
						sizeBytes: file.size,
						mimeType: file.type || undefined,
					},
				})
			} catch (err) {
				// An aborted upload was a user-initiated cancel — the pending row
				// has already been removed by handleRemovePending; nothing to
				// surface and no error state to set.
				if (controller.signal.aborted) return
				console.error(`[chat] failed to upload ${file.name}`, err)
				const message = err instanceof Error ? err.message : 'Upload failed'
				// Mirror the comment input: the failed chip stays put so the user
				// can see which attachment broke and remove it. Send stays blocked
				// (via canSend) until every pending row is resolved or removed.
				setPendingUploads((prev) =>
					prev.map((p) => (p.tempId === tempId ? { ...p, status: 'failed', error: message } : p)),
				)
			} finally {
				abortControllersRef.current.delete(tempId)
			}
		},
		[uploadFile, onDispatchSelection],
	)

	const handleFileSelection = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const input = event.target
			const files = Array.from(input.files ?? [])
			input.value = '' // allow re-picking the same file after removing it
			const additions: PendingUpload[] = files.map((file) => ({
				tempId: makeTempId(),
				name: file.name,
				sizeBytes: file.size,
				mimeType: file.type || undefined,
				status: 'uploading',
				progress: 0,
			}))
			if (additions.length === 0) return
			setPendingUploads((prev) => [...prev, ...additions])
			additions.forEach((p, idx) => {
				void uploadPickedFile(p.tempId, files[idx])
			})
		},
		[uploadPickedFile],
	)

	const handleRemovePending = useCallback((tempId: string) => {
		// Abort first so the in-flight XHR is cancelled before the request can
		// finish on the server. uploadPickedFile's catch branch sees
		// signal.aborted=true and skips the error toast; the file row never
		// gets created in the backend (AC-T4).
		abortControllersRef.current.get(tempId)?.abort()
		abortControllersRef.current.delete(tempId)
		setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId))
	}, [])

	return (
		<div
			className={cn(
				'relative flex flex-col gap-1 rounded-md border border-border bg-bg-surface p-2 shadow-sm',
			)}
		>
			<SlashPicker
				workspaceId={workspaceId}
				open={pickerOpen}
				onOpenChange={handlePickerOpenChange}
				onSelect={handlePickerSelect}
				selected={selection}
				initialKindId={pickerKind}
				anchor={
					<span aria-hidden className="pointer-events-none absolute left-2 bottom-2 h-0 w-0" />
				}
			/>
			<SelectionChips
				selection={selection}
				onRemoveAgent={onRemoveAgent}
				onRemoveObject={onRemoveObject}
				onRemoveNotification={onRemoveNotification}
				onRemoveFile={onRemoveFile}
			/>
			{pendingUploads.length > 0 && (
				<ul
					className="flex list-none flex-wrap items-center gap-1 p-0"
					aria-label="Uploading attachments"
				>
					{pendingUploads.map((p) => (
						<li
							key={p.tempId}
							data-upload-status={p.status}
							className={cn(
								'inline-flex max-w-full items-center gap-1 rounded-full border bg-bg-surface px-2 py-0.5 text-xs text-foreground',
								p.status === 'failed' ? 'border-error' : 'border-border',
							)}
						>
							<UploadProgress
								progress={p.progress}
								status={p.status}
								error={p.error}
								className="shrink-0"
							/>
							<span className="max-w-[12rem] truncate text-muted-foreground">{p.name}</span>
							<button
								type="button"
								onClick={() => handleRemovePending(p.tempId)}
								aria-label={
									p.status === 'failed'
										? `Remove failed upload ${p.name}`
										: `Cancel upload ${p.name}`
								}
								className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<X size={10} aria-hidden />
							</button>
						</li>
					))}
				</ul>
			)}
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				multiple
				className="hidden"
				onChange={handleFileSelection}
				aria-hidden
				tabIndex={-1}
			/>
			<form onSubmit={handleSubmit}>
				<Textarea
					autoResize
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					disabled={disabled}
					rows={1}
					aria-label={textareaLabel}
				/>
				{sendError || externalError ? (
					<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
						{sendError ?? externalError} — your message is preserved; try again.
					</p>
				) : null}
				<div className="flex items-center gap-1">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs text-text-secondary"
						onClick={() => openPickerForKind('agent')}
						disabled={disabled}
						aria-label="Pick an agent"
					>
						<Bot size={14} aria-hidden />
						Agent
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs text-text-secondary"
						onClick={() => openPickerForKind('item')}
						disabled={disabled}
						aria-label="Attach items"
					>
						<Box size={14} aria-hidden />
						Items
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="relative h-7 gap-1 px-2 text-xs text-text-secondary before:absolute before:-inset-3 before:h-11 before:w-11 before:content-['']"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled}
						aria-label="Attach image"
					>
						<Paperclip size={14} aria-hidden />
						Attach
					</Button>
					<div className="ml-auto">
						<Button
							type="submit"
							size="icon"
							variant="ghost"
							disabled={!canSend}
							aria-label="Send message"
						>
							{showSpinner ? <Spinner /> : <Send size={16} />}
						</Button>
					</div>
				</div>
			</form>
		</div>
	)
}
