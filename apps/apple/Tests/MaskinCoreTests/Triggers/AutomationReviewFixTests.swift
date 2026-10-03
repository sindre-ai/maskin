import Foundation
import Testing

@testable import MaskinCore

/// A gate a test opens by hand, so debounce windows never depend on the wall clock.
actor SleepGate {
	private var waiters: [CheckedContinuation<Void, Never>] = []
	private(set) var waiting = 0

	func wait() async {
		waiting += 1
		await withCheckedContinuation { waiters.append($0) }
	}

	func open() {
		for w in waiters { w.resume() }
		waiters.removeAll()
	}
}

private func tz(_ id: String) -> TimeZone { TimeZone(identifier: id)! }

private func utcDate(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
	CronSchedule.utcCalendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
}

@Suite("Cron schedules are UTC")
struct CronUTCTests {
	@Test("the summary names the zone the server evaluates in")
	func summaryLabelsUTC() {
		#expect(CronSchedule(frequency: .daily, minute: 0, hour: 9).summary == "every day at 9:00 AM UTC")
		#expect(CronSchedule(frequency: .weekly, minute: 0, hour: 9, dayOfWeek: 1).summary.hasSuffix("UTC"))
		#expect(CronSchedule(frequency: .monthly, minute: 0, hour: 9, dayOfMonth: 3).summary.hasSuffix("UTC"))
		#expect(CronSchedule(frequency: .hourly, minute: 5).summary == "every hour at minute 5")
	}

	@Test("next fire uses UTC by default, whatever the device zone is")
	func nextFireDefaultsToUTC() {
		let schedule = CronSchedule(frequency: .daily, minute: 0, hour: 9)
		#expect(schedule.nextFire(after: utcDate(2026, 10, 2, 8)) == utcDate(2026, 10, 2, 9))
		#expect(schedule.nextFire(after: utcDate(2026, 10, 2, 9)) == utcDate(2026, 10, 3, 9))
	}

	@Test("the viewer's local equivalent follows the real zone offset", arguments: [
		("Europe/Berlin", "11:00 AM"),
		("Asia/Kolkata", "2:30 PM"),
		("America/Los_Angeles", "2:00 AM"),
	])
	func localEquivalent(zone: String, expected: String) {
		let schedule = CronSchedule(frequency: .daily, minute: 0, hour: 9)
		#expect(schedule.localEquivalent(after: utcDate(2026, 10, 2), timeZone: tz(zone)) == expected)
	}

	@Test("no local hint when the viewer is on UTC, and none for hourly")
	func localEquivalentNil() {
		let daily = CronSchedule(frequency: .daily, minute: 0, hour: 9)
		#expect(daily.localEquivalent(after: utcDate(2026, 10, 2), timeZone: tz("UTC")) == nil)
		let hourly = CronSchedule(frequency: .hourly, minute: 5)
		#expect(hourly.localEquivalent(after: utcDate(2026, 10, 2), timeZone: tz("Asia/Tokyo")) == nil)
	}

	@Test("a zone that crosses midnight names the shifted weekday and month day")
	func dayBoundary() {
		// Monday 23:00 UTC is Tuesday 01:00 in Berlin (CEST, +2).
		let weekly = CronSchedule(frequency: .weekly, minute: 0, hour: 23, dayOfWeek: 1)
		#expect(
			weekly.localEquivalent(after: utcDate(2026, 10, 2), timeZone: tz("Europe/Berlin"))
				== "1:00 AM, Tuesday")
		// The 15th at 01:00 UTC is still the 14th in Los Angeles.
		let monthly = CronSchedule(frequency: .monthly, minute: 0, hour: 1, dayOfMonth: 15)
		#expect(
			monthly.localEquivalent(after: utcDate(2026, 10, 2), timeZone: tz("America/Los_Angeles"))
				== "6:00 PM, day 14")
	}

	@Test("daylight saving changes the local equivalent but never the UTC schedule")
	func dst() {
		let sunday = CronSchedule(frequency: .weekly, minute: 0, hour: 12, dayOfWeek: 0)
		let ny = tz("America/New_York")
		#expect(sunday.localEquivalent(after: utcDate(2026, 1, 10), timeZone: ny) == "7:00 AM")
		#expect(sunday.localEquivalent(after: utcDate(2026, 7, 10), timeZone: ny) == "8:00 AM")
		#expect(sunday.nextFire(after: utcDate(2026, 7, 10)) == utcDate(2026, 7, 12, 12))
	}
}

@Suite("Cron summaries are never wrong")
struct CronFaithfulTests {
	@Test("both day fields restricted means day-of-month OR day-of-week, which no shape models")
	func domOrDow() {
		#expect(CronSchedule(expression: "0 9 15 * 1") == nil)
		#expect(CronSchedule.describe("0 9 15 * 1") == "0 9 15 * 1")
		#expect(CronSchedule(expression: "0 9 1 * 7") == nil)
	}

