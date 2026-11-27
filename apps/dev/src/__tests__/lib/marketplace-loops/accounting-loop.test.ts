import { ACCOUNTING_LOOP_ACTOR_BOOKKEEPER } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	ACCOUNTING_LOOP,
	ACCOUNTING_LOOP_ACTOR_IDS,
	ACCOUNTING_LOOP_SKILL_IDS,
	ACCOUNTING_LOOP_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/accounting-loop'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import { loopSettingsSchema } from '../../../lib/marketplace-loops/loop-settings'

const actorTexts = () =>
	ACCOUNTING_LOOP_ACTOR_IDS.map((id) => {
		const a = getActorData(id)
		return `${a.name} ${a.description} ${a.systemPrompt}`
	})
const triggerTexts = () =>
	ACCOUNTING_LOOP_TRIGGER_IDS.map((id) => getTriggerData(id).actionPrompt ?? '')
const checklistTexts = () => {
	const checklist = ACCOUNTING_LOOP.settings.checklist
	return [
		checklist?.title,
		checklist?.body,
		...(checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
	]
}
const skillTexts = () => ACCOUNTING_LOOP_SKILL_IDS.map((id) => getSkillData(id).content ?? '')

describe('Accounting loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(ACCOUNTING_LOOP.slug).toBe('accounting-loop')
		expect(ACCOUNTING_LOOP.name).toBe('Accounting')
		expect(ACCOUNTING_LOOP.useCase).toBe('Finance')
		expect(ACCOUNTING_LOOP.version).toBe('1.6.0')
		expect(ACCOUNTING_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships entry condition, close condition and tags, with no targets', () => {
		const settings = loopSettingsSchema.parse(ACCOUNTING_LOOP.settings)
		expect(settings.entryCondition).toMatch(/uploads a receipt/)
		expect(settings.closeCondition).toMatch(/draft voucher/)
		expect(settings.tags).toEqual(['Finance'])
		expect(settings.targets).toBeUndefined()
	})

	it('names no adviser or accountant gate anywhere in the shipped text', () => {
		const settings = loopSettingsSchema.parse(ACCOUNTING_LOOP.settings)
		const all = [
			ACCOUNTING_LOOP.description,
			settings.entryCondition,
			settings.closeCondition,
			...checklistTexts(),
			...actorTexts(),
			...triggerTexts(),
			...skillTexts(),
		].join('\n')
		expect(all).not.toMatch(/advis[eo]r|accountant/i)
	})

	it('ships a setup checklist of six children, driven by the Bookkeeper', () => {
		const settings = loopSettingsSchema.parse(ACCOUNTING_LOOP.settings)
		expect(settings.checklist?.title).toBe('Accounting setup checklist')
		expect(settings.checklist?.driverSourceItemId).toBe(ACCOUNTING_LOOP_ACTOR_BOOKKEEPER)
		const items = settings.checklist?.items ?? []
		expect(items.map((i) => i.title)).toEqual([
			'Connect Dinero',
			'Run the first connection check',
			'Say which Dinero plan you have',
			'Upload one test receipt',
			'Confirm the financial year end',
			'Confirm the VAT period',
		])
		for (const item of [{ title: settings.checklist?.title ?? '' }, ...items]) {
			expect(item.title.split(' ').length).toBeLessThanOrEqual(8)
		}
		expect(settings.checklist?.body).toContain('at most 3 questions at a time')
	})

	it('points the connect step at the Dinero sign-in, not a custom tool and token', () => {
		const settings = loopSettingsSchema.parse(ACCOUNTING_LOOP.settings)
		const connect = settings.checklist?.items[0]
		expect(connect?.body).toMatch(/Dinero connected under Settings, Integrations/)
		expect(connect?.body).toMatch(/sign in once with their own Dinero user/)
		expect(connect?.body).not.toMatch(/custom tool/)
	})

	it('ships one actor, five triggers and five skills, no duplicates', () => {
		expect(ACCOUNTING_LOOP_ACTOR_IDS).toEqual([ACCOUNTING_LOOP_ACTOR_BOOKKEEPER])
		expect(ACCOUNTING_LOOP_TRIGGER_IDS.length).toBe(5)
		expect(ACCOUNTING_LOOP_SKILL_IDS.length).toBe(5)
		expect(new Set(ACCOUNTING_LOOP_SKILL_IDS).size).toBe(ACCOUNTING_LOOP_SKILL_IDS.length)
		expect(ACCOUNTING_LOOP_SKILL_IDS.map((id) => getSkillData(id).name).sort()).toEqual([
			'accounting-connection-check',
			'accounting-rule-check',
			'accounting-year-end-pack',
			'bookkeeping-draft-method',
			'vat-return-check',
		])
	})

	it('wires the trigger and every skill to the bundled Bookkeeper only', () => {
		const actorIds = new Set<string>(ACCOUNTING_LOOP_ACTOR_IDS)
		for (const id of ACCOUNTING_LOOP_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of ACCOUNTING_LOOP_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	const triggerByName = (name: string) => {
		const found = ACCOUNTING_LOOP_TRIGGER_IDS.map((id) => getTriggerData(id)).find(
			(t) => t.name === name,
		)
		if (!found) throw new Error(`trigger ${name} not found in the accounting bundle`)
		return found
	}

	// The daily check reads the checklist every day and keeps the connection check to Mondays, so
	// the checklist never waits more than a day.
	it('runs the daily check, reading the checklist first and the connection check on Mondays', () => {
		const trigger = triggerByName('Daily check (06:00 UTC)')
		expect(trigger.name).toBe('Daily check (06:00 UTC)')
		expect(trigger.config).toMatchObject({ expression: '0 6 * * *' })
		const prompt = trigger.actionPrompt ?? ''
		expect(prompt).toMatch(/^First read the flow's setup checklist/)
		expect(prompt).toContain('Accounting setup checklist')
		expect(prompt).toContain('at most 3 questions at a time')
		expect(prompt).toContain('only when every child task is done or discarded')
		expect(prompt).toContain('report it once')
		expect(prompt).toContain('only if today is Monday (UTC)')
		expect(prompt).toContain('On any other day you are done: stay silent.')
		expect(prompt.indexOf('Accounting setup checklist')).toBeLessThan(
			prompt.indexOf('only if today is Monday (UTC)'),
		)
		expect(prompt.indexOf('only if today is Monday (UTC)')).toBeLessThan(
			prompt.indexOf('weekly connection check'),
		)
	})

	// The briefing runs an hour after the daily check, so a lapsed sign-in is found first. It reads
	// the Dinero reports and posted entries first, falls back to bank lines and vouchers only when
	// a report cannot be read, and never estimates.
	it('posts a weekly money briefing on Mondays, flagging missing data and never estimating', () => {
		const trigger = triggerByName('Weekly money briefing (Mon 07:00 UTC)')
		expect(trigger.config).toMatchObject({ expression: '0 7 * * 1' })
		expect(trigger.targetActorId).toBe(ACCOUNTING_LOOP_ACTOR_BOOKKEEPER)
		expect(trigger.enabled).toBe(true)
		const prompt = trigger.actionPrompt ?? ''
		expect(prompt).toContain('flow named Accounting')
		expect(prompt).toContain('more than 1 hour after its scheduled time')
		expect(prompt).toContain('Line one of the page is the data line')
		expect(prompt).toContain('Never estimate')
		expect(prompt).toContain('Read the reports first')
		expect(prompt).toContain('get_report')
		expect(prompt).toContain('list_posted_entries')
		expect(prompt).toContain('Only when a report cannot be read')
		expect(prompt).toContain('rebuild every figure from the bank lines and vouchers')
		expect(prompt).toContain('say so on the data line')
		expect(prompt).toContain('Never book, post, file, pay, send or change anything')
		expect(prompt).toContain('in_loop')
		for (const part of [
			'Runway in months',
			'Customers by profit',
			'three biggest money moves',
			'Books status',
			'Deadlines in the next 30 days',
			'at most 3',
		]) {
			expect(prompt).toContain(part)
		}
		expect(ACCOUNTING_LOOP.description).toMatch(/Every Monday it also posts a short money briefing/)
	})

	it('tells the Bookkeeper about its checklist and the three-question limit', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toContain('# Setup checklist')
		expect(prompt).toContain('Accounting setup checklist')
		expect(prompt).toMatch(/at most 3 questions at a time/)
	})

	it('names the flow Accounting in the trigger prompt', () => {
		for (const prompt of triggerTexts()) expect(prompt).toContain('flow named Accounting')
	})

	it('keeps tool access free of connected servers', () => {
		for (const id of ACCOUNTING_LOOP_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})

	// Install step for Dinero: connect it under Settings, Integrations and sign in once with the
	// owner's own Dinero user. The custom tool route stays as a fallback. A check on every first run.
	it('tells the owner how to connect Dinero and what the first run checks', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).toMatch(/under Integrations, connect Dinero/)
		expect(check).toMatch(/Sign in once with your own Dinero user/)
		expect(check).toMatch(/Pro or Total/)
		expect(check).toMatch(/no token to find or paste/)
		expect(check).toMatch(/only the one company/)
		expect(check).toMatch(/Only if Dinero cannot be connected under Integrations/)
		expect(check).toMatch(/add Dinero's own server as a custom tool/)
		expect(check).toMatch(/needs someone technical/)
		expect(check).toMatch(/Limit the tool to reading and saving drafts/)
		expect(check).toMatch(/read and write access/)
		expect(check).toMatch(/at the start of every job/i)
		expect(check).toMatch(/no tool that books, posts, changes, deletes, pays or sends/)
		expect(actorTexts().join('\n')).toMatch(/connection check first/)
	})

	it('says a sign-in error means signing in to Dinero again', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).not.toMatch(/early version/)
		expect(check).toMatch(/sign in to Dinero again with your own Dinero user/)
		expect(check).toMatch(/older custom tool route, the token has run out/)
		expect(check).toMatch(/On the older route the sign-in token runs out after about an hour/)
		expect(ACCOUNTING_LOOP.description).toMatch(/runs out after about an hour/)
		expect(actorTexts().join('\n')).toMatch(/do not try to sign in yourself/i)
	})

	// A connected install gets more than the 18 names from Maskin's own limit (36 tools on 25 Nov
	// 2026), so the first run must not stop on them. The custom tool route keeps the strict check.
	it('accepts the tool set a signed-in connection offers and keeps the booking rule', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).toMatch(
			/the connection itself limits the Dinero tools to reading and saving drafts/,
		)
		expect(check).toMatch(/Accept that set: do not stop because a tool is not on the 18-name list/)
		// A tool that books, pays or sends still stops the check, and is never called, except the
		// booking tools that appear only after a person has switched booking on.
		expect(check).toMatch(
			/offers any other tool that books or finalises a voucher, registers a payment or sends anything to a customer/,
		)
		expect(check).toMatch(/say so and stop\. Never call such a tool/)
		expect(check).not.toMatch(/steps 1 to 4/)
		expect(check).toMatch(/finished the install steps \(1 and 2, or 3 on the older route\)/)
		expect(ACCOUNTING_LOOP.description).not.toMatch(/early version/)
	})

	it('keeps the token rule and the allowed-list stop for the custom tool route only', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toMatch(
			/When Dinero is connected under Integrations, the connection limits the tools/,
		)
		expect(prompt).toMatch(
			/On the older custom tool route, if the connection check shows a Dinero tool/,
		)
		expect(prompt).toMatch(
			/Only if Dinero was added by the older custom tool route, the token runs out/,
		)
		expect(prompt).not.toMatch(/- Dinero's sign-in token runs out after about an hour/)
	})

	// The allowed list has no field in the Custom tools form, so the text is the only way an owner
	// learns the call and the names. Names are Dinero's own, read from its live tool list.
	it('names the call and the allowed Dinero tools in the install text', () => {
		const allowed = [
			'CreatePurchaseVoucher',
			'upload_file',
			'list_organizations',
			'list_accounting_years',
			'get_chart_of_accounts',
			'list_purchase_accounts',
			'list_vat_types',
			'list_contacts',
			'get_contact',
			'GetContactByName',
			'list_vouchers',
			'get_purchase_voucher',
			'list_files',
			'list_voucher_file_cards',
			'get_purchase_drafts_for_file',
			'SearchBankTransactions',
			'get_report',
			'list_posted_entries',
		]
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		const prompt = actorTexts().join('\n')
		expect(check).toMatch(/PUT \/api\/custom-mcp-servers\/\{id\}/)
		expect(check).toMatch(/add allowed_tools to the server/)
		expect(check).toMatch(/exactly these 18 names/)
		expect(ACCOUNTING_LOOP.description).toMatch(/exactly these 18 names/)
		expect(prompt).not.toMatch(/\b16\b/)
		for (const name of allowed) {
			expect(check).toContain(name)
			expect(prompt).toContain(name)
			expect(ACCOUNTING_LOOP.description).toContain(name)
		}
		// None of the tools that book, change, delete, pay or send is on the list the text gives.
		for (const name of ['CreateFinanceVoucher', 'BookVoucher', 'book_finance_voucher']) {
			expect(ACCOUNTING_LOOP.description).not.toContain(name)
			expect(prompt).not.toContain(name)
		}
		// The check still stops on a tool that books, and on any Dinero tool off the list.
		expect(check).toMatch(/every Dinero tool you have is on the list/)
		expect(check).toMatch(/a tool that books, changes or deletes is offered, or a Dinero tool/)
		// get_vat_report is the gateway's own read, not a Dinero tool, so the check must not count it.
		expect(check).toMatch(/get_vat_report is not a Dinero tool and does not count here/)
	})

	// Booking is the owner's switch. With it off the flow behaves as before, so the draft text stays
	// and the booking steps are written as conditional on the switch, the booking tools and a period
	// request. The tools are named in the skill, never in the prompt or the listing text.
	it('describes the booking steps behind the switch, with the log and the super-user line', () => {
		const method =
			skillTexts().find((t) => t.startsWith('---\nname: bookkeeping-draft-method')) ?? ''
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		const prompt = actorTexts().join('\n')
		expect(method).toMatch(/## Period run \(only when booking is on/)
		for (const name of ['BookVoucher', 'add_purchase_payment', 'add_invoice_payment']) {
			expect(method).toContain(name)
			expect(prompt).not.toContain(name)
			expect(ACCOUNTING_LOOP.description).not.toContain(name)
		}
		expect(method).toMatch(/Never book without a timestamp/)
		expect(method).toMatch(/leave it to Dinero/)
		expect(method).toMatch(/stays a draft, gets a flag/)
		expect(method).toMatch(/the rule check shows the entry clear/)
		expect(method).toMatch(/Put the reason on every line/)
		expect(method).toMatch(/is logged for you/)
		expect(method).toMatch(/The owner has approved the books: stop at once/)
		expect(method).toMatch(/file anything with SKAT or Erhvervsstyrelsen/)
		expect(prompt).toMatch(/Booking is the owner's switch, never yours/)
		expect(prompt).toMatch(/the owner has asked you in this chat to work a period/)
		expect(prompt).toMatch(/Draft only unless booking is switched on/)
		expect(check).toMatch(/Booking is off until a person switches it on/)
		expect(check).toMatch(/must be a super-user in Dinero/)
		expect(check).toMatch(/never add a booking tool to it/)
		expect(ACCOUNTING_LOOP.description).toMatch(/must be a super-user in Dinero/)
	})

	// A signed-in connection offers more than the 18 names, and with booking on it also offers the
	// booking and email tools, so the check must say which may be called, or it would stop the
	// Bookkeeper on them. The prompt points to the check instead of naming them.
	it('names the booking and email tools of the connection in the connection check', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		const prompt = actorTexts().join('\n')
		expect(check).toMatch(
			/CreateFinanceVoucher, which you call only with its book option set to false/,
		)
		expect(check).toMatch(
			/When a person has switched booking on, it also offers the three booking tools/,
		)
		for (const name of [
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		]) {
			expect(check).toContain(name)
		}
		expect(check).toMatch(/You use a booking tool only in a period run the owner asked for/)
		expect(check).toMatch(/only when the owner asks in the chat for exactly that one/)
		expect(prompt).toMatch(/the gateway sets the tool list itself and offers a few more tools/)
		expect(prompt).toMatch(/accounting-connection-check says which of them you may call and when/)
	})

	it('leaves the allowed list for a custom server and the draft path as they were', () => {
		const check =
			skillTexts().find((t) => t.startsWith('---\nname: accounting-connection-check')) ?? ''
		expect(check).toMatch(/keep its allowed list exactly as in step 3/)
		expect(check).toMatch(/with exactly these 18 names/)
		expect(ACCOUNTING_LOOP.description).toMatch(/exactly these 18 names/)
		expect(ACCOUNTING_LOOP.settings.closeCondition).toMatch(/With booking off, nothing is booked/)
	})

	it('never says reconcile: a payment is registered and a line is matched', () => {
		const all = [ACCOUNTING_LOOP.description, ...actorTexts(), ...skillTexts()].join('\n')
		expect(all).not.toMatch(/reconcil/i)
		expect(all).toMatch(/payment registered/)
	})

	it('has no key-based install step left', () => {
		const all = [ACCOUNTING_LOOP.description, ...actorTexts(), ...skillTexts()].join('\n')
		expect(all).not.toMatch(/client ID|client secret|Connect Dinero form|no browser sign-in/i)
	})

	it('never sees or asks for the sign-in token', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toMatch(
			/never see the owner's Dinero sign-in token and never ask for it in chat/,
		)
		expect(skillTexts().join('\n')).toMatch(/Never paste the token in the chat/)
	})

	it('is draft only and takes receipts from uploaded files only', () => {
		const prompt = actorTexts().join('\n')
		expect(prompt).toMatch(/Draft only/)
		expect(prompt).toMatch(/never book, finalise, change, approve, pay, send or delete/i)
		expect(prompt).toMatch(/uploads in the chat/)
		expect(prompt).toMatch(/do not promise that a photo or an email will arrive on its own/i)
	})

	it('keeps the published text free of workspace-specific references and credentials', () => {
		const texts = [
			ACCOUNTING_LOOP.description,
			ACCOUNTING_LOOP.settings.entryCondition,
			ACCOUNTING_LOOP.settings.closeCondition,
			ACCOUNTING_LOOP.settings.checklist?.title,
			ACCOUNTING_LOOP.settings.checklist?.body,
			...(ACCOUNTING_LOOP.settings.checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
			...actorTexts(),
			...triggerTexts(),
			...skillTexts(),
		]
		for (const text of texts) {
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
			expect(text).not.toMatch(/—|assum|Lane \d|Sebastian|Magnus|Maskin|bet\b/i)
			expect(text).not.toMatch(/https?:\/\//)
			expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
		}
	})

	// The rule check: a written, sourced rule list and a clear or flagged result for every entry,
	// in a fixed table another step (such as a booking step) can read.
	describe('rule check', () => {
		const ruleCheck = () =>
			skillTexts().find((t) => t.startsWith('---\nname: accounting-rule-check')) ?? ''
		const ruleRows = () =>
			ruleCheck()
				.split('\n')
				.filter((l) => /^R\d+ \| /.test(l))

		it('lists 32 rules, each with a severity, a status, a source and an owner line', () => {
			const rows = ruleRows()
			expect(rows.length).toBe(32)
			expect(rows.map((r) => r.split(' | ')[0])).toEqual(
				Array.from({ length: 32 }, (_, i) => `R${i + 1}`),
			)
			for (const row of rows) {
				const parts = row.split(' | ')
				expect(['flag', 'note']).toContain(parts[1])
				expect(['sourced', 'unsourced']).toContain(parts[2])
				expect(row).toMatch(/Source: .+\. \| Owner line: .+/)
			}
		})

		it('flags unsourced rules instead of passing them', () => {
			const unsourced = ruleRows().filter((r) => r.includes(' | unsourced | '))
			expect(unsourced.length).toBe(5)
			expect(ruleCheck()).toMatch(/flags whenever the situation it describes is present/)
			expect(ruleCheck()).toMatch(/not flagged by a rule just because the rule is unsourced/)
			for (const row of unsourced) expect(row.split(' | ')[1]).toBe('flag')
		})

		it('flags a missing receipt once and an odd amount by its own rule', () => {
			const text = ruleCheck()
			expect(text).toMatch(/write R5 and say the rules that need the receipt/)
			expect(ruleRows().find((r) => r.startsWith('R32 | '))).toMatch(
				/usual amount for the same payee/,
			)
			expect(ruleRows().find((r) => r.startsWith('R21 | '))).toMatch(/within 14 days/)
		})

		it('writes one clear or flagged row per entry in a fixed table', () => {
			const text = ruleCheck()
			expect(text).toContain('| entry | result | rules | why |')
			expect(text).toMatch(/exactly clear or flagged/)
			expect(text).toMatch(/treats every entry that is not exactly clear as flagged/)
			expect(text).toMatch(/An entry on that list is never clear/)
		})

		it('never changes a draft to make it pass and never books', () => {
			const text = ruleCheck()
			expect(text).toMatch(/never changes a voucher and never books one/)
			expect(text).toMatch(/Never change an amount, an account or a VAT code to make an entry pass/)
			expect(text).toMatch(/clear does not mean approved/)
		})

		it('is run by the Bookkeeper after every draft', () => {
			const prompt = actorTexts().join('\n')
			const method =
				skillTexts().find((t) => t.startsWith('---\nname: bookkeeping-draft-method')) ?? ''
			expect(prompt).toMatch(/Run the rule check on the draft \(skill accounting-rule-check\)/)
			expect(method).toMatch(/Step 3: run the rule check/)
			expect(method).toMatch(
				/Never save a second draft, or change the first, to make an entry pass/,
			)
			expect(ACCOUNTING_LOOP.description).toMatch(/clear or flagged with the rule it broke/)
		})
	})

	// The VAT return check: reads the flow's own VAT report, never builds a second set of figures,
	// never guesses a date, and never says anything was filed.
	describe('VAT return check', () => {
		const skill = () => skillTexts().find((t) => t.startsWith('---\nname: vat-return-check')) ?? ''
		const trigger = () => {
			const t = ACCOUNTING_LOOP_TRIGGER_IDS.map((id) => getTriggerData(id)).find((x) =>
				x.name.startsWith('VAT return check'),
			)
			if (!t) throw new Error('VAT return check trigger not shipped')
			return t
		}

		it('runs on Mondays at 07:00 UTC, with a late-start guard, silent until a return is near', () => {
			expect(trigger().name).toBe('VAT return check (Monday 07:00 UTC)')
			expect(trigger().config).toMatchObject({ expression: '0 7 * * 1' })
			const prompt = trigger().actionPrompt ?? ''
			expect(prompt).toContain('flow named Accounting')
			expect(prompt).toContain('more than 1 hour after its scheduled time, do nothing')
			expect(prompt).toContain('vat-return-check')
			expect(prompt).toContain('more than 28 days away')
		})

		it('reads figures only from get_vat_report and never builds a second set', () => {
			expect(skill()).toMatch(/figures come from the tool get_vat_report and from nothing else/)
			expect(skill()).toMatch(/do not build a second set of figures/)
			expect(skill()).toMatch(/Both amounts on every finding/)
		})

		it('reads dates from Skat at run time, cites them and never guesses', () => {
			expect(skill()).toMatch(/Every date comes from Skat at run time/)
			expect(skill()).toMatch(/Never guess a date/)
			expect(skill()).toMatch(/due date not confirmed/)
			expect(skill()).toMatch(/more than 28 days away: stay silent/)
			expect(skill()).toMatch(/within 20 days: run the short version/)
		})

		it('writes one note titled by the period, linked to the flow, and never says filed', () => {
			expect(skill()).toMatch(/titled exactly VAT check, the period start, the word to/)
			expect(skill()).toMatch(/in_loop relationship from the flow/)
			expect(skill()).toMatch(/This check files nothing/)
			expect(skill().toLowerCase()).not.toMatch(/\b(was|has been|is|are) filed\b/)
			const prompt = actorTexts().join('\n')
			expect(prompt).toMatch(/# VAT return check/)
			expect(prompt).toMatch(/get_vat_report, is not a Dinero tool/)
			expect(prompt).toMatch(/never files/)
		})

		it('stops and names the owner when the report tool is not there', () => {
			expect(skill()).toMatch(/If the tool is not among your tools, say so in the first line/)
			expect(skill()).toMatch(/Dinero connected by sign-in/)
		})
	})

	// The year-end pack: open items and what only a person signs or files. A draft checklist for the
	// owner, never filed or signed by the flow, with no human accountant step.
	describe('year-end pack', () => {
		const pack = () =>
			skillTexts().find((t) => t.startsWith('---\nname: accounting-year-end-pack')) ?? ''
		const yearEndTrigger = () =>
			ACCOUNTING_LOOP_TRIGGER_IDS.map((id) => getTriggerData(id)).find((t) =>
				t.name.startsWith('Year-end pack check'),
			)

		it('lists the three kinds of open item in a fixed table with counts and kroner', () => {
			const text = pack()
			expect(text).toMatch(/Missing receipts\./)
			expect(text).toMatch(/Bank lines with no matching voucher\./)
			expect(text).toMatch(/Uncategorised vouchers\./)
			expect(text).toContain('| kind | items | amount in kroner | where to start |')
			expect(text).toMatch(/table counts equal the number of lines listed under it/)
		})

		it('says plainly that the owner signs and files, with no human accountant step', () => {
			const text = pack()
			expect(text).toMatch(/The owner signs and files themselves: the flow does not/)
			expect(text).toMatch(/the flow has no other review step/)
			expect(text).toMatch(/The rule check \(skill accounting-rule-check\) is the control/)
			expect(text).toMatch(/5\. What the owner still does\./)
			expect(text).toMatch(/Prepare, sign and file the annual report/)
			expect(text).toMatch(/you sign and file yourself/)
			expect(yearEndTrigger()?.actionPrompt).toMatch(/the owner signs and files themselves/)
			expect(actorTexts().join('\n')).toMatch(/owner signs and files themselves/)
			expect(text).not.toMatch(/adviser reviews/i)
			expect(ACCOUNTING_LOOP.description).toMatch(/the flow never signs or files/)
		})

		it('never says anything was booked, signed, filed or approved', () => {
			const all = [pack(), yearEndTrigger()?.actionPrompt ?? '', ...actorTexts()].join('\n')
			expect(all).not.toMatch(
				/\b(has|have|had|was|were|is|are|been|get|gets) (been )?(filed|signed|submitted)\b/i,
			)
			expect(pack()).toMatch(/never book, finalise, change, approve, pay, send, sign or file/i)
			expect(pack()).toMatch(/Never state that anything was booked, signed, filed or approved/)
		})

		it('keeps one set of figures: none are computed in this pack', () => {
			expect(pack()).toMatch(/Figures are not part of this version of the pack/)
			expect(pack()).toMatch(/Do not compute figures/)
		})

		it('starts 60 days before the year end, once per accounting year', () => {
			const trigger = yearEndTrigger()
			expect(trigger?.type).toBe('cron')
			expect(trigger?.name).toMatch(/UTC/)
			expect(trigger?.actionPrompt).toContain('flow named Accounting')
			expect(trigger?.actionPrompt).toMatch(/more than 60 days away/)
			expect(trigger?.actionPrompt).toMatch(
				/workspace file tool list_files \(never Dinero's list_files[^)]*\) to look for a file in this flow named exactly Year-end pack/,
			)
			expect(trigger?.actionPrompt).toMatch(/If one exists, say nothing/)
			expect(pack()).toMatch(/Make one pack per accounting year/)
			expect(pack()).toMatch(/named exactly Year-end pack followed by the accounting year's name/)
			expect(pack()).toMatch(/workspace file tool create_file/)
			expect(pack()).toMatch(/workspace file tool list_files \(never Dinero's list_files/)
		})

		it('ends silently when the connection fails, leaving the owner note to the 06:00 check', () => {
			const prompt = yearEndTrigger()?.actionPrompt ?? ''
			expect(prompt).toMatch(/If the connection fails, end the session without a comment/)
			expect(prompt).toMatch(/weekly connection check at 06:00/)
			expect(prompt).not.toMatch(/connection fails, post/)
		})

		it('uses only Dinero tools that are on the allowed list', () => {
			const allowed = new Set([
				'CreatePurchaseVoucher',
				'upload_file',
				'list_organizations',
				'list_accounting_years',
				'get_chart_of_accounts',
				'list_purchase_accounts',
				'list_vat_types',
				'list_contacts',
				'get_contact',
				'GetContactByName',
				'list_vouchers',
				'get_purchase_voucher',
				'list_files',
				'list_voucher_file_cards',
				'get_purchase_drafts_for_file',
				'SearchBankTransactions',
			])
			const named =
				pack().match(/\b(?:list_[a-z_]+|get_[a-z_]+|SearchBankTransactions|Create[A-Za-z]+)\b/g) ??
				[]
			for (const name of named) expect(allowed.has(name)).toBe(true)
		})
	})

	it('says flow, not loop, in the text a person reads', () => {
		const texts = [
			ACCOUNTING_LOOP.description,
			...(ACCOUNTING_LOOP.settings.checklist?.items ?? []).map((i) => `${i.title} ${i.body}`),
			...actorTexts(),
			...triggerTexts(),
			...skillTexts(),
		]
		for (const text of texts) expect(text).not.toMatch(/\b[Ll]oops?\b/)
	})
})
