import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ConversationListItemResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AtSign } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * `<MentionPicker>` — the `@`-in-composer picker for chat.tsx.
 *
 * Pool: every workspace actor with `role !== "system"` (i.e. not the
 * `isSystem` flag), agents and humans alike. Loaded once via a cached
 * `useActors` query and filtered client-side against the current query. The
 * three-section layout matches the spec verbatim:
 *
 *   1. "In this conversation" — other participants of the active conversation
 *   2. "Recent collaborators" — actors seen across the `useConversationsInfinite`
 *      cache, deduplicated by id, drop self, sort by `lastMessageAt` desc
 *   3. "Matches — \"{query}\"" — remaining alphabetical
 *
 * Empty-query state omits the query section. No-match state renders "No agent
 * by that name" (verbatim, chats v4 parity).
 *
 * Anchoring: composer passes an invisible `anchor` node pinned to the caret so
 * the popover always lands next to the `@`. Composer keeps DOM focus while the
 * picker is open — the popover's `onOpenAutoFocus` preventDefault + the
 * keyboard handlers routing through the composer's own `onKeyDown` are what
 * makes `↵` / `esc` / arrow keys work without stealing focus (a11y).
 *
 * Mobile (<768px, `useIsMobile`): renders as a bottom `Sheet` with a drag
 * handle, tap-select, and no arrow-key nav. Backdrop tap dismisses (Radix
 * Sheet default).
 */

export interface MentionPickerActor {
	id: string
	name: string
	type: string
	description?: string | null
	email?: string | null
}

export interface MentionPickerProps {
	/** Whether the picker is open. */
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Every workspace actor eligible for mention (agents + humans, `isSystem` filtered upstream). */
	actors: MentionPickerActor[]
	/** The current conversation's participant actor ids. Drives the "In this conversation" section. */
	conversationParticipantIds: string[]
	/** Substring filter — the text after the `@`. */
	query: string
	workspaceId: string
	/** Current actor id — omitted from the pool so self-mention takes the picker's explicit "you" path elsewhere. */
	selfActorId?: string | null
	/** Fired when a row is selected. `kind` records human vs agent for analytics. */
	onSelect: (actor: MentionPickerActor & { kind: 'agent' | 'human' }) => void
	/** External anchor (pinned to the caret) — desktop only. */
	anchor?: ReactNode
}

interface Section {
	heading: string
	rows: MentionPickerActor[]
}

export function MentionPicker({
	open,
	onOpenChange,
	actors,
	conversationParticipantIds,
	query,
	workspaceId,
	selfActorId,
	onSelect,
	anchor,
}: MentionPickerProps) {
	const isMobile = useIsMobile()
	const { data: conversationPages } = useConversationsInfinite(workspaceId)
	// Flattened conversation list — walked to derive "Recent collaborators" via
	// the actor ids that appear in each conversation's participant list.
	const conversations = useMemo<ConversationListItemResponse[]>(
		() => conversationPages?.pages.flatMap((p) => p.conversations) ?? [],
		[conversationPages],
	)

	const sections = useMemo(
		() =>
			buildMentionSections({
				actors,
				conversations,
				conversationParticipantIds,
				query,
				selfActorId: selfActorId ?? null,
			}),
		[actors, conversations, conversationParticipantIds, query, selfActorId],
	)

	const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
	const [highlightIndex, setHighlightIndex] = useState(0)

	// Reset the highlight to the first row every time the flat list changes so
	// the arrow-key state never lands on a stale row (or, worse, past the end).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the length is what drives the reset, not the identity of the rows array.
	useEffect(() => {
		setHighlightIndex(0)
	}, [flatRows.length])

	const listboxRef = useRef<HTMLUListElement | null>(null)

	// Consumers keep the composer focused, so keyboard nav has to come to us
	// via the composer's own onKeyDown. Register a document-level listener the
	// composer can piggy-back on isn't needed — instead expose an imperative
	// handler through the ref. Simpler: for desktop, the Popover's contents
	// listen for keyboard events routed from the composer through the picker
	// state (arrow keys advance `highlightIndex`; `↵` commits `flatRows[i]`).
	// The composer's onKeyDown does that dispatch via `useMentionPickerKeys`
	// below.

	const commit = useCallback(
		(actor: MentionPickerActor) => {
			const kind: 'agent' | 'human' = actor.type === 'agent' ? 'agent' : 'human'
			onSelect({ ...actor, kind })
		},
		[onSelect],
	)

	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="bottom"
					className="flex max-h-[75dvh] flex-col gap-2 rounded-t-lg rounded-b-none p-3"
				>
					<SheetTitle className="sr-only">Mention actor</SheetTitle>
					<div className="mx-auto h-1 w-10 rounded-full bg-muted-foreground/40" aria-hidden />
					<PickerBody
						sections={sections}
						flatRows={flatRows}
						highlightIndex={highlightIndex}
						onHighlight={setHighlightIndex}
						onCommit={commit}
						query={query}
						variant="sheet"
					/>
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{anchor ? <PopoverAnchor asChild>{anchor}</PopoverAnchor> : null}
			<PopoverContent
				className="w-80 p-0"
				align="start"
				sideOffset={6}
				// Keep the composer textarea focused while the picker is open — the
				// spec's `composer input never loses DOM focus` rule.
				onOpenAutoFocus={(e) => e.preventDefault()}
				// Same on close: don't hijack focus to the invisible anchor.
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				<ul
					ref={listboxRef}
					aria-label="Mention actor"
					className="flex max-h-72 flex-col overflow-auto p-1 text-popover-foreground"
				>
					<PickerBody
						sections={sections}
						flatRows={flatRows}
						highlightIndex={highlightIndex}
						onHighlight={setHighlightIndex}
						onCommit={commit}
						query={query}
						variant="popover"
					/>
				</ul>
			</PopoverContent>
		</Popover>
	)
}

