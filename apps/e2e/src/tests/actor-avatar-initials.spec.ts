import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers ActorAvatar (T1 of Per-agent avatars in Maskin):
// 2-letter initials + deterministic per-actor background color on
// the comment-author slot. Renders on every ship-gate viewport since
// the primitive is used across desktop, iPad, and mobile surfaces.

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
		test(`renders initials in the comment-author slot at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Bet for actor-avatar initials',
				status: 'signal',
			})

			// Post a comment as the account so its actor appears in the author slot.
			await account.api.createComment(account.workspaceId, {
				entity_id: bet.id,
				content: 'Testing 2-letter initials on the avatar.',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByText('Bet for actor-avatar initials')).toBeVisible({
				timeout: 20000,
			})

			// AC: initials render in the comment-author avatar slot with the account name.
			const actorName = await page.evaluate(() => {
				const raw = localStorage.getItem('maskin-actor') ?? '{}'
				const parsed = JSON.parse(raw) as { name?: string }
				return parsed.name ?? ''
			})
			const expected = initialsFor(actorName)
			// ActorAvatar renders as a rounded-full <span> or <button> with `title={name}`.
			// Ancestor wrappers (e.g. SubscribeToggle's list-title <div>) also carry a
			// title starting with the actor name but are NOT the palette-backed element,
			// so scoping to `.rounded-full` picks only the avatar itself.
			const avatarSelector = '.rounded-full[title^="E2E "]'
			const avatar = page.locator(avatarSelector).first()
			await expect(avatar).toBeVisible({ timeout: 10000 })
			await expect(avatar).toHaveText(expected)

			// AC: same actor renders the same background color across page loads
			// (deterministic bucket keyed off actor id / name).
			const firstColor = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)
			// Real color must render — not the browser default 'rgba(0, 0, 0, 0)'.
			expect(firstColor).not.toBe('rgba(0, 0, 0, 0)')

			await page.reload()
			await expect(page.getByText('Bet for actor-avatar initials')).toBeVisible({
				timeout: 20000,
			})
			const secondColor = await page
				.locator(avatarSelector)
				.first()
				.evaluate((el) => getComputedStyle(el).backgroundColor)

			expect(secondColor).toBe(firstColor)
		})
	}
})
