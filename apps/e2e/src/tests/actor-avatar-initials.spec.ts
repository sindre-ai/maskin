import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers ActorAvatar (T1 of Per-agent avatars in Maskin):
// 2-letter initials + deterministic per-actor background color.
// Renders on every ship-gate viewport since the primitive is used
// across desktop, iPad, and mobile surfaces. T2 landed the activity
// timeline, so this spec now scopes to the comment-author slot as planned:
// the v2 composer header carries no avatar, and the only other one inside
// `main` sits in the properties drawer — which is a closed Sheet below 768,
// so scoping there would pass on iPad and fail on mobile for layout reasons
// rather than avatar ones.

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
		test(`renders initials in the comment-author avatar slot at ${viewport.label}`, async ({
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
			// The object title is a static <h1> on the v2 detail shell — wait on it
			// to know the object has loaded.
			await expect(
				page.getByRole('heading', { level: 1, name: 'Bet for actor-avatar initials' }),
			).toBeVisible({
				timeout: 20000,
			})

			// Post a comment so the timeline renders an authored row — that row's
			// ActorAvatar is the slot under test, and it exists at every viewport.
			const composer = page.getByPlaceholder(
				viewport.width < 768 ? 'Comment…' : 'Comment — / commands, @ mentions',
			)
			await composer.fill('Avatar slot check')
			await page.getByRole('button', { name: 'Send comment' }).click()
			await expect(page.getByText('Avatar slot check')).toBeVisible({ timeout: 10000 })

			// AC: initials render in the avatar slot with the account name.
			const actorName = await page.evaluate(() => {
				const raw = localStorage.getItem('maskin-actor') ?? '{}'
				const parsed = JSON.parse(raw) as { name?: string }
				return parsed.name ?? ''
			})
			const expected = initialsFor(actorName)
			// `main` excludes the sidebar workspace switcher (whose avatar also
			// carries a `title` starting with the account-derived workspace name).
			// The comment row sits in the reader column, ahead of the properties
			// drawer, so `.first()` is the comment author rather than a subscriber.
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
			).toBeVisible({
				timeout: 20000,
			})
			// The comment persists, so its avatar returns with the timeline — but
			// the timeline loads after the heading, so wait for it before reading
			// the computed colour.
			const avatarAfterReload = page.locator('main .rounded-full[title^="E2E "]').first()
			await expect(avatarAfterReload).toBeVisible({ timeout: 10000 })
			const secondColor = await avatarAfterReload.evaluate(
				(el) => getComputedStyle(el).backgroundColor,
			)

			expect(secondColor).toBe(firstColor)
		})
	}
})
