import Foundation
import Testing

@testable import MaskinCore

private func userInfo(options: [[String: Any]] = [["label": "Ship it"], ["label": "Hold"]]) -> [AnyHashable: Any] {
	[
		"workspace_id": "ws-1", "notification_id": "n-1", "deep_link": "maskin://ws-1/objects/obj-1",
		"decision": [
			"eventId": 42, "parentEventId": 7, "objectId": "obj-1", "options": options, "recommended": 1,
		] as [String: Any],
	]
}

@Suite("PushDecisionPayload")
struct PushDecisionPayloadTests {
	@Test func parsesTheServerContract() throws {
		let p = try #require(PushDecisionPayload(userInfo: userInfo()))
		#expect(p.workspaceId == "ws-1")
		#expect(p.notificationId == "n-1")
		#expect(p.eventId == 42)
		#expect(p.parentEventId == 7)
		#expect(p.objectId == "obj-1")
		#expect(p.options.map(\.label) == ["Ship it", "Hold"])
		#expect(p.options.map(\.recommended) == [false, true])
		#expect(p.deepLink == "maskin://ws-1/objects/obj-1")
	}

	@Test func plainPushesAreNotDecisions() {
		#expect(PushDecisionPayload(userInfo: ["workspace_id": "ws-1", "notification_id": "n-1"]) == nil)
	}

	@Test func malformedDecisionsAreRejectedNotCrashed() {
		for bad: [AnyHashable: Any] in [
			userInfo(options: []),
			userInfo(options: [["label": "  "], ["nope": 1]]),
			["workspace_id": "ws-1", "notification_id": "n-1", "decision": "x"],
			["workspace_id": "ws-1", "notification_id": "n-1", "decision": ["eventId": 0, "objectId": "o", "options": [["label": "A"]]]],
			["notification_id": "n-1", "decision": ["eventId": 1, "objectId": "o", "options": [["label": "A"]]]],
		] {
			#expect(PushDecisionPayload(userInfo: bad) == nil)
		}
	}

	@Test func skipsBlankLabelsButKeepsTheRest() throws {
		let p = try #require(PushDecisionPayload(userInfo: userInfo(options: [["label": ""], ["label": "Hold"]])))
		#expect(p.options.map(\.label) == ["Hold"])
	}
}

@Suite("NotificationActionPlan")
struct NotificationActionPlanTests {
	private func payload(_ labels: [String]) -> PushDecisionPayload {
		PushDecisionPayload(
			workspaceId: "ws", notificationId: "n-9", eventId: 1, objectId: "o",
			options: labels.map { PushDecisionOption(label: $0) })
	}

	@Test func twoOptionsGetReplyAndOpen() {
		let plan = NotificationActionPlan(payload(["Ship", "Hold"]))
		#expect(plan.categoryIdentifier == "decision.n-9")
		#expect(plan.actions.map(\.title) == ["Ship", "Hold", "Reply", "Open"])
		#expect(plan.actions.map(\.identifier) == ["maskin.option.0", "maskin.option.1", "maskin.reply", "maskin.open"])
	}

	@Test func neverExceedsFourActionsAndKeepsReply() {
		let plan = NotificationActionPlan(payload(["A", "B", "C", "D", "E"]))
		#expect(plan.actions.count == 4)
		#expect(plan.actions.map(\.title) == ["A", "B", "C", "Reply"])
	}

	@Test func destructiveOptionsRequireAuthentication() {
		var p = payload(["Delete", "Keep"])
		p.options[0].destructive = true
		let plan = NotificationActionPlan(p)
		#expect(plan.actions[0].requiresAuthentication && plan.actions[0].isDestructive)
		#expect(!plan.actions[1].requiresAuthentication)
	}

	@Test func choiceMapsIdentifiersBackToWhatWasTapped() {
		let p = payload(["Ship", "Hold"])
		#expect(NotificationActionPlan.choice(for: "maskin.option.1", in: p) == .option(label: "Hold"))
		#expect(NotificationActionPlan.choice(for: "maskin.reply", in: p) == .reply)
		#expect(NotificationActionPlan.choice(for: "maskin.option.9", in: p) == nil)
		#expect(NotificationActionPlan.choice(for: "com.apple.UNNotificationDefaultActionIdentifier", in: p) == nil)
	}
}
