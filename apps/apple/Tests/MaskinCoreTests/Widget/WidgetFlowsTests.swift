import Foundation
import Testing

@testable import MaskinCore

@Suite("Widget flows")
struct WidgetFlowsTests {
	private func loop(
		_ id: String, _ name: String, status: LoopPill = .learning, inProgress: Int = 0,
		closed: Int = 0, waiting: Int = 0
	) -> LoopSummary {
		LoopSummary(
			id: id, name: name, status: status, inProgressCount: inProgress, closedCount: closed,
			waitingCount: waiting)
	}

	@Test("running flows only, needs-you first, capped at three")
	func selection() {
		let flows = WidgetSnapshotBuilder.flows(from: [
			loop("a", "Quiet", inProgress: 1),
			loop("b", "Paused", status: .paused, waiting: 5),
			loop("c", "Busy", inProgress: 9),
			loop("d", "Waiting", inProgress: 0, waiting: 2),
			loop("e", "Draft", status: .draft),
		])
		#expect(flows.map(\.id) == ["d", "c", "a"])
		#expect(flows.first?.needsYou == true)
	}

	@Test("running count includes flows past the tile cap")
	func runningCount() {
		let loops = (0..<5).map { loop("l\($0)", "F\($0)") } + [loop("p", "P", status: .paused)]
		let s = WidgetSnapshotBuilder.make(
			cards: [], actors: [], unreadNotifications: 0, actorId: "a", workspaceId: "w",
			now: Date(timeIntervalSince1970: 0), loops: loops)
		#expect(s.flows.count == 3)
		#expect(s.runningFlowCount == 5)
		#expect(s.caughtUpDetail == "5 flows running")
	}

	@Test("progress is the closed share, clamped")
	func progress() {
		#expect(WidgetSnapshot.Flow(id: "x", name: "x", progress: 2, needsYou: false).progress == 1)
		#expect(WidgetSnapshot.Flow(id: "x", name: "x", progress: .nan, needsYou: false).progress == 0)
		let f = WidgetSnapshotBuilder.flows(from: [loop("a", "A", inProgress: 1, closed: 3)])
		#expect(f.first?.progress == 0.75)
	}

	@Test("a snapshot cached before flows existed still decodes")
	func backwardsCompatibleDecode() throws {
		let json = """
			{"actorId":"a","workspaceId":"w","needsCount":0,"decisions":[],"unreadCount":2,"updatedAt":0}
			"""
		let s = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(json.utf8))
		#expect(s.flows.isEmpty)
		#expect(s.runningFlowCount == 0)
		#expect(s.caughtUpDetail == "2 unread notifications")
	}

	@Test("flows survive an encode/decode round trip and removing(objectIds:)")
	func roundTrip() throws {
		let s = WidgetSnapshot(
			actorId: "a", workspaceId: "w", needsCount: 1,
			decisions: [.init(objectId: "o", title: "t")], unreadCount: 0,
			updatedAt: Date(timeIntervalSince1970: 0),
			flows: [.init(id: "f", name: "F", progress: 0.5, needsYou: true)], runningFlowCount: 4)
		let back = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(s))
		#expect(back == s)
		#expect(s.removing(objectIds: ["o"]).flows == s.flows)
		#expect(s.removing(objectIds: ["o"]).runningFlowCount == 4)
	}

	@Test("singular running line")
	func singular() {
		let s = WidgetSnapshot(
			actorId: "a", workspaceId: "w", needsCount: 0, decisions: [], unreadCount: 0,
			updatedAt: Date(timeIntervalSince1970: 0), runningFlowCount: 1)
		#expect(s.caughtUpDetail == "1 flow running")
	}
}
