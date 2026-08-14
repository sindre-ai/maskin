import type { RowSelectionState, Table } from '@tanstack/react-table'
import { useEffect, useRef, useState } from 'react'

// Match the prototype's gesture vocabulary so the same hand-feel from board-view carries here.
// See T5 spec on the bet for the full reasoning behind these numbers.
export const LONG_PRESS_MS = 500
export const LONG_PRESS_MOVE_TOLERANCE = 8
export const AUTOSCROLL_ZONE_PCT = 0.15
export const AUTOSCROLL_MIN_SPEED = 2
export const AUTOSCROLL_MAX_SPEED = 16

export type DragIntent = 'select' | 'deselect'

interface ComputeRangeArgs {
	current: RowSelectionState
	orderedIds: string[]
	anchorIdx: number
	prevIdx: number
	newIdx: number
	intent: DragIntent
	originalState: Map<string, boolean>
}

/**
 * Pure range-batching step for drag-select. The active drag carries a single
 * intent (select-all-crossed or deselect-all-crossed); when the pointer
 * reverses direction across the anchor, rows that were *previously* inside
 * the swept range but are *now* outside it snap back to the pre-drag
 * snapshot — matching Apple Mail, not "opposite of intent".
 */
export function computeRangeSelection({
	current,
	orderedIds,
	anchorIdx,
	prevIdx,
	newIdx,
	intent,
	originalState,
}: ComputeRangeArgs): RowSelectionState {
	const wantOn = intent === 'select'
	const lo = Math.min(anchorIdx, newIdx)
	const hi = Math.max(anchorIdx, newIdx)
	const prevLo = Math.min(anchorIdx, prevIdx)
	const prevHi = Math.max(anchorIdx, prevIdx)
	const next: RowSelectionState = { ...current }
	for (let i = lo; i <= hi; i++) {
		const id = orderedIds[i]
		if (!id) continue
		if (wantOn) next[id] = true
		else delete next[id]
	}
	for (let i = prevLo; i <= prevHi; i++) {
		if (i >= lo && i <= hi) continue
		const id = orderedIds[i]
		if (!id) continue
		if (originalState.get(id)) next[id] = true
		else delete next[id]
	}
	return next
}

interface UseDragSelectArgs<T> {
	scrollRef: React.RefObject<HTMLDivElement | null>
	table: Table<T>
	// True once the real scroll container is expected to be mounted (i.e. not
	// during a loading/empty placeholder render). scrollRef is a ref object
	// whose identity never changes, so without this the attach effect — which
	// runs before the container exists on first mount — would never re-run
	// once the real container replaces the placeholder.
	enabled: boolean
}

interface ArmState {
	x: number
	y: number
	rowId: string
	checkEl: HTMLElement
	pointerId: number
}

interface DragState {
	anchorId: string
	anchorIdx: number
	lastIdx: number
	intent: DragIntent
	pointerId: number
	captureEl: HTMLElement
	originalState: Map<string, boolean>
}

/**
 * Wires touch / pointer drag-select onto the scroll container. The hook is
 * intentionally container-scoped (not per-row): rows under the pointer are
 * resolved via `document.elementFromPoint`, so a virtualised list works
 * without per-row event wiring. Selection state is updated through
 * `table.setRowSelection`, which delegates to the parent's `rowSelection`.
 *
 * Markup contract:
 * - the scroll container is the element passed via `scrollRef`
 * - each leaf row carries `data-drag-row={rowId}` where rowId matches
 *   `table.getRowModel().rows[*].id`
 * - the row's checkbox (or its 44px hit-zone wrapper) carries
 *   `data-drag-checkbox` and `touch-action: none`
 */
