import XCTest
@testable import Maskin

final class CardClassifierTests: XCTestCase {
	private func object(type: String, status: String, decisionType: String? = nil) -> MaskinObject {
		let metadata: JSONValue? = decisionType.map { .object(["decision_type": .string($0)]) }
		return MaskinObject(
			id: "obj-1", workspaceId: "ws-1", type: type, title: "Title", content: nil,
			status: status, metadata: metadata, driver: nil, createdBy: "actor-1",
			createdAt: nil, updatedAt: nil, isSubscribed: nil, unreadCount: nil
		)
	}

	private func item(_ object: MaskinObject?) -> UnreadItem {
		UnreadItem(
			entityType: "object", entityId: "obj-1", unreadCount: 1, mentioningUnreadCount: 0,
			latestEventId: 1, latestActivityAt: nil, object: object
		)
	}

	func testTaskInReviewWithDecisionTypeClassifiesAsDecision() {
		let object = object(type: "task", status: "in_review", decisionType: "design")
		XCTAssertEqual(CardClassifier.classify(item(object)), .decision)
	}

	func testTaskInReviewWithoutDecisionTypeClassifiesAsSignOff() {
		let object = object(type: "task", status: "in_review")
		XCTAssertEqual(CardClassifier.classify(item(object)), .signOff)
	}

	func testProposedBetStatusesClassifyAsProposedBet() {
		for status in ["signal", "proposed", "define", "clustered"] {
			let object = object(type: "bet", status: status)
			XCTAssertEqual(CardClassifier.classify(item(object)), .proposedBet, "status=\(status)")
		}
	}

	func testEverythingElseFallsBackToThread() {
		let object = object(type: "insight", status: "new")
		XCTAssertEqual(CardClassifier.classify(item(object)), .thread)
	}

	func testMissingObjectFallsBackToThread() {
		XCTAssertEqual(CardClassifier.classify(item(nil)), .thread)
	}
}
