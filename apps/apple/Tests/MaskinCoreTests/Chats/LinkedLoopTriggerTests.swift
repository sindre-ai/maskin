import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Linked loops and triggers")
struct LinkedLoopTriggerTests {
	let ws = "ws-1"
	let loopID = "11111111-2222-3333-4444-555555555555"
	let otherLoopID = "22222222-2222-3333-4444-555555555555"
	let triggerID = "33333333-2222-3333-4444-555555555555"
	let missingID = "44444444-2222-3333-4444-555555555555"

	final class Calls: @unchecked Sendable {
		private let lock = NSLock()
		private var _loops = 0
		private var _triggers = 0
		var loops: Int { lock.withLock { _loops } }
		var triggers: Int { lock.withLock { _triggers } }
		func loop() { lock.withLock { _loops += 1 } }
		func trigger() { lock.withLock { _triggers += 1 } }
	}

	private func summary(_ id: String, pill: LoopPill = .supervised) -> LoopSummary {
		LoopSummary(
			id: id, name: "  Weekly review  ", content: "# Review\nLook at **last week** and plan the next.",
			status: pill, pill: pill, inProgressCount: 3, closedCount: 12, agentIDs: ["a-1", "a-2"],
			updatedAt: Date(timeIntervalSince1970: 500))
	}

	private func trigger(enabled: Bool = true) -> Trigger {
		Trigger(
			id: triggerID, name: " Close done tasks ", kind: .event,
			config: .object([
				"entity_type": .string("task"), "action": .string("status_changed"), "to_status": .string("done"),
			]),
			actionPrompt: "Secret instruction text.", targetActorID: "a-1", enabled: enabled)
	}

	private func make(
		loops: [LoopSummary] = [], triggers: [Trigger] = [], complete: Bool = true, objects: FakeDraftsRemote = FakeDraftsRemote(),
		calls: Calls = Calls(), clock: Date = Date(timeIntervalSince1970: 1000)
	) -> LinkedItemStore {
		LinkedItemStore(
			objects: objects, files: FakeLinkedFiles(), actors: { [ActorRef(id: "a-1", name: "Relay", isAgent: true)] },
			loops: {
				calls.loop()
				return loops
			},
			triggers: {
				calls.trigger()
				return TriggerListing(triggers: triggers, isComplete: complete)
			}, workspaceID: { "ws-1" }, retryAfter: 30, now: { clock })
	}

	// MARK: Addresses

	@Test("loop and trigger addresses are targets of their own kind, and count with objects in the lookup cap")
	func targets() {
		let text = """
			[Flow](https://maskin.io/\(ws)/loops/\(loopID)) and https://maskin.io/\(ws)/triggers/\(triggerID).
			"""
		let found = LinkedTarget.extract(from: text)
		#expect(found.map(\.key) == ["loop:\(loopID)", "trigger:\(triggerID)"])
		#expect(LinkedTarget.parse(href: "/\(ws)/loops/\(loopID)")?.kind == .loop)
		#expect(LinkedTarget.parse(href: "https://maskin.io/\(ws)/loops")?.kind == nil)
		let many = (0..<12).map { i in
			LinkedTarget(kind: i % 2 == 0 ? .loop : .trigger, uuid: String(format: "00000000-0000-0000-0000-%012d", i))
		}
		#expect(LinkedMessageLayout.lookupTargets(many).count == LinkedMessageLayout.maxObjectLookupsPerMessage)
	}

	// MARK: Loop card

