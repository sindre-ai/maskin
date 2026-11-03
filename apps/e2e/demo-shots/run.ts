// Takes the named product screenshots of the Maskin Demo workspace.
//
//   pnpm --filter @maskin/e2e demo:shots                  all shots
//   pnpm --filter @maskin/e2e demo:shots approval-card    one shot by name
//   pnpm --filter @maskin/e2e demo:shots --no-upload      keep the PNGs local only
//
// Needs the Maskin Demo login (the Keychain secrets "Maskin Demo email" and "Maskin Demo
// password"; DEMO_EMAIL and DEMO_PASSWORD override them), and MASKIN_API_KEY unless
// --no-upload is given. PNGs land in demo-shots/out/ and are uploaded to the main workspace.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { DemoApi, login } from './api'
import { APP_URL, DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME } from './config'
import { AGENT_NAME, CHAT_TITLE, KEYS } from './seed'
import { SHOTS, type ShotContext, findShot } from './shots'
import { uploadShot } from './upload'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out')
// Fixed so shots look the same every week.
const VIEWPORT = { width: 1440, height: 900 }
const DEVICE_SCALE_FACTOR = 2
const HOURS_AFTER_SEEDING = 3

async function main() {
	const args = process.argv.slice(2)
	const upload = !args.includes('--no-upload')
	const names = args.filter((a) => !a.startsWith('--'))
	const shots = names.length ? names.map(findShot) : SHOTS

	const actor = await login()
	const api = new DemoApi(actor.api_key)
	await api.assertMember(DEMO_WORKSPACE_NAME)

	const bets = await api.listObjects('bet')
	const tasks = await api.listObjects('task')
	const bet = bets.find((b) => b.metadata?.demo_key === KEYS.bet)
	const approval = tasks.find((t) => t.metadata?.demo_key === KEYS.approvalTask)
	const chats = await api.request<{ conversations: { id: string; title: string }[] }>(
		'GET',
		'/conversations?limit=100',
	)
	const chat = chats.conversations.find((c) => c.title === CHAT_TITLE)
	if (!bet || !approval || !chat) {
		throw new Error(
			`The demo workspace is not seeded (${AGENT_NAME} data missing). Run demo:seed first.`,
		)
	}
	const ctx: ShotContext = { betId: bet.id, conversationId: chat.id }

	// Relative times ("2 hours ago") are worked out in the browser, so the clock is pinned a
	// few hours after the data was seeded. Shots then read the same however old the data is.
	const seededAt = Date.parse(String(approval.metadata?.seeded_at ?? approval.createdAt))
	const pinnedNow = new Date(seededAt + HOURS_AFTER_SEEDING * 3_600_000)

	await mkdir(OUT_DIR, { recursive: true })
	const date = new Date().toISOString().slice(0, 10)
	const browser = await chromium.launch()
	try {
		for (const shot of shots) {
			// A fresh context per shot: nothing carries over between screens.
			const context = await browser.newContext({
				viewport: VIEWPORT,
				deviceScaleFactor: DEVICE_SCALE_FACTOR,
				reducedMotion: 'reduce',
				locale: 'en-GB',
				timezoneId: 'Europe/Copenhagen',
			})
			await context.clock.setFixedTime(pinnedNow)
			await context.addInitScript(
				(data) => {
					localStorage.setItem('maskin-api-key', data.apiKey)
					localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
					localStorage.setItem(`north_star_answered_${data.workspaceId}`, '1')
				},
				{
					apiKey: actor.api_key,
					actor: { id: actor.id, name: actor.name, type: actor.type, email: actor.email },
					workspaceId: DEMO_WORKSPACE_ID,
				},
			)
			const page = await context.newPage()
			const url = `${APP_URL}${shot.path(ctx)}`
			// The workspace is part of every path; stop here if that ever stops being true.
			if (!url.startsWith(`${APP_URL}/${DEMO_WORKSPACE_ID}`)) {
				throw new Error(`Shot ${shot.name} points outside the demo workspace`)
			}
			await page.goto(url)
			await shot.ready(page)
			await page.evaluate(() => document.fonts.ready)
			await page.waitForTimeout(500)

			const file = join(OUT_DIR, `demo-shot-${shot.name}-${date}.png`)
			const options = { path: file, animations: 'disabled', caret: 'hide' } as const
			if (shot.target) await shot.target(page).screenshot(options)
			else await page.screenshot(options)
			await context.close()

			console.log(`${shot.name}: saved ${file}`)
			if (upload) console.log(`${shot.name}: uploaded as file ${await uploadShot(file)}`)
		}
	} finally {
		await browser.close()
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
