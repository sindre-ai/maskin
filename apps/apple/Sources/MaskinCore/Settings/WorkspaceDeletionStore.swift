import Foundation
import Observation

/// Settings › Delete workspace, for the current workspace. The person types the workspace's name
/// back before the button enables; blockers from the preview replace the form entirely.
@MainActor
@Observable
public final class WorkspaceDeletionStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading
		case loaded(WorkspaceDeletionPreview)
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	public private(set) var isDeleting = false
	public private(set) var error: String?
	public private(set) var isDeleted = false
	public var typedName = ""

	@ObservationIgnored private let api: any DeletionAPI
	@ObservationIgnored private let workspaceId: String
	/// Deleting this workspace leaves the person with none; the confirmation says so up front.
	public let isLastWorkspace: Bool
	@ObservationIgnored private let didDelete: @MainActor () async -> Void

	/// - Parameter didDelete: refreshes the workspace list and moves the selection off the
	///   deleted workspace (to another one, or to none).
	public init(
		api: any DeletionAPI, workspaceId: String, isLastWorkspace: Bool = false,
		didDelete: @escaping @MainActor () async -> Void
	) {
		self.api = api
		self.workspaceId = workspaceId
		self.isLastWorkspace = isLastWorkspace
		self.didDelete = didDelete
	}

	public var preview: WorkspaceDeletionPreview? {
		if case .loaded(let p) = phase { return p }
		return nil
	}

	/// Exact match after trimming surrounding whitespace; case counts, as on the web.
	public var nameMatches: Bool {
		guard let preview else { return false }
		return typedName.trimmingCharacters(in: .whitespacesAndNewlines) == preview.workspaceName
	}

	public var canConfirm: Bool {
		preview?.canDelete == true && nameMatches && !isDeleting && !isDeleted
	}

	public func load() async {
		if preview == nil { phase = .loading }
		do {
			phase = .loaded(try await api.workspacePreview(workspaceId: workspaceId))
			error = nil
		} catch {
			if preview == nil {
				phase = .failed((error as? DeletionError)?.message ?? "Couldn't check this workspace.")
			}
		}
	}

	@discardableResult
	public func delete() async -> Bool {
		guard canConfirm, let preview else { return false }
		isDeleting = true
		error = nil
		defer { isDeleting = false }
		do {
			try await api.deleteWorkspace(
				workspaceId: workspaceId, confirmName: preview.workspaceName,
				idempotencyKey: UUID().uuidString)
		} catch let e as DeletionError {
			error = e.message
			return false
		} catch {
			self.error = "Couldn't delete the workspace."
			return false
		}
		isDeleted = true
		await didDelete()
		return true
	}

	public func dismissError() { error = nil }
}
