import Foundation

/// A password-reset link from the reset email: `https://maskin.io/reset-password?token=<raw>` or
/// `maskin://reset-password?token=<raw>`.
///
/// Untrusted input, like `InviteLink`: anything that is not exactly one of those shapes yields
/// `nil`. The token is restricted to the base64url alphabet and a sane length, so a hostile link
/// can't smuggle path segments or control characters into the API call that spends it. The token
/// is a one-hour, single-use credential: it lives in memory for the screen and is never stored.
public struct PasswordResetLink: Equatable, Hashable, Sendable {
	public let token: String

	/// Tokens are 47 characters today (`rst_` plus 43 base64url); the bounds leave room for a
	/// format change without accepting arbitrary text.
	public static let tokenLengths = 16...256

	/// The one path segment, shared with the web route and the universal-link list.
	public static let route = "reset-password"

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
			// `maskin://reset-password?token=…` (an empty or `/` path is the same place).
			guard c.host?.lowercased() == Self.route, Self.segments(c.path).isEmpty else { return nil }
		case "https":
			guard let host = c.host?.lowercased(), universalHosts.contains(host),
				Self.segments(c.path) == [Self.route]
			else { return nil }
		default:
			return nil
		}
		// Exactly one `token` parameter: a duplicate is ambiguous, so it is not a reset link.
		let tokens = (c.queryItems ?? []).filter { $0.name == "token" }
		guard tokens.count == 1, let value = tokens[0].value else { return nil }
		self.init(token: value)
	}

	private static func segments(_ path: String) -> [String] {
		path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
	}

	private static func isTokenCharacter(_ ch: Character) -> Bool {
		guard ch.isASCII else { return false }
		return ch.isLetter || ch.isNumber || ch == "-" || ch == "_"
	}
}
