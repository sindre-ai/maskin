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

	@Test func readsDestructiveAndKeepsALongLabelWhole() throws {
		let long = String(repeating: "word ", count: 20).trimmingCharacters(in: .whitespaces)
		let p = try #require(
			PushDecisionPayload(
				userInfo: userInfo(options: [["label": long, "destructive": true], ["label": "Hold"]])))
		#expect(p.options[0].label == long)
		#expect(p.options[0].destructive)
		#expect(!p.options[1].destructive)
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

	@Test func twoOptionsGetLaterAndReply() {
		let plan = NotificationActionPlan(payload(["Ship", "Hold"]))
		#expect(plan.categoryIdentifier == "decision.n-9")
		#expect(plan.actions.map(\.title) == ["Ship", "Hold", "Later", "Reply"])
		#expect(
			plan.actions.map(\.identifier)
				== ["maskin.option.0", "maskin.option.1", "maskin.later", "maskin.reply"])
	}

	@Test func neverExceedsFourActionsAndKeepsLaterAndReply() {
		let plan = NotificationActionPlan(payload(["A", "B", "C", "D", "E"]))
		#expect(plan.actions.count == 4)
		#expect(plan.actions.map(\.title) == ["A", "B", "Later", "Reply"])
	}

	@Test func anOptionThatNeedsConfirmationOpensTheCardInsteadOfSending() {
		var p = payload(["Delete", "Keep"])
		p.options[0].destructive = true
		let plan = NotificationActionPlan(p)
		// Never one tap on a lock screen: the button opens the card, where the confirmation lives.
		#expect(plan.actions[0].kind == .open)
		#expect(plan.actions[0].title.contains("Delete"))
		#expect(!plan.actions[0].requiresAuthentication && !plan.actions[0].isDestructive)
		#expect(plan.actions[1].kind == .option(label: "Keep"))
		#expect(NotificationActionPlan.choice(for: "maskin.option.0", in: p) == .open)
	}

	@Test func aDestructiveOptionBecomesAReviewButtonThatOpensTheApp() throws {
		var p = payload(["Delete", "Keep"])
		p.options[0].destructive = true
		let action = try #require(NotificationActionPlan(p).actions.first { $0.identifier == "maskin.option.0" })
		#expect(action.kind == .open)
		#expect(action.title == "Review \u{201C}Delete\u{201D}")
		#expect(action.title.hasPrefix("Review"))
	}

	@Test func aNonDestructiveOptionStaysOneTap() throws {
		let plan = NotificationActionPlan(payload(["Ship", "Hold"]))
		let ship = try #require(plan.actions.first { $0.identifier == "maskin.option.0" })
		#expect(ship.kind == .option(label: "Ship"))
		#expect(ship.title == "Ship")
		#expect(!ship.title.contains("Review"))
		#expect(NotificationActionPlan.choice(for: "maskin.option.0", in: payload(["Ship", "Hold"])) == .option(label: "Ship"))
	}

	@Test func aMixedListKeepsOrderAndKindsPerOption() {
		var p = payload(["Ship", "Delete"])
		p.options[1].destructive = true
		let plan = NotificationActionPlan(p)
		#expect(plan.actions.map(\.identifier) == ["maskin.option.0", "maskin.option.1", "maskin.later", "maskin.reply"])
		#expect(plan.actions[0].kind == .option(label: "Ship"))
		#expect(plan.actions[1].kind == .open)
		#expect(plan.actions[1].title.contains("Delete"))
		#expect(plan.actions[2].kind == .later)
		#expect(plan.actions[3].kind == .reply)

		// Destructive first, Hold second: the lead stays first and Hold keeps its place.
		var q = payload(["Delete", "Hold"])
		q.options[0].destructive = true
		let plan2 = NotificationActionPlan(q)
		#expect(plan2.actions.prefix(2).map(\.kind) == [.open, .option(label: "Hold")])
	}

	@Test func aDestructiveOptionNeverYieldsAPostingAction() {
		// Also when it is the recommended lead.
		var p = payload(["Delete", "Hold"])
		p.options[0].destructive = true
		p.options[0].recommended = true
		let plan = NotificationActionPlan(p)
		for action in plan.actions where action.title.contains("Delete") {
			#expect(action.kind == .open)
		}
		let posted = plan.actions.compactMap { action -> String? in
			if case .option(let label) = action.kind { return label }
			return nil
		}
		#expect(!posted.contains("Delete"))
		#expect(NotificationActionPlan.choice(for: "maskin.option.0", in: p) == .open)
	}

	@Test func laterIsAnActionOfItsOwn() {
		let p = payload(["Ship", "Hold"])
		#expect(NotificationActionPlan.choice(for: "maskin.later", in: p) == .later)
	}

	@Test func categoryIdentifierIsPerNotificationAndStable() {
		let a = NotificationActionPlan(payload(["Ship", "Hold"]))
		let b = NotificationActionPlan(payload(["Ship", "Hold"]))
		#expect(a == b)
		#expect(a.categoryIdentifier.hasPrefix(PushDecisionPayload.categoryPrefix))
	}

	@Test func choiceMapsIdentifiersBackToWhatWasTapped() {
		let p = payload(["Ship", "Hold"])
		#expect(NotificationActionPlan.choice(for: "maskin.option.1", in: p) == .option(label: "Hold"))
		#expect(NotificationActionPlan.choice(for: "maskin.reply", in: p) == .reply)
		#expect(NotificationActionPlan.choice(for: "maskin.option.9", in: p) == nil)
		#expect(NotificationActionPlan.choice(for: "com.apple.UNNotificationDefaultActionIdentifier", in: p) == nil)
	}
}