	@Test("a 6-field expression only reads as a 5-field one when its seconds are 0")
	func seconds() {
		#expect(CronSchedule(expression: "0 30 9 * * *")?.summary == "every day at 9:30 AM UTC")
		#expect(CronSchedule(expression: "30 30 9 * * *") == nil)
		#expect(CronSchedule(expression: "*/10 30 9 * * *") == nil)
		#expect(CronSchedule(expression: "* * * * * *") == nil)
	}

	@Test("aliases, steps, lists, ranges and names stay raw", arguments: [
		"@daily", "@hourly", "@weekly", "@monthly", "@yearly", "*/15 * * * *", "0 */2 * * *",
		"0 9 */2 * *", "0 9 * * */2", "0 9,17 * * *", "0 9 1,15 * *", "0 9 * * 1,3", "0 9-17 * * *",
		"0 9 * * 1-5", "0 9 * * MON", "0 9 * * MON-FRI", "0 9 * JAN *", "0 9 1 JAN *", "0 9 * 1 *",
		"0 9 L * *", "0 9 ? * *",
	])
	func rawStaysRaw(expression: String) {
		#expect(CronSchedule(expression: expression) == nil)
		#expect(CronSchedule.describe(expression) == expression)
	}

	@Test("0 and 7 both mean Sunday")
	func sunday() {
		#expect(CronSchedule(expression: "0 9 * * 0")?.dayOfWeek == 0)
		#expect(CronSchedule(expression: "0 9 * * 7")?.dayOfWeek == 0)
	}
}

@MainActor
@Suite("Trigger writes carry one idempotency key per intent")
struct TriggerKeyTests {
	private func draft() -> TriggerDraft {
		var d = TriggerDraft()
		d.name = "Morning"
		d.actionPrompt = "Do it"
		d.targetActorID = "agent-1"
		return d
	}

	@Test("creating again after a lost response reuses the key, so it cannot create twice")
	func createRetry() async throws {
		let api = FakeTriggersAPI([])
		let store = TriggersStore(api: api, events: nil)
		await api.setDropNextResponse(true)
		await #expect(throws: AutomationError.self) { try await store.create(draft()) }
		_ = try await store.create(draft())
		let keys = await api.createKeys
		#expect(keys.count == 2)
		#expect(keys[0] == keys[1])
	}

	@Test("an edited draft, or a draft after success, gets a new key")
	func createNewIntent() async throws {
		let api = FakeTriggersAPI([])
		let store = TriggersStore(api: api, events: nil)
		_ = try await store.create(draft())
		_ = try await store.create(draft())
		var other = draft()
		other.name = "Evening"
		_ = try await store.create(other)
		#expect(Set(await api.createKeys).count == 3)
	}

