import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { McpAppContext } from '@/mcp-apps/shared/mcp-app-provider'
import {
	ActivityFeed,
	ObjectCard,
	ObjectKanban,
	ObjectListTable,
	RelationshipGraph,
	WIDGET_CATALOG,
	type WorkspaceSchema,
} from '@/mcp-apps/shared/widgets'
import { createFileRoute } from '@tanstack/react-router'

/**
 * Dev sandbox for the MCP widget catalog. Designers can iterate on visuals
 * without booting Claude — every primitive is mounted with seeded fixtures
 * that match the response shapes documented in `packages/mcp/RENDERING.md`.
 *
 * Hidden from the main nav on purpose; lives under `/dev/` so it stays an
 * internal tool. Hit it directly at `/<workspaceId>/dev/mcp-widgets`.
 */
export const Route = createFileRoute('/_authed/$workspaceId/dev/mcp-widgets')({
	component: McpWidgetsSandbox,
})

const SCHEMA: WorkspaceSchema = {
	workspace_id: 'demo',
	workspace_name: 'Demo workspace',
	relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to'],
	types: {
		insight: {
			display_name: 'Insight',
			statuses: ['new', 'processing', 'clustered', 'discarded'],
			fields: [],
		},
		bet: {
			display_name: 'Bet',
			statuses: ['signal', 'proposed', 'active', 'completed', 'paused'],
			fields: [{ name: 'priority', type: 'enum', required: false, values: ['low', 'med', 'high'] }],
		},
		task: {
			display_name: 'Task',
			statuses: ['todo', 'in_progress', 'done', 'blocked'],
			fields: [],
		},
	},
}

const NOW = new Date().toISOString()

const SAMPLE_OBJECT = {
	id: '11111111-1111-1111-1111-111111111111',
	workspaceId: 'demo',
	type: 'bet',
	title: 'Rich MCP app experience — turn tool responses into interactive workspace cards in-chat',
	content:
		'**Hypothesis:** if MCP responses upgrade from text to interactive cards, the chat surface becomes a full Maskin client.',
	status: 'active',
	metadata: null,
	owner: null,
	activeSessionId: null,
	createdBy: 'system',
	createdAt: NOW,
	updatedAt: NOW,
}

const SAMPLE_OBJECTS = [
	{
		...SAMPLE_OBJECT,
		id: 'a',
		title: 'Audit MCP UI gaps vs web app',
		type: 'task',
		status: 'done',
	},
	{
		...SAMPLE_OBJECT,
		id: 'b',
		title: 'Define rendering primitives',
		type: 'task',
		status: 'in_progress',
	},
	{
		...SAMPLE_OBJECT,
		id: 'c',
		title: 'Wire ObjectCard into objects card',
		type: 'task',
		status: 'todo',
	},
	{ ...SAMPLE_OBJECT, id: 'd', title: 'Add kanban widget for bets', type: 'task', status: 'todo' },
	{
		...SAMPLE_OBJECT,
		id: 'e',
		title: 'Backfill activity feed wrapper',
		type: 'task',
		status: 'blocked',
	},
]

const SAMPLE_GRAPH = {
	nodes: [
		{ id: 'n1', type: 'bet', title: 'Rich MCP app experience', status: 'active' },
		{ id: 'n2', type: 'task', title: 'Define rendering primitives', status: 'in_progress' },
		{ id: 'n3', type: 'task', title: 'Add kanban widget', status: 'todo' },
	],
	edges: [
		{ id: 'e1', source: 'n1', target: 'n2', type: 'breaks_into' },
		{ id: 'e2', source: 'n1', target: 'n3', type: 'breaks_into' },
		{ id: 'e3', source: 'n2', target: 'n3', type: 'informs' },
	],
}

const SAMPLE_EVENTS = [
	{
		id: 1,
		workspaceId: 'demo',
		actorId: 'system',
		action: 'object.created',
		entityType: 'task',
		entityId: 'b',
		data: null,
		createdAt: NOW,
	},
	{
		id: 2,
		workspaceId: 'demo',
		actorId: 'system',
		action: 'object.status_changed',
		entityType: 'task',
		entityId: 'a',
		data: { from: 'in_progress', to: 'done' },
		createdAt: NOW,
	},
]

function McpWidgetsSandbox() {
	return (
		<McpAppContext.Provider
			value={{
				isConnected: true,
				toolResult: {
					toolName: 'sandbox',
					result: { content: [] },
					input: null,
					webAppBaseUrl: window.location.origin,
					workspaceId: 'demo',
				},
				callTool: async () => ({ content: [] }),
			}}
		>
			<div className="p-6 space-y-6 max-w-5xl">
				<header>
					<h1 className="text-lg font-semibold text-foreground">MCP widget sandbox</h1>
					<p className="text-sm text-muted-foreground">
						Catalog of rendering primitives mounted with fixture data. See{' '}
						<code className="text-xs">packages/mcp/RENDERING.md</code> for the response-shape
						mapping.
					</p>
				</header>

				<Tabs defaultValue="object_card">
					<TabsList>
						{WIDGET_CATALOG.map((entry) => (
							<TabsTrigger key={entry.kind} value={entry.kind}>
								{entry.displayName}
							</TabsTrigger>
						))}
					</TabsList>

					<TabsContent value="object_card">
						<Description>Single object detail. Used when a tool returns one record.</Description>
						<ObjectCard object={SAMPLE_OBJECT} schema={SCHEMA} />
					</TabsContent>

					<TabsContent value="object_list_table">
						<Description>Default fallback for any object list.</Description>
						<Card className="p-0 overflow-hidden">
							<ObjectListTable objects={SAMPLE_OBJECTS} schema={SCHEMA} />
						</Card>
					</TabsContent>

					<TabsContent value="object_kanban">
						<Description>
							Status-grouped kanban. Column order respects schema status sequence.
						</Description>
						<ObjectKanban objects={SAMPLE_OBJECTS} schema={SCHEMA} />
					</TabsContent>

					<TabsContent value="relationship_graph">
						<Description>Nodes and edges; for create_graph and list_relationships.</Description>
						<RelationshipGraph
							nodes={SAMPLE_GRAPH.nodes}
							edges={SAMPLE_GRAPH.edges}
							schema={SCHEMA}
						/>
					</TabsContent>

					<TabsContent value="activity_feed">
						<Description>Events stream wrapper around the web app's ActivityFeedView.</Description>
						<Card className="h-[420px] overflow-hidden">
							<ActivityFeed events={SAMPLE_EVENTS} />
						</Card>
					</TabsContent>
				</Tabs>
			</div>
		</McpAppContext.Provider>
	)
}

function Description({ children }: { children: React.ReactNode }) {
	return <p className="mb-3 text-xs text-muted-foreground">{children}</p>
}
