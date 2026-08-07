import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { CommandPaletteProvider } from '@/lib/command-palette-context'
import { NewConversationProvider } from '@/lib/new-conversation-context'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { PendingCommentsProvider } from '@/lib/pending-comments-context'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
} from '@/lib/posthog'
import { WorkspaceContext, useWorkspace } from '@/lib/workspace-context'
import { Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
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

	// Connect SSE for real-time updates
	const sseStatus = useSSE(workspaceId)

	const workspace = useMemo(
		() => workspaces?.find((w) => w.id === workspaceId),
		[workspaces, workspaceId],
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
										<div
											className="flex flex-col flex-1 min-w-0 overflow-auto p-4 md:p-8"
											data-scroll-root
										>
											<Outlet />
										</div>
									</SidebarInset>
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
				title: defaultAgent.name,
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
