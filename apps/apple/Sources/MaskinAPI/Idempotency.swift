import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Carries the `Idempotency-Key` for the write currently being issued.
///
/// The offline outbox generates one key per queued mutation, persists it, and replays the write
/// inside `IdempotencyKey.$current.withValue(key) { ... }` so a retry after a lost response is
/// recognised by the backend instead of applied twice. Outside such a scope writes go out
/// without a key, exactly as before.
public enum IdempotencyKey {
	@TaskLocal public static var current: String?

	/// A fresh key for a new mutation. Store it with the queued work, never regenerate on retry.
	public static func make() -> String { UUID().uuidString }
}

/// Stamps `Idempotency-Key` on write requests when `IdempotencyKey.current` is set. An explicit
/// header already on the request wins.
struct IdempotencyMiddleware: ClientMiddleware {
	static let header = HTTPField.Name("Idempotency-Key")!
	static let writeMethods: Set<HTTPRequest.Method> = [.post, .put, .patch, .delete]

	func intercept(
		_ request: HTTPRequest,
		body: HTTPBody?,
		baseURL: URL,
		operationID: String,
		next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
	) async throws -> (HTTPResponse, HTTPBody?) {
		var request = request
		if let key = IdempotencyKey.current, Self.writeMethods.contains(request.method),
			request.headerFields[Self.header] == nil
		{
			request.headerFields[Self.header] = key
		}
		return try await next(request, body, baseURL)
	}
}
