import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class RecordingCycleHost: CycleActivityHosting {
	var started: [String] = []
	var updated: [String] = []
	var ended: [String] = []
	func start(flowId: String, workspaceId: String, state: CycleActivityState) { started.append(flowId) }
	func update(flowId: String, state: CycleActivityState) async { updated.append(flowId) }
	func end(flowId: String) async { ended.append(flowId) }
}

@MainActor
@Suite("Cycle activity planner and controller")
struct CycleActivityControllerTests {
	private func flow(_ id: String, status: LoopPill = .supervised, closed: Int = 2, inProgress: Int = 3) -> LoopSummary {
		LoopSummary(id: id, name: "Flow \(id)", status: status, inProgressCount: inProgress, closedCount: closed)
	}

	@Test func aFlowThatIsNotFollowedGetsNoCard() {
		let plan = CycleActivityPlanner.plan(loops: [flow("a")], needsYou: { _ in false }, optedIn: [], active: [:])
		#expect(plan.isEmpty)
	}

	@Test func aFollowedRunningFlowStartsAtItsNextCycle() {
		let plan = CycleActivityPlanner.plan(loops: [flow("a")], needsYou: { _ in false }, optedIn: ["a"], active: [:])
		guard case .start(let id, let state) = plan.first else { Issue.record("expected a start"); return }
		#expect(id == "a")
		#expect(state.cycle == 3)
		#expect(state.phase == .running)
	}

	@Test func aPausedFlowEndsItsCard() {
		let running = CycleActivityPlanner.state(for: flow("a"), needsYou: false)
		let plan = CycleActivityPlanner.plan(
			loops: [flow("a", status: .paused)], needsYou: { _ in false }, optedIn: ["a"], active: ["a": running])
		#expect(plan == [.end(flowId: "a")])
	}

	@Test func aFlowThatTurnsToYouUpdatesToNeedsYou() {
		let running = CycleActivityPlanner.state(for: flow("a"), needsYou: false)
		let plan = CycleActivityPlanner.plan(
			loops: [flow("a")], needsYou: { _ in true }, optedIn: ["a"], active: ["a": running])
		guard case .update(_, let state) = plan.first else { Issue.record("expected an update"); return }
		#expect(state.phase == .needsYou)
	}

	@Test func anUnchangedFlowDoesNothing() {
		let running = CycleActivityPlanner.state(for: flow("a"), needsYou: false)
		let plan = CycleActivityPlanner.plan(
			loops: [flow("a")], needsYou: { _ in false }, optedIn: ["a"], active: ["a": running])
		#expect(plan.isEmpty)
	}

	@Test func theControllerStartsOnceThenEndsWhenUnfollowed() async {
		let host = RecordingCycleHost()
		let controller = CycleActivityController(host: host, storage: InMemoryCycleOptInStorage())
		await controller.workspaceChanged("ws")
		controller.sync(loops: [flow("a")], needsYou: { _ in false })
		controller.setOn(true, flowId: "a")
		controller.sync(loops: [flow("a")], needsYou: { _ in false })
		#expect(host.started == ["a"])
		controller.setOn(false, flowId: "a")
		await Task.yield()
		await Task.yield()
		#expect(host.ended == ["a"])
	}

	@Test func theOptInIsRemembered() {
		let storage = InMemoryCycleOptInStorage()
		let first = CycleActivityController(host: RecordingCycleHost(), storage: storage)
		first.setOn(true, flowId: "a")
		let second = CycleActivityController(host: RecordingCycleHost(), storage: storage)
		#expect(second.isOn("a"))
	}
}

@MainActor
private final class RecordingMeetingHost: MeetingActivityHosting {
	var started = 0
	var updates: [Bool] = []
	var ended = 0
	func start(meetingId: String, workspaceId: String, conversationId: String?, state: MeetingActivityState) { started += 1 }
	func update(state: MeetingActivityState) async { updates.append(state.muted) }
	func end() async { ended += 1 }
}

@MainActor
@Suite("Meeting activity controller")
struct MeetingActivityControllerTests {
	@Test func followsTheCallFromStartToEnd() async {
		let host = RecordingMeetingHost()
		let controller = MeetingActivityController(host: host)
		controller.callStarted(
			meetingId: "m", workspaceId: "ws", conversationId: "c", name: "Chief of Staff", startedAt: .now, kind: .adHoc)
		#expect(controller.isShowing)
		controller.muteChanged(true)
		controller.muteChanged(true)
		controller.callEnded()
		await Task.yield()
		await Task.yield()
		#expect(host.started == 1)
		#expect(host.updates == [true])
		#expect(host.ended == 1)
		#expect(!controller.isShowing)
	}

	@Test func theCallControlOnlyActsWhileACallIsRegistered() {
		let control = MeetingCallControl()
		var muted = 0
		control.performToggleMute()
		#expect(muted == 0)
		control.register(toggleMute: { muted += 1 }, hangUp: {})
		control.performToggleMute()
		#expect(muted == 1)
		control.clear()
		control.performToggleMute()
		#expect(muted == 1)
	}
}
