import Foundation
import Testing

@testable import MaskinCore

@Suite("Handoff activity")
struct HandoffActivityTests {
	@Test("the payload round-trips to the object's link")
	func roundTrip() {
		let info = HandoffActivity.userInfo(workspaceId: "ws-1", objectId: "obj-9")
		let url = HandoffActivity.link(from: info)
		#expect(url.flatMap { DeepLink(url: $0) } == .object(workspaceId: "ws-1", id: "obj-9"))
	}

	@Test("anything that is not a Maskin link is ignored")
	func foreign() {
		#expect(HandoffActivity.link(from: nil) == nil)
		#expect(HandoffActivity.link(from: ["url": "https://evil.example/ws/objects/o"]) == nil)
		#expect(HandoffActivity.link(from: ["url": 42]) == nil)
		#expect(HandoffActivity.link(from: [:]) == nil)
	}
}
