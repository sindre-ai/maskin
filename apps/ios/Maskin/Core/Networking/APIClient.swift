import Foundation

/// Mirrors `apps/web/src/lib/api.ts`'s `request<T>()`. One generic entry point; every
/// resource-specific call in `Endpoints/` goes through this.
struct APIError: Error, LocalizedError {
	let status: Int
	let code: String?
	let message: String
	let fieldErrors: [String: [String]]

	var errorDescription: String? { message }
	var hasFieldErrors: Bool { !fieldErrors.isEmpty }
}

private struct APIErrorBody: Decodable {
	struct Detail: Decodable {
		let field: String?
		let message: String
	}

	struct ErrorObject: Decodable {
		let code: String?
		let message: String
		let details: [Detail]?
	}

	// Structured `{ error: { code, message, details? } }` or legacy `{ error: "message" }`.
	let error: ErrorValue

	enum ErrorValue: Decodable {
		case structured(ErrorObject)
		case legacy(String)

		init(from decoder: Decoder) throws {
			let container = try decoder.singleValueContainer()
			if let object = try? container.decode(ErrorObject.self) {
				self = .structured(object)
			} else {
				self = .legacy((try? container.decode(String.self)) ?? "Unknown error")
			}
		}
	}
}

actor APIClient {
	static let shared = APIClient()

	/// Base URL for the running `apps/dev` backend — see `DevServer` (native requests
	/// aren't subject to browser CORS, so no backend config change is needed here).
	var baseURL = DevServer.apiBaseURL

	private let session: URLSession
	private let decoder: JSONDecoder
	private let encoder: JSONEncoder

	init(session: URLSession = .shared) {
		self.session = session
		self.decoder = JSONDecoder()
		self.decoder.keyDecodingStrategy = .convertFromSnakeCase
		self.encoder = JSONEncoder()
	}

	enum Method: String { case get = "GET", post = "POST", patch = "PATCH", delete = "DELETE" }

	func request<T: Decodable>(
		_ path: String,
		method: Method = .get,
		query: [String: String?] = [:],
		body: Encodable? = nil,
		workspaceId: String? = nil
	) async throws -> T {
		var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
		let items = query.compactMap { key, value -> URLQueryItem? in
			guard let value else { return nil }
			return URLQueryItem(name: key, value: value)
		}
		if !items.isEmpty { components.queryItems = items }

		var request = URLRequest(url: components.url!)
		request.httpMethod = method.rawValue

		if let apiKey = await AuthManager.shared.apiKey {
			request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		}
		if let workspaceId {
			request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try encoder.encode(AnyEncodable(body))
		}

		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else {
			throw APIError(status: 0, code: nil, message: "No response", fieldErrors: [:])
		}

		guard (200..<300).contains(http.statusCode) else {
			throw Self.decodeError(data: data, status: http.statusCode)
		}

		if data.isEmpty, T.self == EmptyResponse.self {
			return EmptyResponse() as! T
		}
		return try decoder.decode(T.self, from: data)
	}

	private static func decodeError(data: Data, status: Int) -> APIError {
		guard let body = try? JSONDecoder().decode(APIErrorBody.self, from: data) else {
			return APIError(status: status, code: nil, message: "Request failed (\(status))", fieldErrors: [:])
		}
		switch body.error {
		case .legacy(let message):
			return APIError(status: status, code: nil, message: message, fieldErrors: [:])
		case .structured(let object):
			var fieldErrors: [String: [String]] = [:]
			for detail in object.details ?? [] {
				let field = detail.field ?? "_root"
				fieldErrors[field, default: []].append(detail.message)
			}
			return APIError(status: status, code: object.code, message: object.message, fieldErrors: fieldErrors)
		}
	}
}

struct EmptyResponse: Decodable {}

/// Type-erasing wrapper so `request(body:)` can accept any `Encodable` value.
private struct AnyEncodable: Encodable {
	private let value: Encodable
	init(_ value: Encodable) { self.value = value }
	func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
