import Foundation
import Observation

/// The no-workspaces screen's "Create workspace". Not optimistic: the new workspace's id comes
/// from the server, so there is nothing to show before it answers. Instead the button is busy
/// (and ignores further taps) while the request runs, and a failure leaves the screen and the
/// typed name exactly as they were, with a plain-language message.
@MainActor
@Observable
public final class FirstWorkspaceStore {
	public var name = ""
	public private(set) var isCreating = false
	public private(set) var error: String?

	@ObservationIgnored private let api: any WorkspaceAdminAPI
	@ObservationIgnored private let isOnline: @Sendable () -> Bool
	/// Adopts the created workspace (list + selection), then reconciles with the server.
	@ObservationIgnored private let didCreate: @MainActor (CreatedWorkspace) async -> Void
	/// Kept across a failed attempt for the same name, so a retry after a lost response is the
	/// same write to the server rather than a second workspace.
	@ObservationIgnored private var pendingKey: (name: String, key: String)?

	static let offlineMessage = "You're offline. Connect to the internet to create a workspace."

	public init(
		api: any WorkspaceAdminAPI, isOnline: @escaping @Sendable () -> Bool = { true },
		didCreate: @escaping @MainActor (CreatedWorkspace) async -> Void
	) {
		self.api = api
		self.isOnline = isOnline
		self.didCreate = didCreate
	}

	/// Same rule as the web dialog: the name, trimmed, must not be empty.
	public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var canCreate: Bool { !trimmedName.isEmpty && !isCreating }

	@discardableResult
	public func create() async -> Bool {
		guard canCreate else { return false }
		let n = trimmedName
		guard isOnline() else {
			error = Self.offlineMessage
			return false
		}
		isCreating = true
		error = nil
		defer { isCreating = false }
		let key: String
		if let pendingKey, pendingKey.name == n {
			key = pendingKey.key
		} else {
			key = UUID().uuidString
			pendingKey = (n, key)
		}
		do {
			let created = try await api.create(name: n, idempotencyKey: key)
			pendingKey = nil
			await didCreate(created)
			return true
		} catch let e as SettingsError {
			error = e.message
		} catch {
			self.error = RemoteFailure.describe(error).isOffline
				? Self.offlineMessage : "Couldn't create the workspace. Try again."
		}
		return false
	}

	public func dismissError() { error = nil }
}
