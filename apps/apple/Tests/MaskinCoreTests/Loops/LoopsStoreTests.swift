import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("LoopsStore")
struct LoopsStoreTests {
	@Test("the list keeps the API order and flags loops that need you")
	func flatList() async {
		let api = FakeLoopsAPI([
			loopRow("a", status: .paused), loopRow("b", status: .supervised, waiting: 2),
			loopRow("c", status: .learning), loopRow("d", status: .draft),
		])
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		#expect(store.filtered().map(\.id) == ["a", "b", "c", "d"])
		#expect(store.filtered().filter(store.needsYou).map(\.id) == ["b"])
		#expect(store.waitingCount == 2)
	}

	@Test("the subtitle counts running loops and those that need you")
	func summaryLine() async {
		let store = LoopsStore(
			api: FakeLoopsAPI([
				loopRow("a"), loopRow("b", status: .supervised, waiting: 1), loopRow("c", status: .paused),
			]), events: nil)
		await store.start()
		#expect(store.summaryLine == "Two outcomes in motion. One needs you.")
	}

	@Test("search filters by name")
	func search() async {
		let store = LoopsStore(
			api: FakeLoopsAPI([loopRow("a", name: "Sales rep"), loopRow("b", name: "Inbox triage")]),
			events: nil)
		await store.start()
		#expect(store.filtered(query: "triage").map(\.id) == ["b"])
	}

	@Test("an untitled loop gets a plain name")
	func untitled() {
		#expect(loopRow("a", name: nil).displayName == "Untitled flow")
		#expect(loopRow("a", name: "  ").displayName == "Untitled flow")
	}

	@Test("agent names resolve through the directory and skip unknown ids")
	func agentNames() async {
		let store = LoopsStore(
			api: FakeLoopsAPI([loopRow("a", agents: ["agent-1", "agent-2", "ghost"])]), events: nil)
		await store.start()
		#expect(store.agentNames(for: store.loops[0]) == ["Relay", "Forge"])
	}

	@Test("a failed first load reports the error")
	func failure() async {
		let api = FakeLoopsAPI([])
		await api.setFailLoops(true)
		let store = LoopsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.phase == .failed("offline"))
	}

	@Test("pausing is optimistic and resuming goes back to learning")
	func pauseResume() async {
		let api = FakeLoopsAPI([loopRow("a", status: .supervised)])
		await api.setStatusDelay(.milliseconds(80))
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		let task = Task { await store.togglePause("a") }
		#expect(await eventually { store.loop(id: "a")?.status == .paused })
		await task.value
		#expect(store.loop(id: "a")?.pill == .paused)
		await store.togglePause("a")
		#expect(store.loop(id: "a")?.status == .learning)
		let calls = await api.statusCalls
		#expect(calls.map(\.1) == [.paused, .learning])
	}

	@Test("a refused pause rolls back and explains")
	func pauseRollback() async {
		let api = FakeLoopsAPI([loopRow("a", status: .learning, waiting: 1)])
		await api.setFailStatus(true)
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		await store.togglePause("a")
		#expect(store.loop(id: "a")?.status == .learning)
		#expect(store.loop(id: "a")?.pill == .waitingOnYou)
		#expect(store.notice?.contains("Couldn't pause") == true)
	}

	@Test("resuming a loop with unread work shows needs you again")
	func resumeWaiting() {
		let paused = loopRow("a", status: .paused, waiting: 3)
		#expect(paused.with(status: .learning).pill == .waitingOnYou)
		#expect(paused.pill == .paused)
	}

	@Test("a refresh during a pending pause does not undo it")
	func refreshKeepsPending() async {
		let api = FakeLoopsAPI([loopRow("a", status: .learning)])
		await api.setStatusDelay(.milliseconds(150))
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		let task = Task { await store.togglePause("a") }
		#expect(await eventually { store.loop(id: "a")?.status == .paused })
		await store.refresh()
		#expect(store.loop(id: "a")?.status == .paused)
		await task.value
	}

	@Test("installs are keyed by the loop object id")
	func installs() async {
		let api = FakeLoopsAPI([loopRow("a")])
		await api.setInstalls([
			LoopInstall(objectID: "a", hasUpdate: true, availableVersion: "2.0", isForked: false),
			LoopInstall(objectID: nil, hasUpdate: true, availableVersion: "1.1", isForked: false),
		])
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		#expect(store.installs["a"]?.hasUpdate == true)
		#expect(store.installs.count == 1)
	}

	@Test("an object event reloads the list")
	func liveReload() async {
		let api = FakeLoopsAPI([loopRow("a")])
		let hub = scriptedHub([objectFrame(1)])
		let store = LoopsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		await api.set([loopRow("a"), loopRow("b")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.loops.count == 2 })
		store.stop()
	}

	@Test("unrelated entity events do not reload")
	func ignoresOthers() async {
		let api = FakeLoopsAPI([loopRow("a")])
		let hub = scriptedHub([objectFrame(1, entity: "conversation")])
		let store = LoopsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		let before = await api.loopCalls
		hub.connect(workspaceId: "w1")
		try? await Task.sleep(for: .milliseconds(150))
		// The scripted stream closes after its frame and reconnects once, which reloads once.
		#expect(await api.loopCalls <= before + 1)
		store.stop()
	}

	@Test("the list reloads after the stream reconnects")
	func reconnect() async {
		let api = FakeLoopsAPI([loopRow("a")])
		let hub = scriptedHub([objectFrame(1, entity: "note"), ""])
		let store = LoopsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		await api.set([loopRow("a"), loopRow("b"), loopRow("c")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.loops.count == 3 })
		store.stop()
	}
}

