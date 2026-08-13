import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers ActorAvatar (T1 of Per-agent avatars in Maskin):
// 2-letter initials + deterministic per-actor background color.
// Renders on every ship-gate viewport since the primitive is used
// across desktop, iPad, and mobile surfaces. The object-detail shell
// (T1 of the Object detail rebuild) renders the acting actor's avatar
// in the comment-composer header; the comment-author slot returns with
// the activity timeline (T2), at which point this spec re-scopes there.

function initialsFor(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	const first = words[0] ?? ''
	const second = words[1] ?? ''
	if (first && second) return (first[0] + second[0]).toUpperCase()
	if (first.length >= 2) return first.slice(0, 2).toUpperCase()
	return (first[0] ?? '?').toUpperCase()
}

test.describe('ActorAvatar — 2-letter initials + deterministic color', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders initials in the composer-header avatar slot at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Bet for actor-avatar initials',
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(
				page.getByRole('heading', { level: 1, name: 'Bet for actor-avatar initials' }),
			).toBeVisible({ timeout: 20000 })

			// AC: initials render in the avatar slot with the account name.
			const actorName = await page.evaluate(() => {
				const raw = localStorage.getItem('maskin-actor') ?? '{}'
				const parsed = JSON.parse(raw) as { name?: string }
				return parsed.name ?? ''
			})
			const expected = initialsFor(actorName)
			// The T1 shell renders the avatar in the comment-composer header:
			// `main` excludes the sidebar workspace switcher (whose avatar also
			// carries a `title` starting with the account-derived workspace name).
			// ActorAvatar renders as a rounded-full <span> with `title={name}`;
			// scoping to `.rounded-full` picks only the palette-backed element.
			const avatar = page.locator('main .rounded-full[title^="E2E "]').first()
			await expect(avatar).toBeVisible({ timeout: 10000 })
			await expect(avatar).toHaveText(expected)

			// AC: same actor renders the same background color across page loads
			// (deterministic bucket keyed off actor id / name).
			const firstColor = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)
			// Real color must render — not the browser default 'rgba(0, 0, 0, 0)'.
			expect(firstColor).not.toBe('rgba(0, 0, 0, 0)')

			await page.reload()
			await expect(
				page.getByRole('heading', { level: 1, name: 'Bet for actor-avatar initials' }),
			).toBeVisible({ timeout: 20000 })
			const secondColor = await page
				.locator('main .rounded-full[title^="E2E "]')
				.first()
				.evaluate((el) => getComputedStyle(el).backgroundColor)

			expect(secondColor).toBe(firstColor)
		})
	}
})