	@Test("delete sends a key and a retry after failure reuses it")
	func deleteKey() async {
		let api = FakeTriggersAPI([trig("a")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		await api.setFailUpdates(true)
		await store.delete("a")
		await store.delete("a")
		await api.setFailUpdates(false)
		await store.delete("a")
		let keys = await api.deleteKeys
		#expect(keys.count == 3)
		#expect(Set(keys).count == 1)
	}

	@Test("a refresh while a delete is in flight does not bring the row back")
	func deleteVersusRefresh() async {
		let api = FakeTriggersAPI([trig("a"), trig("b")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		await api.setDeleteDelay(.milliseconds(120))
		let task = Task { await store.delete("a") }
		#expect(await eventually { store.trigger(id: "a") == nil })
		await store.refresh()
		#expect(store.triggers.map(\.id) == ["b"])
		await task.value
	}

	@Test("a failed delete restores only that row, once")
	func deleteRollbackOnce() async {
		let api = FakeTriggersAPI([trig("a"), trig("b")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		await api.setFailUpdates(true)
		await api.setDeleteDelay(.milliseconds(80))
		let task = Task { await store.delete("a") }
		#expect(await eventually { store.trigger(id: "a") == nil })
		await store.refresh()
		await task.value
		#expect(store.triggers.map(\.id).sorted() == ["a", "b"])
	}

	@Test("the detail screen's save, toggle and delete carry keys; a repeated save reuses its key")
	func detailKeys() async {
		let api = FakeTriggersAPI([trig("t1")])
		let store = TriggerDetailStore(trigger: trig("t1"), api: api, events: nil)
		await api.setFailUpdates(true)
		store.edit.name = "Renamed"
		await store.save()
		await api.setFailUpdates(false)
		await store.save()
		let keys = await api.updateKeys
		#expect(keys.count == 2)
		#expect(keys[0] == keys[1])
		await store.delete()
		#expect(await api.deleteKeys.count == 1)
	}

	@Test("a trigger missing from a list that stopped early is unknown, not deleted")
	func incompleteListIsNotDeletion() async {
		let api = FakeTriggersAPI([trig("other")])
		await api.setListComplete(false)
		let store = TriggerDetailStore(trigger: trig("t1"), api: api, events: nil)
		await store.refresh()
		#expect(!store.isDeleted)
		await api.setListComplete(true)
		await store.refresh()
		#expect(store.isDeleted)
	}

	@Test("the next-run hint is the viewer's local time of the UTC schedule")
	func nextRunLocal() {
		let t = trig("t1", config: .object(["expression": .string("0 9 * * *")]))
		let store = TriggerDetailStore(trigger: t, api: FakeTriggersAPI([t]), events: nil)
		#expect(store.nextRunLocalEquivalent(now: utcDate(2026, 10, 2), timeZone: tz("Europe/Berlin")) == "11:00 AM")
		var off = t
		off.enabled = false
		let offStore = TriggerDetailStore(trigger: off, api: FakeTriggersAPI([off]), events: nil)
		#expect(offStore.nextRunLocalEquivalent(now: utcDate(2026, 10, 2), timeZone: tz("Europe/Berlin")) == nil)
	}
}

@MainActor
@Suite("Loops and agents live refresh and rollback")
struct AutomationLiveTests {
	@Test("a burst of session events becomes one agents reload")
	func agentsDebounce() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = scriptedHub((1...4).map {
			conversationFrame($0, conversation: "s\($0)", action: "updated", entity: "session")
		})
		let gate = SleepGate()
		let store = AgentsStore(api: api, events: hub, debounce: .seconds(1), sleep: { _ in await gate.wait() })
		await store.start()
		let baseline = await api.calls
		hub.connect(workspaceId: "w1")
		// Four events open exactly one debounce window (reload counts are not asserted: the
		// scripted stream also reconnects once, which reloads immediately).
		#expect(await eventually { await gate.waiting == 1 })
		try? await Task.sleep(for: .milliseconds(60))
		#expect(await gate.waiting == 1)
		await gate.open()
		#expect(await eventually { await api.calls > baseline })
		try? await Task.sleep(for: .milliseconds(60))
		#expect(await gate.waiting == 1)
		store.stop()
	}

	@Test("a quiet agent gets its own latest session, so an old failure reads Failed")
	func quietAgentLatest() async {
		let api = FakeAgentsAPI(
			[agentRow("busy"), agentRow("quiet")],
			sessions: [agentSession("s1", actor: "busy", status: "completed", at: 50)])
		await api.set(latest: ["quiet": agentSession("old", actor: "quiet", status: "failed", at: -9_000)])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		let quiet = store.agent(id: "quiet")
		#expect(quiet?.latestSession?.id == "old")
		#expect(quiet?.status == .failed)
		#expect(quiet?.sessionCount == 1)
		#expect(await api.latestCalls == ["quiet"])
	}

	@Test("a second tap on pause while the first is in flight is ignored")
	func toggleReentrancy() async {
		let api = FakeLoopsAPI([loopRow("a", status: .supervised)])
		await api.setStatusDelay(.milliseconds(120))
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		let first = Task { await store.togglePause("a") }
		#expect(await eventually { store.loop(id: "a")?.status == .paused })
		await store.togglePause("a")
		#expect(store.loop(id: "a")?.status == .paused)
		await first.value
		#expect(await api.statusCalls.count == 1)
	}

	@Test("a failed pause keeps what a refresh learned about the row meanwhile")
	func rollbackIsScoped() async {
		let api = FakeLoopsAPI([loopRow("a", status: .supervised, inProgress: 2), loopRow("b")])
		await api.setStatusDelay(.milliseconds(120))
		await api.setFailStatus(true)
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		let task = Task { await store.togglePause("a") }
		#expect(await eventually { store.loop(id: "a")?.status == .paused })
		await api.set([loopRow("a", status: .supervised, inProgress: 9), loopRow("b", inProgress: 7)])
		await store.refresh()
		await task.value
		#expect(store.loop(id: "a")?.status == .supervised)
		#expect(store.loop(id: "a")?.inProgressCount == 9)
		#expect(store.loop(id: "b")?.inProgressCount == 7)
	}

	@Test("a loop pause carries the same key on retry after failure")
	func loopKeyReuse() async {
		let api = FakeLoopsAPI([loopRow("a", status: .supervised)])
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		await api.setFailStatus(true)
		await store.togglePause("a")
		await store.togglePause("a")
		#expect(await api.statusKeys.count == 2)
		#expect(Set(await api.statusKeys).count == 1)
	}
}
