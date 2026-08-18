import { SelectionChips } from '@/components/chat/selection-chips'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/chat/slash-picker'
import { CreatePicker } from '@/components/shared/create-picker'
import { TypeBadge } from '@/components/shared/type-badge'
import { UploadProgress } from '@/components/shared/upload-progress'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useDictation } from '@/hooks/use-dictation'
import { useUploadFile } from '@/hooks/use-files'
import { deriveEntryAgentRole, trackSpecialistSummonedManually } from '@/lib/analytics'
import type { ChatSelection, ChatSelectionAction } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { readFileAsBase64 } from '@/lib/file-utils'
import { AtSign, Box, Mic, Paperclip, Plus, Send, Sparkles, X } from 'lucide-react'
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
	/** Optional controlled draft. Supply both to let a caller prefill the
	 *  composer (the chats zero-state suggestion rows); omit both to keep the
	 *  composer's own internal state. */
	value?: string
	onValueChange?: (value: string) => void
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
	value: controlledValue,
	onValueChange,
}: ComposerProps) {
	const [internalValue, setInternalValue] = useState('')
	const value = controlledValue ?? internalValue
	// Mirrors `value` for the functional-update path — a controlled caller has
	// no state for us to read back synchronously.
	const valueRef = useRef(value)
	valueRef.current = value
	const setValue = useCallback(
		(updater: string | ((prev: string) => string)) => {
			const next = typeof updater === 'function' ? updater(valueRef.current) : updater
			valueRef.current = next
			if (controlledValue === undefined) setInternalValue(next)
			onValueChange?.(next)
		},
		[controlledValue, onValueChange],
	)
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
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	// `/` opens the create list (mockup 761–771). The chosen type seeds the
	// shipped create surface; the mockup's FROM-THIS-CHAT panel additionally
	// pre-fills the name/fields from the conversation, which needs a `seed`
	// prop on <CreatePicker> that doesn't exist yet — see the composer note
	// where it is rendered.
	const [createOpen, setCreateOpen] = useState(false)
	const [createSubtype, setCreateSubtype] = useState<string | undefined>(undefined)
	const [turnIntoOpen, setTurnIntoOpen] = useState(false)
	const objectTypes = useAvailableObjectTypes()
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
	const uploadFile = useUploadFile(workspaceId)
	const dictation = useDictation(
		useCallback(
			(text: string) => {
				setValue((prev) => (prev.length === 0 ? text : `${prev.trimEnd()} ${text}`))
			},
			[setValue],
		),
	)

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
		[canSend, onDismissExternalError, onSend, setValue, value],
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

	const handleChange = useCallback(
		(e: ChangeEvent<HTMLTextAreaElement>) => {
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
			setTurnIntoOpen(true)
		},
		[setValue],
	)

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
	}, [setValue])

	const openCreateFor = useCallback(
		(subtype: string | undefined) => {
			setCreateSubtype(subtype)
			setTurnIntoOpen(false)
			consumeSlashTrigger()
			setCreateOpen(true)
		},
		[consumeSlashTrigger],
	)

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
				'relative mx-auto flex w-full max-w-[860px] flex-col gap-1 rounded-2xl border border-input bg-card px-3 py-2.5 shadow-sm',
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
			<Popover
				open={turnIntoOpen}
				onOpenChange={(next) => {
					setTurnIntoOpen(next)
					if (!next) slashPosRef.current = null
				}}
			>
				<PopoverAnchor asChild>
					<span aria-hidden className="pointer-events-none absolute bottom-2 left-2 h-0 w-0" />
				</PopoverAnchor>
				<PopoverContent
					align="start"
					side="top"
					sideOffset={8}
					className="w-[320px] p-1.5"
					onOpenAutoFocus={(e) => e.preventDefault()}
					aria-label="Turn this into an object"
				>
					<p className="eyebrow px-2 pb-1 pt-1.5">Turn this into an object</p>
					<ul className="flex list-none flex-col p-0">
						{objectTypes.map((type) => (
							<li key={type.value}>
								<button
									type="button"
									onClick={() => openCreateFor(type.value)}
									className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
								>
									<TypeBadge type={type.value} variant="tile" />
									<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
										{type.label}
									</span>
								</button>
							</li>
						))}
					</ul>
				</PopoverContent>
			</Popover>
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
								'inline-flex max-w-full items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs text-foreground',
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
					ref={textareaRef}
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
				<div className="flex items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							{/* No 44 px `::before` here: Attach next to it already carries one,
							    and two overlapping invisible hit surfaces 8 px apart steal
							    taps from each other. The v2 control row is 28 px by design. */}
							<Button
								type="button"
								size="icon"
								variant="outline"
								className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
								disabled={disabled}
								aria-label="Add an object, file, or mention"
							>
								<Plus size={15} aria-hidden />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-[252px]">
							<DropdownMenuItem onSelect={() => openPickerForKind('item')}>
								<Box size={15} aria-hidden />
								Reference an object
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openPickerForKind('agent')}>
								<AtSign size={15} aria-hidden />
								Mention an agent
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => openCreateFor(undefined)}>
								<Sparkles size={15} aria-hidden />
								Create an object
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{/* Attach stays a visible sibling rather than a menu row: it is the
					    one composer affordance with a pinned 44 px touch target
					    (`ios-chat-attach-tap-area.spec.ts`), which a closed menu can't
					    satisfy. */}
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="relative h-7 w-7 shrink-0 rounded-full text-muted-foreground before:absolute before:-inset-2 before:h-11 before:w-11 before:content-['']"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled}
						aria-label="Attach image"
					>
						<Paperclip size={14} aria-hidden />
					</Button>
					{dictation.supported ? (
						<Button
							type="button"
							size="icon"
							variant={dictation.recording ? 'destructive' : 'outline'}
							className={cn(
								'ml-auto h-7 w-7 shrink-0 rounded-full',
								dictation.recording ? 'animate-pulse' : 'text-muted-foreground',
							)}
							onClick={dictation.toggle}
							disabled={disabled}
							aria-pressed={dictation.recording}
							aria-label={dictation.recording ? 'Stop dictating' : 'Dictate a message'}
						>
							<Mic size={14} aria-hidden />
						</Button>
					) : null}
					<Button
						type="submit"
						size="icon"
						className={cn(
							'h-7 w-7 shrink-0 rounded-full',
							dictation.supported ? '' : 'ml-auto',
							canSend
								? 'bg-primary text-primary-foreground'
								: 'bg-muted text-muted-foreground hover:bg-muted',
						)}
						disabled={!canSend}
						aria-label="Send message"
					>
						{showSpinner ? <Spinner /> : <Send size={14} />}
					</Button>
				</div>
			</form>
			{/* "Turn this into an object" — reuses the shipped creation flow rather
			    than the mockup's bespoke FROM-THIS-CHAT modal (800–848). The picked
			    type is seeded; the conversation itself is not, because pre-filling
			    the name / field table / "CONTEXT IT INHERITS" block needs a `seed`
			    prop on CreatePicker, which is owned elsewhere. */}
			<CreatePicker
				open={createOpen}
				onOpenChange={setCreateOpen}
				defaultType="object"
				defaultObjectSubtype={createSubtype}
			/>
		</div>
	)
}
