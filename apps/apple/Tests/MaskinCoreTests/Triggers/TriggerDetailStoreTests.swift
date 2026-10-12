import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("TriggerDescriber")
struct TriggerDescriberTests {
	@Test("describes event, cron and reminder triggers")
	func describes() {
		#expect(trig("a", kind: .cron).summary == "Runs every day at 9:00 AM UTC")
		#expect(trig("a", kind: .cron, config: .object([:])).summary == "Runs on a schedule")
		#expect(
			trig("a", kind: .event, config: .object(["entity_type": .string("bet"), "action": .string("created")])).summary
				== "When bet is created")
		#expect(
			trig(
				"a", kind: .event,
				config: .object([
					"entity_type": .string("task"), "action": .string("status_changed"),
					"from_status": .string("in_progress"), "to_status": .string("done"),
				])
			).summary == "When task changes from in progress to done")
		#expect(
			trig(
				"a", kind: .event,
				config: .object([
					"entity_type": .string("task"), "action": .string("status_changed"),
					"filter": .object(["status": .array([.string("done"), .string("blocked")])]),
				])
			).summary == "When task changes from any to done or blocked")
		#expect(trig("a", kind: .reminder, config: .object([:])).summary == "One-time reminder")
	}

	@Test("an unparseable cron expression is shown raw, not described wrongly")
	func rawCron() {
		let t = trig("a", config: .object(["expression": .string("*/5 * * * *")]))
		#expect(t.summary == "Runs */5 * * * *")
		#expect(t.schedule == nil)
	}
}

@MainActor
@Suite("TriggerDetailStore")
struct TriggerDetailStoreTests {
	private func make(
		_ trigger: Trigger = trig("t1", name: "Digest"), rows: [Trigger]? = nil
	) -> (TriggerDetailStore, FakeTriggersAPI) {
		let api = FakeTriggersAPI(rows ?? [trigger])
		return (TriggerDetailStore(trigger: trigger, directory: ActorDirectory(testActors), api: api, events: nil), api)
	}

	@Test("a pristine edit is not dirty and has no patch")
	func clean() {
		let (store, _) = make()
		#expect(!store.isDirty)
		#expect(!store.canSave)
	}

	@Test("the patch contains only what changed")
	func minimalPatch() async {
		let (store, api) = make()
		store.edit.name = "Evening digest"
		store.edit.targetActorID = "agent-2"
		#expect(store.canSave)
		await store.save()
		let patch = await api.updates.first?.1
		#expect(patch?.name == "Evening digest")
		#expect(patch?.targetActorID == "agent-2")
		#expect(patch?.actionPrompt == nil)
		#expect(patch?.config == nil)
		#expect(!store.isDirty)
		#expect(store.trigger.name == "Evening digest")
	}

	@Test("moving the schedule keeps the rest of the cron config")
	func schedulePreservesScope() async {
		let scope: JSONValue = .object(["entity_type": .string("task")])
		let trigger = trig(
			"t1", config: .object(["expression": .string("0 9 * * *"), "scope": scope]))
		let (store, api) = make(trigger)
		store.edit.schedule = CronSchedule(frequency: .weekly, minute: 0, hour: 8, dayOfWeek: 5)
		await store.save()
		let patch = await api.updates.first?.1
		#expect(patch?.kind == .cron)
		#expect(patch?.config?["expression"]?.stringValue == "0 8 * * 5")
		#expect(patch?.config?["scope"] == scope)
	}

	@Test("an expression the app can't model stays read-only")
	func rawStaysUntouched() {
		let (store, _) = make(trig("t1", config: .object(["expression": .string("*/5 * * * *")])))
		#expect(store.edit.schedule == nil)
		#expect(!store.isDirty)
	}

	@Test("blank name or prompt blocks saving")
	func validation() {
		let (store, _) = make()
		store.edit.name = "   "
		#expect(!store.edit.isValid)
		#expect(!store.canSave)
	}

	@Test("a failed save keeps the edit and shows the error")
	func saveFailure() async {
		let (store, api) = make()
		await api.setFailUpdates(true)
		store.edit.name = "Renamed"
		await store.save()
		#expect(store.error == "server said no")
		#expect(store.edit.name == "Renamed")
		#expect(store.isDirty)
		store.discardChanges()
		#expect(!store.isDirty)
		#expect(store.error == nil)
	}

	@Test("toggling enabled rolls back when refused")
	func toggleRollback() async {
		let (store, api) = make(trig("t1", enabled: true))
		await api.setFailUpdates(true)
		await store.setEnabled(false)
		#expect(store.trigger.enabled)
		#expect(store.error?.contains("Couldn't turn off") == true)
	}

	@Test("next run is only offered while enabled")
	func nextRun() {
		let (on, _) = make(trig("t1", enabled: true))
		let (off, _) = make(trig("t2", enabled: false))
		#expect(on.nextRun() != nil)
		#expect(off.nextRun() == nil)
	}

	@Test("refresh keeps an unsaved edit but follows the server otherwise")
	func refreshPolicy() async {
		let (store, api) = make()
		await api.set([trig("t1", name: "Server rename")])
		await store.refresh()
		#expect(store.edit.name == "Server rename")
		store.edit.prompt("typed")
		await api.set([trig("t1", name: "Another rename")])
		await store.refresh()
		#expect(store.trigger.name == "Another rename")
		#expect(store.edit.actionPrompt == "typed")
	}

	@Test("a trigger that disappears marks the screen deleted")
	func gone() async {
		let (store, api) = make()
		await api.set([])
		await store.refresh()
		#expect(store.isDeleted)
	}

	@Test("delete reports through the callback")
	func deleteCallback() async {
		let (store, api) = make()
		var deletedID: String?
		store.onDeleted = { deletedID = $0 }
		await store.delete()
		#expect(store.isDeleted)
		#expect(deletedID == "t1")
		#expect(await api.deleted == ["t1"])
	}
}

extension TriggerEdit {
	fileprivate mutating func prompt(_ text: String) { actionPrompt = text }
}
