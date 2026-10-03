import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("TriggersStore")
struct TriggersStoreTests {
	@Test("loads triggers and resolves agent names, never ids")
	func loads() async {
		let api = FakeTriggersAPI([trig("t1", name: "Morning brief", agent: "agent-2")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		#expect(store.phase == .loaded)
		#expect(store.agentName(for: store.triggers[0]) == "Forge")
		store.stop()
	}

	@Test("an unresolvable agent reads as Unknown agent")
	func unknownAgent() async {
		let store = TriggersStore(api: FakeTriggersAPI([trig("t1", agent: "ghost")]), events: nil)
		await store.start()
		#expect(store.agentName(for: store.triggers[0]) == "Unknown agent")
	}

	@Test("a failed first load reports the error")
	func failure() async {
		let api = FakeTriggersAPI([])
		await api.setFailList(true)
		let store = TriggersStore(api: api, events: nil)
		await store.refresh()
		#expect(store.phase == .failed("offline"))
	}

	@Test("sections split on and off and filter by search")
	func sections() async {
		let store = TriggersStore(
			api: FakeTriggersAPI([
				trig("a", name: "Daily digest"), trig("b", name: "Weekly review", enabled: false),
				trig("c", name: "Digest follow-up", enabled: false),
			]), events: nil)
		await store.start()
		#expect(store.sections().map(\.label) == ["On", "Off"])
		#expect(store.sections(query: "digest").map { $0.items.map(\.id) } == [["a"], ["c"]])
		#expect(store.sections(query: "relay").flatMap(\.items).count == 3)
		#expect(store.sections(query: "zzz").isEmpty)
	}

	@Test("enabling is optimistic and confirmed by the server")
	func toggleOptimistic() async {
		let api = FakeTriggersAPI([trig("a", enabled: false)])
		await api.setUpdateDelay(.milliseconds(80))
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		let task = Task { await store.setEnabled("a", true) }
		#expect(await eventually { store.trigger(id: "a")?.enabled == true })
		await task.value
		#expect(store.trigger(id: "a")?.enabled == true)
		#expect(await api.updates.first?.1.enabled == true)
	}

	@Test("a refused toggle rolls back and explains")
	func toggleRollback() async {
		let api = FakeTriggersAPI([trig("a", enabled: true)])
		await api.setFailUpdates(true)
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		await store.setEnabled("a", false)
		#expect(store.trigger(id: "a")?.enabled == true)
		#expect(store.notice?.contains("Couldn't turn off") == true)
	}

	@Test("a refresh during a pending toggle does not flip it back")
	func refreshKeepsPending() async {
		let api = FakeTriggersAPI([trig("a", enabled: false)])
		await api.setUpdateDelay(.milliseconds(150))
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		let task = Task { await store.setEnabled("a", true) }
		#expect(await eventually { store.trigger(id: "a")?.enabled == true })
		await store.refresh()
		#expect(store.trigger(id: "a")?.enabled == true)
		await task.value
	}

	@Test("creating adds the trigger first and sends a cron draft")
	func create() async throws {
		let api = FakeTriggersAPI([trig("a")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		var draft = TriggerDraft()
		draft.name = "  Nightly  "
		draft.actionPrompt = "Summarise the day"
		draft.targetActorID = "agent-1"
		draft.schedule = CronSchedule(frequency: .daily, minute: 0, hour: 22)
		let made = try await store.create(draft)
		#expect(store.triggers.first?.id == made.id)
		#expect(made.name == "Nightly")
		#expect(made.summary == "Runs every day at 10:00 PM UTC")
	}

	@Test("an incomplete draft is rejected before any request")
	func createInvalid() async {
		let api = FakeTriggersAPI([])
		let store = TriggersStore(api: api, events: nil)
		await #expect(throws: AutomationError.self) { try await store.create(TriggerDraft()) }
		#expect(await api.created.isEmpty)
	}

	@Test("deleting removes optimistically and restores on failure")
	func delete() async {
		let api = FakeTriggersAPI([trig("a"), trig("b")])
		let store = TriggersStore(api: api, events: nil)
		await store.start()
		await store.delete("a")
		#expect(store.triggers.map(\.id) == ["b"])
		await api.setFailUpdates(true)
		await store.delete("b")
		#expect(store.triggers.map(\.id) == ["b"])
		#expect(store.notice?.contains("Couldn't delete") == true)
	}

	@Test("a trigger event reloads the list")
	func liveReload() async {
		let api = FakeTriggersAPI([trig("a")])
		let hub = scriptedHub([triggerFrame(1, trigger: "a")])
		let store = TriggersStore(api: api, events: hub)
		await store.start()
		await api.set([trig("a"), trig("b")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.triggers.count == 2 })
		store.stop()
	}

	@Test("the list reloads after the stream reconnects")
	func reconnect() async {
		let api = FakeTriggersAPI([trig("a")])
		let hub = scriptedHub([triggerFrame(1, trigger: "a", entity: "note"), ""])
		let store = TriggersStore(api: api, events: hub)
		await store.start()
		await api.set([trig("a"), trig("b"), trig("c")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.triggers.count == 3 })
		store.stop()
	}
}
