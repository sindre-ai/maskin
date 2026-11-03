import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Carries the `Idempotency-Key` for the write currently being issued.
///
/// The offline outbox generates one key per queued mutation, persists it, and replays the write
/// inside `IdempotencyKey.bind(key) { ... }` so a retry after a lost response is
/// recognised by the backend instead of applied twice. Outside such a scope writes go out
/// without a key, exactly as before.
public enum IdempotencyKey {
	@TaskLocal public static var current: String?

	/// Runs `operation` with `key` as the current key, unless that key is already the current one.
	///
	/// Use this instead of `$current.withValue(_:)`. The outbox binds the key around a queued
	/// write, and the source that performs the write binds it again; a nested `withValue` aborts
	/// inside the iOS 17 Swift runtime (TestFlight crashes on iOS 17.1.2, all in chat send).
	///
	/// Contract: when `key` equals the current key this is a plain call, so a source can always
	/// bind the key it was given and stay correct both inside the outbox (same key, no second
	/// binding) and outside it (the only binding). A *different* key, or `nil`, still rebinds,
	/// which is a nested `withValue`. That is accepted only where nothing keyed is above it:
	/// `APISettingsSource.regenerate` pins `nil` and is never queued in the outbox. Do not add a
	/// new path that binds a different key inside an outbox executor.
	public static func bind<T>(
		_ key: String?,
		isolation: isolated (any Actor)? = #isolation,
		operation: () async throws -> T
	) async rethrows -> T {
		if current == key { return try await operation() }
		rebindObserver?(key)
		return try await $current.withValue(key, operation: operation, isolation: isolation)
	}

	/// Test hook: called each time `bind` really enters `$current.withValue`, with the key bound.
	/// Lets a test assert that a path binds the key once, which the key's value alone cannot show
	/// (a nested `withValue` yields the right value on every OS except the one that crashes).
	nonisolated(unsafe) static var rebindObserver: (@Sendable (String?) -> Void)?

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
