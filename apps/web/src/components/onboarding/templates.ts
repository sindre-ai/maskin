import { BarChart3, Globe, MessageSquare, PenTool } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface TemplateObject {
	$id: string
	type: string
	title: string
	content: string
	status: string
}

export interface TemplateEdge {
	source: string
	target: string
	type: string
}

export interface OnboardingTemplate {
	id: string
	name: string
	description: string
	icon: LucideIcon
	color: string
	objects: TemplateObject[]
	edges: TemplateEdge[]
	simulatedActivity: string[]
}

export const templates: OnboardingTemplate[] = [
	{
		id: 'feedback-triage',
		name: 'Customer Feedback Triage',
		description:
			'Agents monitor support channels, cluster feedback into themes, and surface actionable insights for your product team.',
		icon: MessageSquare,
		color: 'text-blue-600 dark:text-blue-400',
		objects: [
			{
				$id: 'insight-1',
				type: 'insight',
				title: 'Users struggling with onboarding flow',
				content:
					'Multiple reports from support tickets and NPS surveys indicate confusion during initial setup. Common themes: unclear next steps, missing tooltips, no progress indicator.',
				status: 'signal',
			},
			{
				$id: 'insight-2',
				type: 'insight',
				title: 'Feature request: bulk export',
				content:
					'12 customers requested CSV/Excel export in the last 30 days. Mostly enterprise accounts on annual plans.',
				status: 'clustered',
			},
			{
				$id: 'bet-1',
				type: 'bet',
				title: 'Redesign onboarding to reduce time-to-value',
				content:
					'Based on feedback analysis, reducing onboarding friction could improve activation by 20-30%. Focus on guided first-run experience with templates.',
				status: 'proposed',
			},
			{
				$id: 'task-1',
				type: 'task',
				title: 'Audit current onboarding drop-off points',
				content: 'Analyze funnel data and identify the top 3 drop-off moments in the current flow.',
				status: 'todo',
			},
		],
		edges: [
			{ source: 'insight-1', target: 'bet-1', type: 'informs' },
			{ source: 'bet-1', target: 'task-1', type: 'breaks_into' },
		],
		simulatedActivity: [
			'Agent scanning latest support tickets...',
			'Found 3 new feedback items matching "onboarding"',
			'Clustering feedback by theme...',
			'Updated insight: "Users struggling with onboarding flow"',
			'Surfacing recommendation to product team',
		],
	},
	{
		id: 'competitive-monitoring',
		name: 'Competitive Monitoring',
		description:
			'Agents track competitor launches, pricing changes, and market moves — then distill them into strategic bets for your team.',
		icon: Globe,
		color: 'text-purple-600 dark:text-purple-400',
		objects: [
			{
				$id: 'insight-1',
				type: 'insight',
				title: 'Competitor X launched AI-powered analytics',
				content:
					'Competitor X announced a new AI analytics feature targeting mid-market. Early reviews highlight ease of use but limited customization. Pricing starts at $49/seat.',
				status: 'signal',
			},
			{
				$id: 'insight-2',
				type: 'insight',
				title: 'Industry shift toward usage-based pricing',
				content:
					'3 of top 5 competitors moved to usage-based pricing in Q1. Market analysts predict this will become the standard within 18 months.',
				status: 'signal',
			},
			{
				$id: 'bet-1',
				type: 'bet',
				title: 'Evaluate usage-based pricing model',
				content:
					'Multiple competitors shifting to usage-based pricing. We should model the impact on our revenue and churn if we make a similar move.',
				status: 'proposed',
			},
			{
				$id: 'task-1',
				type: 'task',
				title: 'Build pricing impact model',
				content:
					'Create a spreadsheet model comparing current per-seat pricing vs usage-based scenarios using last 6 months of usage data.',
				status: 'todo',
			},
		],
		edges: [
			{ source: 'insight-2', target: 'bet-1', type: 'informs' },
			{ source: 'bet-1', target: 'task-1', type: 'breaks_into' },
		],
		simulatedActivity: [
			'Agent monitoring competitor news feeds...',
			'Detected pricing change from Competitor Y',
			'Cross-referencing with market analyst reports...',
			'Created insight: "Industry shift toward usage-based pricing"',
			'Recommending strategic review',
		],
	},
	{
		id: 'sprint-metrics',
		name: 'Sprint Metrics',
		description:
			'Agents pull data from your tools, calculate velocity and health metrics, and flag risks before standup.',
		icon: BarChart3,
		color: 'text-green-600 dark:text-green-400',
		objects: [
			{
				$id: 'insight-1',
				type: 'insight',
				title: 'Sprint velocity declining 15% over 3 sprints',
				content:
					'Team velocity dropped from 42 to 36 story points over the last 3 sprints. Correlation with increased bug-fix ratio (from 20% to 35% of sprint capacity).',
				status: 'signal',
			},
			{
				$id: 'insight-2',
				type: 'insight',
				title: 'QA bottleneck: 8 items blocked in review',
				content:
					'8 tickets stuck in QA review for 3+ days. Average review time increased from 1.2 to 3.4 days this sprint.',
				status: 'signal',
			},
			{
				$id: 'bet-1',
				type: 'bet',
				title: 'Invest in automated testing to reduce QA bottleneck',
				content:
					'QA is the primary bottleneck. Investing in automated test coverage for critical paths could free up 30% of QA capacity and improve velocity.',
				status: 'proposed',
			},
			{
				$id: 'task-1',
				type: 'task',
				title: 'Identify top 10 most-tested manual flows',
				content:
					'Work with QA to identify the 10 manual test flows that consume the most time. Prioritize by frequency and time-per-run.',
				status: 'todo',
			},
		],
		edges: [
			{ source: 'insight-1', target: 'bet-1', type: 'informs' },
			{ source: 'insight-2', target: 'bet-1', type: 'informs' },
			{ source: 'bet-1', target: 'task-1', type: 'breaks_into' },
		],
		simulatedActivity: [
			'Agent pulling sprint data from project tracker...',
			'Calculating velocity trend across last 3 sprints...',
			'Detected 15% velocity decline — flagging',
			'Analyzing blocked items in QA queue...',
			'Generated sprint health report',
		],
	},
	{
		id: 'content-pipeline',
		name: 'Content Pipeline',
		description:
			'Agents research topics, draft outlines, track publication status, and measure content performance across channels.',
		icon: PenTool,
		color: 'text-orange-600 dark:text-orange-400',
		objects: [
			{
				$id: 'insight-1',
				type: 'insight',
				title: '"How-to" content drives 3x more signups than thought leadership',
				content:
					'Analysis of last 50 blog posts: practical how-to guides generate 3.2x more trial signups per view than thought leadership pieces. Average time on page is also 40% higher.',
				status: 'clustered',
			},
			{
				$id: 'bet-1',
				type: 'bet',
				title: 'Shift content mix to 70% practical guides',
				content:
					'Data shows how-to content significantly outperforms thought leadership for signups. Shifting the content mix could double content-attributed signups.',
				status: 'active',
			},
			{
				$id: 'task-1',
				type: 'task',
				title: 'Draft: "5 automation workflows every PM needs"',
				content:
					'Write a practical guide targeting product managers. Include step-by-step walkthroughs with screenshots. Target: 1,500 words, publish by end of week.',
				status: 'in_progress',
			},
			{
				$id: 'task-2',
				type: 'task',
				title: 'Research trending topics in product ops',
				content:
					'Scan Reddit, Twitter, and industry newsletters for trending product ops topics. Compile a list of 10 potential article ideas with estimated search volume.',
				status: 'todo',
			},
		],
		edges: [
			{ source: 'insight-1', target: 'bet-1', type: 'informs' },
			{ source: 'bet-1', target: 'task-1', type: 'breaks_into' },
			{ source: 'bet-1', target: 'task-2', type: 'breaks_into' },
		],
		simulatedActivity: [
			'Agent scanning trending topics on Reddit...',
			'Found 5 relevant discussions in r/productmanagement',
			'Analyzing content performance metrics...',
			'Updated insight: how-to content ROI analysis',
			'Drafting outline for next article...',
		],
	},
]
