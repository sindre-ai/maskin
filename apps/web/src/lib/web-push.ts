/**
 * Browser side of Web Push: feature detection, service-worker registration and the
 * subscribe/unsubscribe calls on the Push API. Server side lives in
 * apps/dev/src/services/web-push.ts; the worker itself is public/sw.js.
 */

const SW_URL = '/sw.js'
// The server-side subscription id, so "turn off" can delete the exact row. Losing it (cleared
// site data) is harmless: the row is pruned the first time the push service reports it gone.
const SUBSCRIPTION_ID_KEY = 'maskin-web-push-subscription-id'

export function isWebPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'serviceWorker' in navigator &&
		'PushManager' in window &&
		'Notification' in window
	)
}

export function getPermission(): NotificationPermission {
	return typeof Notification === 'undefined' ? 'denied' : Notification.permission
}

export function getStoredSubscriptionId(): string | null {
	try {
		return localStorage.getItem(SUBSCRIPTION_ID_KEY)
	} catch {
		return null
	}
}

export function storeSubscriptionId(id: string | null) {
	try {
		if (id) localStorage.setItem(SUBSCRIPTION_ID_KEY, id)
		else localStorage.removeItem(SUBSCRIPTION_ID_KEY)
	} catch {
		// Storage can be blocked (private window); the toggle still works for this session.
	}
}

/** VAPID keys travel URL-safe base64; `subscribe()` wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
	const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
	const out = new Uint8Array(new ArrayBuffer(raw.length))
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
	return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
	await navigator.serviceWorker.register(SW_URL)
	return navigator.serviceWorker.ready
}

/** The browser's current push subscription, without registering anything or asking permission. */
export async function getBrowserSubscription(): Promise<PushSubscription | null> {
	if (!isWebPushSupported()) return null
	const reg = await navigator.serviceWorker.getRegistration(SW_URL)
	return (await reg?.pushManager.getSubscription()) ?? null
}

/** What `close()` and the matchers below need from a shown browser notification. */
export type ShownNotification = { tag: string; data?: unknown; close(): void }

/**
 * The tags a push for this notification can carry: the server tags a push with its collapse key
 * when it has one, else the notification id (buildWebPushPayload in apps/dev).
 */
export function pushTagsOf(n: { id: string; metadata?: Record<string, unknown> | null }): string[] {
	const key = n.metadata?.push_collapse_key
	return typeof key === 'string' && key.trim() ? [n.id, key.trim()] : [n.id]
}

/** Matches the tags chat pushes use for one conversation: the chat, its threads and @mentions. */
export function isChatTag(tag: string, conversationId: string): boolean {
	return (
		tag === `chat:${conversationId}` ||
		tag.startsWith(`chat:${conversationId}:`) ||
		tag.startsWith(`chat-mention:${conversationId}:`)
	)
}

/**
 * Shown notifications of this workspace whose tag is not in `pendingTags`. A notification from
 * another workspace (or with no link we can read) is left alone: we only know the pending set of
 * the workspace in view.
 */
export function staleNotifications<T extends ShownNotification>(
	shown: T[],
	workspaceId: string,
	pendingTags: Set<string>,
): T[] {
	const prefix = `/${workspaceId}/`
	return shown.filter((n) => {
		const url = (n.data as { url?: unknown } | null | undefined)?.url
		return (
			Boolean(n.tag) && typeof url === 'string' && url.startsWith(prefix) && !pendingTags.has(n.tag)
		)
	})
}

/** Notifications this browser is showing right now; empty when push is off or unsupported. */
export async function getShownNotifications(): Promise<Notification[]> {
	if (!isWebPushSupported() || getPermission() !== 'granted') return []
	const reg = await navigator.serviceWorker.getRegistration(SW_URL)
	return (await reg?.getNotifications()) ?? []
}

/**
 * Closes shown browser notifications picked by `pick`. Only reaches this browser: closing one on
 * another device would need a silent push, which browsers do not allow. Never throws, since a
 * lingering notification must not break the action that handled it.
 */
export async function closeShownNotifications(
	pick: (shown: Notification[]) => Notification[],
): Promise<void> {
	try {
		for (const n of pick(await getShownNotifications())) n.close()
	} catch {
		// Best effort.
	}
}

export type SubscribeOutcome =
	| { status: 'subscribed'; subscription: PushSubscription }
	| { status: 'denied' }
	| { status: 'dismissed' } // prompt closed without a choice; permission is still "default"

/** Must be called from a user gesture: it may show the permission prompt. */
export async function subscribeBrowser(publicKey: string): Promise<SubscribeOutcome> {
	const permission = await Notification.requestPermission()
	if (permission === 'default') return { status: 'dismissed' }
	if (permission !== 'granted') return { status: 'denied' }
	const reg = await registration()
	const subscription =
		(await reg.pushManager.getSubscription()) ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey),
		}))
	return { status: 'subscribed', subscription }
}

export async function unsubscribeBrowser(): Promise<void> {
	const subscription = await getBrowserSubscription()
	await subscription?.unsubscribe()
}

/** Shape the API wants, from a browser subscription. */
export function toSubscribeBody(subscription: PushSubscription) {
	const json = subscription.toJSON()
	const p256dh = json.keys?.p256dh
	const auth = json.keys?.auth
	if (!json.endpoint || !p256dh || !auth)
		throw new Error('Browser returned an incomplete push subscription')
	return {
		endpoint: json.endpoint,
		keys: { p256dh, auth },
		user_agent: navigator.userAgent.slice(0, 512),
	}
}
