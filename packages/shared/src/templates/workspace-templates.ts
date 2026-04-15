import type { z } from 'zod'
import type { workspaceSettingsSchema } from '../schemas/workspaces'
import {
	DEVELOPMENT_AGENTS,
	DEVELOPMENT_TRIGGERS,
	type SeedAgent,
	type SeedTrigger,
} from './development-agents'
import { GROWTH_AGENTS, GROWTH_TRIGGERS } from './growth-agents'

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>
export type { SeedAgent, SeedTrigger }

export interface TemplateSeedNode {
	$id: string
	type: string
	title: string
	content?: string
	status: string
	metadata?: Record<string, unknown>
}

export interface TemplateSeedEdge {
	source: string
	target: string
	type: string
}

export interface WorkspaceTemplate {
	id: string
	name: string
	description: string
	/**
	 * Vivid, excited pitch handed to the agent as guidance for the post-apply
	 * message to the user. Should answer: "what did I just get?" in a way that
	 * makes the user feel they now own a capable new machine.
	 */
	pitch: string
	settings: Partial<WorkspaceSettings>
	seedNodes: TemplateSeedNode[]
	seedEdges: TemplateSeedEdge[]
	/** Agents to create alongside the workspace schema + seed objects. */
	seedAgents?: SeedAgent[]
	/** Event/cron triggers to create; targetActor$id references a SeedAgent. */
	seedTriggers?: SeedTrigger[]
}

const developmentTemplate: WorkspaceTemplate = {
	id: 'development',
	name: 'Development',
	description:
		'For product teams building and shipping software. Tracks bets (experiments to run), tasks (work to ship), and insights (things you learn).',
	pitch:
		"You now have your own AI development team — an execution machine. Drop in a bet (a goal you want to reach), optionally point it at a GitHub repo, and agents can pick up the tasks, write the code, and ship. You bring the direction; the machine does the building. Bets break into tasks, tasks become PRs, and insights feed back into the next bet. It's the setup a senior eng org takes months to build — you have it running in 3 minutes.",
	settings: {
		display_names: {
			bet: 'Bet',
			task: 'Task',
			insight: 'Insight',
		},
		statuses: {
			bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'in_review', 'testing', 'done', 'blocked'],
			insight: ['new', 'processing', 'clustered', 'discarded'],
		},
		field_definitions: {
			task: [{ name: 'github_link', type: 'text', required: false }],
			insight: [{ name: 'tags', type: 'text', required: false }],
		},
		relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
		enabled_modules: ['work'],
	},
	seedNodes: [
		{
			$id: 'bet1',
			type: 'bet',
			title: 'Ship the first end-to-end feature',
			content:
				'Pick one small but meaningful feature. Go from idea to shipped, so the team experiences the full loop once.',
			status: 'active',
		},
		{
			$id: 'task1',
			type: 'task',
			title: 'Write a one-page spec for the feature',
			content: 'Problem, user, scope, non-goals, success criteria. Keep it under one page.',
			status: 'todo',
		},
		{
			$id: 'task2',
			type: 'task',
			title: 'Implement and open a PR',
			content: 'Prefer a vertical slice over perfect abstractions.',
			status: 'todo',
		},
		{
			$id: 'insight1',
			type: 'insight',
			title: 'Example insight: users want X',
			content:
				'Replace this with something you actually learned. Insights are the raw material for future bets.',
			status: 'new',
			metadata: { tags: 'example' },
		},
	],
	seedEdges: [
		{ source: 'bet1', target: 'task1', type: 'breaks_into' },
		{ source: 'bet1', target: 'task2', type: 'breaks_into' },
		{ source: 'insight1', target: 'bet1', type: 'informs' },
	],
	seedAgents: DEVELOPMENT_AGENTS,
	seedTriggers: DEVELOPMENT_TRIGGERS,
}