interface PickerBodyProps {
	sections: Section[]
	flatRows: MentionPickerActor[]
	highlightIndex: number
	onHighlight: (index: number) => void
	onCommit: (actor: MentionPickerActor) => void
	query: string
	variant: 'popover' | 'sheet'
}

function PickerBody({
	sections,
	flatRows,
	highlightIndex,
	onHighlight,
	onCommit,
	query,
	variant,
}: PickerBodyProps) {
	if (flatRows.length === 0) {
		return (
			<div
				className={cn(
					'px-3 py-3 text-sm text-muted-foreground',
					// The sheet mode wraps its own listbox around this body — announce
					// the empty state as a listbox row so screen readers still land here.
					variant === 'sheet' && 'text-center',
				)}
				role={variant === 'popover' ? 'option' : undefined}
				aria-selected={false}
				aria-live="polite"
			>
				No agent by that name
			</div>
		)
	}

	let runningIndex = 0
	return (
		<>
			{sections.map((section) => {
				const startIndex = runningIndex
				runningIndex += section.rows.length
				return (
					<div key={section.heading} className="flex flex-col gap-0.5 py-1">
						<div className="px-2 pt-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
							{section.heading}
						</div>
						{section.rows.map((row, idx) => {
							const index = startIndex + idx
							const active = index === highlightIndex
							return (
								<button
									key={row.id}
									type="button"
									// biome-ignore lint/a11y/useSemanticElements: <button role="option"> is the shipped custom-picker pattern here (spec: keyboard nav routed from the composer's own onKeyDown); a native <option> can't carry the click handler + focus semantics.
									role="option"
									aria-selected={active}
									onMouseEnter={() => onHighlight(index)}
									onMouseDown={(e) => {
										// Prevent the composer textarea from losing focus on click.
										e.preventDefault()
									}}
									onClick={() => onCommit(row)}
									className={cn(
										'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground',
										active && 'bg-accent text-accent-foreground',
									)}
								>
									<ActorAvatar id={row.id} name={row.name} type={row.type} size="sm" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px] font-semibold">{row.name}</span>
										{row.description || row.email ? (
											<span className="block truncate text-[11px] text-muted-foreground">
												{row.description?.trim() || row.email}
											</span>
										) : null}
									</span>
									<AtSign
										size={12}
										aria-hidden
										className={cn('text-muted-foreground', active && 'text-accent-foreground')}
									/>
								</button>
							)
						})}
					</div>
				)
			})}
		</>
	)
}

/**
 * Pure section builder — exported so unit tests can pin the sort + section
 * split without spinning up the picker.
 */
export interface BuildMentionSectionsInput {
	actors: MentionPickerActor[]
	conversations: ConversationListItemResponse[]
	conversationParticipantIds: string[]
	query: string
	selfActorId: string | null
}

