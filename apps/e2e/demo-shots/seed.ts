// Fills the Maskin Demo workspace with fake data for the screenshot job.
//
// Safe to run twice: every object carries a stable demo_key in its metadata and is only
// created when no object with that key exists. Everything here is invented (a fictional
// Danish bakery and a few neighbouring shops); there are no real names, companies, emails
// or customer data. Run: pnpm --filter @maskin/e2e demo:seed
import { fileURLToPath } from 'node:url'
import { type ApiObject, DemoApi, login } from './api'
import { DEMO_FLAG, DEMO_KEY, DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME } from './config'

export const AGENT_NAME = 'Customer Replies'
export const CHAT_TITLE = 'What needs me at the bakery today?'
export const KEYS = {
	bet: 'bet-click-and-collect',
	approvalTask: 'task-approval-gluten-free-reply',
} as const

const DEMO_NOTE = '\n\nDemo data: invented for product screenshots.'

interface TaskSeed {
	key: string
	title: string
	status: string
	content: string
	/** Part of the click-and-collect bet. */
	inBet?: boolean
	/** Driven by the demo agent. */
	byAgent?: boolean
}

const TASKS: TaskSeed[] = [
	{
		key: 'task-order-form',
		title: 'Set up the online order form',
		status: 'done',
		content: 'Order form is live with pickup times between 07:00 and 16:00.',
		inBet: true,
	},
	{
		key: 'task-pickup-rules',
		title: 'Write the pickup-time rules',
		status: 'in_review',
		content: 'Orders close at 18:00 the day before. Late pickups are held until 17:00.',
		inBet: true,
	},
	{
		key: 'task-announcement',
		title: 'Draft the opening announcement',
		status: 'in_progress',
		content: 'Short post for the shop window, the newsletter and the Instagram page.',
		inBet: true,
		byAgent: true,
	},
	{
		key: 'task-sourdough-photos',
		title: 'Photograph the new sourdough range',
		status: 'todo',
		content: 'Four loaves, natural light, before the morning rush.',
		inBet: true,
	},
	{
		key: 'task-delivery-prices',
		title: 'Compare prices from two delivery partners',
		status: 'backlog',
		content: 'Only relevant if pickup orders go well. Compare cost per parcel.',
		inBet: true,
	},
	{
		key: 'task-bike-shop-invoice',
		title: 'Answer the bike shop about invoice 1042',
		status: 'todo',
		content: 'They were charged kr. 1.280 for the party order and expected kr. 1.180.',
		byAgent: true,
	},
	{
		key: 'task-opening-hours',
		title: 'Update opening hours on the website',
		status: 'in_progress',
		content: 'Winter hours start on Monday: 07:00 to 16:00, closed Sundays.',
	},
	{
		key: 'task-packaging',
		title: 'Order paper bags for December',
		status: 'backlog',
		content: 'Last year 2.400 bags lasted until 20 December.',
	},
	{
		key: 'task-newsletter',
		title: 'Send the newsletter to regulars',
		status: 'validated',
		content: 'Cardamom buns are back. Checked and ready to send.',
	},
	{
		key: 'task-card-payments',
		title: 'Match last month’s card payments',
		status: 'done',
		content: 'All 312 payments match the bank statement.',
	},
]

const APPROVAL_REPLY = `Hej,

Thank you for asking about gluten-free bread. We bake three gluten-free loaves on Tuesdays and Fridays: a seeded rye-style loaf, a buckwheat loaf and a small sandwich loaf. They are baked in a separate area, but our kitchen does handle wheat flour, so they are not suitable for severe allergies.

You can reserve a loaf through the pickup form and collect it from 07:00.

Venlig hilsen
Bageriet Nordlys`

