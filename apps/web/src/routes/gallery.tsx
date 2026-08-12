import { ChatTranscript } from '@/components/chat/chat-transcript'
import { ForYouListRow } from '@/components/foryou/foryou-list-row'
import { ObjectCard } from '@/components/objects/data-table/object-card'
import { OwnerSelect, StatusSelect } from '@/components/objects/property-selects'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AvatarGroup } from '@/components/shared/avatar-group'
import { ChatTypingMotion } from '@/components/shared/chat-typing-motion'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterChip } from '@/components/shared/filter-chip'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { ObjectReference } from '@/components/shared/object-reference'
import { SourceBadge } from '@/components/shared/source-badge'
import { SparkBar, StatCell } from '@/components/shared/stat-cell'
import { StatusBadge } from '@/components/shared/status-badge'
import { SuggestChip } from '@/components/shared/suggest-chip'
import { TypeBadge } from '@/components/shared/type-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { MemberResponse, ObjectResponse, UnreadItem, WorkspaceWithRole } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import type { ChatEvent } from '@/lib/chat-stream'
import type { SSEStatus } from '@/lib/sse'
import { useTheme } from '@/lib/theme'
import { WorkspaceContext } from '@/lib/workspace-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronsUpDown, House, Inbox, LayoutDashboard, Moon, Search, Sun } from 'lucide-react'
import { type ReactNode, useState } from 'react'

export const Route = createFileRoute('/gallery')({
	component: GalleryPage,
})

// Patterns render without the auth-gated app shell, so the data-bound hooks
// (workspaces, agents, sessions, object lookups) get an isolated query client
// that fails fast instead of hammering the API — the shared components still
// render their empty/loading states off live tokens, which is what the walk
// asserts.

const galleryQueryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			staleTime: Number.POSITIVE_INFINITY,
			gcTime: Number.POSITIVE_INFINITY,
		},
	},
})

const MOCK_WORKSPACE = {
	id: 'gallery-ws',
	name: 'Design Library',
} as unknown as WorkspaceWithRole

const mockWorkspaceContext = {
	workspace: MOCK_WORKSPACE,
	workspaceId: 'gallery-ws',
	sseStatus: 'connected' as SSEStatus,
}

const MOCK_ACTORS: MemberResponse[] = [
	{ actorId: 'a1', role: 'admin', joinedAt: '2026-01-01T00:00:00Z', name: 'Sindre', type: 'human' },
	{
		actorId: 'a2',
		role: 'member',
		joinedAt: '2026-01-01T00:00:00Z',
		name: 'Strategist',
		type: 'agent',
	},
	{
		actorId: 'a3',
		role: 'member',
		joinedAt: '2026-01-01T00:00:00Z',
		name: 'Developer',
		type: 'agent',
	},
]

const MOCK_OBJECT: ObjectResponse = {
	id: 'obj-1',
	workspaceId: 'gallery-ws',
	type: 'bet',
	title: 'Design review + shared component library',
	content: 'Cool zinc is the product palette; the mockup is the source of truth.',
	status: 'active',
	metadata: null,
	driver: null,
	activeSessionId: null,
	createdBy: 'a1',
	createdAt: '2026-08-11T10:00:00Z',
	updatedAt: '2026-08-12T00:00:00Z',
}

const MOCK_UNREAD: UnreadItem = {
	entity_type: 'object',
	entity_id: 'obj-1',
	unread_count: 2,
	mentioning_unread_count: 1,
	latest_event_id: 12,
	latest_activity_at: '2026-08-12T00:00:00Z',
	object: MOCK_OBJECT,
}

const MOCK_CHAT: ChatEvent[] = [
	{ kind: 'user', text: 'Summarise this bet' },
	{
		kind: 'text',
		text: 'The bet is on track. **13 of 23** patterns are reusable as-is; four are net-new primitives.',
	},
	{ kind: 'tool_use', id: 't1', name: 'get_objects', input: { ids: ['obj-1'] } },
	{ kind: 'thinking', text: 'Weighing the light/dark token evidence…' },
	{ kind: 'result', subtype: 'success', isError: false, text: 'Done', durationMs: 420 },
]

