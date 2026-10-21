/* Maskin service worker — Web Push only.
 *
 * It deliberately has no fetch handler and no cache: it exists so the browser can wake it for a
 * push while the app is closed. Registered from src/lib/web-push.ts, only after the user turns on
 * browser notifications. The payload shape is WebPushPayload in apps/dev/src/services/web-push.ts.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Only same-origin paths open; anything else falls back to the app root, so a malformed or
// hostile payload can never navigate a window off-site.
function safePath(url) {
	return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/'
}

self.addEventListener('push', (event) => {
	let data = null
	try {
		data = event.data ? event.data.json() : null
	} catch {
		data = null
	}
	// Browsers require every push to show a notification, so an unreadable payload still shows one.
	const title = typeof data?.title === 'string' && data.title ? data.title : 'Maskin'
	const options = {
		body: typeof data?.body === 'string' ? data.body : 'You have a new notification',
		tag: typeof data?.tag === 'string' ? data.tag : undefined,
		silent: Boolean(data?.silent),
		requireInteraction: Boolean(data?.requireInteraction),
		icon: '/icon-192.png',
		badge: '/icon-192.png',
		data: { url: safePath(data?.url) },
	}
	event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
	event.notification.close()
	const target = new URL(safePath(event.notification.data?.url), self.location.origin)
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			for (const client of windows) {
				if (new URL(client.url).origin !== target.origin) continue
				try {
					await client.focus()
					// WindowClient.navigate is missing in some browsers; fall through to openWindow.
					if ('navigate' in client) await client.navigate(target.href)
					return
				} catch {
					break
				}
			}
			await self.clients.openWindow(target.href)
		})(),
	)
})