	@Test("loop badge mapping: each rung in words, and Waiting on you where the list says Needs you")
	func badges() {
		let words: [LoopPill: String] = [
			.draft: "Draft", .paused: "Paused", .learning: "Learning", .supervised: "Supervised",
			.fullyAutonomous: "Fully autonomous", .waitingOnYou: "Waiting on you",
		]
		#expect(words.count == LoopPill.allCases.count)
		for (pill, word) in words { #expect(LinkedLoop.badge(for: pill) == word, "\(pill)") }
	}

	@Test("a loop in the list shows name, description, agents, activity and first agent")
	func loopFromList() async {
		let calls = Calls()
		let store = make(loops: [summary(loopID)], calls: calls)
		let target = LinkedTarget(kind: .loop, uuid: loopID)
		await store.resolve([target])
		guard case .loop(let card)? = store.item(for: target) else {
			Issue.record("not a loop card: \(String(describing: store.state(for: target)))")
			return
		}
		#expect(card.name == "Weekly review")
		#expect(card.summary == "Review Look at last week and plan the next.")
		#expect(card.badge == "Supervised")
		#expect(card.agentsFact == "2 agents")
		#expect(card.activity == "3 in progress · 12 closed")
		#expect(card.firstAgentID == "a-1")
		#expect(store.isCard(target))
		#expect(store.showsCard(target))
	}

	@Test("a loop that is not in the list is read as an object: name, description and state, no counts")
	func loopFromObject() async {
		let objects = FakeDraftsRemote()
		objects.set(
			.success(
				ObjectDetail(
					object: WorkObject(id: loopID, type: "loop", title: "New flow", content: "Does a thing.", status: "paused"),
					workspaceId: ws)),
			for: loopID)
		let store = make(loops: [summary(otherLoopID)], objects: objects)
		let target = LinkedTarget(kind: .loop, uuid: loopID)
		await store.resolve([target])
		guard case .loop(let card)? = store.item(for: target) else {
			Issue.record("not a loop card")
			return
		}
		#expect(card.badge == "Paused")
		#expect(card.agentsFact == nil)
		#expect(card.activity == nil)
		#expect(card.firstAgentID == nil)
	}

	@Test("a loop that is gone is a deleted card; one in another workspace or not a loop stays a link")
	func loopGoneOrElsewhere() async {
		let objects = FakeDraftsRemote()
		objects.set(
			.success(
				ObjectDetail(object: WorkObject(id: loopID, type: "loop", title: "Far away", status: "learning"), workspaceId: "ws-2")),
			for: loopID)
		objects.set(
			.success(ObjectDetail(object: WorkObject(id: otherLoopID, type: "task", title: "Not a loop", status: "todo"), workspaceId: ws)),
			for: otherLoopID)
		let store = make(objects: objects)
		let gone = LinkedTarget(kind: .loop, uuid: missingID)
		let elsewhere = LinkedTarget(kind: .loop, uuid: loopID)
		let notALoop = LinkedTarget(kind: .loop, uuid: otherLoopID)
		await store.resolve([gone, elsewhere, notALoop])
		#expect(store.item(for: gone) == .deleted(gone))
		#expect(store.state(for: elsewhere) == .unavailable)
		#expect(store.state(for: notALoop) == .unavailable)
	}

	@Test("several loops and triggers in one message read each list once")
	func listsReadOnce() async {
		let calls = Calls()
		let store = make(loops: [summary(loopID), summary(otherLoopID)], triggers: [trigger()], calls: calls)
		await store.resolve([
			LinkedTarget(kind: .loop, uuid: loopID), LinkedTarget(kind: .loop, uuid: otherLoopID),
			LinkedTarget(kind: .trigger, uuid: triggerID),
		])
		#expect(calls.loops == 1)
		#expect(calls.triggers == 1)
	}

	// MARK: Trigger card

	@Test("a trigger in the list shows its name, On, when it fires in words and the agent, never the instruction")
	func triggerFromList() async {
		let store = make(triggers: [trigger()])
		let target = LinkedTarget(kind: .trigger, uuid: triggerID)
		await store.resolve([target])
		guard case .trigger(let card)? = store.item(for: target) else {
			Issue.record("not a trigger card: \(String(describing: store.state(for: target)))")
			return
		}
		#expect(card.displayName == "Close done tasks")
		#expect(card.badge == "On")
		#expect(card.whenItFires == "When task changes from any to done")
		#expect(card.agentID == "a-1")
		#expect(!card.whenItFires.contains("Secret"))
		#expect(card.kind.symbol == "bolt")
	}

	@Test("a trigger that is off reads Off")
	func triggerOff() async {
		let store = make(triggers: [trigger(enabled: false)])
		let target = LinkedTarget(kind: .trigger, uuid: triggerID)
		await store.resolve([target])
		guard case .trigger(let card)? = store.item(for: target) else {
			Issue.record("not a trigger card")
			return
		}
		#expect(card.badge == "Off")
	}

	@Test("the kind symbols are clock, bolt and bell")
	func triggerSymbols() {
		#expect(Trigger.Kind.cron.symbol == "clock")
		#expect(Trigger.Kind.event.symbol == "bolt")
		#expect(Trigger.Kind.reminder.symbol == "bell")
	}

	@Test("a trigger missing from a whole list is deleted; from a list cut short it stays a link")
	func triggerMissing() async {
		let target = LinkedTarget(kind: .trigger, uuid: missingID)
		let whole = make(triggers: [trigger()], complete: true)
		await whole.resolve([target])
		#expect(whole.item(for: target) == .deleted(target))
		let partial = make(triggers: [trigger()], complete: false)
		await partial.resolve([target])
		#expect(partial.state(for: target) == .unavailable)
		#expect(!partial.isCard(target))
		#expect(!partial.showsCard(target))
	}

	// MARK: Chips

	@Test("the link directory names a loop or trigger, says Deleted for a gone one, and stays silent while unknown")
	func directory() async {
		let store = make(loops: [summary(loopID)], triggers: [trigger()])
		let directory = InternalLinkDirectory(store: { store })
		#expect(directory.named(.loop, id: loopID) == nil)
		#expect(await eventually { directory.named(.loop, id: loopID) != nil })
		#expect(directory.named(.loop, id: loopID) == .init(title: "Weekly review", isDeleted: false))
		_ = directory.named(.trigger, id: triggerID)
		#expect(await eventually { directory.named(.trigger, id: triggerID) != nil })
		#expect(directory.named(.trigger, id: triggerID) == .init(title: "Close done tasks", isDeleted: false))
		_ = directory.named(.trigger, id: missingID)
		#expect(await eventually { directory.named(.trigger, id: missingID) != nil })
		#expect(directory.named(.trigger, id: missingID) == .init(title: nil, isDeleted: true))
		#expect(directory.named(.object, id: loopID) == nil)
	}

	@Test("a trigger that cannot be told apart from the list stays the kind word")
	func directoryChipOnly() async {
		let store = make(triggers: [], complete: false)
		let directory = InternalLinkDirectory(store: { store })
		_ = directory.named(.trigger, id: triggerID)
		try? await Task.sleep(for: .milliseconds(100))
		#expect(directory.named(.trigger, id: triggerID) == nil)
	}

	final class Clock: @unchecked Sendable {
		private let lock = NSLock()
		private var _now = Date(timeIntervalSince1970: 1000)
		private var _triggers: [Trigger] = []
		private var _reads = 0
		var now: Date { lock.withLock { _now } }
		var reads: Int { lock.withLock { _reads } }
		func advance(_ seconds: TimeInterval) { lock.withLock { _now = _now.addingTimeInterval(seconds) } }
		func set(_ triggers: [Trigger]) { lock.withLock { _triggers = triggers } }
		func read() -> [Trigger] { lock.withLock { _reads += 1; return _triggers } }
	}

	@Test("a trigger made after the list was read is found, not called deleted")
	func triggerMadeSinceTheRead() async {
		let clock = Clock()
		let store = LinkedItemStore(
			objects: FakeDraftsRemote(), files: FakeLinkedFiles(),
			triggers: { TriggerListing(triggers: clock.read(), isComplete: true) }, workspaceID: { "ws-1" }, retryAfter: 30,
			now: { clock.now })
		let other = LinkedTarget(kind: .trigger, uuid: missingID)
		await store.resolve([other])
		#expect(store.item(for: other) == .deleted(other))
		// The agent makes a trigger and links it ten seconds later: the held list does not have it.
		clock.set([trigger()])
		clock.advance(10)
		let target = LinkedTarget(kind: .trigger, uuid: triggerID)
		await store.resolve([target])
		guard case .trigger? = store.item(for: target) else {
			Issue.record("called deleted: \(String(describing: store.state(for: target)))")
			return
		}
		#expect(clock.reads == 2)
	}
}
