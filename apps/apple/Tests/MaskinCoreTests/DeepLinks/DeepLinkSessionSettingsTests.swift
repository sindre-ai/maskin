import Foundation
import Testing

@testable import MaskinCore

@Suite("DeepLink sessions, settings and list pages")
struct DeepLinkSessionSettingsTests {
	let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"
	let id = "11111111-2222-3333-4444-555555555555"

	@Test("a session address is recognised in both forms")
	func session() {
		#expect(DeepLink(string: "https://maskin.io/\(ws)/sessions/\(id)") == .session(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/sessions/\(id)") == .session(workspaceId: ws, id: id))
		#expect(DeepLink(string: "maskin://\(ws)/sessions") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/sessions/\(id)/logs") == nil)
	}

	@Test("settings opens the hub, or the page it names")
	func settings() {
		#expect(DeepLink(string: "https://maskin.io/\(ws)/settings") == .settings(workspaceId: ws, page: nil))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/settings/") == .settings(workspaceId: ws, page: nil))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/settings/billing") == .settings(workspaceId: ws, page: .billing))
		#expect(DeepLink(string: "maskin://\(ws)/settings/members") == .settings(workspaceId: ws, page: .members))
		#expect(DeepLink(string: "maskin://\(ws)/settings/notifications") == .settings(workspaceId: ws, page: .notifications))
		#expect(DeepLink(string: "maskin://\(ws)/settings/skills") == .settings(workspaceId: ws, page: .skills))
	}

	@Test("web pages that live on one app page open that page")
	func settingsAliases() {
		for segment in ["keys", "keychain", "mcp"] {
			#expect(DeepLink(string: "maskin://\(ws)/settings/\(segment)") == .settings(workspaceId: ws, page: .keys), "\(segment)")
		}
		#expect(DeepLink(string: "maskin://\(ws)/settings/extensions") == .settings(workspaceId: ws, page: .objects))
		#expect(DeepLink(string: "maskin://\(ws)/settings/objects/status") == .settings(workspaceId: ws, page: .objects))
		#expect(
			DeepLink(string: "https://maskin.io/\(ws)/settings/integrations/google-drive")
				== .settings(workspaceId: ws, page: .integrations))
	}

	@Test("an unknown settings page, a deep path or an unsafe id is not a link")
	func settingsRejects() {
		#expect(DeepLink(string: "maskin://\(ws)/settings/nope") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/settings/integrations/a/b") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/settings/integrations/a%2Fb") == nil)
		#expect(DeepLink(string: "maskin://\(ws)/settings/integrations/..") == nil)
	}

	@Test("list addresses open their tab or sheet")
	func lists() {
		#expect(DeepLink(string: "https://maskin.io/\(ws)/triggers") == .list(workspaceId: ws, kind: .triggers))
		#expect(DeepLink(string: "https://maskin.io/\(ws)/loops") == .list(workspaceId: ws, kind: .loops))
		#expect(DeepLink(string: "maskin://\(ws)/chats") == .list(workspaceId: ws, kind: .chats))
		#expect(DeepLink(string: "maskin://\(ws)/loops/") == .list(workspaceId: ws, kind: .loops))
		#expect(DeepLink(string: "maskin://\(ws)/marketplace") == nil)
	}

	@Test("they round-trip through their canonical URLs and carry the workspace")
	func roundTrip() {
		let links: [DeepLink] = [
			.session(workspaceId: ws, id: id), .settings(workspaceId: ws, page: nil),
			.settings(workspaceId: ws, page: .keys), .list(workspaceId: ws, kind: .triggers),
			.list(workspaceId: ws, kind: .loops), .list(workspaceId: ws, kind: .chats),
		]
		for link in links {
			#expect(DeepLink(url: link.url) == link)
			#expect(DeepLink(url: link.universalURL()) == link)
			#expect(link.workspaceId == ws)
		}
		#expect(DeepLink.settings(workspaceId: ws, page: .billing).url.absoluteString == "maskin://\(ws)/settings/billing")
		#expect(DeepLink.list(workspaceId: ws, kind: .loops).universalURL().absoluteString == "https://maskin.io/\(ws)/loops")
	}

	@Test("a workspace page the app has no screen for is still a Maskin page")
	func workspacePage() {
		for address in [
			"https://maskin.io/\(ws)/marketplace", "https://maskin.io/\(ws)/settings/nope",
			"https://maskin.io/\(ws)/search", "maskin://\(ws)/marketplace",
		] {
			#expect(DeepLink(string: address) == nil, "\(address)")
			#expect(DeepLink.isWorkspacePage(URL(string: address)!), "\(address)")
		}
		for address in [
			"https://maskin.io/pricing", "https://maskin.io/", "https://evil.example/\(ws)/marketplace",
			"https://maskin.io.evil.example/\(ws)/marketplace", "https://maskin.io:8443/\(ws)/marketplace",
			"http://maskin.io/\(ws)/marketplace", "https://github.com/sindre-ai/maskin/pull/1",
		] {
			#expect(!DeepLink.isWorkspacePage(URL(string: address)!), "\(address)")
		}
	}
}
