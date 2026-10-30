import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("ThreadRoute")
struct ThreadRouteTests {
	private func root(serverID: Int?) -> ChatMessage {
		ChatMessage(
			id: serverID.map { "m\($0)" } ?? "local-1", serverID: serverID, conversationID: "c1", actorID: "relay",
			actorName: "Relay", author: .agent, content: "Done.", createdAt: Date(),
			thread: ThreadSummary(replyCount: 2, unreadCount: 1, lastReplyID: 12, participants: []))
	}

	@Test("tapping the pill under a stored message sets the route to that message")
	func opensStoredRoot() {
		#expect(ThreadRoute.opening(root(serverID: 10)) == ThreadRoute(rootID: 10))
		#expect(ThreadRoute.opening(root(serverID: 10))?.id == 10)
	}

	@Test("a message the server has not stored has no thread to open")
	func pendingHasNoRoute() {
		#expect(ThreadRoute.opening(root(serverID: nil)) == nil)
	}
}
