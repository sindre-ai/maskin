import Foundation

#if os(iOS)
	import CallKit
#endif

/// Whether the phone has Maskin switched on under Settings, Phone, Call Blocking and Identification.
/// `unknown` is what the phone says when it cannot tell (a simulator, or an error).
public enum CallerIDStatus: String, Sendable, Equatable {
	case enabled, disabled, unknown
}

/// The phone's call directory, behind a protocol so the store tests without a phone.
public protocol CallDirectoryControlling: Sendable {
	/// The phone's own on or off answer for the Maskin extension.
	func status() async -> CallerIDStatus
	/// Asks the phone to load the extension again, so it re-reads the file. A reload replaces the whole list.
	func reload() async throws
}

/// The real call directory (CallKit). iPhone only: other platforms have no call screen, so they
/// report `unknown` and reload nothing.
public struct SystemCallDirectory: CallDirectoryControlling {
	/// The bundle id of `Apps/MaskinCallDirectory` (project.yml).
	public static let extensionIdentifier = "io.maskin.app.calldirectory"

	public init() {}

	#if os(iOS)
		public func status() async -> CallerIDStatus {
			await withCheckedContinuation { continuation in
				CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(
					withIdentifier: Self.extensionIdentifier
				) { status, error in
					guard error == nil else { return continuation.resume(returning: .unknown) }
					switch status {
					case .enabled: continuation.resume(returning: .enabled)
					case .disabled: continuation.resume(returning: .disabled)
					default: continuation.resume(returning: .unknown)
					}
				}
			}
		}

		public func reload() async throws {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
				CXCallDirectoryManager.sharedInstance.reloadExtension(
					withIdentifier: Self.extensionIdentifier
				) { error in
					if let error { continuation.resume(throwing: error) } else { continuation.resume() }
				}
			}
		}
	#else
		public func status() async -> CallerIDStatus { .unknown }
		public func reload() async throws {}
	#endif
}
