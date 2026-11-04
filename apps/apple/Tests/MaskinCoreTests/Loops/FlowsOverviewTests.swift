import Foundation
import Testing

@testable import MaskinCore

@Suite("FlowsOverview")
struct FlowsOverviewTests {
	@Test("the banner only exists while decisions wait on a running flow")
	func banner() {
		#expect(FlowsOverview.banner(loopRow("a")) == nil)
		#expect(FlowsOverview.banner(loopRow("a", waiting: 1)) == "1 decision waits on you")
		#expect(FlowsOverview.banner(loopRow("a", waiting: 3)) == "3 decisions wait on you")
		#expect(FlowsOverview.banner(loopRow("a", status: .paused, waiting: 3)) == nil)
	}

	@Test("the banner names the decision when its title is known")
	func bannerNamesDecision() {
		#expect(FlowsOverview.banner(loopRow("a", waiting: 1), decisionTitle: "Post text only?") == "Decide: Post text only?")
		#expect(
			FlowsOverview.banner(loopRow("a", waiting: 3), decisionTitle: "Post text only?")
				== "3 decisions waiting: Post text only?")
		#expect(FlowsOverview.banner(loopRow("a", waiting: 1), decisionTitle: "  ") == "1 decision waits on you")
		#expect(FlowsOverview.banner(loopRow("a"), decisionTitle: "Post text only?") == nil)
	}

	@Test("a decision post is called by its title, else the start of its text")
	func decisionTitle() {
		let titled = LoopPost(id: 1, actorID: nil, text: "Long body.", isDecision: true, decisionTitle: "Ship it?")
		let untitled = LoopPost(id: 2, actorID: nil, text: "Pick a brief. Then go.", isDecision: true)
		let plain = LoopPost(id: 3, actorID: nil, text: "FYI", isDecision: false)
		#expect(FlowsOverview.decisionTitle(from: titled) == "Ship it?")
		#expect(FlowsOverview.decisionTitle(from: untitled) == "Pick a brief. Then go.")
		#expect(FlowsOverview.decisionTitle(from: plain) == nil)
		#expect(FlowsOverview.decisionTitle(from: nil) == nil)
	}

	@Test("the overview strip counts only what the list carries")
	func kpis() {
		let busy = loopRow("a", waiting: 1, inProgress: 2, closed: 5)
		let idle = loopRow("b", inProgress: 1, closed: 0)
		let paused = loopRow("c", status: .paused, waiting: 4, inProgress: 0, closed: 0)
		let stats = FlowsOverview.kpis([busy, idle, paused])
		#expect(stats.map(\.label) == ["Need you", "Running", "In progress", "Closed"])
		#expect(stats.map(\.value) == ["1", "2 of 3", "3", "5"])
		#expect(FlowsOverview.kpis([]).isEmpty)
	}

	@Test("the work line leaves out what is zero")
	func workLine() {
		#expect(FlowsOverview.workLine(loopRow("a", inProgress: 0, closed: 0)) == nil)
		#expect(FlowsOverview.workLine(loopRow("a", inProgress: 2, closed: 0)) == "2 in progress")
		#expect(FlowsOverview.workLine(loopRow("a", inProgress: 2, closed: 5)) == "2 in progress · 5 closed")
	}

	@Test("figures come from the most urgent target and are nil without one")
	func figures() {
		var loop = loopRow("a")
		#expect(FlowsOverview.figures(loop) == nil)
		loop.targets = [
			LoopTarget(label: "Shipped", actual: 8, target: 8),
			LoopTarget(label: "Merged per week", actual: 3, target: 8),
		]
		let figures = FlowsOverview.figures(loop)
		#expect(figures?.label == "Merged per week")
		#expect(figures?.value == "3 of 8")
		#expect(figures?.status == .atRisk)
		#expect(figures?.fraction == 0.375)
	}

	@Test("tags are distinct, case-insensitive and sorted")
	func tags() {
		var a = loopRow("a"), b = loopRow("b")
		a.tags = ["product", "Engineering", " "]
		b.tags = ["engineering", "alpha"]
		#expect(FlowTags.all([a, b, loopRow("c")]) == ["alpha", "Engineering", "product"])
		#expect(FlowTags.has(a, "ENGINEERING"))
		#expect(!FlowTags.has(b, "product"))
	}

	@Test("the tag chip narrows the list")
	@MainActor func tagFilter() async {
		var a = loopRow("a"), b = loopRow("b")
		a.tags = ["product"]
		b.tags = ["sales"]
		let store = LoopsStore(api: FakeLoopsAPI([a, b]), events: nil)
		await store.start()
		#expect(store.tags == ["product", "sales"])
		store.tagFilter = "sales"
		#expect(store.filtered().map(\.id) == ["b"])
		store.tagFilter = nil
		#expect(store.filtered().count == 2)
	}

	@Test("stages map to loop statuses and back")
	func stages() {
		for stage in LoopStage.allCases { #expect(LoopStage(status: stage.status) == stage) }
		#expect(LoopStage(status: .paused) == nil)
		#expect(LoopStage(status: .draft) == nil)
	}

	@Test("changing the stage updates the status at once, and rolls back when refused")
	@MainActor func setStage() async {
		let api = FakeLoopsAPI([loopRow("a", status: .learning)])
		let store = LoopDetailStore(loop: loopRow("a", status: .learning), api: api, events: nil)
		await store.setStage(.autonomous)
		#expect(store.loop.status == .fullyAutonomous)
		#expect(await api.statusCalls.map(\.1) == [.fullyAutonomous])
		await api.setFailStatus(true)
		await store.setStage(.supervised)
		#expect(store.loop.status == .fullyAutonomous)
		#expect(store.notice?.contains("Couldn't change the stage") == true)
	}

	@Test("a paused flow ignores a stage tap")
	@MainActor func pausedIgnoresStage() async {
		let api = FakeLoopsAPI([loopRow("a", status: .paused)])
		let store = LoopDetailStore(loop: loopRow("a", status: .paused), api: api, events: nil)
		await store.setStage(.learning)
		#expect(store.loop.status == .paused)
		#expect(await api.statusCalls.isEmpty)
	}
}

@Suite("FlowTargetSource")
struct FlowTargetSourceTests {
	@Test("words show, machine ids and blanks do not")
	func label() {
		#expect(FlowTargetSource.label("Tasks") == "Tasks")
		#expect(FlowTargetSource.label("  Tasks  ") == "Tasks")
		#expect(FlowTargetSource.label("metric:tasks.merged") == nil)
		#expect(FlowTargetSource.label("event:session-completed") == nil)
		#expect(FlowTargetSource.label("  ") == nil)
		#expect(FlowTargetSource.label(nil) == nil)
	}
}

@Suite("Flow driver")
struct FlowDriverTests {
	@Test("the driver is the overview's driver, named from the directory")
	@MainActor func driver() async {
		let api = FakeLoopsAPI([loopRow("a")])
		await api.setOverview(LoopOverview(members: [], posts: [], outputs: [], statusOrder: [], driverID: "agent-1"))
		let store = LoopDetailStore(
			loop: loopRow("a"), directory: ActorDirectory([AutomationActor(id: "agent-1", name: "Developer", isAgent: true)]),
			api: api, events: nil)
		#expect(store.driver == nil)
		await store.start()
		#expect(store.driver?.name == "Developer")
		#expect(store.driver?.id == "agent-1")
	}
}
