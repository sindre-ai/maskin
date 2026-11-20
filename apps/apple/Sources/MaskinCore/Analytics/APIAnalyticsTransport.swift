import Foundation
import MaskinAPI

/// Production `AnalyticsTransport`: `POST /api/telemetry/client`, a batch of at most 50 events with
/// the time each action happened. Hand-encoded `URLSession` request, like `APIDeviceRegistrar`,
/// because the checked-in generated client predates the route. The workspace goes in
/// `X-Workspace-Id`, so the server can apply that workspace's share-usage and anonymise settings.
/// No event content is ever put in an error message or a log line.
public struct APIAnalyticsTransport: AnalyticsTransport {
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

	public func send(_ events: [AnalyticsEvent], workspaceId: String) async throws {
		let request = try await makeRequest(events, workspaceId: workspaceId)
		let status: Int
		do {
			let (_, response) = try await session.data(for: request)
			status = (response as? HTTPURLResponse)?.statusCode ?? 0
		} catch {
			throw AnalyticsSendFailed()
		}
		switch status {
		case 200..<300: return
		// A sign-in problem, a timeout or a rate limit passes, and a server error is the server's:
		// keep the events and try again later.
		case 401, 408, 429, 500...: throw AnalyticsSendFailed()
		// Any other refusal is about the batch itself and will not change on a retry.
		case 400..<500: throw AnalyticsRejected()
		default: throw AnalyticsSendFailed()
		}
	}

	/// Built apart from sending so tests can read the URL, headers and body.
	func makeRequest(_ events: [AnalyticsEvent], workspaceId: String) async throws -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/telemetry/client"))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		}
		request.httpBody = try Self.body(events)
		return request
	}

	static func body(_ events: [AnalyticsEvent]) throws -> Data {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime]
		let wire = events.map {
			Wire(name: $0.name, properties: $0.properties, occurred_at: formatter.string(from: $0.occurredAt))
		}
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		return try encoder.encode(["events": wire])
	}

	private struct Wire: Encodable {
		var name: String
		var properties: AnalyticsProperties
		var occurred_at: String
	}
}

/// The batch did not get through (offline, a server error, a sign-in problem). It stays queued.
struct AnalyticsSendFailed: Error {}
