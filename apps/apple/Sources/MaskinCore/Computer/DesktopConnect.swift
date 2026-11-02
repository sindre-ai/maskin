import Foundation
import MaskinAPI

/// What `POST /api/desktop/connect` hands back: a one-time ticket for the stream (valid 30 seconds,
/// used once) and the screen password. Both are secrets, so neither is ever printed.
public struct DesktopTicket: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
	public var ticket: String
	public var path: String
	public var password: String

	public init(ticket: String, path: String, password: String) {
		self.ticket = ticket
		self.path = path
		self.password = password
	}

	public var description: String { "DesktopTicket(redacted)" }
	public var debugDescription: String { description }

	/// The WebSocket address for this ticket on `base`'s host: wss for https, ws for the plain-http dev server.
	public func streamURL(base: URL) -> URL? {
		guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
		parts.scheme = base.scheme == "http" ? "ws" : "wss"
		parts.path = path
		parts.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
		return parts.url
	}
}

public enum DesktopConnectError: Error, Equatable, Sendable {
	/// No agent to open: the card could not say whose computer this is. Nothing is sent.
	case missingAgent
	case signedOut
	/// 403: only a workspace writer may open a computer.
	case notAllowed
	/// 404: computers are off here, or the agent is not in this workspace.
	case unavailable
	/// 503: no capacity for a new computer right now.
	case noCapacity
	case network
	case server(status: Int)

	/// What the Computer screen shows under "Couldn't open the desktop".
	public var message: String {
		switch self {
		case .missingAgent: "Can't tell which computer this is."
		case .signedOut: "You're signed out. Sign in again to open the computer."
		case .notAllowed: "Only people who can edit this workspace can open a computer."
		case .unavailable: "This computer isn't available."
		case .noCapacity: "No computer is free right now. Try again in a minute."
		case .network: "Couldn't reach Maskin. Check your connection and try again."
		case .server: "Couldn't start the desktop. Try again."
		}
	}
}

/// Asks the server for a fresh ticket. Every connect and every reconnect calls this again: a
/// ticket is single-use and short-lived, so one is never kept or reused.
public protocol DesktopConnecting: Sendable {
	func connect(agentID: String?) async throws -> DesktopTicket
}

/// `/api/desktop/*` is not in the generated client (its path filter leaves it out), so this is one
/// hand-written request with the same headers the client's middleware adds.
public struct APIDesktopConnect: DesktopConnecting {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func connect(agentID: String?) async throws -> DesktopTicket {
		guard let agentID, !agentID.isEmpty else { throw DesktopConnectError.missingAgent }
		guard let creds = await credentials() else { throw DesktopConnectError.signedOut }
		let request = Self.makeRequest(baseURL: baseURL, clientSource: clientSource, credentials: creds, agentID: agentID)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch let error as URLError where error.code != .cancelled {
			throw DesktopConnectError.network
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		switch status {
		case 200..<300: break
		case 400: throw DesktopConnectError.missingAgent
		case 401: throw DesktopConnectError.signedOut
		case 403: throw DesktopConnectError.notAllowed
		case 404: throw DesktopConnectError.unavailable
		case 503: throw DesktopConnectError.noCapacity
		default: throw DesktopConnectError.server(status: status)
		}
		struct Wire: Decodable {
			var ticket: String
			var path: String
			var password: String
		}
		guard let wire = try? JSONDecoder().decode(Wire.self, from: data), !wire.ticket.isEmpty, !wire.path.isEmpty
		else { throw DesktopConnectError.server(status: status) }
		return DesktopTicket(ticket: wire.ticket, path: wire.path, password: wire.password)
	}

	static func makeRequest(
		baseURL: URL, clientSource: String, credentials: MaskinCredentials, agentID: String
	) -> URLRequest {
		var parts = URLComponents(
			url: baseURL.appendingPathComponent("api/desktop/connect"), resolvingAgainstBaseURL: false)!
		parts.queryItems = [URLQueryItem(name: "agent_id", value: agentID)]
		var request = URLRequest(url: parts.url!)
		request.httpMethod = "POST"
		// A computer starting for the first time can take up to a minute.
		request.timeoutInterval = 120
		// A ticket must never come from a cache.
		request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
		if let workspaceId = credentials.workspaceId {
			request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
		}
		return request
	}
}
