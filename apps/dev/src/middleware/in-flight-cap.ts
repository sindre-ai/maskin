import { createApiError } from '@maskin/shared'
import type { Context, MiddlewareHandler } from 'hono'

/** Seconds a refused client is told to wait. */
export const CAP_RETRY_AFTER_S = 3

export interface InFlightCapOptions {
	/** Most requests of one key that run at once. */
	max: number
	/** Most requests of one key that wait for a slot; the next one is refused at once. */
	maxWaiting: number
	/** Longest a request waits for a slot before it is refused. */
	maxWaitMs: number
	/** Who a request belongs to. Return undefined to leave it uncapped. */
	keyOf: (c: Context) => string | undefined
	/** Requests this cap never touches (event streams, webhooks, health). */
	skip?: (c: Context) => boolean
	/** Called when a request is refused, for a log line. */
	onRefuse?: (key: string) => void
	/** Most keys tracked at once; entries are dropped as soon as they go idle, so this is a backstop. */
	maxKeys?: number
}

type Slot = { running: number; waiting: Array<() => void> }

/**
 * Keeps one client from holding the whole database pool. Every request costs database
 * connections, the pool is shared by everyone (auth runs on each request), and a single busy
 * client (a loop view firing 100 reads, a retrying tab, an agent in a loop) used to starve all the
 * rest. At most `max` of a client's requests run; the next `maxWaiting` wait here, in memory,
 * which is cheap, instead of in the pool, which is not; beyond that, or after `maxWaitMs`, the
 * request is refused with a 503 and Retry-After, and the web and iOS clients retry those.
 *
 * Per key, never global: one client at its cap does not slow another. Only waiting is bounded
 * here; the work of a request that has started is never cut short.
 */
export function inFlightCap(options: InFlightCapOptions): MiddlewareHandler {
	const { max, maxWaiting, maxWaitMs, keyOf, skip, onRefuse, maxKeys = 5_000 } = options
	const slots = new Map<string, Slot>()

	const refuse = (c: Context, key: string) => {
		onRefuse?.(key)
		c.header('Retry-After', String(CAP_RETRY_AFTER_S))
		return c.json(
			createApiError('INTERNAL_ERROR', 'Too many requests at once. Try again in a few seconds.'),
			503,
		)
	}

	return async (c, next) => {
		if (skip?.(c)) return next()
		const key = keyOf(c)
		if (!key) return next()

		let slot = slots.get(key)
		if (!slot) {
			// Past the key limit, stop tracking new clients rather than grow without bound.
			if (slots.size >= maxKeys) return next()
			slot = { running: 0, waiting: [] }
			slots.set(key, slot)
		}

		if (slot.running >= max) {
			if (slot.waiting.length >= maxWaiting) return refuse(c, key)
			const granted = await new Promise<boolean>((resolve) => {
				const wake = () => {
					clearTimeout(timer)
					resolve(true)
				}
				const timer = setTimeout(() => {
					const at = slot.waiting.indexOf(wake)
					if (at >= 0) slot.waiting.splice(at, 1)
					resolve(false)
				}, maxWaitMs)
				timer.unref?.()
				slot.waiting.push(wake)
			})
			if (!granted) {
				if (slot.running === 0 && slot.waiting.length === 0) slots.delete(key)
				return refuse(c, key)
			}
			// The slot was handed over by the request that just finished: `running` already counts us.
		} else {
			slot.running += 1
		}

		try {
			await next()
		} finally {
			const oldest = slot.waiting.shift()
			if (oldest) {
				oldest() // hand the slot straight to the oldest waiter; `running` stays as it is
			} else {
				slot.running -= 1
				if (slot.running === 0) slots.delete(key)
			}
		}
	}
}
