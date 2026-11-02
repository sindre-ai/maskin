import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

const SHORT = 'Fix login'
const MEDIUM = 'Audit open bet PRs for work merged into a bet branch and never reported'
const DASHED = 'David Harboe — Norlix (CTO & Co-founder)'
const LONG =
	'Audit every open bet pull request for work that was merged into a bet branch and never reported back to the bet, then close the ones that are done'

const CHIPS = [
	{ key: 'short', title: SHORT, shown: SHORT },
	{ key: 'medium', title: MEDIUM, shown: MEDIUM },
	{ key: 'dashed', title: DASHED, shown: 'David Harboe' },
	{ key: 'long', title: LONG, shown: null },
] as const

type Account = { workspaceId: string; api: TestAPI }

async function openChatWithChips(account: Account, page: Page) {
	const ws = account.workspaceId
	const agent = await account.api.createAgentActor(`Chip QA Agent ${Date.now()}`)
	await account.api.addWorkspaceMember(ws, agent.id)
	const conversation = await account.api.createConversation(ws, {
		title: 'E2E chip plate',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	const poster = new TestAPI(agent.api_key)
	for (const chip of CHIPS) {
		const task = await account.api.createObject(ws, {
			type: 'task',
			title: chip.title,
			status: 'todo',
			driver: agent.id,
		})
		await poster.postConversationMessage(conversation.id, ws, {
			content: `Please look at [${chip.title}](/${ws}/objects/${task.id}), then carry on with the rest of this sentence before Friday.`,
		})
	}
	await page.goto(`/${ws}/chats/${conversation.id}`)
	const thread = page.getByTestId('thread-messages')
	const chips = Object.fromEntries(
		CHIPS.map((chip) => [
			chip.key,
			thread.getByRole('link', {
				name: new RegExp(`^Task, To do: ${escapeRegExp(chip.title.slice(0, 20))}`),
			}),
		]),
	) as Record<(typeof CHIPS)[number]['key'], Locator>
	for (const locator of Object.values(chips)) await expect(locator).toBeVisible({ timeout: 10_000 })
	return chips
}

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** What the chip, the comma after it and the sentence around it measure in the page. */
function measure(link: Locator) {
	return link.evaluate((el) => {
		const paragraph = el.closest('p') as HTMLElement
		const style = getComputedStyle(el)
		const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight)
		const pieces = Array.from(el.getClientRects())
		const last = pieces[pieces.length - 1]
		const next = el.parentElement?.nextSibling ?? null
		let comma: { top: number; left: number } | null = null
		if (next?.nodeType === Node.TEXT_NODE && (next.textContent ?? '').startsWith(',')) {
			const range = document.createRange()
			range.setStart(next, 0)
			range.setEnd(next, 1)
			const rect = range.getBoundingClientRect()
			comma = { top: rect.top, left: rect.left }
		}
		const dots = Array.from(el.querySelectorAll<HTMLElement>('span.rounded-full'))
		const statusDot = dots[dots.length - 1]
		const dotStyle = statusDot ? getComputedStyle(statusDot) : null
		return {
			label: el.querySelector(':scope > span')?.textContent ?? '',
			fontSize: style.fontSize,
			paragraphFontSize: getComputedStyle(paragraph).fontSize,
			fontWeight: style.fontWeight,
			background: style.backgroundColor,
			decoration: style.getPropertyValue('box-decoration-break'),
			borderWidth: style.borderTopWidth,
			lineHeight,
			paragraphHeight: paragraph.getBoundingClientRect().height,
			pieces: pieces.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })),
			last: last
				? { top: last.top, bottom: last.bottom, left: last.left, right: last.right }
				: null,
			comma,
			dotCount: dots.length,
			dotColor: dotStyle?.color ?? null,
			dotBackground: dotStyle?.backgroundColor ?? null,
			dotWidth: statusDot ? statusDot.getBoundingClientRect().width : 0,
			dotHidden: statusDot?.getAttribute('aria-hidden') ?? null,
		}
	})
}

async function setScheme(page: Page, scheme: 'light' | 'dark') {
	await page.evaluate(
		(dark) => document.documentElement.classList.toggle('dark', dark),
		scheme === 'dark',
	)
}

