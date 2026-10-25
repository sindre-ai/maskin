import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private final class Clock: @unchecked Sendable {
	private let lock = NSLock()
	private var value: Date
	init(_ value: Date) { self.value = value }
	var now: Date { lock.withLock { value } }
	func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

private final class Sent: @unchecked Sendable {
	private let lock = NSLock()
	private(set) var records: [WidgetDecisionRecord] = []
	func add(_ r: WidgetDecisionRecord) { lock.withLock { records.append(r) } }
}

private func decision(
	id: String = "o1", eventId: Int? = 42, options: [String] = ["Send all 7", "Hold"],
	recommended: String? = "Send all 7", confirm: [String] = []
) -> WidgetSnapshot.Decision {
	WidgetSnapshot.Decision(
		objectId: id, title: "Send follow-ups?", agentName: "Chief of Staff", optionLabels: options,
		recommendedLabel: recommended, since: t0, eventId: eventId, confirmLabels: confirm)
}

private func service(
	clock: Clock, sent: Sent, outcome: NotificationActionOutcome = .answered("x"),
	store: InMemoryWidgetDecisionStore = InMemoryWidgetDecisionStore()
) -> WidgetDecisionService {
	WidgetDecisionService(
		store: store, undoWindow: 8, now: { clock.now },
		sleep: { clock.advance($0) },
		send: { record in
			sent.add(record)
			return outcome
		})
}

@Suite("Widget decisions")
struct WidgetDecisionTests {
	@Test func primaryIsTheRecommendationAndHoldComesSecond() {
		let d = decision(options: ["Edit", "Hold a week", "Ship it"], recommended: "Ship it")
		#expect(d.primaryLabel == "Ship it")
		#expect(d.secondaryLabel == "Hold a week")
	}

	@Test func holdAndConfirmOptionsOpenTheAppInsteadOfActing() {
		let d = decision(options: ["Send all 7", "Hold", "Charge cards"], confirm: ["Charge cards"])
		#expect(d.decidesInPlace("Send all 7"))
		#expect(!d.decidesInPlace("Hold"))
		#expect(!d.decidesInPlace("Charge cards"))
		#expect(!decision(eventId: nil).decidesInPlace("Send all 7"))
	}

	@Test func chooseHoldsThenSettleSendsAfterTheWindow() async throws {
		let clock = Clock(t0)
		let sent = Sent()
		let svc = service(clock: clock, sent: sent)
		let record = try #require(svc.choose(decision(), label: "Send all 7", workspaceId: "ws"))
		#expect(record.phase == .held)
		#expect(sent.records.isEmpty)
		await svc.settle(objectId: "o1")
		#expect(sent.records.map(\.label) == ["Send all 7"])
		#expect(svc.shown().first?.phase == .sent)
	}

	@Test func undoInsideTheWindowSendsNothing() async throws {
		let clock = Clock(t0)
		let sent = Sent()
		let svc = service(clock: clock, sent: sent)
		_ = svc.choose(decision(), label: "Send all 7", workspaceId: "ws")
		#expect(svc.undo(objectId: "o1"))
		await svc.settle(objectId: "o1")
		#expect(sent.records.isEmpty)
		#expect(svc.shown().isEmpty)
	}

	@Test func undoAfterTheSendIsRefused() async {
		let clock = Clock(t0)
		let svc = service(clock: clock, sent: Sent())
		_ = svc.choose(decision(), label: "Send all 7", workspaceId: "ws")
		await svc.settle(objectId: "o1")
		#expect(!svc.undo(objectId: "o1"))
	}

	@Test func aSecondTapOnTheSameDecisionIsIgnored() {
		let svc = service(clock: Clock(t0), sent: Sent())
		#expect(svc.choose(decision(), label: "Send all 7", workspaceId: "ws") != nil)
		#expect(svc.choose(decision(), label: "Hold", workspaceId: "ws") == nil)
	}

	@Test func flushDueSendsAnAnswerThatAKilledProcessLeftHeld() async {
		let clock = Clock(t0)
		let sent = Sent()
		let store = InMemoryWidgetDecisionStore()
		let svc = service(clock: clock, sent: sent, store: store)
		_ = svc.choose(decision(), label: "Send all 7", workspaceId: "ws")
		await svc.flushDue()
		#expect(sent.records.isEmpty)
		clock.advance(9)
		await svc.flushDue()
		await svc.flushDue()
		#expect(sent.records.count == 1)
	}

	@Test func aFailedSendKeepsTheReasonAndReturnsTheDecisionToTheList() async throws {
		let clock = Clock(t0)
		let svc = service(clock: clock, sent: Sent(), outcome: .failed("Offline"))
		_ = svc.choose(decision(), label: "Send all 7", workspaceId: "ws")
		await svc.settle(objectId: "o1")
		let record = try #require(svc.shown().first)
		#expect(record.phase == .failed)
		#expect(record.message == "Offline")
		#expect(!record.hidesDecision)
		// A failed answer can be tried again.
		#expect(svc.choose(decision(), label: "Send all 7", workspaceId: "ws") != nil)
	}

	@Test func answeredDecisionsDropOutOfTheSnapshot() {
		let snapshot = WidgetSnapshot(
			actorId: "a", workspaceId: "ws", needsCount: 3,
			decisions: [decision(id: "o1"), decision(id: "o2")], unreadCount: 0, updatedAt: t0)
		let record = WidgetDecisionRecord(
			objectId: "o1", workspaceId: "ws", title: "t", label: "x", agentName: nil, eventId: 1,
			decidedAt: t0, sendAt: t0, phase: .sent)
		guard case .content(let after) = WidgetState.content(snapshot).applying([record]) else {
			Issue.record("expected content")
			return
		}
		#expect(after.needsCount == 2)
		#expect(after.decisions.map(\.objectId) == ["o2"])
	}

	@Test func theChosenCardExpiresAfterAnHourAndAFailureAfterFive() {
		var r = WidgetDecisionRecord(
			objectId: "o", workspaceId: "ws", title: "t", label: "x", agentName: nil, eventId: 1,
			decidedAt: t0, sendAt: t0.addingTimeInterval(8), phase: .sent)
		#expect(r.isShown(at: t0.addingTimeInterval(3_599)))
		#expect(!r.isShown(at: t0.addingTimeInterval(3_601)))
		r.phase = .failed
		#expect(!r.isShown(at: t0.addingTimeInterval(301)))
	}

	@Test func olderCachesWithoutTheNewFieldsStillDecode() throws {
		let json = #"{"objectId":"o","title":"T","optionLabels":["A"]}"#
		let d = try JSONDecoder().decode(WidgetSnapshot.Decision.self, from: Data(json.utf8))
		#expect(d.eventId == nil && d.confirmLabels.isEmpty)
		#expect(!d.decidesInPlace("A"))
	}

	@Test func fileStoreRoundTrips() throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent("wd-\(UUID().uuidString).json")
		defer { try? FileManager.default.removeItem(at: url) }
		let store = FileWidgetDecisionStore(fileURL: url)
		let r = WidgetDecisionRecord(
			objectId: "o", workspaceId: "ws", title: "t", label: "x", agentName: "A", eventId: 1,
			decidedAt: t0, sendAt: t0.addingTimeInterval(8))
		store.update { $0.append(r) }
		#expect(FileWidgetDecisionStore(fileURL: url).records() == [r])
	}
}