const STATUSES = ['signal', 'define', 'active', 'done']

const BET_STATUS: BetStatusResult = {
	state: 'progressing',
	pendingAction: {
		kind: 'progressing',
		tasks: [{ id: 't2', title: 'Build the shared gallery', driver: 'a3', status: 'in_progress' }],
	},
	decisionsSoFar: [],
}

function Specimen({
	n,
	title,
	reuse,
	children,
}: {
	n: number
	title: string
	reuse: string
	children: ReactNode
}) {
	return (
		<section className="flex w-full min-w-0 flex-col gap-3">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold text-foreground">{title}</h3>
				<span className="font-mono text-[11px] text-muted-foreground">#{n} / 23</span>
			</div>
			<div className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground">
				<div className="overflow-x-auto">{children}</div>
			</div>
			<p className="text-xs text-muted-foreground">{reuse}</p>
		</section>
	)
}

function GalleryPage() {
	const { resolvedTheme, setTheme } = useTheme()
	const [filterValue, setFilterValue] = useState<'all' | 'open' | 'done'>('all')
	const [status, setStatus] = useState('active')
	const [ownerId, setOwnerId] = useState<string | null>('a2')
	const [spark, setSpark] = useState([22, 41, 30, 58, 47, 70, 63, 88])

	return (
		<div className="min-h-screen bg-background text-foreground">
			<div className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
				<header className="mb-8 flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<p className="font-mono text-[11px] tracking-wide text-muted-foreground">
							SHARED COMPONENT LIBRARY — PART 2
						</p>
						<h1 className="mt-1 text-2xl font-semibold tracking-[-0.022em]">
							Repeating pattern gallery
						</h1>
						<p className="mt-1 max-w-xl text-sm text-muted-foreground">
							23 patterns drawn from the mockup, composed from the shared component inventory and
							the four Part-1 primitives, sourced from the live :root / .dark tokens.
						</p>
					</div>
					<div className="flex items-center gap-2 rounded-md border border-border bg-card p-1">
						<Button
							type="button"
							variant={resolvedTheme === 'light' ? 'secondary' : 'ghost'}
							size="sm"
							onClick={() => setTheme('light')}
						>
							<Sun className="size-4" aria-hidden />
							Light
						</Button>
						<Button
							type="button"
							variant={resolvedTheme === 'dark' ? 'secondary' : 'ghost'}
							size="sm"
							onClick={() => setTheme('dark')}
						>
							<Moon className="size-4" aria-hidden />
							Dark
						</Button>
					</div>
				</header>

				<WorkspaceContext.Provider value={mockWorkspaceContext}>
					<QueryClientProvider client={galleryQueryClient}>
						<main className="flex flex-col gap-8">
							<Specimen
								n={1}
								title="Sidebar nav row"
								reuse="layout/sidebar.tsx · layout/sidebar-nav-item.tsx"
							>
								<div className="w-full max-w-56">
									<SidebarProvider defaultOpen>
										<SidebarGroup>
											<SidebarGroupLabel>Workspace</SidebarGroupLabel>
											<SidebarMenu>
												<SidebarMenuItem>
													<SidebarMenuButton isActive>
														<LayoutDashboard className="size-4" aria-hidden />
														<span>Overview</span>
														<SidebarMenuBadge>3</SidebarMenuBadge>
													</SidebarMenuButton>
												</SidebarMenuItem>
												<SidebarMenuItem>
													<SidebarMenuButton>
														<House className="size-4" aria-hidden />
														<span>For You</span>
													</SidebarMenuButton>
												</SidebarMenuItem>
												<SidebarMenuItem>
													<SidebarMenuButton>
														<Inbox className="size-4" aria-hidden />
														<span>Objects</span>
													</SidebarMenuButton>
												</SidebarMenuItem>
											</SidebarMenu>
										</SidebarGroup>
									</SidebarProvider>
								</div>
							</Specimen>

							<Specimen n={2} title="Workspace switcher row" reuse="layout/workspace-switcher.tsx">
								<div className="w-full max-w-56">
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm font-medium text-sidebar-accent-foreground"
									>
										<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
											D
										</span>
										<span className="min-w-0 flex-1 truncate text-left">Development</span>
										<ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
									</button>
								</div>
							</Specimen>

							<Specimen n={3} title="User menu row" reuse="layout/nav-user.tsx">
								<div className="w-full max-w-56">
									<DropdownMenu>
										<DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border border-input bg-card px-2 py-1.5 text-left text-sm">
											<ActorAvatar name="Sindre" type="human" size="sm" />
											<span className="min-w-0 flex-1 truncate font-medium">sindre@maskin.io</span>
											<ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="start" className="w-56">
											<DropdownMenuLabel>sindre@maskin.io</DropdownMenuLabel>
											<DropdownMenuSeparator />
											<DropdownMenuItem>Profile</DropdownMenuItem>
											<DropdownMenuItem>Settings</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem>Log out</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</Specimen>

							<Specimen
								n={4}
								title="Live-agents strip"
								reuse="layout/sidebar-activity.tsx + shared/actor-avatar.tsx"
							>
								<div className="flex flex-col gap-2.5">
									<div className="flex items-center gap-2.5">
										<AvatarGroup
											items={MOCK_ACTORS.map((a) => ({
												id: a.actorId,
												name: a.name,
												type: a.type,
											}))}
											max={4}
										/>
										<span className="text-sm text-muted-foreground">3 working now</span>
									</div>
									<div className="flex flex-col gap-1.5">
										{MOCK_ACTORS.map((a) => (
											<div
												key={a.actorId}
												className="flex items-center gap-2.5 rounded-md bg-muted/40 px-2 py-1.5"
											>
												<ActorAvatar name={a.name} type={a.type} size="sm" />
												<span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
												<ChatTypingMotion variant="eq" state="typing" />
											</div>
										))}
									</div>
								</div>
							</Specimen>

							<Specimen n={5} title="Top-nav tabs" reuse="ui/tabs.tsx · shared/filter-tabs.tsx">
								<div className="flex flex-col gap-3">
									<Tabs defaultValue="objects">
										<TabsList>
											<TabsTrigger value="bets">Bets</TabsTrigger>
											<TabsTrigger value="objects" className="px-3">
												Objects
											</TabsTrigger>
											<TabsTrigger value="agents">Agents</TabsTrigger>
										</TabsList>
									</Tabs>
									<FilterTabs<typeof filterValue>
										aria-label="Filter"
										tabs={[
											{ label: 'All', value: 'all', count: 23 },
											{ label: 'Open', value: 'open', count: 12 },
											{ label: 'Done', value: 'done', count: 5 },
										]}
										value={filterValue}
										onChange={setFilterValue}
									/>
								</div>
							</Specimen>

							<Specimen
								n={6}
								title="Chip family"
								reuse="shared/filter-chip.tsx · ui/badge.tsx · ui/button-group.tsx"
							>
								<div className="flex flex-col gap-3">
									<div className="flex flex-wrap items-center gap-2">
										<FilterChip label="Status: active" value="active" onRemove={() => {}} />
										<FilterChip label="Owner: Strategist" value="a2" onRemove={() => {}} />
										<Badge>primary</Badge>
										<Badge variant="secondary">secondary</Badge>
										<Badge variant="outline">outline</Badge>
										<Badge variant="destructive">destructive</Badge>
									</div>
									<div className="flex flex-wrap gap-2">
										<TypeBadge type="bet" />
										<StatusBadge status="active" />
										<StatusBadge status="in_review" variant="dot-word" />
									</div>
									<ButtonGroup className="w-fit">
										<Button type="button" variant="outline" size="sm">
											Day
										</Button>
										<Button type="button" variant="outline" size="sm">
											Week
										</Button>
										<Button type="button" variant="outline" size="sm">
											Month
										</Button>
									</ButtonGroup>
								</div>
							</Specimen>

							<Specimen
								n={7}
								title="Menu row (DropdownMenu)"
								reuse="ui/dropdown-menu.tsx · objects/property-selects.tsx"
							>
								<div className="flex flex-wrap items-center gap-3">
									<StatusSelect current={status} options={STATUSES} onChange={setStatus} />
									<OwnerSelect
										members={MOCK_ACTORS}
										currentOwnerId={ownerId}
										onChange={setOwnerId}
										compact
									/>
								</div>
							</Specimen>

							<Specimen
								n={8}
								title="Select field"
								reuse="objects/property-selects.tsx · ui/select.tsx"
							>
								<Select value={status} onValueChange={(v) => setStatus(v)}>
									<SelectTrigger className="w-full max-w-64">
										<SelectValue placeholder="Select status" />
									</SelectTrigger>
									<SelectContent>
										{STATUSES.map((s) => (
											<SelectItem key={s} value={s}>
												{s}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Specimen>

							<Specimen
								n={9}
								title="Actor avatar + group"
								reuse="shared/actor-avatar.tsx · AvatarGroup (net-new)"
							>
								<div className="flex flex-wrap items-center gap-5">
									<div className="flex items-center gap-2">
										<ActorAvatar name="Strategist" type="agent" />
										<ActorAvatar name="Sindre" type="human" />
										<ActorAvatar name="Developer" type="agent" size="sm" />
									</div>
									<AvatarGroup
										items={[
											{ id: 'a1', name: 'Sindre', type: 'human' },
											{ id: 'a2', name: 'Strategist', type: 'agent' },
											{ id: 'a3', name: 'Developer', type: 'agent' },
											{ id: 'a4', name: 'Designer', type: 'agent' },
											{ id: 'a5', name: 'Synthesizer', type: 'agent' },
										]}
										max={4}
										size="md"
									/>
								</div>
							</Specimen>

							<Specimen
								n={10}
								title="Chat message + typing"
								reuse="chat/chat-transcript.tsx · ChatTypingMotion (net-new)"
							>
								<div className="flex flex-col gap-3">
									<ChatTranscript
										workspaceId="gallery-ws"
										events={MOCK_CHAT}
										starting={false}
										error={null}
										className="max-h-56"
									/>
									<div className="flex items-center gap-4 border-t border-border pt-3">
										<ChatTypingMotion variant="dots" state="typing" />
										<ChatTypingMotion variant="eq" state="typing" />
										<ChatTypingMotion variant="mic" state="typing" />
										<ChatTypingMotion variant="eq" state="stopped" />
									</div>
								</div>
							</Specimen>

							<Specimen n={11} title="Conversation group row" reuse="chat/chat-panel.tsx">
								<div className="flex w-full max-w-sm flex-col gap-1">
									{MOCK_ACTORS.map((a) => (
										<div
											key={a.actorId}
											className="flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted/60"
										>
											<AvatarGroup
												items={[{ name: a.name, type: a.type }]}
												max={1}
												showOverflow={false}
											/>
											<div className="min-w-0 flex-1">
												<div className="flex items-center justify-between gap-2">
													<span className="truncate text-sm font-medium">{a.name}</span>
													<span className="text-xs text-muted-foreground">2m</span>
												</div>
												<p className="truncate text-xs text-muted-foreground">
													Working through the gallery…
												</p>
											</div>
										</div>
									))}
								</div>
							</Specimen>

							<Specimen
								n={12}
								title="Source / citation pill"
								reuse="shared/source-badge.tsx · shared/object-reference.tsx"
							>
								<div className="flex flex-wrap items-center gap-2">
									<SourceBadge source="behavioral" />
									<SourceBadge source="thread" />
									<Badge variant="secondary">obj-1 · 2 cites</Badge>
								</div>
								<div className="mt-3 flex flex-wrap gap-2">
									<ObjectReference
										objectId={MOCK_OBJECT.id}
										workspaceId="gallery-ws"
										object={MOCK_OBJECT}
									/>
									<ObjectReference
										objectId={MOCK_OBJECT.id}
										workspaceId="gallery-ws"
										object={MOCK_OBJECT}
										variant="block"
										showType
										showStatus
									/>
								</div>
							</Specimen>

							<Specimen n={13} title="Object row / card" reuse="objects/data-table/object-card.tsx">
								<ObjectCard
									object={MOCK_OBJECT}
									workspaceId="gallery-ws"
									isSelected={false}
									onSelect={() => {}}
									onClick={() => {}}
									betStatus={BET_STATUS}
								/>
							</Specimen>

							<Specimen n={14} title="Ask row / create-field row" reuse="composed from inputs">
								<div className="flex w-full max-w-sm flex-col gap-2.5">
									<div className="flex items-center gap-2">
										<span className="w-14 shrink-0 text-sm text-muted-foreground">Owner</span>
										<Input className="flex-1" defaultValue="Strategist" />
									</div>
									<div className="flex items-center gap-2">
										<span className="w-14 shrink-0 text-sm text-muted-foreground">Status</span>
										<StatusSelect current={status} options={STATUSES} onChange={setStatus} />
									</div>
								</div>
							</Specimen>

							<Specimen n={15} title="For You list row" reuse="foryou/foryou-list-row.tsx">
								<div className="w-full max-w-sm rounded-md border border-border">
									<ForYouListRow workspaceId="gallery-ws" item={MOCK_UNREAD} />
									<ForYouListRow
										workspaceId="gallery-ws"
										item={{ ...MOCK_UNREAD, unread_count: 0, mentioning_unread_count: 0 }}
									/>
								</div>
							</Specimen>

							<Specimen n={16} title="Loop flow rail" reuse="loops/loop-flow.tsx">
								<div className="flex w-full flex-wrap items-center gap-2">
									{STATUSES.map((s, i) => (
										<div key={s} className="flex items-center gap-2">
											<div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-2">
												<span className="text-xs font-medium text-foreground">
													{s.replace(/_/g, ' ')}
												</span>
												<Badge variant="secondary">{i + 1}</Badge>
											</div>
											{i < STATUSES.length - 1 ? (
												<span className="text-muted-foreground" aria-hidden>
													→
												</span>
											) : null}
										</div>
									))}
								</div>
							</Specimen>

							<Specimen
								n={17}
								title="Stat cell + spark bar"
								reuse="agents/agent-usage-chart.tsx · StatCell/SparkBar (net-new)"
							>
								<div className="flex flex-wrap">
									<StatCell label="tokens" value="12.4k" delta="+8%" deltaTone="positive" />
									<StatCell label="sessions" value="3.1k" delta="−2%" deltaTone="negative" />
									<StatCell label="cache" value="86%" spark={spark} />
								</div>
								<div className="mt-4">
									<SparkBar data={spark} height={36} />
								</div>
							</Specimen>

							<Specimen n={18} title="Toggle row (privacy)" reuse="ui/switch.tsx · ui/card.tsx">
								<div className="flex w-full max-w-sm flex-col gap-2">
									{(
										[
											['Share usage data', 'Help improve the product'],
											['Anonymise my workspace', 'Hash identity before it leaves'],
										] as const
									).map(([title, desc]) => (
										<div
											key={title}
											className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5"
										>
											<div>
												<p className="text-sm font-medium">{title}</p>
												<p className="text-xs text-muted-foreground">{desc}</p>
											</div>
											<Switch defaultChecked={title.startsWith('Share')} aria-label={title} />
										</div>
									))}
								</div>
							</Specimen>

							<Specimen n={19} title="Table row" reuse="ui/table.tsx">
								<Table className="w-full min-w-72">
									<TableHeader>
										<TableRow>
											<TableHead>Item</TableHead>
											<TableHead>Status</TableHead>
											<TableHead className="text-right">Amount</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										<TableRow>
											<TableCell className="font-medium">Usage</TableCell>
											<TableCell>
												<StatusBadge status="active" />
											</TableCell>
											<TableCell className="text-right">$24.00</TableCell>
										</TableRow>
										<TableRow>
											<TableCell className="font-medium">Tokens</TableCell>
											<TableCell>
												<StatusBadge status="done" />
											</TableCell>
											<TableCell className="text-right">$6.50</TableCell>
										</TableRow>
									</TableBody>
								</Table>
							</Specimen>

							<Specimen n={20} title="Card + board column" reuse="ui/card.tsx · objects/board/">
								<div className="flex flex-wrap gap-4">
									<Card className="w-44">
										<CardHeader className="pb-2">
											<CardTitle className="text-sm">Define</CardTitle>
										</CardHeader>
										<CardContent className="flex flex-col gap-2">
											<div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
												<p className="truncate text-sm font-medium">Settle palette</p>
												<p className="text-xs text-muted-foreground">Part 1</p>
											</div>
											<div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
												<p className="truncate text-sm font-medium">Regate count</p>
												<p className="text-xs text-muted-foreground">21 → 23</p>
											</div>
										</CardContent>
									</Card>
									<Card className="w-44">
										<CardHeader className="pb-2">
											<CardTitle className="text-sm">Active</CardTitle>
											<CardDescription className="text-xs">2 in flight</CardDescription>
										</CardHeader>
										<CardContent>
											<div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
												<p className="truncate text-sm font-medium">Build gallery</p>
												<p className="text-xs text-muted-foreground">T2</p>
											</div>
										</CardContent>
									</Card>
								</div>
							</Specimen>

							<Specimen
								n={21}
								title="Command palette rows"
								reuse="command-palette.tsx · shared/new-menu.tsx"
							>
								<div className="w-full max-w-sm">
									<div className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
										<div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
											<Search className="size-4 text-muted-foreground" aria-hidden />
											<Input
												className="border-0 shadow-none focus-visible:ring-0"
												placeholder="Search commands…"
												value=""
												onChange={() => {}}
											/>
										</div>
										<div className="flex flex-col p-1.5">
											{['Build a bet', 'Open Objects', 'Ask Strategist'].map((row) => (
												<div
													key={row}
													className="flex items-center justify-between rounded-md px-2.5 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
												>
													<span>{row}</span>
													<span className="font-mono text-[10px] text-muted-foreground">↵</span>
												</div>
											))}
										</div>
									</div>
								</div>
							</Specimen>

							<Specimen
								n={22}
								title="Decision block + receipt"
								reuse="foryou/foryou-queue-card.tsx"
							>
								<div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
									<div className="mb-3 flex items-center justify-between">
										<span className="text-sm font-semibold">Decision needed</span>
										<StatusBadge status="in_review" variant="dot-word" />
									</div>
									<p className="text-sm text-muted-foreground">
										Approve the gallery handoff to the Code Reviewer?
									</p>
									<div className="mt-3 flex flex-wrap gap-2">
										<Badge variant="secondary">Ship</Badge>
										<Badge variant="secondary">Fix first</Badge>
										<Badge variant="secondary">Re-plan</Badge>
									</div>
								</div>
							</Specimen>

							<Specimen
								n={23}
								title="Empty state + section overline"
								reuse="shared/empty-state.tsx · ui/label.tsx"
							>
								<div className="flex flex-col gap-4">
									<div className="flex items-center gap-2">
										<Label className="font-mono text-[11px] tracking-wide text-muted-foreground">
											ACTIVITY
										</Label>
										<span className="h-px flex-1 bg-border" aria-hidden />
									</div>
									<EmptyState
										title="No recent activity"
										description="Nothing has changed in this view yet."
										action={
											<Button type="button" variant="outline" size="sm">
												Create an object
											</Button>
										}
									/>
								</div>
							</Specimen>
						</main>
					</QueryClientProvider>
				</WorkspaceContext.Provider>

				<footer className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">
					Specimens render at 375px in light ({resolvedTheme === 'light' ? 'active' : 'inactive'})
					and dark ({resolvedTheme === 'dark' ? 'active' : 'inactive'}) from the live :root / .dark
					tokens. Zero hardcoded colour or radius in this page.
				</footer>
			</div>
		</div>
	)
}
