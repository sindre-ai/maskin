# Web Push — live verification runbook

Mocks cannot prove what Chrome, Edge, Firefox or Safari do with a push, so every
environment gets a real one (see `.claude/rules/live-verification.md`). Run this
per browser, in **staging first, then production**. About 10 minutes each.

Do not change the implementation while verifying. A defect is reported against
the existing PR; see the bet "Browser push notifications (Web Push)".

## 0. One-time server setup (per environment)

1. Generate a key pair **once** and keep it: `npx web-push generate-vapid-keys`.
   Never rotate it later; rotation invalidates every browser subscription.
2. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` or
   `https://` contact) on the `apps/dev` service and restart it.
3. Confirm: `GET /api/web-push/config` (authenticated) returns
   `{ "enabled": true, "public_key": "<the public key>" }`.
   `enabled: false` means a variable is missing or the subject is not `mailto:`/`https://`.

## 1. Per browser

Use a real browser profile on a real machine. Chrome, Edge and Firefox work in a tab.
**Safari on iOS only receives Web Push once the site is added to the Home Screen**
(Share > Add to Home Screen), and Safari on macOS needs 16+.

| # | Do | Expect |
|---|---|---|
| 1 | Open Profile > Notifications | "Browser notifications" switch is visible and off |
| 2 | Turn it on, click **Allow** | Switch turns on; toast "Browser notifications are on" |
| 3 | Query: `select id, actor_id, split_part(endpoint,'/',3) host, length(p256dh), length(auth) from web_push_subscriptions where actor_id = '<you>'` | One row. Host is the browser's push service (Chrome/Edge `fcm.googleapis.com`, Firefox `updates.push.services.mozilla.com`, Safari `web.push.apple.com`). Key lengths 87 and 22 |
| 4 | Close the tab (or minimise the browser). Make something notify you, e.g. an agent `@mentions` you | An OS notification appears with the right title and body |
| 5 | Click it | The browser focuses and opens the right object, chat or notifications page |
| 6 | Turn the switch off | Row is gone from `web_push_subscriptions` |
| 7 | Block notifications for the site in the browser's site settings, reload Profile | Switch is disabled and says "Blocked in site settings" |

## 2. Pruning (410)

1. With the switch on, unsubscribe **in the browser only** (DevTools > Application >
   Service Workers > Push, or `(await (await navigator.serviceWorker.getRegistration('/sw.js')).pushManager.getSubscription()).unsubscribe()`).
   The server row is now stale.
2. Trigger another notification for yourself.
3. Expect a log line `Web Push subscription gone, removed` with status 404 or 410, and the
   row deleted.

## 3. Layout

Walk the Profile > Notifications row at 375px and 1024px, in light and dark mode,
including the blocked state.

## Record

Paste per browser and environment: the row query output (step 3), the log line
(section 2), and a screenshot of the notification. Update the PR's live-verification
matrix and the bet's checklist.
