import { sortByPriority } from './priority'
import type { BetCheckContext, BetInput, SetupCheck } from './types'

function safeCheck(name: string, run: () => SetupCheck | null): SetupCheck | null {
	try {
		return run()
	} catch (err) {
		console.error(`[setup-guidance] object check '${name}' threw, degrading to unknown:`, err)
		return {
			name,
			status: 'unknown',
			message: `Could not evaluate ${name}: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

const MIN_CONTENT_LENGTH = 200

function contentQuality(bet: BetInput): SetupCheck | null {
	const content = bet.content?.trim() ?? ''
	if (content.length >= MIN_CONTENT_LENGTH) return null
	return {
		name: 'content_quality',
		status: 'warn',
		message:
			content.length === 0
				? `This ${bet.type} has no content yet — ask the user to add more detail so agents and collaborators know what it's about.`
				: `This ${bet.type}'s content is only ${content.length} character${content.length === 1 ? '' : 's'} — ask the user to add more detail (aim for ${MIN_CONTENT_LENGTH}+).`,
		fix: {
			tool: 'update_objects',
			args_hint: 'set content: "<a fuller description>" on the object',
			why: 'Thin content gives agents and collaborators little to act on.',
		},
	}
}

function driverSet(bet: BetInput): SetupCheck {
	if (!bet.driver) {
		return {
			name: 'driver_set',
			status: 'warn',
			message: `This ${bet.type} has no driver — ask the user to add one so someone is accountable for moving it forward.`,
			fix: {
				tool: 'update_objects',
				args_hint: 'set driver: "<actor id>" on the object',
				why: 'Without a driver, nobody owns pushing this forward.',
			},
		}
	}
	return {
		name: 'driver_set',
		status: 'warn',
		message: `This ${bet.type} is driven by ${bet.driver} — ask the user to confirm this is the right driver.`,
		fix: {
			tool: 'update_objects',
			args_hint: 'set driver: "<actor id>" to change the owner',
			why: 'Objects are sometimes created with a placeholder or wrong driver — confirm ownership before work starts.',
		},
	}
}

function statusProgression(bet: BetInput, ctx: BetCheckContext): SetupCheck | null {
	const order = ctx.statusOrder ?? []
	if (order.length < 2 || !bet.status) return null
	const [first, next] = order
	if (bet.status !== first) return null
	return {
		name: 'status_progression',
		status: 'warn',
		message: `This ${bet.type} is at the entry status "${first}" — ask the user if it should be progressed to "${next}".`,
		fix: {
			tool: 'update_objects',
			args_hint: `set status: "${next}"`,
			why: `Objects sitting at the entry status ("${first}") may already be ready to move forward.`,
		},
	}
}

export function checkBet(bet: BetInput, ctx: BetCheckContext): SetupCheck[] {
	const results: (SetupCheck | null)[] = [
		safeCheck('content_quality', () => contentQuality(bet)),
		safeCheck('driver_set', () => driverSet(bet)),
		safeCheck('status_progression', () => statusProgression(bet, ctx)),
	]
	return sortByPriority(results.filter((c): c is SetupCheck => c !== null))
}
