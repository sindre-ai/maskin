import { ActorAvatar } from '@/components/shared/actor-avatar'
import { IndicatorBadgeRow } from '@/components/shared/indicator-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Checkbox } from '@/components/ui/checkbox'
import { useStar } from '@/hooks/use-star'
import type { ActorListItem, NotificationResponse, ObjectResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'

// Ask-line title truncation. The SPEC calls for `~90 chars` — 90 is the exact
// count, tuned to fit one line at the row's title-column width on desktop
// before the CSS `truncate` steps in on narrower viewports. Keep as a literal
// so the value shows up in one grep-able place if design revises it.
const ASK_LINE_TITLE_MAX = 90

export interface ListRowProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected: boolean
	onSelect: (selected: boolean) => void
	/** Row-open navigation — identical to the DataTable row-click contract: the
	 *  list calls its own capture-then-navigate at view level, so shift-clickers
	 *  never lose their selection to a navigate. */
	onOpen: (objectId: string) => void
	/** Fired on shift-click so the view can extend the selection to a range. */
	onShiftClick: (objectId: string) => void
	/** The workspace's pending needs_input ask targeting this row, if any. The
	 *  row shows the ask line + "Waiting on you" pill only while the ask is
	 *  still pending — a resolved/dismissed ask never renders. */
	ask?: NotificationResponse
	/** Total pending asks on this row, including `ask`. When ≥ 2, the ask-line
	 *  renders a trailing `+ N more` counter (plain text, not a link). The
	 *  caller is responsible for the count — the row only knows about the
	 *  single first ask threaded via `ask`. Ordering: oldest pending first,
	 *  matching the "Waiting on you" pill's own ordering.  */
	pendingAskCount?: number
	betStatus?: BetStatusResult
	showBetStatusIndicator?: boolean
	columnVisibility: VisibilityState
	/** True once any row in the list is selected. Flips the whole list from the
	 *  resting star affordance to an explicit checkbox column (mockup 756–758's
	 *  `showStar: !selectionActive`). */
	anySelected?: boolean
	/** The workspace's display name for this row's type ("Article", "Company").
	 *  Absent for a type the workspace no longer defines, where the raw key is
	 *  the only honest label left. */
	typeLabel?: string
	/** First `in_loop` edge on this object, resolved client-side by
	 *  `useObjectLoops` in list-view. Renders as the D1 loop chip immediately
	 *  after the title; absent = no chip (no reserved space, per the D1
	 *  acceptance criterion). Multi-loop objects show only the first edge in
	 *  creation-time order — the caller picks that edge, the row renders it. */
	loop?: { id: string; name: string }
}

