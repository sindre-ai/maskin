import Foundation
import Testing

@testable import MaskinCore

@Suite("DeepLink parsing")
struct DeepLinkTests {
	let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
	let id = "11111111-2222-3333-4444-555555555555"

	@Test("parses every maskin:// shape the backend sends")
	func customScheme() {
		#expect(DeepLink(string: "maskin://\(ws)/objects/\(id)") == .object(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/chats/\(id)") == .chat(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/notifications") == .notifications(workspaceId: ws))
		#expect(DeepLink(string: "maskin://\(ws)") == .notifications(workspaceId: ws))
		#expect(DeepLink(string: "maskin://\(ws)/objects/\(id)/") == .object(workspaceId: ws, id: id))
	}

	@Test("parses the web app's universal-link routes")
	func universal() {
		#expect(DeepLink(string: "https://maskin.io/\(ws)/objects/\(id)") == .object(workspaceId: ws, id: id))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/chats/\(id)") == .chat(workspaceId: ws, id: id))
		#expect(DeepLink(string: "https://maskin.io/\(ws)") == .notifications(workspaceId: ws))
		#expect(DeepLink(string: "https://MASKIN.io/\(ws)/objects/\(id)") != nil)
		#expect(DeepLink(string: "https://maskin.io/\(ws)/objects/\(id)?tab=comments#x") == .object(workspaceId: ws, id: id))
	}

	@Test("round-trips through its canonical URLs")
	func roundTrip() {
		for link in [
			DeepLink.object(workspaceId: ws, id: id), .chat(workspaceId: ws, id: id),
			.notifications(workspaceId: ws),
		] {
			#expect(DeepLink(url: link.url) == link)
			#expect(DeepLink(url: link.universalURL()) == link)
		}
		#expect(DeepLink.chat(workspaceId: ws, id: id).url.absoluteString == "maskin://\(ws)/chats/\(id)")
		#expect(DeepLink.object(workspaceId: ws, id: id).universalURL().absoluteString == "https://maskin.io/\(ws)/objects/\(id)")
	}

	@Test("rejects foreign schemes and hosts")
	func foreign() {
		#expect(DeepLink(string: "http://maskin.io/\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "https://evil.example/\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "https://maskin.io.evil.example/\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "https://evil.example@maskin.io/\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "https://maskin.io:8443/\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "javascript:alert(1)") == nil)
		#expect(DeepLink(string: "file:///etc/passwd") == nil)
		#expect(DeepLink(string: "otherapp://\(ws)/objects/\(id)") == nil)
		#expect(DeepLink(string: "maskin:///objects/\(id)") == nil)
		#expect(DeepLink(string: "maskin://user:pw@\(ws)/objects/\(id)") == nil)
	}

	@Test("rejects malformed paths")
	func malformed() {
		#expect(DeepLink(string: "maskin://\(ws)/objects") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/objects/") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/objects/\(id)/extra") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/settings/keys") == nil)
		#expect(DeepLink(string: "maskin://\(ws)//objects/\(id)") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/objects/..") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/objects/.") == nil)
		#expect(DeepLink(string: "https://maskin.io/") == nil)
		#expect(DeepLink(string: "https://maskin.io") == nil)
		#expect(DeepLink(string: "") == nil)
	}

	@Test("rejects ids that could alter a later request")
	func hostileIDs() {
		for bad in ["a%2Fb", "a%2e%2e", "a%00b", "a b", "a%20b", "id;drop", "id%3Fx%3D1", "%F0%9F%92%A5", String(repeating: "a", count: 65)] {
			#expect(DeepLink(string: "maskin://\(ws)/objects/\(bad)") == nil, "\(bad)")
			#expect(DeepLink(string: "https://maskin.io/\(ws)/chats/\(bad)") == nil, "\(bad)")
		}
		#expect(DeepLink(string: "maskin://a%2Fb/objects/\(id)") == nil)
		#expect(DeepLink(string: "https://maskin.io/..%2F/objects/\(id)") == nil)
	}

	@Test("custom universal hosts are honoured")
	func customHosts() {
		let url = URL(string: "https://staging.maskin.test/\(ws)/chats/\(id)")!
		#expect(DeepLink(url: url) == nil)
		#expect(DeepLink(url: url, universalHosts: ["staging.maskin.test"]) == .chat(workspaceId: ws, id: id))
	}

	@Test("accepts short fixture ids")
	func shortIDs() {
		#expect(DeepLink(string: "maskin://ws-1/objects/obj_9") == .object(workspaceId: "ws-1", id: "obj_9"))
	}
}
