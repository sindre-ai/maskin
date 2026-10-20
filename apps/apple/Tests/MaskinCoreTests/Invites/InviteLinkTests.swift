import Foundation
import Testing

@testable import MaskinCore

private let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

@Suite("InviteLink")
struct InviteLinkTests {
	@Test("parses the universal link on the maskin.io host", arguments: ["maskin.io"])
	func universal(host: String) {
		let link = InviteLink(url: URL(string: "https://\(host)/invite?token=\(token)")!)
		#expect(link?.token == token)
	}

	@Test("parses the custom scheme, with or without a trailing slash")
	func scheme() {
		#expect(InviteLink(url: URL(string: "maskin://invite?token=\(token)")!)?.token == token)
		#expect(InviteLink(url: URL(string: "maskin://invite/?token=\(token)")!)?.token == token)
	}

	@Test("hosts are case-insensitive")
	func caseInsensitive() {
		#expect(InviteLink(url: URL(string: "https://MASKIN.io/invite?token=\(token)")!) != nil)
	}

	@Test("rejects links that are not exactly an invite", arguments: [
		"https://maskin.io/invite",
		"https://maskin.io/invite?token=",
		"https://maskin.io/invite?other=1",
		"https://maskin.io/invite/extra?token=" + token,
		"https://maskin.io/invite?token=" + token + "&token=" + token,
		"https://www.maskin.io/invite?token=" + token,
		"https://evil.example/invite?token=" + token,
		"https://maskin.io.evil.example/invite?token=" + token,
		"http://maskin.io/invite?token=" + token,
		"https://user@maskin.io/invite?token=" + token,
		"maskin://elsewhere?token=" + token,
		"maskin://invite/extra?token=" + token,
		"https://maskin.io/invite?token=short",
		"https://maskin.io/invite?token=abc%2Fdef%20ghijklmnopqrstuvwxyz",
	])
	func rejects(url: String) {
		#expect(InviteLink(url: URL(string: url)!) == nil)
	}

	@Test("a bare /invite is not a workspace deep link")
	func notADeepLink() {
		#expect(DeepLink(url: URL(string: "https://maskin.io/invite?token=\(token)")!) == nil)
	}

	@Test("the shareable URL round-trips")
	func roundTrip() {
		let link = InviteLink(token: token)!
		#expect(InviteLink(url: link.universalURL()) == link)
	}
}

@Suite("PendingInviteStore")
struct PendingInviteStoreTests {
	private func defaults() -> UserDefaults {
		let name = "invite-tests-\(UUID().uuidString)"
		let d = UserDefaults(suiteName: name)!
		d.removePersistentDomain(forName: name)
		return d
	}

	@Test("a saved token survives a new store instance (relaunch)")
	func persists() {
		let d = defaults()
		UserDefaultsPendingInviteStore(defaults: d).save(token)
		#expect(UserDefaultsPendingInviteStore(defaults: d).load() == token)
	}

	@Test("clear forgets it")
	func clears() {
		let d = defaults()
		let store = UserDefaultsPendingInviteStore(defaults: d)
		store.save(token)
		store.clear()
		#expect(store.load() == nil)
	}

	@Test("a token older than a week is dropped")
	func expires() {
		let d = defaults()
		UserDefaultsPendingInviteStore(defaults: d, now: { Date(timeIntervalSince1970: 0) }).save(token)
		let later = UserDefaultsPendingInviteStore(
			defaults: d, now: { Date(timeIntervalSince1970: UserDefaultsPendingInviteStore.maxAge + 1) })
		#expect(later.load() == nil)
		#expect(d.data(forKey: "invite.pending.v1") == nil)
	}

	@Test("a corrupt or hostile stored value is dropped")
	func corrupt() {
		let d = defaults()
		d.set(Data("not json".utf8), forKey: "invite.pending.v1")
		#expect(UserDefaultsPendingInviteStore(defaults: d).load() == nil)
	}
}
