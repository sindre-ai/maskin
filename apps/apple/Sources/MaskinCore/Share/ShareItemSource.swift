import Foundation
import UniformTypeIdentifiers

/// One item the host app handed the extension. A protocol so extraction tests with fakes; the
/// production implementation wraps `NSItemProvider`.
public protocol ShareItemSource: Sendable {
	var typeIdentifiers: [String] { get }
	var suggestedName: String? { get }
	/// The value of a URL item (a web page, or a file URL).
	func loadURL() async throws -> URL?
	func loadText() async throws -> String?
	/// Runs `body` with the item's file while it exists. The system deletes the file as soon as the
	/// callback returns, so anything worth keeping is copied or transformed inside `body`.
	func withFile<T: Sendable>(
		conformingTo type: UTType, _ body: @escaping @Sendable (URL) throws -> T
	) async throws -> T
}

struct ShareItemUnreadable: Error {}

// `NSItemProvider.suggestedName` doesn't exist on watchOS or tvOS, and the share extension is
// iOS-only.
#if !os(watchOS) && !os(tvOS)
public struct NSItemProviderSource: ShareItemSource, @unchecked Sendable {
	private let provider: NSItemProvider

	public init(_ provider: NSItemProvider) { self.provider = provider }

	public var typeIdentifiers: [String] { provider.registeredTypeIdentifiers }
	public var suggestedName: String? { provider.suggestedName }

	public func loadURL() async throws -> URL? {
		try await withCheckedThrowingContinuation { continuation in
			_ = provider.loadObject(ofClass: URL.self) { url, error in
				if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: url) }
			}
		}
	}

	public func loadText() async throws -> String? {
		try await withCheckedThrowingContinuation { continuation in
			_ = provider.loadObject(ofClass: String.self) { text, error in
				if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: text) }
			}
		}
	}

	public func withFile<T: Sendable>(
		conformingTo type: UTType, _ body: @escaping @Sendable (URL) throws -> T
	) async throws -> T {
		let identifier =
			provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: type) == true }
			?? type.identifier
		return try await withCheckedThrowingContinuation { continuation in
			_ = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
				guard let url else {
					continuation.resume(throwing: error ?? ShareItemUnreadable())
					return
				}
				continuation.resume(with: Result { try body(url) })
			}
		}
	}
}
#endif

extension ShareItemSource {
	func conforms(to type: UTType) -> Bool {
		typeIdentifiers.contains { UTType($0)?.conforms(to: type) == true }
	}
}
