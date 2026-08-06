import { ChatPanel } from '@/components/chat/chat-panel'
import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useActors } from '@/hooks/use-actors'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { deriveEntryAgentRole } from '@/lib/analytics'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { ChatProvider, useChat } from '@/lib/chat-context'
import { CommandPaletteProvider } from '@/lib/command-palette-context'
import { NewConversationProvider } from '@/lib/new-conversation-context'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { PendingCommentsProvider } from '@/lib/pending-comments-context'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
} from '@/lib/posthog'
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

	// Prefer the workspace-level default_agent_id when set (Chief of Staff
	// prototype bet); fall back to the Workspace Coach lookup by name. The
	// fallback keeps every pre-CoS workspace unchanged — settings without a
	// `default_agent_id` behave exactly as they did before this task.
	const defaultAgent = useMemo(() => {
		if (!actors) return null
		const settings = workspace?.settings as { default_agent_id?: string | null } | undefined
		const defaultId = settings?.default_agent_id
		if (typeof defaultId === 'string' && defaultId.length > 0) {
			const pinned = actors.find((a) => a.id === defaultId)
			if (pinned) return pinned
		}
		return actors.find((a) => a.type === 'agent' && a.name === 'Workspace Coach') ?? null
	}, [actors, workspace])
	const agentActorId = defaultAgent?.id ?? null
	// Chief of Staff prototype bet's `chat_session_started.entry_agent_role`:
	// derived from the routing agent's display name so the property flips to
	// `'chief-of-staff'` automatically once T3 makes CoS the default here.
	const entryAgentRole = useMemo(
		() => deriveEntryAgentRole(defaultAgent?.name ?? null),
		[defaultAgent],
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
			<ChatProvider workspaceId={workspaceId}>
				<NewConversationProvider>
					<CommandPaletteProvider>
						<PendingPromptBootstrap agentActorId={agentActorId} />
						<GuestDraftClaimBootstrap workspaceId={workspaceId} />
						<PendingCommentsProvider workspaceId={workspaceId}>
							<PageHeaderProvider>
								<ChatPinShell>
									<SidebarProvider open={open} onOpenChange={setOpen} className="h-screen !min-h-0">
										<AppSidebar />
										<SidebarInset className="min-w-0">
											<Header />
											<div
												className="flex flex-col flex-1 min-w-0 overflow-auto p-4 md:p-8"
												data-scroll-root
											>
												<Outlet />
											</div>
										</SidebarInset>
									</SidebarProvider>
								</ChatPinShell>
							</PageHeaderProvider>
							<CommandPalette />
							<ChatPanel
								workspaceId={workspaceId}
								agentActorId={agentActorId}
								entryAgentRole={entryAgentRole}
							/>
						</PendingCommentsProvider>
					</CommandPaletteProvider>
				</NewConversationProvider>
			</ChatProvider>
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
 * Reads `maskin_pending_prompt` from localStorage once the agent's actor ID
 * resolves, then opens the chat panel with that prompt as the first message.
 * Fires at most once per mount — the ref guard prevents a re-trigger if
 * `agentActorId` changes identity while remaining non-null.
 */
function PendingPromptBootstrap({ agentActorId }: { agentActorId: string | null }) {
	const { openWithContext } = useChat()
	const firedRef = useRef(false)

	useEffect(() => {
		if (!agentActorId || firedRef.current) return
		const prompt = localStorage.getItem('maskin_pending_prompt')
		if (!prompt) return
		firedRef.current = true
		localStorage.removeItem('maskin_pending_prompt')
		openWithContext([], prompt)
	}, [agentActorId, openWithContext])

	return null
}

/**
 * Wraps the main layout (left sidebar + header + outlet) so that when the
 * chat panel is pinned AND open, or the current route reports its own fixed
 * right sidebar via PageHeaderContext (e.g. the object-detail properties
 * sidebar), the layout gets a right margin equal to whichever is wider — both
 * panels are fixed-positioned, so this margin is what makes them "push
 * content aside" instead of floating over it, and keeps the header's action
 * buttons clear of either.
 */
function ChatPinShell({ children }: { children: ReactNode }) {
	const { pinned, open, panelWidth } = useChat()
	const { contentPush } = usePageHeader()
	const isMobile = useIsMobile()
	// On mobile both panels overlay the viewport (Sheet/Sheet), so a stale
	// `pinned=true` from desktop must not apply a margin that would squash
	// the main content off-screen.
	const chatPushed = pinned && open && !isMobile
	const pagePushed = Boolean(contentPush) && !isMobile
	let marginRight: string | number = 0
	if (chatPushed && pagePushed) {
		marginRight = `max(${panelWidth}px, ${contentPush})`
	} else if (chatPushed) {
		marginRight = `${panelWidth}px`
	} else if (pagePushed) {
		marginRight = contentPush as string
	}
	return (
		<div className="transition-[margin] duration-200 ease-linear" style={{ marginRight }}>
			{children}
		</div>
	)
}