export function ListRow({
	object,
	workspaceId,
	actors,
	isSelected,
	onSelect,
	onOpen,
	onShiftClick,
	ask,
	pendingAskCount,
	betStatus,
	showBetStatusIndicator,
	columnVisibility,
	anySelected,
	typeLabel,
	loop,
}: ListRowProps) {
	const { isStarred, isSaving: isStarSaving, toggle: toggleStar } = useStar(object.id)
	const driver = object.driver ? actors?.find((a) => a.id === object.driver) : null
	const isArchived = object.status === 'archived'
	// Prior status is populated by the archive handler (T6) into metadata.previous_status.
	// We only render "was <status>" when it's set; falling back to `object.status` would
	// print "was archived", which is useless.
	const priorStatusRaw = object.metadata?.previous_status
	const priorStatus = isArchived && typeof priorStatusRaw === 'string' ? priorStatusRaw : null
	const hasPendingAsk = ask?.status === 'pending'
	const askActorName = hasPendingAsk
		? (actors?.find((a) => a.id === ask.sourceActorId)?.name ?? 'Agent')
		: null
	// Ask-line text: SPEC copy is `{who} asks — "{text}"` where `{text}` is
	// the notification's title, ellipsis at ~90 chars. `content` is a longer
	// free-form body only some notifications carry — falls back to `title` so
	// bare-title asks still render.
	const rawAskText = hasPendingAsk ? (ask.content ?? ask.title ?? '') : ''
	const askText =
		rawAskText.length > ASK_LINE_TITLE_MAX
			? `${rawAskText.slice(0, ASK_LINE_TITLE_MAX).trimEnd()}…`
			: rawAskText
	const extraAskCount = hasPendingAsk ? Math.max(0, (pendingAskCount ?? 1) - 1) : 0
	// D2 · Working ring predicate. Gated on `running` explicitly — see
	// `hydrateActiveSessionStates` in `apps/dev/src/routes/objects.ts` for
	// why `activeSessionId != null` isn't enough (pending/starting/paused
	// would flicker the ring on states where the agent isn't working).
	const isWorking = object.active_session_state === 'running'
	const showType = columnVisibility.type !== false
	const showTag = columnVisibility.status !== false
	const showDriver = columnVisibility.driver !== false
	const showUpdated = columnVisibility.updatedAt !== false
	// At rest the 20px slot carries the star; every row switches to a checkbox
	// once anything is selected (mockup 756–758). The star has to stay clickable
	// while the pointer is over the row, so — unlike the dot this replaced — it
	// cannot be the thing that yields to the checkbox on hover. The checkbox
	// instead appears in the page gutter to the row's left, which keeps the
	// resting row pixel-identical to the mockup and leaves both affordances
	// hittable at the same time.
	const selectionMode = !!anySelected || isSelected
	const showStar = !selectionMode

	return (
		<div
			data-obj-id={object.id}
			data-state={isSelected ? 'selected' : undefined}
			data-archived={isArchived ? '' : undefined}
			onClick={(e) => {
				if (e.shiftKey) {
					e.preventDefault()
					e.stopPropagation()
					onShiftClick(object.id)
					return
				}
				onOpen(object.id)
			}}
			onKeyDown={(e) => {
				// SPEC §D5 keyboard shortcut: `s` toggles star on the focused row.
				// Don't fire when the shift-select or another modifier is held, or
				// when focus is inside a real editable field (a metadata inline edit
				// nested in the row would otherwise lose the `s` keystroke).
				if (e.key !== 's' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
				const target = e.target as HTMLElement | null
				const tag = target?.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
				e.preventDefault()
				toggleStar()
			}}
			className={cn(
				'group relative flex w-full items-center gap-3 rounded-lg py-2.5 pr-3',
				// The extra left padding is the select lane: the checkbox is absolutely
				// placed in it so revealing it on hover shifts nothing, and reserving
				// the space keeps it inside the row's own hover highlight instead of
				// hanging off the list's left edge.
				// Touch puts the checkbox back in the star's slot, so the lane is dead
				// space there — hand those pixels back to the title.
				'pl-8 max-[1024.02px]:pl-3 pointer-coarse:pl-3',
				'cursor-pointer transition-colors hover:bg-muted/40',
				'data-[state=selected]:bg-muted',
				isArchived && 'opacity-[0.62] hover:opacity-90',
			)}
		>
			{/* The leading slot is star-sized on pointer devices. On touch it holds the
			    16px checkbox and the star side by side; each keeps a ~44px tap area
			    as real padding cancelled by an equal negative margin, so the row stays
			    slim without shrinking what a thumb can hit. The slot is 52px wide so
			    the star's tap area ends inside its own box (an overflowing child is
			    what the mobile-QA scrollWidth gate flags); the -mr-3 hands those 12px
			    back out of the row's gap-3, so the title column keeps its width. */}
			<span className="grid size-5 shrink-0 place-items-center self-center max-[1024.02px]:flex max-[1024.02px]:w-13 max-[1024.02px]:-mr-3 max-[1024.02px]:gap-2 pointer-coarse:flex pointer-coarse:w-13 pointer-coarse:-mr-3 pointer-coarse:gap-2">
				{showStar && (
					<button
						type="button"
						aria-label={isStarred ? 'Starred (click to remove)' : 'Star this object'}
						aria-pressed={isStarred}
						onClick={(e) => {
							e.preventDefault()
							e.stopPropagation()
							toggleStar()
						}}
						className={cn(
							'text-[13px] leading-none transition-colors',
							// Touch has no hover, so the checkbox sits in the slot at rest and
							// the star stays beside it, to its right. The 1024.02px cutoff is
							// Tailwind's `max-lg` nudged past 1024 (it is exclusive of 1024), so
							// iPad landscape gets the touch layout too. The padding is the
							// 44px tap area and the equal negative margin keeps the slot's
							// layout at the glyph's size; z-10 keeps it above the checkbox's.
							'max-[1024.02px]:relative max-[1024.02px]:z-10 max-[1024.02px]:order-2 max-[1024.02px]:p-3.5 max-[1024.02px]:-m-3.5',
							'pointer-coarse:relative pointer-coarse:z-10 pointer-coarse:order-2 pointer-coarse:p-3.5 pointer-coarse:-m-3.5',
							// Amber-filled when on (SPEC §D5 — parity with detail meta row).
							// `--ink-3` (border-strong) → `--ink-2` (muted-foreground) on hover
							// when off, per SPEC.
							isStarred ? 'text-[#f59e0b]' : 'text-border-strong hover:text-muted-foreground',
							// SPEC: 60% opacity while the server round-trip is in flight.
							isStarSaving && 'opacity-60',
						)}
					>
						{isStarred ? '★' : '☆'}
					</button>
				)}
				{/* The checkbox's own box is the visible 16px square, so its tap area
				    cannot be padding on the box. On touch this wrapper carries it (same
				    padding / negative margin as the star) and forwards a tap on that
				    padding to the selection; elsewhere it is display: contents, so the
				    checkbox still positions against the row exactly as before. */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: tap-area extension only, keyboard users reach the checkbox inside it */}
				<span
					onClick={(e) => {
						e.stopPropagation()
						onSelect(!isSelected)
					}}
					className="contents max-[1024.02px]:grid max-[1024.02px]:touch-none max-[1024.02px]:select-none max-[1024.02px]:p-3.5 max-[1024.02px]:-m-3.5 pointer-coarse:grid pointer-coarse:touch-none pointer-coarse:select-none pointer-coarse:p-3.5 pointer-coarse:-m-3.5"
				>
					<Checkbox
						checked={isSelected}
						onCheckedChange={(value) => onSelect(!!value)}
						onClick={(e) => e.stopPropagation()}
						aria-label="Select row"
						className={cn(
							'shrink-0 touch-none select-none',
							// Touch: the visible box stays 16px; the wrapper reaches 44px. `relative`
							// also cancels the lane's `absolute` below.
							'max-[1024.02px]:relative',
							'pointer-coarse:relative',
							// One checkbox per row, in one of two places. In selection mode it
							// sits in the slot; at rest the star has the slot, so the checkbox
							// moves out into the page gutter and fades in on hover — that way
							// both controls stay hittable instead of trading the same 20px.
							// Touch viewports have no hover, so it stays visible there;
							// `pointer-coarse` carries iPad landscape, which sits at the `lg`
							// breakpoint but still has no hover.
							showStar && [
								// Pointer devices: the star owns the slot, so the checkbox waits
								// in the row's select lane and fades in on row hover — both
								// controls stay hittable instead of trading the same 20px.
								'absolute left-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity',
								'group-hover:opacity-100 focus-visible:opacity-100',
								// Touch: no hover to reveal it, and the lane is dead space there.
								// It takes the slot back, in flow, to the star's left.
								// `relative` (set above) takes it out of the lane, so the lane offsets
								// must be cleared rather than left to nudge the box.
								'max-[1024.02px]:inset-auto max-[1024.02px]:translate-y-0 max-[1024.02px]:opacity-100',
								'pointer-coarse:inset-auto pointer-coarse:translate-y-0 pointer-coarse:opacity-100',
							],
						)}
					/>
				</span>
			</span>
			{showType && <TypeBadge type={object.type} label={typeLabel} variant="pill" />}
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => {
							if (e.shiftKey) {
								e.preventDefault()
								e.stopPropagation()
								onShiftClick(object.id)
								return
							}
							if (e.metaKey || e.ctrlKey || e.button === 1) {
								// Let the browser open the link in a new tab — just stop the
								// row's own onClick from also navigating the current tab.
								e.stopPropagation()
								return
							}
							// Route a plain click through the same capture-then-navigate path
							// as the rest of the row (see ListView.handleOpen) instead of the
							// Link's own navigation — otherwise clicking the title (the widest
							// hit target on narrow viewports) skips onCaptureViewState and the
							// scroll-anchor view-state snapshot never gets taken.
							e.preventDefault()
							e.stopPropagation()
							onOpen(object.id)
						}}
						className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
					>
						{object.title || 'Untitled'}
					</Link>
					{loop && (
						// D1 · Loop chip. Position: after the title, before the right-
						// side status chip. Copy verbatim per SPEC: `↺ Loop · {name}`.
						// The chip itself never truncates (`shrink-0`) — the title
						// truncates first, exactly as the D1 spec asks.
						<Link
							to="/$workspaceId/loops/$loopId"
							params={{ workspaceId, loopId: loop.id }}
							onClick={(e) => e.stopPropagation()}
							className={cn(
								'shrink-0 rounded-full border border-border bg-muted/60 px-2 py-0.5',
								'text-[10px] font-medium leading-none text-muted-foreground',
								'transition-colors hover:text-foreground hover:underline',
								'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							)}
						>
							↺ Loop · {loop.name}
						</Link>
					)}
					{hasPendingAsk && (
						<span className="shrink-0 rounded-full border border-ask-border bg-ask-surface px-2 py-0.5 text-[10px] font-bold leading-none text-warning">
							Waiting on you
						</span>
					)}
					{betStatus && showBetStatusIndicator && (
						<IndicatorBadgeRow result={betStatus} className="shrink-0" />
					)}
				</div>
				{hasPendingAsk && (
					// D3 · Ask-line under the title. Copy is verbatim from the SPEC:
					// `{who} asks — "{text}"` (name bolded, text truncated at ~90
					// chars). Multi-ask overflow renders `+ N more` as plain text —
					// not a link, per the D3 spec's explicit "plain text, not a link".
					// The type label is a sibling column here (not inline with the
					// title as in the mockup), so the ask line already starts at the
					// title column — no extra `askIndent` offset is needed.
					<p className="truncate text-xs leading-snug text-muted-foreground">
						<span className="font-bold text-warning">{askActorName}</span> asks —{' '}
						<span>“{askText}”</span>
						{extraAskCount > 0 && (
							<span className="text-muted-foreground/80"> + {extraAskCount} more</span>
						)}
					</p>
				)}
				{priorStatus && (
					<p className="truncate text-xs leading-snug text-muted-foreground">
						was {priorStatus.replace(/_/g, ' ')}
					</p>
				)}
			</div>
			{/* The mockup's row status is the bare coloured word — no dot, no pill
			    (759). A dot beside it doubles the colour signal in 11px of space. */}
			{showTag && (
				<StatusBadge
					status={object.status}
					variant="word"
					// Hidden below `sm`: at 375px the leading touch checkbox and star plus
					// five columns leaves the title little room, and the status word is
					// the one column the reader can already get from the group header
					// (grouping rests on Status). It returns at 640px.
					className="hidden text-[11px] font-semibold sm:inline"
				/>
			)}
			{showDriver && driver && (
				// D2 · Driver avatar gains a violet conic-gradient ring when the
				// object has an actively-running session on it. Replaces the old
				// right-side <AgentWorkingBadge> — the ring is the row's only
				// working indicator now, per the D2 acceptance criteria.
				<ActorAvatar
					id={driver.id}
					name={driver.name}
					type={driver.type}
					className="shrink-0"
					working={isWorking}
				/>
			)}
			{showUpdated && object.updatedAt && (
				<RelativeTime
					date={object.updatedAt}
					compact
					// Mockup 764: a 30px right-aligned age column. `min-w` rather than a
					// hard width, and nowrap, so a day/month token ("Jan 15") widens
					// the column instead of wrapping onto a second line.
					className="min-w-8 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
				/>
			)}
		</div>
	)
}
