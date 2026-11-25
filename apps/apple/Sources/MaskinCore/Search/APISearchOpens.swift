import Foundation
import MaskinAPI

/// Reports that the person opened a search result, so the server can rank it higher next time
/// (frecency). The server does the ranking; the phone only writes.
public protocol SearchOpensRemote: Sendable {
	/// `POST /api/search/opens`: the person opened this result from a search. Best effort.
	func recordOpen(entityId: String) async
}

/// Production `SearchOpensRemote`. Plain `URLSession`, not the generated client: the checked-in
/// client is older than these routes (same reason as `APIChatSearch`).
public struct APISearchOpens: SearchOpensRemote {
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

	public func recordOpen(entityId: String) async {
		guard let body = try? JSONEncoder().encode(["entity_id": entityId]) else { return }
		let request = await makeRequest(method: "POST", body: body)
		_ = try? await session.data(for: request)
	}

	/// Built apart from sending so tests can read the URL, method and headers.
	func makeRequest(method: String, body: Data?) async -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/search/opens"))
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = creds.workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
		}
		return request
	}
}
