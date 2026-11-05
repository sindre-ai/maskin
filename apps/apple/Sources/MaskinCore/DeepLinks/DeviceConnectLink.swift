import Foundation

/// `maskin://connect?code=BCDF-2345`: the web or the Mac app asking this phone to approve a device
/// sign-in. It names no workspace, so it is not a `DeepLink`: the code is all it carries, and the
/// Settings "Sign in a device" page checks it against the server before anything is approved.
///
/// Untrusted input like every link: exactly one `code` parameter of eight letters or digits (an
/// optional dash after the fourth), nothing else in the URL.
public struct DeviceConnectLink: Equatable, Hashable, Sendable {
	/// The code as the page shows it: "BCDF-2345".
	public let code: String

	public init?(url: URL) {
		guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
			c.scheme?.lowercased() == DeepLink.scheme, c.host?.lowercased() == "connect",
			c.user == nil, c.password == nil, c.port == nil,
			c.path.isEmpty || c.path == "/"
		else { return nil }
		let codes = (c.queryItems ?? []).filter { $0.name == "code" }
		guard codes.count == 1, let raw = codes[0].value else { return nil }
		self.init(code: raw)
	}

	public init?(code raw: String) {
		let upper = raw.uppercased()
		let dashless = upper.filter { $0 != "-" }
		guard upper.count == dashless.count || (upper.count == 9 && upper.dropFirst(4).first == "-"),
			dashless.count == 8, dashless.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
		else { return nil }
		code = "\(dashless.prefix(4))-\(dashless.dropFirst(4))"
	}
}