const growthTemplate: WorkspaceTemplate = {
	id: 'growth',
	name: 'Growth',
	description:
		'For founders and growth teams running a pipeline. Ships with a full agent org: Bet Decomposer, SDR, Content Agent, Scout, Growth Ops, Curator, Launch Manager, and more — all wired up via tag-routed task triggers.',
	pitch:
		'You now have your own AI growth team — a machine that turns signals into bets into shipped outreach and content. Drop in a goal (first 100 users, hit $10k MRR, launch on Product Hunt) and the machine plans the experiments, breaks bets into tasks, and routes each task to a specialist: SDR for outreach, Content Agent for drafts, Scout for reply opportunities, Growth Ops for review, Launch Manager for launch-day coordination. Contacts, companies, and LinkedIn posts live in the same graph as bets and insights, so nothing falls through the cracks. Daily and weekly reviews keep score and recommend next moves. You bring the vision; the machine runs the playbook.',
	settings: {
		display_names: {
			bet: 'Bet',
			task: 'Task',
			insight: 'Insight',
			contact: 'Contact',
			company: 'Company',
			linkedin_post: 'LinkedIn Post',
		},
		statuses: {
			bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'done', 'blocked'],
			insight: ['new', 'processing', 'clustered', 'discarded'],
			contact: [
				'new_lead',
				'connection_requested',
				'messaged',
				'in_conversation',
				'meeting_booked',
				'converted',
				'not_interested',
				'follow_up_later',
			],
			company: ['prospect', 'icp_match', 'engaged', 'customer', 'churned', 'not_a_fit'],
			linkedin_post: ['draft', 'proposed', 'approved', 'published', 'skipped'],
		},
		field_definitions: {
			bet: [
				{
					name: 'impact',
					type: 'enum',
					required: false,
					values: ['high', 'medium', 'low'],
				},
				{
					name: 'effort',
					type: 'enum',
					required: false,
					values: ['high', 'medium', 'low'],
				},
				{ name: 'deadline', type: 'date', required: false },
				{ name: 'tag', type: 'text', required: false },
			],
			task: [
				{
					name: 'tag',
					type: 'enum',
					required: false,
					values: ['outreach', 'content', 'scouting', 'video', 'ops', 'launch'],
				},
			],
			contact: [
				{ name: 'linkedin_url', type: 'text', required: false },
				{ name: 'email', type: 'text', required: false },
				{ name: 'company', type: 'text', required: false },
				{ name: 'position', type: 'text', required: false },
				{ name: 'connected_on', type: 'date', required: false },
				{ name: 'last_contacted', type: 'date', required: false },
				{ name: 'notes', type: 'text', required: false },
				{ name: 'lead_source', type: 'text', required: false },
				{
					name: 'priority',
					type: 'enum',
					required: false,
					values: ['hot', 'warm', 'cold'],
				},
				{
					name: 'outreach_stage',
					type: 'enum',
					required: false,
					values: [
						'not_started',
						'first_touch',
						'follow_up_1',
						'follow_up_2',
						'breakup',
						'completed',
					],
				},
				{
					name: 'response_status',
					type: 'enum',
					required: false,
					values: ['no_reply', 'replied', 'engaged', 'bounced'],
				},
				{
					name: 'icp_score',
					type: 'enum',
					required: false,
					values: ['perfect', 'strong', 'moderate', 'weak', 'not_fit'],
				},
				{ name: 'icp_reasoning', type: 'text', required: false },
			],
			company: [
				{ name: 'website', type: 'text', required: false },
				{ name: 'industry', type: 'text', required: false },
				{
					name: 'size',
					type: 'enum',
					required: false,
					values: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'],
				},
				{
					name: 'icp_score',
					type: 'enum',
					required: false,
					values: ['perfect', 'strong', 'moderate', 'weak'],
				},
				{ name: 'notes', type: 'text', required: false },
			],
			linkedin_post: [
				{ name: 'hook', type: 'text', required: false },
				{ name: 'source_url', type: 'text', required: false },
				{ name: 'relevance_score', type: 'number', required: false },
				{ name: 'reasoning', type: 'text', required: false },
			],
		},
		custom_extensions: {
			crm: {
				name: 'CRM',
				types: ['contact', 'company'],
				relationship_types: ['relates_to', 'works_at', 'decision_maker_at'],
				enabled: true,
			},
			linkedin_content: {
				name: 'LinkedIn Content',
				types: ['linkedin_post'],
				relationship_types: ['derived_from'],
				enabled: true,
			},
		},
		relationship_types: [
			'informs',
			'breaks_into',
			'blocks',
			'relates_to',
			'duplicates',
			'works_at',
			'decision_maker_at',
			'derived_from',
		],
		enabled_modules: ['work'],
	},
	seedNodes: [
		{
			$id: 'bet1',
			type: 'bet',
			title: 'Reach our first 100 users',
			content:
				'Find the people most likely to love the product and get them to try it. Track what works and what does not.',
			status: 'active',
			metadata: { impact: 'high', effort: 'medium' },
		},
		{
			$id: 'task1',
			type: 'task',
			title: 'Send 10 personal intros this week',
			content:
				'Short, personal, specific. Track replies as contacts. The SDR Agent will pick this up when moved to in_progress.',
			status: 'todo',
			metadata: { tag: 'outreach' },
		},
		{
			$id: 'task2',
			type: 'task',
			title: 'Draft a launch post',
			content:
				'One page. What it is, who it is for, why now. The Content Agent will pick this up when moved to in_progress.',
			status: 'todo',
			metadata: { tag: 'content' },
		},
		{
			$id: 'task3',
			type: 'task',
			title: 'Find 5 reply opportunities on X/Reddit this week',
			content:
				'Genuine, helpful replies — not spam. The Scout will pick this up when moved to in_progress.',
			status: 'todo',
			metadata: { tag: 'scouting' },
		},
		{
			$id: 'company1',
			type: 'company',
			title: 'Example Co',
			content: 'Replace this with a real target company.',
			status: 'prospect',
			metadata: { website: 'https://example.com', industry: 'SaaS', size: '11-50' },
		},
		{
			$id: 'contact1',
			type: 'contact',
			title: 'Jane Doe',
			content: 'Replace this with a real contact.',
			status: 'new_lead',
			metadata: {
				email: 'jane@example.com',
				company: 'Example Co',
				position: 'Head of Product',
				priority: 'warm',
				outreach_stage: 'not_started',
				response_status: 'no_reply',
			},
		},
		{
			$id: 'insight1',
			type: 'insight',
			title: 'Example insight: what is resonating',
			content:
				'When you notice a pattern in replies or signups, write it down here. It becomes the input for your next bet.',
			status: 'new',
		},
	],
	seedEdges: [
		{ source: 'bet1', target: 'task1', type: 'breaks_into' },
		{ source: 'bet1', target: 'task2', type: 'breaks_into' },
		{ source: 'bet1', target: 'task3', type: 'breaks_into' },
		{ source: 'contact1', target: 'company1', type: 'works_at' },
		{ source: 'insight1', target: 'bet1', type: 'informs' },
	],
	seedAgents: GROWTH_AGENTS,
	seedTriggers: GROWTH_TRIGGERS,
}

export const WORKSPACE_TEMPLATES = {
	development: developmentTemplate,
	growth: growthTemplate,
} as const satisfies Record<string, WorkspaceTemplate>

export type WorkspaceTemplateId = keyof typeof WORKSPACE_TEMPLATES
