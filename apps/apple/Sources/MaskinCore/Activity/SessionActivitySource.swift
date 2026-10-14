import Foundation
import MaskinAPI

/// Where activity traces come from. A protocol so the store tests without a server and the
/// backend can change shape (the steps endpoint today, raw log envelopes tomorrow) without the
/// UI noticing.
public protocol SessionActivitySource: Sendable {
	/// The newest `limitTurns` turns of a session. `background` marks a fetch the user did not
	/// ask for (history for a finished turn): it declines to use Low Data Mode connections.
	func activity(sessionID: String, limitTurns: Int, background: Bool) async throws -> SessionActivity
}

/// `GET /api/sessions/{id}/activity`. Hand-rolled over URLSession because the endpoint is not in
/// the generated client's `openapi.json` snapshot yet; it still sends the same headers
/// (`Authorization`, `X-Workspace-Id`, `X-Client-Source`) as every other call.
public struct HTTPSessionActivitySource: SessionActivitySource {
	/// Hard ceiling on a response, so a runaway trace can't eat a cellular plan.
	public static let maxBodyBytes = 512 * 1024
	/// Turns per request never exceed the server's `limit_turns` max.
	public static let maxTurns = 20

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

	public func activity(sessionID: String, limitTurns: Int, background: Bool) async throws
		-> SessionActivity
	{
		guard let creds = await credentials(), let workspace = creds.workspaceId else {
			throw ChatsError("Not signed in.")
		}
		let turns = min(max(limitTurns, 1), Self.maxTurns)
		var components = URLComponents(
			url: baseURL.appendingPathComponent("api/sessions/\(sessionID)/activity"),
			resolvingAgainstBaseURL: false)
		components?.queryItems = [URLQueryItem(name: "limit_turns", value: String(turns))]
		guard let url = components?.url else { throw ChatsError("Bad activity URL.") }
		var request = URLRequest(url: url)
		request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		request.setValue(workspace, forHTTPHeaderField: "X-Workspace-Id")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.timeoutInterval = 15
		if background { request.allowsConstrainedNetworkAccess = false }
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw ChatsError("No response.") }
		guard (200..<300).contains(http.statusCode) else {
			throw ChatsHTTPError(status: http.statusCode, message: "Couldn't load the agent's steps.")
		}
		guard data.count <= Self.maxBodyBytes else { throw ChatsError("The agent's steps are too large.") }
		return try ActivityParser.parse(data)
	}
}

extension HTTPSessionActivitySource {
	@MainActor
	public init(environment: AppEnvironment) {
		self.init(
			baseURL: environment.baseURL, clientSource: environment.clientSource,
			credentials: environment.auth.credentialsProvider)
	}
}
