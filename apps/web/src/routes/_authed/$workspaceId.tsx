import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SindrePanel } from '@/components/sindre/sindre-panel'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { PageHeaderProvider } from '@/lib/page-header-context'
import { PendingCommentsProvider } from '@/lib/pending-comments-context'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
} from '@/lib/posthog'
import { SindreProvider, useSindre } from '@/lib/sindre-context'
import { WorkspaceContext } from '@/lib/workspace-context'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'maskin-sidebar-open'

// Migrate old key
try {
	const old = localStorage.getItem('ai-native-sidebar-open')
	if (old && !localStorage.getItem(STORAGE_KEY)) {
		localStorage.setItem(STORAGE_KEY, old)
		localStorage.removeItem('ai-native-sidebar-open')
	}
} catch {}

function getInitialOpen(): boolean {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		return stored === null ? true : stored === 'true'
	} catch {
		return true
	}
}

export const Route = createFileRoute('/_authed/$workspaceId')({
	component: WorkspaceLayout,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkspaceLayout() {
	const { workspaceId } = Route.useParams()
	const { data: workspaces } = useWorkspaces()
	const { data: actors } = useActors(workspaceId, { enabled: !!workspaceId })

	// Connect SSE for real-time updates
	const sseStatus = useSSE(workspaceId)

	const workspace = useMemo(
		() => workspaces?.find((w) => w.id === workspaceId),
		[workspaces, workspaceId],
	)

	// Resolve the per-workspace Sindre meta-agent by name (matches SINDRE_DEFAULT
	// in packages/shared/src/templates/sindre-agent.ts). Null until actors load
	// or when the workspace is missing Sindre (e.g. pre-backfill).
	const sindreActorId = useMemo(
		() => actors?.find((a) => a.type === 'agent' && a.name === 'Sindre')?.id ?? null,
		[actors],
	)

	const [open, setOpenState] = useState(getInitialOpen)

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => {
			const next = typeof value === 'function' ? value(prev) : value
			localStorage.setItem(STORAGE_KEY, String(next))
			return next
		})
	}, [])

	// Pin the Synthesizer's join keys on every analytics event from this workspace,
	// and apply the workspace's Privacy & data settings — both the share-usage
	// opt-in/out and the SHA-256 identify when anonymise is on — so the prefs
	// survive reloads, not just the moment the user flips a switch.
	const settings = workspace?.settings as Record<string, unknown> | undefined
	const privacy = settings?.privacy as
		| { share_usage?: boolean; anonymize_workspace?: boolean }
		| undefined
	const shareUsage = privacy?.share_usage ?? true
	const anonymizeWorkspace = privacy?.anonymize_workspace ?? false
	useEffect(() => {
		if (!workspace) return
		const actor = getStoredActor()
		if (!actor) return
		registerWorkspaceProperties({
			workspace_id: workspaceId,
			actor_id: actor.id,
			actor_type: actor.type,
		})
		setCapturingEnabled(shareUsage)
		void identifyForWorkspace(actor.id, anonymizeWorkspace)
	}, [workspace, workspaceId, shareUsage, anonymizeWorkspace])

	if (!workspace) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading workspace...</p>
			</div>
		)
	}

	return (
		<WorkspaceContext.Provider value={{ workspace, workspaceId, sseStatus }}>
			<SindreProvider workspaceId={workspaceId}>
				<PendingPromptBootstrap sindreActorId={sindreActorId} />
				<GuestDraftClaimBootstrap workspaceId={workspaceId} />
				<PendingCommentsProvider workspaceId={workspaceId}>
					<PageHeaderProvider>
						<SindrePinShell>
							<SidebarProvider open={open} onOpenChange={setOpen} className="h-screen !min-h-0">
								<AppSidebar />
								<SidebarInset className="min-w-0">
									<Header />
									<div className="flex flex-col flex-1 min-w-0 overflow-auto p-4 md:p-8">
										<Outlet />
									</div>
								</SidebarInset>
							</SidebarProvider>
						</SindrePinShell>
					</PageHeaderProvider>
					<CommandPalette />
					<SindrePanel workspaceId={workspaceId} sindreActorId={sindreActorId} />
				</PendingCommentsProvider>
			</SindreProvider>
		</WorkspaceContext.Provider>
	)
}

/**
 * Claims any guest bet drafts created on the landing page (identified by
 * `maskin_anon_id` in localStorage) and creates them as bets in the workspace.
 * Fires at most once — the key is removed before the API call so a failed
 * claim does not retry on the next render.
 */
function GuestDraftClaimBootstrap({ workspaceId }: { workspaceId: string }) {
	const firedRef = useRef(false)

	useEffect(() => {
		if (firedRef.current) return
		const guestSessionId = localStorage.getItem('maskin_anon_id')
		if (!guestSessionId) return
		firedRef.current = true
		localStorage.removeItem('maskin_anon_id')

		api.publicBetStrategist
			.claim(workspaceId, guestSessionId)
			.then(({ claimed }) =>
				Promise.allSettled(
					claimed
						.filter((d) => d.content)
						.map((d) =>
							api.objects.create(workspaceId, {
								type: 'bet',
								title: d.title ?? undefined,
								content: d.content ?? undefined,
								status: 'signal',
							}),
						),
				),
			)
			.catch(() => console.error('[maskin] failed to claim guest drafts'))
	}, [workspaceId])

	return null
}

/**
 * Reads `maskin_pending_prompt` from localStorage once Sindre's actor ID
 * resolves, then opens the Sindre panel with that prompt as the first message.
 * Fires at most once per mount — the ref guard prevents a re-trigger if
 * `sindreActorId` changes identity while remaining non-null.
 */
function PendingPromptBootstrap({ sindreActorId }: { sindreActorId: string | null }) {
	const { openWithContext } = useSindre()
	const firedRef = useRef(false)

	useEffect(() => {
		if (!sindreActorId || firedRef.current) return
		const prompt = localStorage.getItem('maskin_pending_prompt')
		if (!prompt) return
		firedRef.current = true
		localStorage.removeItem('maskin_pending_prompt')
		openWithContext([], prompt)
	}, [sindreActorId, openWithContext])

	return null
}

/**
 * Wraps the main layout so that when Sindre is pinned AND open, the layout
 * gets a right margin equal to the Sindre panel width — the panel is always
 * fixed-positioned, so this margin is what makes it "push content aside"
 * instead of floating over it.
 */
function SindrePinShell({ children }: { children: ReactNode }) {
	const { pinned, open, panelWidth } = useSindre()
	const isMobile = useIsMobile()
	// On mobile the panel overlays the viewport and the pin toggle is hidden,
	// so a stale `pinned=true` from desktop must not apply a margin that would
	// squash the main content off-screen.
	const pushed = pinned && open && !isMobile
	return (
		<div
			className="transition-[margin] duration-200 ease-linear"
			style={{ marginRight: pushed ? `${panelWidth}px` : 0 }}
		>
			{children}
		</div>
	)
}
