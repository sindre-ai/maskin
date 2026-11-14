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
	/// `…/<ws>/chats/<id>?thread=<rootId>`: one reply thread of a chat (the root message's id).
	case thread(workspaceId: String, id: String, rootId: Int)
	/// `…/<ws>/files/<id>`: a file (an HTML page, document, image or PDF) an agent made or attached.
	case file(workspaceId: String, id: String)
	/// `maskin://<ws>/notifications` (or the web's workspace home): open the inbox.
	case notifications(workspaceId: String)
	/// `…/<ws>/agents`: the Agents screen ("See all" on the agents Live Activity).
	case agents(workspaceId: String)
	/// `…/<ws>/agents/<id>`: one agent.
	case agent(workspaceId: String, id: String)
	/// `…/<ws>/loops/<id>`: one loop (a flow).
	case loop(workspaceId: String, id: String)
	/// `…/<ws>/triggers/<id>`: one trigger.
	case trigger(workspaceId: String, id: String)
	/// `…/<ws>/sessions/<id>`: one agent session (the app shows its log).
	case session(workspaceId: String, id: String)
	/// `…/<ws>/settings` or `…/<ws>/settings/<page>`: Settings, on one page when the link names it.
	case settings(workspaceId: String, page: SettingsPage?)
	/// `…/<ws>/triggers`, `…/<ws>/loops`, `…/<ws>/chats`: a list page, which opens the matching tab or sheet.
	case list(workspaceId: String, kind: ListKind)

	/// The Settings pages a link can open. Raw values are the app's canonical path segment; the web's
	/// `keychain` and `mcp` pages live on the app's Keys page, `extensions` on Item types.
	public enum SettingsPage: String, Equatable, Hashable, Sendable {
		case members, integrations, keys, skills, billing, notifications, objects

		init?(webSegment: String) {
			switch webSegment {
			case "keychain", "mcp": self = .keys
			case "extensions": self = .objects
			default: self.init(rawValue: webSegment)
			}
		}
	}

	/// The list pages a link can open. Raw values are the web's path segment (flows are `loops` there).
	public enum ListKind: String, Equatable, Hashable, Sendable {
		case triggers, loops, chats
	}

	public static let scheme = "maskin"

	/// Origins whose `https` URLs count as universal links. Anything else is foreign.
	public static let defaultUniversalHosts: Set<String> = ["maskin.io"]

	public var workspaceId: String {
		switch self {
		case .object(let ws, _), .chat(let ws, _), .thread(let ws, _, _), .file(let ws, _),
			.notifications(let ws), .agents(let ws), .agent(let ws, _), .loop(let ws, _), .trigger(let ws, _),
			.session(let ws, _), .settings(let ws, _), .list(let ws, _): ws
		}
	}

	/// The canonical `maskin://` form, as the backend puts it in push payloads.
	public var url: URL {
		var c = URLComponents()
		c.scheme = Self.scheme
		c.host = workspaceId
		if case .thread(_, _, let rootId) = self { c.queryItems = [URLQueryItem(name: "thread", value: String(rootId))] }
		switch self {
		case .object(_, let id): c.path = "/objects/\(id)"
		case .chat(_, let id), .thread(_, let id, _): c.path = "/chats/\(id)"
		case .file(_, let id): c.path = "/files/\(id)"
		case .notifications: c.path = "/notifications"
		case .agents: c.path = "/agents"
		case .agent(_, let id): c.path = "/agents/\(id)"
		case .loop(_, let id): c.path = "/loops/\(id)"
		case .trigger(_, let id): c.path = "/triggers/\(id)"
		case .session(_, let id): c.path = "/sessions/\(id)"
		case .settings(_, let page): c.path = "/settings" + (page.map { "/\($0.rawValue)" } ?? "")
		case .list(_, let kind): c.path = "/\(kind.rawValue)"
		}
		return c.url!
	}

	/// The equivalent web-app URL, for sharing.
	public func universalURL(host: String = "maskin.io") -> URL {
		var c = URLComponents()
		c.scheme = "https"
		c.host = host
		if case .thread(_, _, let rootId) = self { c.queryItems = [URLQueryItem(name: "thread", value: String(rootId))] }
		switch self {
		case .object(let ws, let id): c.path = "/\(ws)/objects/\(id)"
		case .chat(let ws, let id), .thread(let ws, let id, _): c.path = "/\(ws)/chats/\(id)"
		case .file(let ws, let id): c.path = "/\(ws)/files/\(id)"
		case .notifications(let ws): c.path = "/\(ws)"
		case .agents(let ws): c.path = "/\(ws)/agents"
		case .agent(let ws, let id): c.path = "/\(ws)/agents/\(id)"
		case .loop(let ws, let id): c.path = "/\(ws)/loops/\(id)"
		case .trigger(let ws, let id): c.path = "/\(ws)/triggers/\(id)"
		case .session(let ws, let id): c.path = "/\(ws)/sessions/\(id)"
		case .settings(let ws, let page): c.path = "/\(ws)/settings" + (page.map { "/\($0.rawValue)" } ?? "")
		case .list(let ws, let kind): c.path = "/\(ws)/\(kind.rawValue)"
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
		// `invite` is a route, not a workspace: invitation links are `InviteLink`'s, and a bare
		// `/invite` must not be read as the inbox of a workspace called "invite".
		guard workspace.lowercased() != "invite" else { return nil }

		switch rest.count {
		case 0:
			// The bare workspace URL is the web's "pulse"/inbox page. `maskin://<ws>` alone too.
			self = .notifications(workspaceId: workspace)
		case _ where rest.first == "settings":
			// `settings`, `settings/<page>`, and one id below a page (`settings/integrations/google-drive`),
			// which opens that page. Anything else under settings is not a page the app has.
			guard rest.count <= 3, rest.dropFirst(2).allSatisfy(Self.isSafeID) else { return nil }
			if rest.count == 1 {
				self = .settings(workspaceId: workspace, page: nil)
			} else if let page = SettingsPage(webSegment: rest[1]) {
				self = .settings(workspaceId: workspace, page: page)
			} else {
				return nil
			}
		case 1 where rest[0] == "notifications":
			self = .notifications(workspaceId: workspace)
		case 1 where rest[0] == "agents":
			self = .agents(workspaceId: workspace)
		case 1 where ListKind(rawValue: rest[0]) != nil:
			self = .list(workspaceId: workspace, kind: ListKind(rawValue: rest[0])!)
		case 2:
			guard Self.isSafeID(rest[1]) else { return nil }
			switch rest[0] {
			case "objects": self = .object(workspaceId: workspace, id: rest[1])
			case "chats":
				if let rootId = Self.threadRoot(c.queryItems) {
					self = .thread(workspaceId: workspace, id: rest[1], rootId: rootId)
				} else {
					self = .chat(workspaceId: workspace, id: rest[1])
				}
			case "files": self = .file(workspaceId: workspace, id: rest[1])
			case "agents": self = .agent(workspaceId: workspace, id: rest[1])
			case "loops": self = .loop(workspaceId: workspace, id: rest[1])
			case "triggers": self = .trigger(workspaceId: workspace, id: rest[1])
			case "sessions": self = .session(workspaceId: workspace, id: rest[1])
			default: return nil
			}
		default:
			return nil
		}
	}

	/// Whether a URL is a page of a Maskin workspace (`maskin://<ws>/…`, or `https://maskin.io/<ws>/…`
	/// with a workspace id first), whether or not the app has a screen for it. A page the app cannot
	/// open must not fall through to Safari, where the person is signed out.
	public static func isWorkspacePage(
		_ url: URL, universalHosts: Set<String> = DeepLink.defaultUniversalHosts
	) -> Bool {
		guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.user == nil, c.password == nil,
			c.port == nil
		else { return false }
		switch c.scheme?.lowercased() {
		case scheme: return c.host.map { UUID(uuidString: $0) != nil } ?? false
		case "https":
			guard let host = c.host?.lowercased(), universalHosts.contains(host),
				let first = segments(c.path).first
			else { return false }
			return UUID(uuidString: first) != nil
		default: return false
		}
	}

	public init?(string: String, universalHosts: Set<String> = DeepLink.defaultUniversalHosts) {
		guard let url = URL(string: string) else { return nil }
		self.init(url: url, universalHosts: universalHosts)
	}

	/// The `thread` query value: exactly one item holding a positive integer of at most nine digits.
	/// Anything else (absent, repeated, signed, padded, huge) reads as no thread, so the link still
	/// opens the chat.
	private static func threadRoot(_ items: [URLQueryItem]?) -> Int? {
		let found = (items ?? []).filter { $0.name == "thread" }
		guard found.count == 1, let value = found[0].value, (1...9).contains(value.utf8.count),
			value.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let n = Int(value), n > 0
		else { return nil }
		return n
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
