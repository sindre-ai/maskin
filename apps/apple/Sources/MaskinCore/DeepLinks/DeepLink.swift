import Foundation

/// A place in the app a URL can point at. Parsed from the push payload's `deep_link`
/// (`maskin://<workspaceId>/objects/<id>`) and from the web app's universal-link routes
/// (`https://maskin.io/<workspaceId>/objects/<id>`).
///
/// Untrusted input: links arrive from push payloads, other apps and the web. Parsing is strict
/// and total: anything that is not exactly one of the known shapes yields `nil`, never a
/// partially-valid link. Ids are restricted to a conservative charset, so a hostile link can't
/// smuggle path segments, queries or control characters into a later API call.
public enum DeepLink: Equatable, Hashable, Sendable {
	/// `…/<ws>/objects/<id>`: an insight, bet, task or any other object.
	case object(workspaceId: String, id: String)
	/// `…/<ws>/chats/<id>`.
	case chat(workspaceId: String, id: String)
	/// `maskin://<ws>/notifications` (or the web's workspace home): open the inbox.
	case notifications(workspaceId: String)

	public static let scheme = "maskin"

	/// Origins whose `https` URLs count as universal links. Anything else is foreign.
	public static let defaultUniversalHosts: Set<String> = ["maskin.io", "www.maskin.io", "app.maskin.io"]

	public var workspaceId: String {
		switch self {
		case .object(let ws, _), .chat(let ws, _), .notifications(let ws): ws
		}
	}

	/// The canonical `maskin://` form, as the backend puts it in push payloads.
	public var url: URL {
		var c = URLComponents()
		c.scheme = Self.scheme
		c.host = workspaceId
		switch self {
		case .object(_, let id): c.path = "/objects/\(id)"
		case .chat(_, let id): c.path = "/chats/\(id)"
		case .notifications: c.path = "/notifications"
		}
		return c.url!
	}

	/// The equivalent web-app URL, for sharing.
	public func universalURL(host: String = "maskin.io") -> URL {
		var c = URLComponents()
		c.scheme = "https"
		c.host = host
		switch self {
		case .object(let ws, let id): c.path = "/\(ws)/objects/\(id)"
		case .chat(let ws, let id): c.path = "/\(ws)/chats/\(id)"
		case .notifications(let ws): c.path = "/\(ws)"
		}
		return c.url!
	}

	// MARK: Parsing

	public init?(url: URL, universalHosts: Set<String> = DeepLink.defaultUniversalHosts) {
		guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
		// No credentials or port tricks on either form.
		guard c.user == nil, c.password == nil else { return nil }

		let workspace: String
		var rest: [String]
		switch c.scheme?.lowercased() {
		case Self.scheme:
			guard c.port == nil, let host = c.host, !host.isEmpty else { return nil }
			workspace = host
			rest = Self.segments(c.path)
		case "https":
			guard c.port == nil, let host = c.host?.lowercased(), universalHosts.contains(host) else {
				return nil
			}
			var parts = Self.segments(c.path)
			guard !parts.isEmpty else { return nil }
			workspace = parts.removeFirst()
			rest = parts
		default:
			return nil
		}
		guard Self.isSafeID(workspace) else { return nil }

		switch rest.count {
		case 0:
			// The bare workspace URL is the web's "pulse"/inbox page. `maskin://<ws>` alone too.
			self = .notifications(workspaceId: workspace)
		case 1 where rest[0] == "notifications":
			self = .notifications(workspaceId: workspace)
		case 2:
			guard Self.isSafeID(rest[1]) else { return nil }
			switch rest[0] {
			case "objects": self = .object(workspaceId: workspace, id: rest[1])
			case "chats": self = .chat(workspaceId: workspace, id: rest[1])
			default: return nil
			}
		default:
			return nil
		}
	}

	public init?(string: String, universalHosts: Set<String> = DeepLink.defaultUniversalHosts) {
		guard let url = URL(string: string) else { return nil }
		self.init(url: url, universalHosts: universalHosts)
	}

	/// Path segments, rejecting empty (`//`) and dot segments by returning a poisoned list that
	/// no shape matches. A single trailing slash is tolerated.
	private static func segments(_ path: String) -> [String] {
		var parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
		if parts.first == "" { parts.removeFirst() }
		if parts.last == "" { parts.removeLast() }
		if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return ["\u{0}"] }
		return parts
	}

	/// Ids are UUIDs in practice; accept the broader `[A-Za-z0-9_-]{1,64}` so fixtures and future
	/// id formats work, but nothing that could alter a path or query.
	static func isSafeID(_ s: String) -> Bool {
		guard (1...64).contains(s.utf8.count) else { return false }
		return s.utf8.allSatisfy {
			($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
				|| $0 == 0x2D || $0 == 0x5F
		}
	}
}