@MainActor
@Suite("LoopDetailStore")
struct LoopDetailStoreTests {
	private func make(
		status: LoopPill = .supervised
	) async -> (LoopDetailStore, FakeLoopsAPI) {
		let row = loopRow("a", status: status)
		let api = FakeLoopsAPI([row])
		await api.setSteps([
			LoopStep(triggerID: "t1", name: "Triage", agentName: "Relay", handsOffName: "Forge"),
			LoopStep(triggerID: "t2", name: nil),
		])
		await api.setFeed([
			LoopActivityEntry(id: "2", action: "session_completed", entityType: "session", actorID: "agent-1"),
			LoopActivityEntry(id: "1", action: "trigger_fired", entityType: "trigger", description: "Fired Triage"),
		])
		return (LoopDetailStore(loop: row, api: api, events: nil), api)
	}

	@Test("loads steps and activity, resolving actor names")
	func loads() async {
		let (store, _) = await make()
		await store.start()
		#expect(store.phase == .loaded)
		#expect(store.steps.count == 2)
		#expect(store.steps[1].displayName == "Untitled step")
		#expect(store.actorName(store.activity[0]) == "Relay")
		#expect(store.actorName(store.activity[1]) == nil)
	}

	@Test("activity titles use the server description, else plain words")
	func activityTitles() async {
		let (store, _) = await make()
		await store.start()
		#expect(store.activity.map(\.title) == ["Session finished", "Fired Triage"])
		#expect(LoopActivityEntry(id: "x", action: "custom_thing", entityType: "x").title == "Custom thing")
	}

	@Test("pause is optimistic and rolls back on failure")
	func pause() async {
		let (store, api) = await make()
		await store.start()
		await api.setFailStatus(true)
		await store.togglePause()
		#expect(store.loop.status == .supervised)
		#expect(store.notice?.contains("Couldn't pause") == true)
		await api.setFailStatus(false)
		await store.togglePause()
		#expect(store.loop.status == .paused)
		#expect(!store.isTogglingPause)
	}

	@Test("a loop that disappears marks the screen gone")
	func gone() async {
		let (store, api) = await make()
		await api.set([])
		await store.refresh()
		#expect(store.isGone)
	}

	@Test("an event for a related entity refreshes the feed")
	func live() async {
		let (store, api) = await make()
		let hub = scriptedHub([objectFrame(1, entity: "session")])
		let live = LoopDetailStore(loop: store.loop, api: api, events: hub, debounce: .zero, sleep: { _ in })
		await live.start()
		await api.setFeed([LoopActivityEntry(id: "3", action: "session_failed", entityType: "session")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { live.activity.first?.id == "3" })
		live.stop()
	}

	@Test("a failed load with nothing on screen reports the error")
	func failure() async {
		let (store, api) = await make()
		await api.setFailLoops(true)
		await store.refresh()
		#expect(store.phase == .failed("offline"))
	}

	@Test("step summaries describe the trigger in words")
	func stepSummary() {
		let step = LoopStep(
			triggerID: "t", name: "x", triggerKind: .cron,
			triggerConfig: .object(["expression": .string("0 17 * * 0")]))
		#expect(step.firesSummary == "Runs every Sunday at 5:00 PM UTC")
	}
}

@Suite("Loops store latest updates")
@MainActor
struct LoopsLatestUpdateTests {
	private func post(_ text: String, by actor: String? = "agent-1") -> LoopPost {
		LoopPost(id: 1, actorID: actor, text: text, date: Date())
	}

