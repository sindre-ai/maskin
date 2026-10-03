import Foundation
import Observation

/// Rename the selected workspace and create new ones. The shared `WorkspaceStore` owns the list
/// and the selection; this store reaches it through two closures so it tests on its own.
@MainActor
@Observable
public final class WorkspaceSettingsStore {
	public private(set) var isWorking = false
	public private(set) var error: String?

	@ObservationIgnored private let api: any WorkspaceAdminAPI
	@ObservationIgnored private let refreshWorkspaces: @MainActor () async -> Void
	@ObservationIgnored private let selectWorkspace: @MainActor (String) -> Void

	public init(
		api: any WorkspaceAdminAPI,
		refreshWorkspaces: @escaping @MainActor () async -> Void,
		selectWorkspace: @escaping @MainActor (String) -> Void
	) {
		self.api = api
		self.refreshWorkspaces = refreshWorkspaces
		self.selectWorkspace = selectWorkspace
	}

	public static func normalized(_ name: String) -> String {
		name.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// Renaming needs the new name to be non-empty and different. Admins and owners only.
	public func canRename(to name: String, current: String, role: MemberRole) -> Bool {
		let n = Self.normalized(name)
		return role.canManage && !n.isEmpty && n != current && !isWorking
	}

	@discardableResult
	public func rename(workspaceId: String, to name: String) async -> Bool {
		let n = Self.normalized(name)
		guard !n.isEmpty, !isWorking else { return false }
		isWorking = true
		error = nil
		defer { isWorking = false }
		do {
			try await api.rename(workspaceId: workspaceId, name: n, idempotencyKey: UUID().uuidString)
			await refreshWorkspaces()
			return true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't rename the workspace."
			return false
		}
	}

	/// Creates the workspace, reloads the list and selects it.
	@discardableResult
	public func create(name: String) async -> Bool {
		let n = Self.normalized(name)
		guard !n.isEmpty, !isWorking else { return false }
		isWorking = true
		error = nil
		defer { isWorking = false }
		do {
			let created = try await api.create(name: n, idempotencyKey: UUID().uuidString)
			await refreshWorkspaces()
			selectWorkspace(created.id)
			return true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't create the workspace."
			return false
		}
	}

	public func dismissError() { error = nil }
}
