/** Object types provided by the Work module */
export const WORK_OBJECT_TYPES = [
	{
		type: 'insight',
		label: 'Insight',
		pluralLabel: 'Insights',
		icon: 'lightbulb',
		defaultStatuses: ['new', 'processing', 'clustered', 'discarded'],
	},
	{
		type: 'bet',
		label: 'Bet',
		pluralLabel: 'Bets',
		icon: 'target',
		defaultStatuses: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
	},
	{
		type: 'task',
		label: 'Task',
		pluralLabel: 'Tasks',
		icon: 'check-square',
		defaultStatuses: ['todo', 'in_progress', 'done', 'blocked'],
	},
] as const
