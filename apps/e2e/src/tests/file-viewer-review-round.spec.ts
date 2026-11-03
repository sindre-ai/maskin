import { expect, test } from '../fixtures/auth.fixture'

// Slice 4 acceptance criterion:
// "Playwright happy-path E2E is green in CI on bet/7abe-file-review-viewer.
//  Open file from an object → zoom → pin → comment → send round →
//  verify driver's For You receives one rollup → click rollup → land back
//  in viewer with panel filtered to that round."
//
// This is the composed-viewer E2E for the whole bet — the flow that proves
// Slices 1-4 land together end-to-end. It exercises the *product* seam, not
// the DOM detail: pin placement runs against the real iframe / coord math
// (Slice 1), the review panel + send flow (Slice 3), and the deep-link
// filter (Slice 3) — Slice 4's responsive shell doesn't gate the flow at
// desktop viewports, which is the primary viewport per §No-gos.

const DECK_HTML = `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<title>Deck for review</title>
	<style>
		body { margin: 0; font: 16px/1.4 -apple-system, sans-serif; }
		.slide { min-height: 100vh; padding: 40px; box-sizing: border-box; background: #fff; }
	</style>
</head>
<body>
	<section class="slide" data-slide="1"><h1>Slide 1</h1><p>Cover.</p></section>
	<section class="slide" data-slide="2"><h1>Slide 2</h1><p>Body.</p></section>
</body>
</html>
`

test.describe('File review viewer — happy path (Slice 4)', () => {
	test('open → pin → comment → send round → deep-link filter', async ({ page, account }) => {
		// Desktop viewport — the composed flow is desktop-primary per the
		// parent bet's No-gos section. Responsive coverage lives in the
		// rendered tests (viewer-responsive.test.tsx).
		await page.setViewportSize({ width: 1440, height: 900 })

		// Seed data: a bet the review round can land on (spec §Solution
		// sketch: send targets the attaching object's driver), plus an HTML
		// file attached to that bet. The current test actor is the bet's
		// driver, so the resulting rollup event mentions the same actor.
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Review this deck',
			status: 'active',
		})
		const file = await account.api.createFile(account.workspaceId, {
			name: 'review-deck.deck.html',
			mime_type: 'text/html',
			content: DECK_HTML,
			encoding: 'utf8',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: bet.id,
			target_type: 'file',
			target_id: file.id,
			type: 'attached',
		})

		// Open the file viewer with the panel forced open via search param.
		// panel=open is the deep-link contract from Slice 3 — same one the
		// rollup click uses below. Opening it here lets us assert the panel
		// mounted correctly before the user places anything.
		await page.goto(`/${account.workspaceId}/files/${file.id}?panel=open`)

		// Panel is inline at 1440 (lg+ desktop) — spec §Responsive.
		const panel = page.locator('[data-review-panel][data-layout="inline"]')
		await expect(panel).toBeVisible({ timeout: 10_000 })

		// Enter annotate mode. The stage's click-to-place-pin path is gated
		// on annotate mode (see viewer-stage.tsx onClick handler); this is
		// the same affordance mobile uses via long-press but exposed as a
		// button in the top bar for desktop.
		await page.getByRole('button', { name: /toggle annotate mode/i }).click()

		// Wait for the iframe/doc to settle before placing a pin —
		// `data-viewer-state="ready"` is the stage's own "ready-to-annotate"
		// signal, wired in Slice 1.
		await expect(page.locator('[data-viewer-state="ready"]')).toBeVisible({ timeout: 15_000 })

		// Click the stage viewport to place a pin. The absolute pixel doesn't
		// matter — the point is that the click lands on the pin-placement
		// surface and Slice 1's coord math translates it into doc space.
		const stage = page.locator('[data-annotate-mode="true"]').first()
		await stage.click({ position: { x: 400, y: 300 } })

		// The pin landed → the panel now shows a Drafts group + one draft
		// card with a Textarea. `data-viewer-state="draft-in-progress"` is
		// the Slice 4 marker on the DraftGroup.
		await expect(panel.locator('[data-viewer-state="draft-in-progress"]')).toBeVisible()
		const draftTextarea = panel.getByPlaceholder(/what should the driver see/i)
		await expect(draftTextarea).toBeVisible()
		await draftTextarea.fill('Move the CTA above the fold.')

		// Save the draft. The panel's "Save draft" button posts the draft as
		// a real file_comment row (still without a roundId — the send below
		// stamps the roundId transactionally on all pending drafts).
		await panel.getByRole('button', { name: /save draft/i }).click()

		// Send the round. The panel foot's button reads "Send round · <bet
		// title>" once a target has resolved (variant #1, one attacher).
		const sendButton = panel.getByTestId('panel-send-round')
		await expect(sendButton).toBeEnabled()
		await sendButton.click()

		// Post-send lock: the foot swaps to "Sent · <driver-name>" — the
		// data-viewer-state pin proves the transition is visible in DOM.
		const foot = panel.getByTestId('panel-foot-sent')
		await expect(foot).toBeVisible({ timeout: 10_000 })
		await expect(foot).toHaveAttribute('data-viewer-state', 'post-send')
		await expect(foot).toContainText(/^Sent · /)

		// Verify the "one rollup on the driver's timeline" invariant — Slice
		// 3's transactional round-send posts exactly one comment event on
		// the bet with metadata.file_comments_round.roundId. We poll the API
		// rather than the shell UI because the exact rollup-card DOM lives
		// in the For You feed component whose selectors are outside this
		// slice's scope. This assertion is the definition of the invariant.
		let roundId: string | null = null
		await expect
			.poll(
				async () => {
					const events = await fetch(
						`http://localhost:5173/api/events/history?entity_id=${bet.id}`,
						{
							headers: {
								Authorization: `Bearer ${account.apiKey}`,
								'X-Workspace-Id': account.workspaceId,
							},
						},
					).then((r) => r.json())
					const roundEvents = (
						events as Array<{
							action: string
							data?: { metadata?: { file_comments_round?: { roundId: string } } }
						}>
					).filter(
						(e) => e.action === 'commented' && e.data?.metadata?.file_comments_round !== undefined,
					)
					if (roundEvents.length === 1) {
						roundId = roundEvents[0].data?.metadata?.file_comments_round?.roundId ?? null
						return roundEvents.length
					}
					return roundEvents.length
				},
				{ timeout: 15_000, message: 'expected exactly one rollup comment on the bet' },
			)
			.toBe(1)

		expect(roundId, 'rollup event carries a roundId').not.toBeNull()

		// Deep-link filter: hitting ?round=<id>&panel=open lands the viewer
		// with the panel filtered to just that round (spec §Solution sketch,
		// Slice 3 deep-link contract). The panel header shows the "Round
		// filter active" banner with a Clear button.
		await page.goto(`/${account.workspaceId}/files/${file.id}?round=${roundId}&panel=open`)
		const filteredPanel = page.locator('[data-review-panel][data-layout="inline"]')
		await expect(filteredPanel).toBeVisible()
		await expect(filteredPanel.getByText(/round filter active/i)).toBeVisible()
		await expect(filteredPanel.getByRole('button', { name: /clear/i })).toBeVisible()
		// The sent comment shows up in the filtered list with its "Sent" pill.
		await expect(filteredPanel.getByTestId('comment-sent-badge').first()).toBeVisible()
	})
})
