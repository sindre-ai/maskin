import Foundation
import Observation

/// Settings › Delete account. Loads the preview (what blocks it, which workspaces are left or
/// deleted), holds the toggle and the password, and deletes. On success it calls `didDelete`,
/// which signs out and wipes local state; the password is cleared the moment the call returns.
@MainActor
@Observable
public final class AccountDeletionStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading
		case loaded(AccountDeletionPreview)
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	public private(set) var isDeleting = false
	public private(set) var error: String?
	public private(set) var isDeleted = false
	/// A preview fetch is in flight; the one on screen may not match the toggle yet.
	public private(set) var isRefreshing = false
	/// Also delete the workspaces only this person is in. Off until they choose.
	public var deleteSoleWorkspaces = false
	/// Held only while the screen is up; never persisted or logged.
	public var password = ""

	@ObservationIgnored private let api: any DeletionAPI
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private let didDelete: @MainActor () async -> Void

	public init(api: any DeletionAPI, didDelete: @escaping @MainActor () async -> Void) {
		self.api = api
		self.didDelete = didDelete
	}

	public var preview: AccountDeletionPreview? {
		if case .loaded(let p) = phase { return p }
		return nil
	}

	/// The password step is offered only once the server says nothing blocks deletion.
	public var canProceed: Bool { preview?.canDelete == true && !isDeleting && !isDeleted && !isRefreshing }

	public var canConfirm: Bool { canProceed && !password.isEmpty }

	/// Re-run whenever the toggle changes: the server's blockers depend on it, and the confirm
	/// button must not enable for a delete that would be refused. The old preview stays on screen
	/// meanwhile, but confirming waits (`isRefreshing`). Only the latest answer is kept.
	public func load() async {
		if preview == nil { phase = .loading }
		generation += 1
		let mine = generation
		isRefreshing = true
		defer { if mine == generation { isRefreshing = false } }
		do {
			let fresh = try await api.accountPreview(deleteSoleWorkspaces: deleteSoleWorkspaces)
			guard mine == generation else { return }
			phase = .loaded(fresh)
			error = nil
		} catch {
			guard mine == generation else { return }
			if preview == nil {
				phase = .failed((error as? DeletionError)?.message ?? "Couldn't check your account.")
			}
		}
	}

	@discardableResult
	public func delete() async -> Bool {
		guard canConfirm else { return false }
		isDeleting = true
		error = nil
		defer { isDeleting = false }
		do {
			try await api.deleteAccount(
				password: password, deleteSoleWorkspaces: deleteSoleWorkspaces,
				idempotencyKey: UUID().uuidString)
		} catch let e as DeletionError {
			error = e.message
			if e.isWrongPassword { password = "" }
			return false
		} catch {
			self.error = "Couldn't delete your account."
			return false
		}
		password = ""
		isDeleted = true
		await didDelete()
		return true
	}

	public func dismissError() { error = nil }
}
