import Foundation

/// A workspace invitation link: `https://maskin.io/invite?token=<raw>` (also `www.` and `app.`) or
/// `maskin://invite?token=<raw>`.
///
/// Untrusted input, like `DeepLink`: anything that is not exactly one of those shapes yields `nil`.
/// The token is restricted to the base64url alphabet and a sane length, so a hostile link can't
/// smuggle path segments or control characters into the API call that uses it.
public struct InviteLink: Equatable, Hashable, Sendable {
	public let token: String

	/// Tokens are 43 base64url characters today; the bounds leave room for a format change
	/// without accepting arbitrary text.
	public static let tokenLengths = 16...256

	public init?(token: String) {
		guard Self.tokenLengths.contains(token.count), token.allSatisfy(Self.isTokenCharacter) else {
			return nil
		}
		self.token = token
	}

	public init?(url: URL, universalHosts: Set<String> = DeepLink.defaultUniversalHosts) {
		guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
			c.user == nil, c.password == nil, c.port == nil
		else { return nil }
		switch c.scheme?.lowercased() {
		case DeepLink.scheme:
			// `maskin://invite?token=…` (an empty or `/` path is the same place).
			guard c.host?.lowercased() == "invite", Self.segments(c.path).isEmpty else { return nil }
		case "https":
			guard let host = c.host?.lowercased(), universalHosts.contains(host),
				Self.segments(c.path) == ["invite"]
			else { return nil }
		default:
			return nil
		}
		// Exactly one `token` parameter: a duplicate is ambiguous, so it is not an invite.
		let tokens = (c.queryItems ?? []).filter { $0.name == "token" }
		guard tokens.count == 1, let value = tokens[0].value else { return nil }
		self.init(token: value)
	}

	/// The web form, for sharing.
	public func universalURL(host: String = "maskin.io") -> URL {
		var c = URLComponents()
		c.scheme = "https"
		c.host = host
		c.path = "/invite"
		c.queryItems = [URLQueryItem(name: "token", value: token)]
		return c.url!
	}

	private static func segments(_ path: String) -> [String] {
		path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
	}

	private static func isTokenCharacter(_ ch: Character) -> Bool {
		guard ch.isASCII else { return false }
		return ch.isLetter || ch.isNumber || ch == "-" || ch == "_"
	}
}
