import Foundation
import Testing

@testable import MaskinCore

#if canImport(UserNotifications) && !os(tvOS) && !os(watchOS)
	import UserNotifications

	private let payload = PushDecisionPayload(
		workspaceId: "ws-1", notificationId: "n-1", eventId: 42, objectId: "obj-1",
		options: [
			PushDecisionOption(label: "Ship it", recommended: true), PushDecisionOption(label: "Hold"),
			PushDecisionOption(label: "Drop", destructive: true),
		])

	private func dynamic(_ id: String) -> UNNotificationCategory {
		UNNotificationCategory(
			identifier: PushDecisionPayload.categoryPrefix + id, actions: [], intentIdentifiers: [],
			options: [])
	}

	@Suite("PushCategories")
	struct PushCategoriesTests {
		@Test func categoryMirrorsThePlanActionForAction() {
			let plan = NotificationActionPlan(payload)
			let category = PushCategories.category(for: plan)
			#expect(category.identifier == "decision.n-1")
			#expect(category.actions.map(\.identifier) == plan.actions.map(\.identifier))
			#expect(category.actions.map(\.title) == plan.actions.map(\.title))
		}

		@Test func replyIsATextInputAndReviewOpensTheApp() throws {
			let needsConfirm = PushDecisionPayload(
				workspaceId: "ws-1", notificationId: "n-2", eventId: 42, objectId: "obj-1",
				options: [
					PushDecisionOption(label: "Ship it", recommended: true),
					PushDecisionOption(label: "Drop", destructive: true),
				])
			let category = PushCategories.category(for: NotificationActionPlan(needsConfirm))
			let reply = try #require(
				category.actions.first { $0.identifier == NotificationActionPlan.replyIdentifier })
			#expect(reply is UNTextInputNotificationAction)
			let review = try #require(category.actions.first { $0.title.hasPrefix("Review") })
			#expect(review.options.contains(.foreground))
			let later = try #require(
				category.actions.first { $0.identifier == NotificationActionPlan.laterIdentifier })
			#expect(!later.options.contains(.foreground))
		}

		@Test func mergePrunesDynamicCategoriesWhoseNotificationIsGone() {
			let existing: Set = [dynamic("old"), dynamic("onscreen")]
			let new = dynamic("new")
			let merged = PushCategories.merged(
				existing: existing, live: ["decision.onscreen"], adding: new)
			let ids = Set(merged.map(\.identifier))
			#expect(ids.contains("decision.onscreen"))
			#expect(ids.contains("decision.new"))
			#expect(!ids.contains("decision.old"))
		}

		@Test func mergeKeepsFixedCategoriesTheAppRegistered() {
			let fixed = UNNotificationCategory(
				identifier: "maskin.other", actions: [], intentIdentifiers: [], options: [])
			let merged = PushCategories.merged(existing: [fixed], live: [], adding: dynamic("new"))
			#expect(merged.contains { $0.identifier == "maskin.other" })
		}

		@Test func mergeReplacesACategoryWithTheSameIdentifier() {
			let plan = NotificationActionPlan(payload)
			let stale = UNNotificationCategory(
				identifier: plan.categoryIdentifier, actions: [], intentIdentifiers: [], options: [])
			let merged = PushCategories.merged(
				existing: [stale], live: [plan.categoryIdentifier],
				adding: PushCategories.category(for: plan))
			let matching = merged.filter { $0.identifier == plan.categoryIdentifier }
			#expect(matching.count == 1)
			#expect(matching.first?.actions.isEmpty == false)
		}

		@Test func mergeEnsuresTheFallbackExistsBeforeTheAppEverLaunched() {
			let merged = PushCategories.merged(existing: [], live: [], adding: dynamic("new"))
			#expect(merged.contains { $0.identifier == PushDecisionPayload.category })
		}

		@Test func mergeDoesNotDuplicateAnExistingFallback() {
			let merged = PushCategories.merged(
				existing: [PushCategories.fallback()], live: [], adding: dynamic("new"))
			#expect(merged.filter { $0.identifier == PushDecisionPayload.category }.count == 1)
		}
	}
#endif

@Suite("NotificationRepost")
struct NotificationRepostTests {
	@Test func failureKeepsButtonsAndStaysTimeSensitive() {
		let repost = NotificationRepost(
			outcome: .failed("Server said no."), originalCategory: "decision.n-1",
			originalLevel: .timeSensitive)
		#expect(repost.categoryIdentifier == "decision.n-1")
		#expect(repost.level == .timeSensitive)
		#expect(repost.keepsSound)
		#expect(!repost.success)
		#expect(repost.body == "Couldn't send. Server said no.")
	}

	@Test func failureOfAPassiveOriginalIsStillAnActiveInterruption() {
		let repost = NotificationRepost(
			outcome: .failed("x"), originalCategory: "decision.n-1", originalLevel: .passive)
		#expect(repost.level == .active)
	}

	@Test func confirmationsAreSilentPassiveAndButtonless() {
		for outcome in [
			NotificationActionOutcome.answered("Ship it"), .queued("Ship it"), .deferred("tomorrow"),
		] {
			let repost = NotificationRepost(
				outcome: outcome, originalCategory: "decision.n-1", originalLevel: .timeSensitive)
			#expect(repost.categoryIdentifier == nil)
			#expect(repost.level == .passive)
			#expect(!repost.keepsSound)
			#expect(repost.success)
		}
	}

	@Test func notSignedInIsAFailureWithoutButtons() {
		let repost = NotificationRepost(
			outcome: .notSignedIn, originalCategory: "decision.n-1", originalLevel: .active)
		#expect(!repost.success)
		#expect(repost.categoryIdentifier == nil)
	}

	@Test func answeredBodyQuotesOnlyTheFirstLineAndCapsIt() {
		let long = String(repeating: "a", count: 100)
		let repost = NotificationRepost(
			outcome: .answered("First\nsecond"), originalCategory: "", originalLevel: .active)
		#expect(repost.body == "You chose \u{201C}First\u{201D}")
		let capped = NotificationRepost(
			outcome: .answered(long), originalCategory: "", originalLevel: .active)
		#expect(capped.body.contains(String(repeating: "a", count: 60) + "\u{2026}"))
	}
}
