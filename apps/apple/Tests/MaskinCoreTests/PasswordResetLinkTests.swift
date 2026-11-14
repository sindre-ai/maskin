import Foundation
import Testing

@testable import MaskinCore

private let token = "rst_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

@Suite("PasswordResetLink")
struct PasswordResetLinkTests {
	@Test("parses the universal link on the maskin.io host")
	func universal() {
		let link = PasswordResetLink(url: URL(string: "https://maskin.io/reset-password?token=\(token)")!)
		#expect(link?.token == token)
	}

	@Test("parses the custom scheme, with or without a trailing slash")
	func scheme() {
		#expect(PasswordResetLink(url: URL(string: "maskin://reset-password?token=\(token)")!)?.token == token)
		#expect(PasswordResetLink(url: URL(string: "maskin://reset-password/?token=\(token)")!)?.token == token)
	}

	@Test("hosts are case-insensitive")
	func caseInsensitive() {
		#expect(PasswordResetLink(url: URL(string: "https://MASKIN.io/reset-password?token=\(token)")!) != nil)
	}

	@Test("rejects links that are not exactly a reset link", arguments: [
		"https://maskin.io/reset-password",
		"https://maskin.io/reset-password?token=",
		"https://maskin.io/reset-password?other=1",
		"https://maskin.io/reset-password/extra?token=" + token,
		"https://maskin.io/reset-password?token=" + token + "&token=" + token,
		"https://www.maskin.io/reset-password?token=" + token,
		"https://evil.example/reset-password?token=" + token,
		"https://maskin.io.evil.example/reset-password?token=" + token,
		"http://maskin.io/reset-password?token=" + token,
		"https://user@maskin.io/reset-password?token=" + token,
		"https://maskin.io/invite?token=" + token,
		"maskin://elsewhere?token=" + token,
		"maskin://reset-password/extra?token=" + token,
		"https://maskin.io/reset-password?token=short",
		"https://maskin.io/reset-password?token=abc%2Fdef%20ghijklmnopqrstuvwxyz",
	])
	func rejects(url: String) {
		#expect(PasswordResetLink(url: URL(string: url)!) == nil)
	}

	@Test("a reset link is not an invite link")
	func notAnInvite() {
		#expect(InviteLink(url: URL(string: "https://maskin.io/reset-password?token=\(token)")!) == nil)
	}

	@Test("a bare reset-password route is not a workspace deep link")
	func notADeepLink() {
		#expect(DeepLink(url: URL(string: "https://maskin.io/reset-password?token=\(token)")!) == nil)
		#expect(DeepLink(url: URL(string: "https://maskin.io/reset-password")!) == nil)
		#expect(DeepLink(url: URL(string: "maskin://reset-password")!) == nil)
	}
}