@Suite("Notification action order")
struct NotificationActionOrderTests {
	@Test func recommendedLeadsAndHoldFollowsKeepingPayloadIndices() {
		let payload = PushDecisionPayload(
			workspaceId: "ws", notificationId: "n", eventId: 1, objectId: "o",
			options: [
				PushDecisionOption(label: "Edit"), PushDecisionOption(label: "Hold a week"),
				PushDecisionOption(label: "Ship it", recommended: true),
			])
		let plan = NotificationActionPlan(payload)
		#expect(plan.actions.prefix(2).map(\.title) == ["Ship it", "Hold a week"])
		// The identifier still names the option's index in the payload.
		#expect(NotificationActionPlan.choice(for: "maskin.option.2", in: payload) == .option(label: "Ship it"))
		// Only two options fit beside Later and Reply, so the third has no button.
		#expect(NotificationActionPlan.choice(for: "maskin.option.0", in: payload) == nil)
	}
}

@Suite("Cycle and meeting activity")
struct CycleActivityTests {
	@Test func clampsProgressAndFormatsTheEyebrow() {
		let s = CycleActivityState(flowName: "Outreach", cycle: 12, stage: "Verify", progress: 1.7, summary: "Writer is drafting.")
		#expect(s.progress == 1)
		#expect(s.eyebrow == "CYCLE 12 \u{00B7} VERIFY")
		#expect(CycleActivityState(flowName: " ", cycle: 0, progress: .nan, summary: "").flowName == "Flow")
		#expect(CycleActivityState(flowName: "F", cycle: 3, progress: 0.624, summary: "").percent == 62)
	}

	@Test func needsYouIsTerminalAndKeepsForEightHours() {
		let s = CycleActivityState(flowName: "Outreach", cycle: 1, progress: 1, summary: "x", phase: .needsYou)
		#expect(s.isTerminal)
		#expect(CycleActivityState.needsYouLifetime == 28_800)
	}

	@Test func meetingNameNeverBlank() {
		#expect(MeetingActivityState(name: "  ", startedAt: t0).name == "Maskin")
		#expect(MeetingActivityState.Kind.dailyBriefing.eyebrow == "LIVE \u{00B7} DAILY BRIEFING")
	}
}

@Suite("Cycle activity summary")
struct CycleSummaryTests {
	@Test("splits a bold lead name from the rest of the sentence")
	func splitsActor() {
		let s = CycleActivityState(
			flowName: "Outreach", cycle: 12, progress: 0.62,
			summary: "Writer is drafting follow-ups. Step 2 of 3.", actor: " Writer ")
		#expect(s.summaryParts?.actor == "Writer")
		#expect(s.summaryParts?.rest == " is drafting follow-ups. Step 2 of 3.")
	}

	@Test("no parts when the summary does not start with the actor or none is given")
	func noParts() {
		#expect(CycleActivityState(flowName: "F", cycle: 1, progress: 0, summary: "Hi", actor: "Writer").summaryParts == nil)
		#expect(CycleActivityState(flowName: "F", cycle: 1, progress: 0, summary: "Hi").summaryParts == nil)
		#expect(CycleActivityState(flowName: "F", cycle: 1, progress: 0, summary: "Hi", actor: "  ").actor == nil)
	}

	@Test("an older payload without an actor still decodes")
	func decodesLegacy() throws {
		let json = #"{"flowName":"F","cycle":1,"stage":"","progress":0.5,"summary":"x","phase":"running"}"#
		let s = try JSONDecoder().decode(CycleActivityState.self, from: Data(json.utf8))
		#expect(s.actor == nil)
	}
}
