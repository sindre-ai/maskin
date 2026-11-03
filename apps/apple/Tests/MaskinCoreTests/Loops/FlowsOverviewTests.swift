import Foundation
import Testing

@testable import MaskinCore

@Suite("FlowsOverview")
struct FlowsOverviewTests {
	@Test("the lead counts running flows that need the viewer")
	func lead() {
		let rows = [
			loopRow("a", waiting: 1), loopRow("b"), loopRow("c", waiting: 2), loopRow("d", status: .paused, waiting: 3),
		]
		#expect(FlowsOverview.lead(rows) == "2 of 4 flows need you.")
		#expect(FlowsOverview.lead([loopRow("a", waiting: 1), loopRow("b")]) == "1 of 2 flows needs you.")
		#expect(FlowsOverview.lead([loopRow("a")]) == "Nothing needs you right now.")
		#expect(FlowsOverview.lead([loopRow("a", waiting: 1)]) == "1 flow needs you.")
		#expect(FlowsOverview.lead([]) == nil)
	}

	@Test("the banner only exists while decisions wait on a running flow")
	func banner() {
		#expect(FlowsOverview.banner(loopRow("a")) == nil)
		#expect(FlowsOverview.banner(loopRow("a", waiting: 1)) == "1 decision waits on you")
		#expect(FlowsOverview.banner(loopRow("a", waiting: 3)) == "3 decisions wait on you")
		#expect(FlowsOverview.banner(loopRow("a", status: .paused, waiting: 3)) == nil)
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
