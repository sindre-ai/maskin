import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class RecordingCallHost: CallActivityHosting {
	var areActivitiesEnabled = true
	var started: [LiveCallActivityState] = []
	var updates: [LiveCallActivityState] = []
	var endedAll = 0
	func start(
		callId: String, agentName: String, workspaceId: String, conversationId: String?,
		state: LiveCallActivityState
	) { started.append(state) }
	func update(state: LiveCallActivityState) async { updates.append(state) }
	func endAll() async { endedAll += 1 }
}

private let t0 = Date(timeIntervalSince1970: 1_000_000)

private func snap(
	_ phase: LiveVoicePhase = .listening, muted: Bool = false, _ connection: LiveCallConnection = .connected,
	failed: Bool = false
) -> LiveCallSnapshot {
	LiveCallSnapshot(voicePhase: phase, isMuted: muted, connection: connection, failed: failed)
}

@MainActor
private func settle() async {
	for _ in 0..<4 { await Task.yield() }
}

@Suite("Call activity state mapping")
struct CallActivityMappingTests {
	@Test func mapsTheVoicePhase() {
		#expect(snap(.listening).activityPhase == .listening)
		#expect(snap(.thinking).activityPhase == .thinking)
		#expect(snap(.speaking).activityPhase == .speaking)
	}

	@Test func mutedBeatsWhatTheAgentIsDoing() {
		#expect(snap(.speaking, muted: true).activityPhase == .muted)
	}

	@Test func connectionBeatsEverythingButKeepsTheMuteFlag() {
		let connecting = snap(.speaking, muted: true, .connecting).state(startedAt: t0)
		#expect(connecting.phase == .connecting)
		let reconnecting = snap(.listening, muted: true, .reconnecting).state(startedAt: t0)
		#expect(reconnecting.phase == .reconnecting)
		#expect(reconnecting.isMuted)
	}

	@Test func statusLinesAreHumanText() {
		#expect(LiveCallActivityState.Phase.listening.statusText == "Listening")
		#expect(LiveCallActivityState.Phase.speaking.statusText == "Speaking")
		#expect(LiveCallActivityState.Phase.muted.statusText == "Muted")
	}

	@Test func stateRoundTripsThroughJSON() throws {
		let state = snap(.thinking).state(startedAt: t0)
		let back = try JSONDecoder().decode(LiveCallActivityState.self, from: JSONEncoder().encode(state))
		#expect(back == state)
	}
}

@MainActor
@Suite("Call activity controller")
struct CallActivityControllerTests {
	private func start(_ controller: CallActivityController, _ snapshot: LiveCallSnapshot = snap()) {
		controller.callStarted(
			callId: "c1", agentName: "Relay", workspaceId: "ws", conversationId: "chat", startedAt: t0,
			snapshot: snapshot)
	}

	@Test func startsWhenTheCallStartsAndEndsWhenItEnds() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host)
		start(controller)
		#expect(controller.isShowing)
		#expect(host.started.count == 1)
		controller.callEnded()
		await settle()
		#expect(host.endedAll == 1)
		#expect(!controller.isShowing)
	}

	@Test func aMuteChangeLandsAtOnceEvenInsideTheRateLimit() async {
		let host = RecordingCallHost()
		var clock = t0
		let controller = CallActivityController(host: host, minInterval: 60, now: { clock })
		start(controller)
		clock = clock.addingTimeInterval(1)
		controller.sync(snap(muted: true), immediate: true)
		await settle()
		#expect(host.updates.map(\.isMuted) == [true])
	}

	@Test func phaseChangesInsideTheIntervalAreHeldAndTheLastOneLands() async throws {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host, minInterval: 0.05)
		start(controller)
		controller.sync(snap(.thinking))
		controller.sync(snap(.speaking))
		await settle()
		#expect(host.updates.isEmpty)
		try await Task.sleep(for: .milliseconds(200))
		#expect(host.updates.map(\.phase) == [.speaking])
	}

	@Test func anUnchangedStateSendsNothing() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host, minInterval: 0)
		start(controller)
		controller.sync(snap())
		await settle()
		#expect(host.updates.isEmpty)
	}

	@Test func muteWhileReconnectingKeepsTheCardReconnectingButFlipsTheButton() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host, minInterval: 0)
		start(controller, snap(.listening, .reconnecting))
		controller.sync(snap(.listening, muted: true, .reconnecting), immediate: true)
		await settle()
		#expect(host.updates.count == 1)
		#expect(host.updates[0].phase == .reconnecting)
		#expect(host.updates[0].isMuted)
	}

	@Test func aFailedCallEndsTheCard() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host)
		start(controller)
		controller.sync(snap(failed: true))
		await settle()
		#expect(host.endedAll == 1)
		#expect(!controller.isShowing)
	}

	@Test func nothingStartsWhenLiveActivitiesAreOff() async {
		let host = RecordingCallHost()
		host.areActivitiesEnabled = false
		let controller = CallActivityController(host: host, minInterval: 0)
		start(controller)
		controller.sync(snap(muted: true), immediate: true)
		await settle()
		#expect(host.started.isEmpty)
		#expect(host.updates.isEmpty)
		#expect(!controller.isShowing)
	}

	@Test func aSecondCallWhileOneIsUpIsIgnored() {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host)
		start(controller)
		start(controller)
		#expect(host.started.count == 1)
	}

	@Test func aCardTheSystemEndedStaysGoneForTheRestOfTheCall() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host, minInterval: 0)
		start(controller)
		controller.cardRemoved()
		controller.sync(snap(muted: true), immediate: true)
		await settle()
		#expect(!controller.isShowing)
		#expect(host.updates.isEmpty)
		controller.callEnded()
		start(controller)
		#expect(host.started.count == 2)
	}

	@Test func staleCardsAreEndedAtLaunchButNotDuringACall() async {
		let host = RecordingCallHost()
		let controller = CallActivityController(host: host)
		await controller.endStaleCards()
		#expect(host.endedAll == 1)
		start(controller)
		await controller.endStaleCards()
		#expect(host.endedAll == 1)
	}
}

@MainActor
@Suite("Call control")
struct LiveCallControlTests {
	@Test func runsTheActionsOnTheRegisteredCall() {
		let control = LiveCallControl()
		var muted = 0
		var hungUp = 0
		control.register(toggleMute: { muted += 1 }, hangUp: { hungUp += 1 })
		#expect(control.perform(.toggleMute) == .performed)
		#expect(control.perform(.hangUp) == .performed)
		#expect(muted == 1)
		#expect(hungUp == 1)
	}

	@Test func withNoLiveCallItDoesNothingAndSaysSo() {
		let control = LiveCallControl()
		#expect(control.perform(.toggleMute) == .noLiveCall)
		var hungUp = 0
		control.register(toggleMute: {}, hangUp: { hungUp += 1 })
		control.clear()
		#expect(control.perform(.hangUp) == .noLiveCall)
		#expect(hungUp == 0)
	}
}