test.describe('Chat — a chip is a plate of text that wraps with the sentence', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape, VIEWPORTS.desktop]) {
		test(`short, medium, dashed and long chips at ${vp.width}px, light and dark`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const chips = await openChatWithChips(account, page)

			for (const scheme of ['light', 'dark'] as const) {
				await setScheme(page, scheme)
				for (const spec of CHIPS) {
					const m = await measure(chips[spec.key])

					// The size and line height of the sentence: the plate adds no height to a line.
					expect(m.fontSize).toBe(m.paragraphFontSize)
					expect(m.fontWeight).toBe('500')
					expect(m.borderWidth).toBe('0px')
					for (const piece of m.pieces) {
						expect(piece.bottom - piece.top).toBeLessThanOrEqual(m.lineHeight + 0.5)
					}
					const lines = m.paragraphHeight / m.lineHeight
					expect(Math.abs(lines - Math.round(lines))).toBeLessThan(0.05)

					// A tinted plate that is redrawn on every line piece.
					expect(m.background).not.toBe('rgba(0, 0, 0, 0)')
					expect(m.decoration).toBe('clone')

					// The comma stays on the chip's last line, right after it.
					expect(m.comma).not.toBeNull()
					expect(Math.abs((m.comma?.top ?? 0) - (m.last?.top ?? 0))).toBeLessThan(m.lineHeight / 2)
					expect(m.comma?.left ?? 0).toBeGreaterThanOrEqual((m.last?.right ?? 0) - 1)

					// No line piece is a dot on its own: each carries words as well.
					for (const piece of m.pieces) {
						expect(piece.right - piece.left).toBeGreaterThan(Number.parseFloat(m.fontSize) * 2)
					}

					// The status dot: 0.4em wide, in the status colour, hidden from assistive tech.
					expect(m.dotCount).toBe(1)
					expect(m.dotHidden).toBe('true')
					expect(m.dotBackground).toBe(m.dotColor)
					expect(m.dotBackground).not.toBe('rgba(0, 0, 0, 0)')
					expect(Math.abs(m.dotWidth - Number.parseFloat(m.fontSize) * 0.4)).toBeLessThan(0.6)

					// The name: whole, except a long dash (short name) and the cut at 90.
					if (spec.shown) expect(m.label).toBe(spec.shown)
					else {
						expect(m.label.endsWith('…')).toBe(true)
						expect(m.label.length).toBeLessThanOrEqual(91)
						expect(LONG.startsWith(m.label.slice(0, -1))).toBe(true)
					}
				}

				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				)
				expect(overflow).toBeLessThanOrEqual(0)
				await page.screenshot({ path: `test-results/chip-plate-${vp.width}-${scheme}.png` })
			}

			// At 375 the long chip runs over several lines and still never leaves its sentence.
			if (vp.width === VIEWPORTS.mobile.width) {
				const long = await measure(chips.long)
				expect(long.pieces.length).toBeGreaterThanOrEqual(2)
				expect(long.pieces.length).toBeLessThanOrEqual(4)
			}
		})
	}

	test('a long dash title is shortened on the chip and whole in its name and preview', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })
		const chips = await openChatWithChips(account, page)
		await expect(chips.dashed).toHaveAttribute('aria-label', /Norlix \(CTO/)
		await expect(chips.dashed).not.toContainText('Norlix')
		const piece = await chips.dashed.evaluate((el) => {
			const r = el.getClientRects()[0]
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
		})
		await page.mouse.move(piece.x, piece.y)
		const preview = page.locator('[data-linked-preview]')
		await expect(preview).toBeVisible()
		await expect(preview).toContainText('David Harboe — Norlix (CTO & Co-founder)')
	})

	for (const width of [640, VIEWPORTS.tabletLandscape.width, VIEWPORTS.desktop.width]) {
		test(`the preview opens under the last line of a wrapped chip at ${width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width, height: 900 })
			const chips = await openChatWithChips(account, page)
			const preview = page.locator('[data-linked-preview]')

			// Hover each line piece in turn: the card opens from any of them.
			const pieces = (await measure(chips.long)).pieces
			expect(pieces.length).toBeGreaterThanOrEqual(1)
			for (const [index, piece] of pieces.entries()) {
				await page.mouse.move(5, 5)
				await expect(preview).toHaveCount(0)
				await page.mouse.move((piece.left + piece.right) / 2, (piece.top + piece.bottom) / 2)
				await expect(preview, `line piece ${index}`).toBeVisible()
			}

			// Under the last line, never over the chip's text, at the box's left edge (or its right
			// edge when that would run off the screen), and the pointer can travel to the card.
			const m = await measure(chips.long)
			const box = await preview.boundingBox()
			const left = Math.min(...m.pieces.map((p) => p.left))
			const right = Math.max(...m.pieces.map((p) => p.right))
			expect(box?.y ?? 0).toBeGreaterThanOrEqual(Math.max(...m.pieces.map((p) => p.bottom)) - 1)
			const flipped = left + 380 > width - 8
			if (flipped)
				expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) - right)).toBeLessThanOrEqual(1)
			else expect(Math.abs((box?.x ?? 0) - left)).toBeLessThanOrEqual(1)
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width)

			const last = m.pieces[m.pieces.length - 1]
			await page.mouse.move((last.left + last.right) / 2, last.bottom + 1)
			await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40, { steps: 6 })
			await expect(preview).toBeVisible()
			await page.screenshot({ path: `test-results/chip-plate-preview-${width}.png` })
		})
	}

	test('hovering the chip tints the plate and a tap on a phone opens the sheet, not the object', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.mobile.width, height: VIEWPORTS.mobile.height })
		const chips = await openChatWithChips(account, page)
		const chatUrl = page.url()
		const before = (await measure(chips.short)).background
		await chips.short.hover()
		await expect.poll(async () => (await measure(chips.short)).background).not.toBe(before)
		await chips.short.click()
		await expect(page.getByRole('dialog', { name: 'Object preview' })).toBeVisible()
		await expect(page).toHaveURL(chatUrl)
	})
})