export async function seed(): Promise<void> {
	const human = await login()
	const api = new DemoApi(human.api_key)
	await api.assertMember(DEMO_WORKSPACE_NAME)

	const existing = new Map<string, ApiObject>()
	for (const type of ['bet', 'task']) {
		for (const obj of await api.listObjects(type)) {
			const key = obj.metadata?.[DEMO_KEY]
			if (typeof key === 'string') existing.set(key, obj)
		}
	}
	const created: string[] = []

	async function ensureObject(
		key: string,
		data: {
			type: string
			title: string
			status: string
			content: string
			driver?: string
			metadata?: Record<string, unknown>
			/** Drafts are the exact text to send, so they carry no demo note (metadata marks them). */
			demoNote?: boolean
		},
	): Promise<ApiObject> {
		const found = existing.get(key)
		if (found) return found
		const { demoNote = true, ...fields } = data
		const obj = await api.request<ApiObject>('POST', '/objects', {
			...fields,
			content: demoNote ? data.content + DEMO_NOTE : data.content,
			metadata: { ...data.metadata, [DEMO_FLAG]: true, [DEMO_KEY]: key },
		})
		existing.set(key, obj)
		created.push(key)
		return obj
	}

	// The agent. Its key is only returned when it is created, so everything the agent itself
	// writes (comments, chat replies) is done in the run that creates it, or when a marker
	// shows it is missing and the key is at hand.
	const actors = await api.listActors()
	let agentId = actors.find((a) => a.type === 'agent' && a.name === AGENT_NAME)?.id
	let agentApi: DemoApi | null = null
	if (!agentId) {
		const made = await api.request<{ id: string; name: string; type: string; api_key: string }>(
			'POST',
			'/actors',
			{
				type: 'agent',
				name: AGENT_NAME,
				workspace_id: DEMO_WORKSPACE_ID,
				description:
					'Answers customer questions for a small Danish bakery and drafts replies for approval. Demo agent.',
				system_prompt: 'Demo agent. Never acts on its own.',
			},
		)
		agentId = made.id
		agentApi = new DemoApi(made.api_key)
		created.push('agent')
	}

	const bet = await ensureObject(KEYS.bet, {
		type: 'bet',
		title: 'Open click-and-collect at Bageriet Nordlys',
		status: 'active',
		content:
			'Let regulars order bread and pastries online and pick them up without queueing. Goal: 40 pickup orders a week by the end of the month.',
		driver: agentId,
	})

	const betEdges = await api.request<{ targetId: string }[]>(
		'GET',
		`/relationships?source_id=${bet.id}&type=breaks_into`,
	)
	const linked = new Set(betEdges.map((e) => e.targetId))

	for (const t of TASKS) {
		const task = await ensureObject(t.key, {
			type: 'task',
			title: t.title,
			status: t.status,
			content: t.content,
			driver: t.byAgent ? agentId : undefined,
		})
		if (t.inBet && !linked.has(task.id)) {
			await api.request('POST', '/relationships', {
				source_type: 'object',
				source_id: bet.id,
				target_type: 'object',
				target_id: task.id,
				type: 'breaks_into',
			})
		}
	}

	// The approval card: a drafted email the agent wants approved, with the ask on it.
	const approval = await ensureObject(KEYS.approvalTask, {
		type: 'task',
		title: 'Reply to a customer about gluten-free bread',
		status: 'in_review',
		content: APPROVAL_REPLY,
		driver: agentId,
		demoNote: false,
		metadata: {
			kind: 'email',
			to: 'kunde@example.com',
			subject: 'Gluten-free bread at Bageriet Nordlys',
		},
	})
	const seededAt = new Date().toISOString()
	if (!approval.metadata?.seeded_comments) {
		if (!agentApi) {
			throw new Error(
				`The ${AGENT_NAME} agent already exists but its comments are missing, and its key is not recoverable. Remove the agent in the demo workspace and run the seed again.`,
			)
		}
		await agentApi.request('POST', '/events', {
			entity_id: approval.id,
			content: 'Drafted a reply to the gluten-free question. Waiting for your approval.',
			mentions: [human.id],
			attention: 4,
			decision: {
				title: 'Send this reply to the customer?',
				summary:
					'A customer asked about gluten-free bread 2 days ago and is still waiting. I drafted a reply that lists the 3 loaves we bake gluten-free.',
				ask: 'I will not send email in the bakery’s name without you.',
				options: [
					{
						label: 'Send reply',
						recommended: true,
						destructive: true,
						consequences: ['Reply goes out today', 'The customer gets the pickup link'],
					},
					{
						label: 'Edit first',
						consequences: ['Nothing is sent until you edit', 'The customer keeps waiting'],
					},
					{
						label: 'Skip',
						consequences: ['No reply is sent', 'The question stays open'],
					},
				],
				draft: {
					object_id: approval.id,
					label: 'Email to customer',
					to: 'Customer, kunde@example.com',
				},
			},
		})
		await agentApi.request('POST', '/events', {
			entity_id: bet.id,
			content: 'Pickup ordering is ready for a go-live decision.',
			mentions: [human.id],
			attention: 3,
			decision: {
				title: 'Open pickup orders to customers?',
				summary:
					'14 of 18 pickup slots are set up and the form passed 3 test orders. Opening hours are the last open item.',
				ask: 'I will not open orders to customers without your go.',
				only_while_status: ['active'],
				options: [
					{
						label: 'Open orders',
						recommended: true,
						consequences: ['Customers can order from Monday', 'Bakers see orders at 05:00'],
					},
					{
						label: 'Wait a week',
						consequences: ['Orders stay closed', 'The opening post is delayed'],
					},
				],
			},
		})
		await api.request('PATCH', `/objects/${approval.id}`, {
			metadata: { ...approval.metadata, seeded_comments: true, seeded_at: seededAt },
		})
		created.push('comments')
	}

	// A short chat with the agent. The agent writes its own replies. The two person messages
	// may wake the agent; the demo workspace has no model credentials, so nothing runs.
	const chats = await api.request<{ conversations: { id: string; title: string }[] }>(
		'GET',
		'/conversations?limit=100',
	)
	if (!chats.conversations.some((c) => c.title === CHAT_TITLE)) {
		if (!agentApi) {
			throw new Error(
				`The ${AGENT_NAME} agent already exists but the chat is missing, and its key is not recoverable. Remove the agent in the demo workspace and run the seed again.`,
			)
		}
		const chat = await api.request<{ id: string }>('POST', '/conversations', {
			title: CHAT_TITLE,
			participant_actor_ids: [agentId],
			initial_message: 'Good morning. What needs me at the bakery today?',
		})
		const post = (client: DemoApi, content: string) =>
			client.request('POST', `/conversations/${chat.id}/messages`, { content })
		await post(
			agentApi,
			'Morning! Two things need you today:\n\n1. A customer is waiting for an answer about gluten-free bread. I drafted a reply for your approval.\n2. Pickup ordering is ready to open. 14 of 18 slots are set up.\n\nEverything else is on track: the newsletter is checked and last month’s 312 card payments match the bank.',
		)
		await post(api, 'Send the bread reply, then open pickup on Monday.')
		await post(
			agentApi,
			'Understood. Once you approve the reply in For You it goes out today. I will open pickup orders on Monday morning and tell the bakers to expect orders from 05:00.',
		)
		created.push('chat')
	}

	console.log(
		created.length ? `Seeded: ${created.join(', ')}` : 'Nothing to seed: demo data is complete.',
	)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	seed().catch((err) => {
		console.error(err instanceof Error ? err.message : err)
		process.exit(1)
	})
}
