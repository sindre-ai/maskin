import Foundation
import Testing

@testable import MaskinCore

@Suite("DeepLink loops and triggers")
struct DeepLinkLoopTriggerTests {
	let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
	let id = "11111111-2222-3333-4444-555555555555"

	@Test("a loop address and a trigger address are recognised in both forms")
	func parses() {
		#expect(DeepLink(string: "https://maskin.io/\(ws)/loops/\(id)") == .loop(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/loops/\(id)") == .loop(workspaceId: ws, id: id))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/triggers/\(id)") == .trigger(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/triggers/\(id)/") == .trigger(workspaceId: ws, id: id))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/loops/\(id)?tab=runs#top") == .loop(workspaceId: ws, id: id))
	}

	@Test("they round-trip through their canonical URLs and carry the workspace")
	func roundTrip() {
		for link in [DeepLink.loop(workspaceId: ws, id: id), .trigger(workspaceId: ws, id: id)] {
			#expect(DeepLink(url: link.url) == link)
			#expect(DeepLink(url: link.universalURL()) == link)
			#expect(link.workspaceId == ws)
		}
		#expect(DeepLink.loop(workspaceId: ws, id: id).url.absoluteString == "maskin://\(ws)/loops/\(id)")
		#expect(DeepLink.trigger(workspaceId: ws, id: id).universalURL().absoluteString == "https://maskin.io/\(ws)/triggers/\(id)")
	}

	@Test("a list address, a sub-page or an unsafe id is not a loop or trigger link")
	func rejects() {
		#expect(DeepLink(string: "maskin://\(ws)/loops") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/triggers") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/loops/\(id)/steps") == nil)
		#expect(DeepLink(string: "https://maskin.io/\(ws)/loops/../x") == nil)
		#expect(DeepLink(string: "https://evil.example/\(ws)/triggers/\(id)") == nil)
	}
}
