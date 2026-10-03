import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// What every authenticated request carries. The key is the `ank_…` API key returned by
/// `POST /api/auth/login`; the workspace scopes every workspace-level route (the backend's
/// `authMiddleware` checks membership from this header, so callers don't re-check it).
public struct MaskinCredentials: Sendable, Equatable {
	public var apiKey: String
	public var workspaceId: String?

	public init(apiKey: String, workspaceId: String? = nil) {
		self.apiKey = apiKey
		self.workspaceId = workspaceId
	}
}

/// Source of truth for credentials at request time, so a workspace switch or sign-out takes
/// effect on the very next call without rebuilding the client.
public typealias MaskinCredentialsProvider = @Sendable () async -> MaskinCredentials?

/// Adds `Authorization`, `X-Workspace-Id` and `X-Client-Source` to every request.
struct MaskinAuthMiddleware: ClientMiddleware {
	let credentials: MaskinCredentialsProvider
	let clientSource: String
	/// Called with the API key that was sent when the server answers 401, so the app can end a
	/// revoked or rotated session in one place instead of every store noticing separately.
	var onUnauthorized: (@Sendable (_ apiKey: String) async -> Void)?

	func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		var request = request
		request.headerFields[.xClientSource] = clientSource
		var sentKey: String?
		if let creds = await credentials() {
			sentKey = creds.apiKey
			request.headerFields[.authorization] = "Bearer \(creds.apiKey)"
			if let workspaceId = creds.workspaceId {
				request.headerFields[.xWorkspaceId] = workspaceId
			}
		}
		let result = try await next(request, body, baseURL)
		// Only a request that carried a key can mean "that key is bad" (login's own 401 is not).
		if result.0.status.code == 401, let sentKey { await onUnauthorized?(sentKey) }
		return result
	}
}

extension HTTPField.Name {
	static let xClientSource = HTTPField.Name("X-Client-Source")!
	static let xWorkspaceId = HTTPField.Name("X-Workspace-Id")!
}

public enum MaskinClient {
	/// Build the generated client. `clientSource` is the `X-Client-Source` value (`ios`,
	/// `macos`, `watchos`, `tvos`) so server-side analytics can tell the surfaces apart.
	public static func make(
		serverURL: URL,
		clientSource: String,
		credentials: @escaping MaskinCredentialsProvider,
		onUnauthorized: (@Sendable (_ apiKey: String) async -> Void)? = nil,
		session: URLSession? = nil
	) -> Client {
		Client(
			serverURL: serverURL,
			transport: session.map { URLSessionTransport(configuration: .init(session: $0)) }
				?? URLSessionTransport(),
			middlewares: [
				MaskinAuthMiddleware(
					credentials: credentials, clientSource: clientSource, onUnauthorized: onUnauthorized),
				IdempotencyMiddleware(),
			]
		)
	}
}