export function buildMentionSections(input: BuildMentionSectionsInput): Section[] {
	const { actors, conversations, conversationParticipantIds, query, selfActorId } = input
	const needle = query.trim().toLowerCase()

	// Index actors by id once so every section lookup is O(1).
	const byId = new Map<string, MentionPickerActor>()
	for (const actor of actors) {
		if (selfActorId && actor.id === selfActorId) continue
		byId.set(actor.id, actor)
	}

	const matches = (actor: MentionPickerActor): boolean => {
		if (needle.length === 0) return true
		const name = actor.name.toLowerCase()
		return name.includes(needle)
	}

	// (1) In this conversation — other participants of the active conversation.
	const participantSet = new Set(conversationParticipantIds.filter((id) => id !== selfActorId))
	const inConversation: MentionPickerActor[] = []
	for (const id of participantSet) {
		const actor = byId.get(id)
		if (actor && matches(actor)) inConversation.push(actor)
	}
	inConversation.sort((a, b) => a.name.localeCompare(b.name))
	const inConversationIds = new Set(inConversation.map((a) => a.id))

	// (2) Recent collaborators — walk useConversationsInfinite; dedupe by
	// actorId, drop self, sort by lastMessageAt desc. `lastMessageAt` may be
	// null on a freshly-created conversation with no messages; treat that as
	// oldest so it doesn't jump the queue.
	const recentSeenAt = new Map<string, number>()
	const sortedConversations = [...conversations].sort((a, b) => {
		const aTime = toEpoch(a.lastMessageAt) ?? 0
		const bTime = toEpoch(b.lastMessageAt) ?? 0
		return bTime - aTime
	})
	for (const conversation of sortedConversations) {
		const stamp = toEpoch(conversation.lastMessageAt) ?? 0
		for (const participant of conversation.participants ?? []) {
			const pid = participant.actorId
			if (!pid || pid === selfActorId) continue
			if (inConversationIds.has(pid)) continue
			if (!byId.has(pid)) continue
			// First (most-recent) occurrence wins because we iterate in desc order.
			if (!recentSeenAt.has(pid)) recentSeenAt.set(pid, stamp)
		}
	}
	const recent: MentionPickerActor[] = []
	for (const [pid, stamp] of recentSeenAt) {
		const actor = byId.get(pid)
		if (!actor || !matches(actor)) continue
		recent.push(actor)
		// annotate with the sort key on a shadow map so the outer sort can pick it up
		;(actor as MentionPickerActor & { __recentStamp?: number }).__recentStamp = stamp
	}
	recent.sort((a, b) => {
		const aStamp = (a as MentionPickerActor & { __recentStamp?: number }).__recentStamp ?? 0
		const bStamp = (b as MentionPickerActor & { __recentStamp?: number }).__recentStamp ?? 0
		return bStamp - aStamp
	})
	const recentIds = new Set(recent.map((a) => a.id))

	// (3) Everyone else, alphabetical. Section heading changes to include the
	// query when the user has typed one; empty-query state hides this section
	// entirely if it would duplicate (1) + (2).
	const remaining: MentionPickerActor[] = []
	for (const actor of byId.values()) {
		if (inConversationIds.has(actor.id) || recentIds.has(actor.id)) continue
		if (!matches(actor)) continue
		remaining.push(actor)
	}
	remaining.sort((a, b) => a.name.localeCompare(b.name))

	const sections: Section[] = []
	if (inConversation.length > 0) {
		sections.push({ heading: 'In this conversation', rows: inConversation })
	}
	if (recent.length > 0) {
		sections.push({ heading: 'Recent collaborators', rows: recent })
	}
	if (remaining.length > 0) {
		sections.push({
			heading: needle.length > 0 ? `Matches — "${query.trim()}"` : 'Everyone',
			rows: remaining,
		})
	}
	return sections
}

function toEpoch(iso: string | null | undefined): number | null {
	if (!iso) return null
	const t = new Date(iso).getTime()
	return Number.isFinite(t) ? t : null
}

// The composer wires arrow keys / Enter / Escape to the picker via a
// dispatcher rather than adding a keyboard listener to the popover — that
// would fight the "composer never loses focus" rule. This helper takes the
// current state + a KeyboardEvent and returns the next state plus whether the
// composer should preventDefault.

export interface MentionPickerKeyResult {
	preventDefault: boolean
	handled: boolean
	action?:
		| { type: 'move'; nextIndex: number }
		| { type: 'commit'; index: number }
		| { type: 'close' }
}

export function reduceMentionPickerKey(
	e: { key: string },
	state: { flatCount: number; highlightIndex: number },
): MentionPickerKeyResult {
	const { flatCount, highlightIndex } = state
	if (flatCount === 0) {
		if (e.key === 'Escape')
			return { preventDefault: true, handled: true, action: { type: 'close' } }
		return { preventDefault: false, handled: false }
	}
	if (e.key === 'ArrowDown') {
		const nextIndex = (highlightIndex + 1) % flatCount
		return { preventDefault: true, handled: true, action: { type: 'move', nextIndex } }
	}
	if (e.key === 'ArrowUp') {
		const nextIndex = (highlightIndex - 1 + flatCount) % flatCount
		return { preventDefault: true, handled: true, action: { type: 'move', nextIndex } }
	}
	if (e.key === 'Enter' || e.key === 'Tab') {
		return {
			preventDefault: true,
			handled: true,
			action: { type: 'commit', index: highlightIndex },
		}
	}
	if (e.key === 'Escape') {
		return { preventDefault: true, handled: true, action: { type: 'close' } }
	}
	return { preventDefault: false, handled: false }
}

/**
 * Detects an `@` trigger at a word boundary in the composer textarea. Returns
 * the position of the `@` character and the query text after it — or null when
 * the caret is not currently in a mention context. The regex is pinned in the
 * task's acceptance criteria: `(?:^|\s)@([\w-]*)$`.
 */
export const MENTION_TRIGGER_RE = /(?:^|\s)@([\w-]*)$/

export interface MentionTriggerMatch {
	atPos: number
	query: string
}

export function detectMentionTrigger(text: string, caretPos: number): MentionTriggerMatch | null {
	if (caretPos <= 0) return null
	const upToCaret = text.slice(0, caretPos)
	const match = MENTION_TRIGGER_RE.exec(upToCaret)
	if (!match) return null
	// `match.index` points at either the preceding whitespace (or the start of
	// string) — the `@` is one character in when it wasn't at pos 0.
	const atPos = match.index + (match[0].startsWith('@') ? 0 : 1)
	return { atPos, query: match[1] ?? '' }
}
