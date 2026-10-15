import Foundation
import Observation

/// The signed-in person's profile: name and email read, name editable.
@MainActor
@Observable
public final class ProfileStore {
	public private(set) var profile: ProfileInfo
	public private(set) var isSaving = false
	public private(set) var error: String?

	@ObservationIgnored private let api: any ProfileAPI
	/// Pushes a saved name into the signed-in session so the profile menu and Settings row follow.
	@ObservationIgnored private let updateSessionName: @MainActor (String) -> Void

	public init(
		api: any ProfileAPI, profile: ProfileInfo,
		updateSessionName: @escaping @MainActor (String) -> Void = { _ in }
	) {
		self.api = api
		self.profile = profile
		self.updateSessionName = updateSessionName
	}

	/// Trimmed and non-empty, and different from what is stored.
	public func canSave(name: String) -> Bool {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		return !trimmed.isEmpty && trimmed != profile.name && !isSaving
	}

	/// Optimistic: the new name shows at once and is restored if the server refuses.
	@discardableResult
	public func saveName(_ name: String) async -> Bool {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard canSave(name: name) else { return false }
		let previous = profile
		profile.name = trimmed
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			let saved = try await api.rename(
				actorId: profile.actorId, name: trimmed, idempotencyKey: UUID().uuidString)
			profile.name = saved.name
			updateSessionName(saved.name)
			return true
		} catch {
			profile = previous
			self.error = (error as? SettingsError)?.message ?? "Couldn't save your name."
			return false
		}
	}

	public func dismissError() { error = nil }
}