	@Test("the newest post of a running flow becomes its card line, with the author resolved")
	func loadsLine() async {
		let api = FakeLoopsAPI([loopRow("a")])
		await api.setPost(post("Scored the week's leads."), for: "a")
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		await store.loadLatestUpdates()
		let line = store.latestUpdate(for: store.loops[0])
		#expect(line?.text == "Scored the week's leads.")
		#expect(line?.author != nil)
	}

	@Test("only the ten most recently touched non-draft flows are read")
	func bounded() async {
		var rows: [LoopSummary] = []
		for i in 0..<14 {
			var row = loopRow("l\(i)")
			row.updatedAt = Date(timeIntervalSince1970: Double(1000 + i))
			rows.append(row)
		}
		rows.append(loopRow("draft", status: .draft))
		let api = FakeLoopsAPI(rows)
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		await store.loadLatestUpdates()
		let called = await api.postCalls
		#expect(Set(called).count == LoopsStore.latestUpdateBound)
		#expect(!called.contains("draft"))
		#expect(!called.contains("l0"))
		#expect(called.contains("l13"))
	}

	@Test("a flow is not read again until it changes, and a failed read is retried")
	func cachedUntilChanged() async {
		var row = loopRow("a")
		row.updatedAt = Date(timeIntervalSince1970: 1000)
		let api = FakeLoopsAPI([row])
		await api.setPost(post("First."), for: "a")
		let store = LoopsStore(api: api, events: nil)
		await store.start()
		await store.loadLatestUpdates()
		await store.loadLatestUpdates()
		#expect(await api.postCalls.filter { $0 == "a" }.count == 1)

		row.updatedAt = Date(timeIntervalSince1970: 2000)
		await api.set([row])
		await api.setPost(post("Second."), for: "a")
		await store.refresh()
		await store.loadLatestUpdates()
		#expect(store.latestUpdate(for: store.loops[0])?.text == "Second.")

		row.updatedAt = Date(timeIntervalSince1970: 3000)
		await api.set([row])
		await api.setFailPosts(["a"])
		await store.refresh()
		await store.loadLatestUpdates()
		#expect(store.latestUpdate(for: store.loops[0])?.text == "Second.")
	}
}

@MainActor
@Suite("Loop tags")
struct LoopTagsTests {
	private func store(_ loops: [LoopSummary]) async -> LoopsStore {
		let store = LoopsStore(api: FakeLoopsAPI(loops), events: nil)
		await store.start()
		return store
	}

	@Test("tags are listed most common first, then alphabetically")
	func order() async {
		let s = await store([
			LoopSummary(id: "1", name: "A", tags: ["Sales", "EMEA"]),
			LoopSummary(id: "2", name: "B", tags: ["Sales"]),
			LoopSummary(id: "3", name: "C", tags: ["Ops"]),
		])
		#expect(s.allTags == ["Sales", "EMEA", "Ops"])
	}

	@Test("choosing a tag narrows the list to loops carrying it")
	func filter() async {
		let s = await store([
			LoopSummary(id: "1", name: "A", status: .learning, tags: ["Sales"]),
			LoopSummary(id: "2", name: "B", status: .learning, tags: ["Ops"]),
			LoopSummary(id: "3", name: "C", status: .learning),
		])
		#expect(s.filtered().count == 3)
		s.selectedTag = "Sales"
		#expect(s.filtered().map(\.id) == ["1"])
		s.selectedTag = nil
		#expect(s.filtered().count == 3)
	}
}

@Suite("Loop progress ring")
struct LoopProgressTests {
	@Test("the ring is the share of work that has closed, and empty with no work")
	func ring() {
		#expect(LoopSummary(id: "a", name: "A").ringProgress == 0)
		#expect(LoopSummary(id: "b", name: "B", inProgressCount: 3, closedCount: 1).ringProgress == 0.25)
		#expect(LoopSummary(id: "c", name: "C", inProgressCount: 0, closedCount: 5).ringProgress == 1)
	}
}
