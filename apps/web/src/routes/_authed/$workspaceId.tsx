import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { MobileNav } from '@/components/layout/mobile-nav'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePersistedSidebarOpen } from '@/hooks/use-persisted-sidebar-open'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { CommandPaletteProvider } from '@/lib/command-palette-context'
import { deriveConversationTitle } from '@/lib/conversation-title'
import { isHiddenRouteId, migrateLegacySidebarState, viewKeyFromRouteId } from '@/lib/nav-view-keys'
import { NewConversationProvider } from '@/lib/new-conversation-context'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { PendingCommentsProvider } from '@/lib/pending-comments-context'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
} from '@/lib/posthog'
import { WorkspaceContext, useWorkspace } from '@/lib/workspace-context'
import { Outlet, createFileRoute, useMatches, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'

migrateLegacySidebarState()

export const Route = createFileRoute('/_authed/$workspaceId')({
	component: WorkspaceLayout,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkspaceLayout() {
	const { workspaceId } = Route.useParams()
	const { data: workspaces } = useWorkspaces()

	// Connect SSE for real-time updates
	const sseStatus = useSSE(workspaceId)

	const workspace = useMemo(
		() => workspaces?.find((w) => w.id === workspaceId),
		[workspaces, workspaceId],
	)

	const matches = useMatches()
	const leafMatch = [...matches].reverse().find((m) => !isHiddenRouteId(m.routeId))
	const viewKey = leafMatch ? viewKeyFromRouteId(leafMatch.routeId) : null
	const { open, setOpen } = usePersistedSidebarOpen(viewKey)

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
			<NewConversationProvider>
				<CommandPaletteProvider>
					<PendingPromptBootstrap />
					<GuestDraftClaimBootstrap workspaceId={workspaceId} />
					<PendingCommentsProvider workspaceId={workspaceId}>
						<PageHeaderProvider>
							<ContentPushShell>
								<SidebarProvider open={open} onOpenChange={setOpen} className="h-screen !min-h-0">
									<AppSidebar />
									<SidebarInset className="min-w-0">
										<Header />
										<MainScrollArea>
											<Outlet />
										</MainScrollArea>
									</SidebarInset>
									<MobileNav />
								</SidebarProvider>
							</ContentPushShell>
						</PageHeaderProvider>
						<CommandPalette />
					</PendingCommentsProvider>
				</CommandPaletteProvider>
			</NewConversationProvider>
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
 * Reads `maskin_pending_prompt` from localStorage once the workspace's
 * default chat agent resolves, creates a new conversation seeded with that
 * prompt as the first message, and navigates straight to the resulting
 * thread. Fires at most once per mount — the ref guard prevents a re-trigger
 * if `defaultAgent` changes identity while remaining non-null.
 */
function PendingPromptBootstrap() {
	const { workspaceId } = useWorkspace()
	const defaultAgent = useDefaultChatAgent()
	const createConversation = useCreateConversation(workspaceId)
	const navigate = useNavigate()
	const firedRef = useRef(false)

	useEffect(() => {
		if (!defaultAgent || firedRef.current) return
		const prompt = localStorage.getItem('maskin_pending_prompt')
		if (!prompt) return
		firedRef.current = true
		localStorage.removeItem('maskin_pending_prompt')
		createConversation
			.mutateAsync({
				title: deriveConversationTitle(prompt, defaultAgent.name),
				participant_actor_ids: [defaultAgent.id],
				initial_message: prompt,
			})
			.then((conversation) => {
				navigate({
					to: '/$workspaceId/chats/$conversationId',
					params: { workspaceId, conversationId: conversation.id },
				})
			})
			.catch(() => console.error('[maskin] failed to bootstrap pending-prompt conversation'))
	}, [defaultAgent, createConversation, navigate, workspaceId])

	return null
}

/**
 * Wraps the main layout (left sidebar + header + outlet) so that when the
 * current route reports its own fixed right sidebar via PageHeaderContext
 * (e.g. the object-detail properties sidebar), the layout gets a right
 * margin equal to its width — that panel is fixed-positioned, so this margin
 * is what makes it "push content aside" instead of floating over it, and
 * keeps the header's action buttons clear of it.
 */
function ContentPushShell({ children }: { children: ReactNode }) {
	const { contentPush } = usePageHeader()
	const isMobile = useIsMobile()
	// On mobile the panel overlays the viewport (Sheet), so it must not apply
	// a margin that would squash the main content off-screen.
	const pagePushed = Boolean(contentPush) && !isMobile
	const marginRight: string | number = pagePushed ? (contentPush as string) : 0
	return (
		<div className="transition-[margin] duration-200 ease-linear" style={{ marginRight }}>
			{children}
		</div>
	)
}

/**
 * The shared page scroll container. Scrolls by default (`overflow-auto`) so
 * ordinary routes get normal page scrolling. A route can opt out via
 * `<PageHeader scrollLocked />` (e.g. the For You card queue, which owns its
 * own internal scroll region on the active card's thread) — the container
 * then clips instead of scrolling, so only that inner region scrolls.
 *
 * Mobile leaves `pb-20`/`scroll-pb-20` of space so the fixed `MobileNav`
 * bottom bar never covers the last row of content or a scroll-into-view
 * target; desktop resets both back to zero via `md:p-8`/`md:scroll-pb-0`.
 */
function MainScrollArea({ children }: { children: ReactNode }) {
	const { scrollLocked } = usePageHeader()
	return (
		<div
			className={cn(
				'flex flex-col flex-1 min-w-0 px-4 pb-20 pt-4 scroll-pb-20 md:p-8 md:scroll-pb-0',
				scrollLocked ? 'overflow-hidden' : 'overflow-auto',
			)}
			data-scroll-root
		>
			{children}
		</div>
	)
}
