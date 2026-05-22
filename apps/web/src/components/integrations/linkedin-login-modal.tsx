import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { queryKeys } from '@/lib/query-keys'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 800
const MOUSE_MOVE_THROTTLE_MS = 33 // ~30fps

type ModalState = 'starting' | 'streaming' | 'captured' | 'expired' | 'error' | 'cancelled'

interface Props {
	workspaceId: string
	open: boolean
	onClose: () => void
}

export function LinkedInLoginModal({ workspaceId, open, onClose }: Props) {
	const queryClient = useQueryClient()
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const [state, setState] = useState<ModalState>('starting')
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const sessionRef = useRef<{ id: string; accessToken: string } | null>(null)
	const lastMouseMoveRef = useRef(0)
	const abortRef = useRef<AbortController | null>(null)
	// Holds the in-flight POST /start Promise so that React 19 StrictMode's
	// intentional dev double-invoke (mount → cleanup → mount) reuses the same
	// request instead of firing a second POST that races past the concurrency
	// check. Refs persist across the synthetic unmount.
	type StartResult = Awaited<ReturnType<typeof api.integrations.linkedinAuthBrowser.start>>
	const bootPromiseRef = useRef<Promise<StartResult> | null>(null)

	const cleanup = useCallback(async () => {
		abortRef.current?.abort()
		abortRef.current = null
		bootPromiseRef.current = null
		const session = sessionRef.current
		sessionRef.current = null
		if (session) {
			await api.integrations.linkedinAuthBrowser.cancel(session.id, workspaceId).catch(() => {})
		}
	}, [workspaceId])

	const handleClose = useCallback(async () => {
		await cleanup()
		onClose()
	}, [cleanup, onClose])

	// Boot the flow when the modal opens. The first StrictMode mount kicks off
	// /start and stashes the Promise; the synthetic unmount sets `cancelled` on
	// the first closure; the second mount reuses the Promise and is the one that
	// actually opens the SSE.
	useEffect(() => {
		if (!open) return
		let cancelled = false
		setState('starting')
		setErrorMessage(null)

		const boot = async () => {
			if (!bootPromiseRef.current) {
				bootPromiseRef.current = api.integrations.linkedinAuthBrowser.start(workspaceId)
			}
			let start: StartResult
			try {
				start = await bootPromiseRef.current
			} catch (err) {
				if (cancelled) return
				bootPromiseRef.current = null
				setState('error')
				setErrorMessage(err instanceof Error ? err.message : String(err))
				return
			}
			if (cancelled) return
			// Guard against opening the SSE twice (the first StrictMode invocation
			// also reaches here, but its `cancelled` is true so it short-circuits).
			if (abortRef.current) return

			sessionRef.current = { id: start.id, accessToken: start.access_token }
			const controller = new AbortController()
			abortRef.current = controller

			fetchEventSource(
				`${API_BASE}/integrations/linkedin/auth-browser/${start.id}/${start.access_token}/stream`,
				{
					signal: controller.signal,
					headers: {
						Authorization: `Bearer ${getApiKey()}`,
						'X-Workspace-Id': workspaceId,
					},
					onopen: async (res) => {
						if (res.ok) {
							setState('streaming')
							return
						}
						throw new Error(`Stream open failed: ${res.status}`)
					},
					onmessage: (msg) => {
						if (msg.event === 'frame') {
							drawFrame(canvasRef.current, msg.data)
						} else if (msg.event === 'captured') {
							setState('captured')
							queryClient.invalidateQueries({
								queryKey: queryKeys.integrations.all(workspaceId),
							})
							controller.abort()
							setTimeout(() => onClose(), 1500)
						} else if (msg.event === 'expired') {
							setState('expired')
							controller.abort()
						} else if (msg.event === 'error') {
							setState('error')
							try {
								const parsed = JSON.parse(msg.data) as { message?: string }
								setErrorMessage(parsed.message ?? 'Unknown error')
							} catch {
								setErrorMessage(msg.data || 'Unknown error')
							}
							controller.abort()
						}
					},
					onerror: (err) => {
						if (cancelled) return
						setState('error')
						setErrorMessage(err instanceof Error ? err.message : String(err))
						throw err // stop retry loop
					},
					openWhenHidden: true,
				},
			).catch(() => {
				/* errors already surfaced via onerror */
			})
		}

		void boot()

		return () => {
			cancelled = true
		}
	}, [open, workspaceId, onClose, queryClient])

	// Cleanup when the modal really closes (open → false). Decoupled from the
	// boot effect so StrictMode's synthetic unmount doesn't tear down a session
	// the second invocation is about to consume.
	useEffect(() => {
		if (open) return
		void cleanup()
	}, [open, cleanup])

	const sendInput = useCallback(
		(type: 'mouse' | 'key' | 'wheel', payload: Record<string, unknown>) => {
			const session = sessionRef.current
			if (!session || state !== 'streaming') return
			api.integrations.linkedinAuthBrowser
				.sendInput(session.id, session.accessToken, type, payload, workspaceId)
				.catch(() => {
					// Best-effort input; failures are usually transient
				})
		},
		[state, workspaceId],
	)

	const toCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const rect = e.currentTarget.getBoundingClientRect()
		const scaleX = CANVAS_WIDTH / rect.width
		const scaleY = CANVAS_HEIGHT / rect.height
		return {
			x: Math.round((e.clientX - rect.left) * scaleX),
			y: Math.round((e.clientY - rect.top) * scaleY),
		}
	}

	const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const now = Date.now()
		if (now - lastMouseMoveRef.current < MOUSE_MOVE_THROTTLE_MS) return
		lastMouseMoveRef.current = now
		const { x, y } = toCanvasCoords(e)
		sendInput('mouse', { type: 'mouseMoved', x, y, button: 'none' })
	}

	const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const { x, y } = toCanvasCoords(e)
		sendInput('mouse', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
	}

	const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const { x, y } = toCanvasCoords(e)
		sendInput('mouse', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
	}

	const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
		const { x, y } = toCanvasCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>)
		sendInput('wheel', {
			type: 'mouseWheel',
			x,
			y,
			deltaX: -e.deltaX,
			deltaY: -e.deltaY,
		})
	}

	const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
		e.preventDefault()
		sendInput('key', {
			type: 'keyDown',
			key: e.key,
			code: e.code,
			text: e.key.length === 1 ? e.key : undefined,
			modifiers: keyboardModifiers(e),
		})
	}

	const handleKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
		e.preventDefault()
		sendInput('key', {
			type: 'keyUp',
			key: e.key,
			code: e.code,
			modifiers: keyboardModifiers(e),
		})
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) void handleClose()
			}}
		>
			<DialogContent className="max-w-5xl">
				<DialogHeader>
					<DialogTitle>Connect LinkedIn</DialogTitle>
					<DialogDescription className="text-xs">
						Log in to LinkedIn in the window below. We'll capture your session cookies and close the
						window automatically once you're signed in.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="relative bg-bg-surface border border-border rounded-md overflow-hidden">
						<canvas
							ref={canvasRef}
							width={CANVAS_WIDTH}
							height={CANVAS_HEIGHT}
							tabIndex={0}
							className="w-full h-auto aspect-[16/10] outline-none focus:ring-2 focus:ring-accent"
							onMouseMove={handleMouseMove}
							onMouseDown={handleMouseDown}
							onMouseUp={handleMouseUp}
							onWheel={handleWheel}
							onKeyDown={handleKeyDown}
							onKeyUp={handleKeyUp}
							onContextMenu={(e) => e.preventDefault()}
						/>
						{state !== 'streaming' && (
							<div className="absolute inset-0 flex items-center justify-center bg-bg-glass-heavy backdrop-blur-sm">
								<StatusOverlay state={state} errorMessage={errorMessage} />
							</div>
						)}
					</div>

					<div className="flex justify-end">
						<Button variant="ghost" size="sm" onClick={handleClose}>
							Cancel
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function StatusOverlay({
	state,
	errorMessage,
}: { state: ModalState; errorMessage: string | null }) {
	if (state === 'starting') {
		return (
			<div className="flex flex-col items-center gap-2 text-text-secondary">
				<Spinner />
				<span className="text-sm">Booting browser…</span>
			</div>
		)
	}
	if (state === 'captured') {
		return (
			<div className="flex flex-col items-center gap-2 text-success">
				<CheckCircle2 className="h-8 w-8" />
				<span className="text-sm">Connected!</span>
			</div>
		)
	}
	if (state === 'expired') {
		return (
			<div className="text-sm text-text-secondary">Session timed out. Close and try again.</div>
		)
	}
	if (state === 'error') {
		return (
			<div className="text-sm text-error max-w-md text-center px-4">
				{errorMessage ?? 'Something went wrong'}
			</div>
		)
	}
	return null
}

function drawFrame(canvas: HTMLCanvasElement | null, base64Jpeg: string) {
	if (!canvas) return
	const img = new Image()
	img.onload = () => {
		const ctx = canvas.getContext('2d')
		if (!ctx) return
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
	}
	img.src = `data:image/jpeg;base64,${base64Jpeg}`
}

function keyboardModifiers(e: React.KeyboardEvent): number {
	// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
	let m = 0
	if (e.altKey) m |= 1
	if (e.ctrlKey) m |= 2
	if (e.metaKey) m |= 4
	if (e.shiftKey) m |= 8
	return m
}
