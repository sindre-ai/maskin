import { MentionTypeahead } from '@/components/sindre/mention-typeahead'
import { SelectionChips } from '@/components/sindre/selection-chips'
import {
	type SlashKindId,
	SlashPicker,
	type SlashPickerResult,
} from '@/components/sindre/slash-picker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { applyMention, getActiveMention } from '@/lib/chat-mentions'
import { cn } from '@/lib/cn'
import type { SindreSelection, SindreSelectionAction } from '@/lib/sindre-selection'
import { AtSign, Box, Paperclip, Send, Square } from 'lucide-react'
import {
	type ChangeEvent,
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

const FILE_MAX_BYTES = 1024 * 1024 // 1 MB per upload

interface ConversationComposerProps {
	workspaceId: string
	agents: ConversationParticipant[]
	value: string
	onValueChange: (value: string) => void
	onSend: () => void
	onStop: () => void
	isBusy: boolean
	disabled?: boolean
	placeholder?: string
	selection: SindreSelection
	onDispatchSelection: (action: SindreSelectionAction) => void
}

/**
 * Composer for the multiplayer chat. Adds an inline `@`-mention typeahead
 * (agents in the workspace) on top of the shared `/` picker for objects and
 * notifications, plus markdown file upload. Enter sends; Shift+Enter inserts a
 * newline. While agents are replying the Send button becomes a Stop button.
 */
export function ConversationComposer({
	workspaceId,
	agents,
	value,
	onValueChange,
	onSend,
	onStop,
	isBusy,
	disabled,
	placeholder,
	selection,
	onDispatchSelection,
}: ConversationComposerProps) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const [error, setError] = useState<string | null>(null)

	// Inline @-mention state.
	const [mentionOpen, setMentionOpen] = useState(false)
	const [mentionQuery, setMentionQuery] = useState('')
	const [mentionIndex, setMentionIndex] = useState(0)
	const mentionAtRef = useRef<number | null>(null)
	const pendingCaretRef = useRef<number | null>(null)

	// Slash picker (objects / notifications).
	const [pickerOpen, setPickerOpen] = useState(false)
	const [pickerKind, setPickerKind] = useState<SlashKindId | null>(null)

	const filteredAgents = useMemo(() => {
		const q = mentionQuery.toLowerCase()
		const list = q.length === 0 ? agents : agents.filter((a) => a.name.toLowerCase().includes(q))
		return list.slice(0, 8)
	}, [agents, mentionQuery])

	const canSend = value.trim().length > 0 && !disabled

	// Apply a queued caret position after a mention insertion re-renders.
	useLayoutEffect(() => {
		if (pendingCaretRef.current === null) return
		const el = textareaRef.current
		if (el) {
			el.focus()
			el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current)
		}
		pendingCaretRef.current = null
	})

	const refreshMention = useCallback((next: string, caret: number) => {
		const active = getActiveMention(next, caret)
		if (active) {
			mentionAtRef.current = active.at
			setMentionQuery(active.query)
			setMentionIndex(0)
			setMentionOpen(true)
		} else {
			mentionAtRef.current = null
			setMentionOpen(false)
		}
	}, [])

	const handleChange = useCallback(
		(e: ChangeEvent<HTMLTextAreaElement>) => {
			const next = e.target.value
			onValueChange(next)
			const caret = e.target.selectionStart ?? next.length
			refreshMention(next, caret)
			// `/` at line start / after whitespace opens the item picker.
			if (caret > 0 && next[caret - 1] === '/') {
				const prev = caret >= 2 ? next[caret - 2] : ''
				if (prev === '' || /\s/.test(prev)) {
					setPickerKind(null)
					setPickerOpen(true)
				}
			}
		},
		[onValueChange, refreshMention],
	)

	const commitMention = useCallback(
		(agent: ConversationParticipant) => {
			const at = mentionAtRef.current
			if (at === null) return
			const result = applyMention(value, { at, query: mentionQuery }, agent.name)
			onValueChange(result.value)
			pendingCaretRef.current = result.caret
			setMentionOpen(false)
			mentionAtRef.current = null
		},
		[value, mentionQuery, onValueChange],
	)

	const submit = useCallback(
		(e?: FormEvent) => {
			e?.preventDefault()
			if (!canSend) return
			setError(null)
			onSend()
		},
		[canSend, onSend],
	)

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (mentionOpen && filteredAgents.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault()
					setMentionIndex((i) => (i + 1) % filteredAgents.length)
					return
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault()
					setMentionIndex((i) => (i - 1 + filteredAgents.length) % filteredAgents.length)
					return
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault()
					commitMention(filteredAgents[mentionIndex])
					return
				}
				if (e.key === 'Escape') {
					e.preventDefault()
					setMentionOpen(false)
					return
				}
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault()
				submit()
			}
		},
		[mentionOpen, filteredAgents, mentionIndex, commitMention, submit],
	)

	const handlePickerSelect = useCallback(
		(result: SlashPickerResult) => {
			if (result.kind === 'object') {
				onDispatchSelection({ type: 'add_object', object: result.ref })
			} else if (result.kind === 'notification') {
				onDispatchSelection({ type: 'add_notification', notification: result.ref })
			} else if (result.kind === 'agent') {
				// Mentioning via the picker inserts an inline @mention so it reads
				// naturally and the orchestrator routes the reply.
				const name = result.ref.name?.trim()
				if (name) {
					onValueChange(
						value.length > 0 && !value.endsWith(' ') ? `${value} @${name} ` : `@${name} `,
					)
				}
			}
		},
		[onDispatchSelection, onValueChange, value],
	)

	const handleFiles = useCallback(
		async (e: ChangeEvent<HTMLInputElement>) => {
			const input = e.target
			const files = Array.from(input.files ?? [])
			input.value = ''
			const failures: string[] = []
			for (const file of files) {
				if (file.size > FILE_MAX_BYTES) {
					failures.push(`${file.name} is larger than ${FILE_MAX_BYTES / 1024}KB`)
					continue
				}
				try {
					const content = await file.text()
					onDispatchSelection({
						type: 'add_file',
						file: { name: file.name, content, sizeBytes: file.size },
					})
				} catch {
					failures.push(`Failed to read ${file.name}`)
				}
			}
			if (failures.length > 0) setError(failures.join('; '))
		},
		[onDispatchSelection],
	)

	return (
		<div className="relative flex flex-col gap-1 rounded-lg border border-border bg-bg-surface p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
			{mentionOpen ? (
				<MentionTypeahead
					agents={filteredAgents}
					activeIndex={mentionIndex}
					onSelect={commitMention}
					onHover={setMentionIndex}
				/>
			) : null}
			<SlashPicker
				workspaceId={workspaceId}
				open={pickerOpen}
				onOpenChange={(next) => {
					setPickerOpen(next)
					if (!next) setPickerKind(null)
				}}
				onSelect={handlePickerSelect}
				selected={selection}
				initialKindId={pickerKind}
				anchor={
					<span aria-hidden className="pointer-events-none absolute bottom-2 left-2 h-0 w-0" />
				}
			/>
			<SelectionChips
				selection={selection}
				onRemoveAgent={() => onDispatchSelection({ type: 'remove_agent' })}
				onRemoveObject={(id) => onDispatchSelection({ type: 'remove_object', id })}
				onRemoveNotification={(id) => onDispatchSelection({ type: 'remove_notification', id })}
				onRemoveFile={(name) => onDispatchSelection({ type: 'remove_file', name })}
			/>
			<input
				ref={fileInputRef}
				type="file"
				accept=".md,.markdown,text/markdown,text/plain"
				multiple
				className="hidden"
				onChange={(e) => void handleFiles(e)}
				aria-hidden
				tabIndex={-1}
			/>
			<form onSubmit={submit}>
				<Textarea
					ref={textareaRef}
					autoResize
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder ?? 'Message the chat… use @ to mention an agent'}
					className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					disabled={disabled}
					rows={1}
				/>
				{error ? (
					<p role="alert" className="px-1 text-error text-xs" aria-live="polite">
						{error}
					</p>
				) : null}
				<div className="flex items-center gap-1">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-text-secondary text-xs"
						onClick={() => {
							const needsSpace = value.length > 0 && !value.endsWith(' ')
							const next = needsSpace ? `${value} @` : `${value}@`
							onValueChange(next)
							mentionAtRef.current = next.length - 1
							pendingCaretRef.current = next.length
							setMentionQuery('')
							setMentionIndex(0)
							setMentionOpen(true)
						}}
						disabled={disabled}
						aria-label="Mention an agent"
					>
						<AtSign size={14} aria-hidden />
						Mention
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-text-secondary text-xs"
						onClick={() => {
							setPickerKind('item')
							setPickerOpen(true)
						}}
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
						className="h-7 gap-1 px-2 text-text-secondary text-xs"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled}
						aria-label="Upload markdown file"
					>
						<Paperclip size={14} aria-hidden />
						Upload
					</Button>
					<div className="ml-auto">
						{isBusy ? (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								onClick={onStop}
								aria-label="Stop generating"
							>
								<Square size={15} className="fill-current" />
							</Button>
						) : (
							<Button
								type="submit"
								size="icon"
								variant="ghost"
								disabled={!canSend}
								aria-label="Send message"
							>
								<Send size={16} />
							</Button>
						)}
					</div>
				</div>
			</form>
		</div>
	)
}