export function useDragSelect<T>({ scrollRef, table, enabled }: UseDragSelectArgs<T>) {
	const [mode, setMode] = useState<'idle' | 'drag'>('idle')

	// Keep the latest table available to long-lived listeners without re-binding
	// every render. The Table instance from useReactTable is stable, but the
	// closure that reads its current state needs the freshest reference.
	const tableRef = useRef(table)
	tableRef.current = table

	const sessionRef = useRef<{
		armed: ArmState | null
		drag: DragState | null
		longPressTimer: number | null
		rafId: number
		speed: number
		lastClientX: number
		suppressClick: boolean
	}>({
		armed: null,
		drag: null,
		longPressTimer: null,
		rafId: 0,
		speed: 0,
		lastClientX: 0,
		suppressClick: false,
	})

	useEffect(() => {
		if (!enabled) return
		const container = scrollRef.current
		if (!container) return

		const orderedIds = (): string[] => {
			const rows = tableRef.current.getRowModel().rows
			const out: string[] = []
			for (const r of rows) {
				if (r.getIsGrouped()) continue
				out.push(r.id)
			}
			return out
		}

		const markActiveEnd = (rowId: string | null) => {
			for (const el of container.querySelectorAll<HTMLElement>('[data-drag-active-end="true"]')) {
				el.removeAttribute('data-drag-active-end')
			}
			if (!rowId) return
			const escaped = (window.CSS?.escape ?? ((s: string) => s))(rowId)
			const row = container.querySelector<HTMLElement>(`[data-drag-row="${escaped}"]`)
			if (row) row.setAttribute('data-drag-active-end', 'true')
		}

		const stopAutoscroll = () => {
			const s = sessionRef.current
			if (s.rafId) cancelAnimationFrame(s.rafId)
			s.rafId = 0
			s.speed = 0
			container.removeAttribute('data-drag-edge')
		}

		const clearArm = () => {
			const s = sessionRef.current
			if (s.longPressTimer !== null) {
				window.clearTimeout(s.longPressTimer)
				s.longPressTimer = null
			}
			if (s.armed) {
				s.armed.checkEl.removeAttribute('data-drag-arming')
				s.armed = null
			}
		}

		const endDrag = () => {
			const s = sessionRef.current
			const d = s.drag
			if (!d) return
			try {
				d.captureEl.releasePointerCapture(d.pointerId)
			} catch {
				/* capture already released or unsupported */
			}
			s.drag = null
			stopAutoscroll()
			markActiveEnd(null)
			setMode('idle')
		}

		const applyRange = (prevIdx: number, newIdx: number) => {
			const d = sessionRef.current.drag
			if (!d) return
			const ids = orderedIds()
			tableRef.current.setRowSelection((current) =>
				computeRangeSelection({
					current,
					orderedIds: ids,
					anchorIdx: d.anchorIdx,
					prevIdx,
					newIdx,
					intent: d.intent,
					originalState: d.originalState,
				}),
			)
		}

		const activate = (arm: ArmState) => {
			const t = tableRef.current
			const ids = orderedIds()
			const startIdx = ids.indexOf(arm.rowId)
			if (startIdx < 0) {
				clearArm()
				return
			}
			const sel = t.getState().rowSelection
			const wasSelected = !!sel[arm.rowId]
			const intent: DragIntent = wasSelected ? 'deselect' : 'select'
			const snapshot = new Map<string, boolean>()
			for (const id of ids) snapshot.set(id, !!sel[id])

			t.setRowSelection((prev) => {
				const next = { ...prev }
				if (wasSelected) delete next[arm.rowId]
				else next[arm.rowId] = true
				return next
			})

			sessionRef.current.suppressClick = true
			sessionRef.current.drag = {
				anchorId: arm.rowId,
				anchorIdx: startIdx,
				lastIdx: startIdx,
				intent,
				pointerId: arm.pointerId,
				captureEl: arm.checkEl,
				originalState: snapshot,
			}
			try {
				arm.checkEl.setPointerCapture(arm.pointerId)
			} catch {
				/* not all pointer types support capture (e.g. mouse with no button held) */
			}
			clearArm()
			setMode('drag')
			navigator.vibrate?.(10)
			markActiveEnd(arm.rowId)
		}

		const extendTo = (clientX: number, clientY: number) => {
			const s = sessionRef.current
			const d = s.drag
			if (!d) return
			s.lastClientX = clientX
			const under = document.elementFromPoint(clientX, clientY)
			const rowEl =
				under instanceof Element ? (under.closest('[data-drag-row]') as HTMLElement | null) : null
			if (rowEl?.dataset.dragRow) {
				const rowId = rowEl.dataset.dragRow
				const ids = orderedIds()
				const idx = ids.indexOf(rowId)
				if (idx >= 0 && idx !== d.lastIdx) {
					applyRange(d.lastIdx, idx)
					d.lastIdx = idx
					markActiveEnd(rowId)
				}
			}
			updateAutoscroll(clientY)
		}

		const updateAutoscroll = (clientY: number) => {
			const s = sessionRef.current
			const rect = container.getBoundingClientRect()
			const zone = rect.height * AUTOSCROLL_ZONE_PCT
			const topDist = clientY - rect.top
			const botDist = rect.bottom - clientY
			let edge: 'top' | 'bottom' | '' = ''
			let depth = 0
			let direction = 0
			if (topDist < zone) {
				edge = 'top'
				direction = -1
				depth = Math.max(0, 1 - topDist / zone)
			} else if (botDist < zone) {
				edge = 'bottom'
				direction = 1
				depth = Math.max(0, 1 - botDist / zone)
			}
			if (!edge) {
				stopAutoscroll()
				return
			}
			container.setAttribute('data-drag-edge', edge)
			const eased = depth * depth
			s.speed =
				direction * (AUTOSCROLL_MIN_SPEED + (AUTOSCROLL_MAX_SPEED - AUTOSCROLL_MIN_SPEED) * eased)
			if (!s.rafId) startAutoscroll()
		}

		const startAutoscroll = () => {
			const tick = () => {
				const s = sessionRef.current
				const d = s.drag
				if (!d || s.speed === 0) {
					s.rafId = 0
					return
				}
				container.scrollTop += s.speed
				const rect = container.getBoundingClientRect()
				const edge = container.getAttribute('data-drag-edge')
				const probeY = edge === 'top' ? rect.top + 4 : rect.bottom - 4
				const under = document.elementFromPoint(s.lastClientX, probeY)
				const rowEl =
					under instanceof Element ? (under.closest('[data-drag-row]') as HTMLElement | null) : null
				if (rowEl?.dataset.dragRow) {
					const rowId = rowEl.dataset.dragRow
					const ids = orderedIds()
					const idx = ids.indexOf(rowId)
					if (idx >= 0 && idx !== d.lastIdx) {
						applyRange(d.lastIdx, idx)
						d.lastIdx = idx
						markActiveEnd(rowId)
					}
				}
				s.rafId = requestAnimationFrame(tick)
			}
			sessionRef.current.rafId = requestAnimationFrame(tick)
		}

		const onPointerDown = (ev: PointerEvent) => {
			const target = ev.target instanceof Element ? ev.target : null
			const checkEl = target?.closest<HTMLElement>('[data-drag-checkbox]') ?? null
			if (!checkEl) return
			const rowEl = checkEl.closest<HTMLElement>('[data-drag-row]')
			const rowId = rowEl?.dataset.dragRow
			if (!rowId) return
			clearArm()
			sessionRef.current.armed = {
				x: ev.clientX,
				y: ev.clientY,
				rowId,
				checkEl,
				pointerId: ev.pointerId,
			}
			sessionRef.current.lastClientX = ev.clientX
			checkEl.setAttribute('data-drag-arming', 'true')
			sessionRef.current.longPressTimer = window.setTimeout(() => {
				const arm = sessionRef.current.armed
				if (arm) activate(arm)
			}, LONG_PRESS_MS)
		}

		const onPointerMove = (ev: PointerEvent) => {
			const s = sessionRef.current
			if (s.armed && !s.drag) {
				const dx = ev.clientX - s.armed.x
				const dy = ev.clientY - s.armed.y
				if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clearArm()
				return
			}
			if (!s.drag) return
			ev.preventDefault()
			extendTo(ev.clientX, ev.clientY)
		}

		const onPointerUp = () => {
			const s = sessionRef.current
			if (s.drag) endDrag()
			else clearArm()
		}

		const onPointerCancel = () => {
			const s = sessionRef.current
			if (s.drag) endDrag()
			else clearArm()
		}

		// Suppress the click that follows the activation pointerup, so the
		// gesture's toggle of the anchor isn't immediately undone by the
		// click handler the checkbox would have fired on tap.
		const onClickCapture = (ev: MouseEvent) => {
			if (!sessionRef.current.suppressClick) return
			sessionRef.current.suppressClick = false
			const target = ev.target instanceof Element ? ev.target : null
			if (target?.closest('[data-drag-checkbox]')) {
				ev.preventDefault()
				ev.stopPropagation()
			}
		}

		// During the arm window the container still has `touch-pan-y`, so a
		// native scroll can legitimately fire — that's the user's "let me
		// scroll instead" signal and we cancel the arm. After activation the
		// container flips to `touch-action: none`, so the only remaining
		// scroll source is our own autoscroll RAF in `startAutoscroll`; we
		// must not let it cancel itself.
		const onScroll = () => {
			if (sessionRef.current.drag) return
			clearArm()
		}

		// While the gesture owns vertical motion, block the page-level pull-to-
		// refresh and rubber-banding that Safari otherwise applies.
		const onTouchMove = (ev: TouchEvent) => {
			if (sessionRef.current.drag) ev.preventDefault()
		}

		container.addEventListener('pointerdown', onPointerDown)
		container.addEventListener('pointermove', onPointerMove, { passive: false })
		container.addEventListener('pointerup', onPointerUp)
		container.addEventListener('pointercancel', onPointerCancel)
		container.addEventListener('click', onClickCapture, true)
		container.addEventListener('scroll', onScroll, { passive: true })
		document.addEventListener('touchmove', onTouchMove, { passive: false })

		return () => {
			container.removeEventListener('pointerdown', onPointerDown)
			container.removeEventListener('pointermove', onPointerMove)
			container.removeEventListener('pointerup', onPointerUp)
			container.removeEventListener('pointercancel', onPointerCancel)
			container.removeEventListener('click', onClickCapture, true)
			container.removeEventListener('scroll', onScroll)
			document.removeEventListener('touchmove', onTouchMove)
			clearArm()
			stopAutoscroll()
			sessionRef.current.drag = null
			sessionRef.current.suppressClick = false
		}
	}, [scrollRef, enabled])

	return { mode }
}
