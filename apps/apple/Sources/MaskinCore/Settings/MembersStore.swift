import Foundation
import Observation

/// Members of one workspace and the actions a manager can take on them. Role changes and
/// removals are optimistic and roll back when the server refuses.
@MainActor
@Observable
public final class MembersStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var members: [WorkspaceMember] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var busyIDs: Set<String> = []

	/// The signed-in person's role here; gates every destructive action.
	public let currentRole: MemberRole
	public let currentActorId: String

	@ObservationIgnored private let api: any MembersAPI
	@ObservationIgnored private let workspaceId: String
	@ObservationIgnored private var generation = 0

	public init(
		api: any MembersAPI, workspaceId: String, currentRole: MemberRole, currentActorId: String
	) {
		self.api = api
		self.workspaceId = workspaceId
		self.currentRole = currentRole
		self.currentActorId = currentActorId
	}

	public var humans: [WorkspaceMember] { members.filter { !$0.isAgent } }
	public var agents: [WorkspaceMember] { members.filter(\.isAgent) }

	// MARK: Permissions (UI never offers what these refuse)

	/// Only managers change roles, never on owners, themselves or agents.
	public func canChangeRole(of member: WorkspaceMember) -> Bool {
		currentRole.canManage && member.role != .owner && member.actorId != currentActorId
			&& !member.isAgent
	}

	/// Only managers remove people, never the owner or themselves.
	public func canRemove(_ member: WorkspaceMember) -> Bool {
		currentRole.canManage && member.role != .owner && member.actorId != currentActorId
	}

	// MARK: Loading

	public func load() async {
		if members.isEmpty { phase = .loading }
		generation += 1
		let mine = generation
		do {
			let list = try await api.list(workspaceId: workspaceId)
			guard mine == generation else { return }
			members = list.sorted(by: Self.order)
			phase = .loaded
		} catch {
			guard mine == generation else { return }
			let message = (error as? SettingsError)?.message ?? "Couldn't load members."
			if members.isEmpty { phase = .failed(message) } else { actionError = message }
		}
	}

	private static func order(_ a: WorkspaceMember, _ b: WorkspaceMember) -> Bool {
		let rank: (MemberRole) -> Int = { $0 == .owner ? 0 : $0 == .admin ? 1 : 2 }
		if rank(a.role) != rank(b.role) { return rank(a.role) < rank(b.role) }
		return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
	}

	// MARK: Actions

	@discardableResult
	public func setRole(_ role: MemberRole, for member: WorkspaceMember) async -> Bool {
		guard canChangeRole(of: member), role != .owner, role != member.role,
			!busyIDs.contains(member.id), let index = members.firstIndex(where: { $0.id == member.id })
		else { return false }
		let previous = members
		members[index].role = role
		busyIDs.insert(member.id)
		actionError = nil
		defer { busyIDs.remove(member.id) }
		do {
			try await api.setRole(
				workspaceId: workspaceId, actorId: member.actorId, role: role,
				idempotencyKey: UUID().uuidString)
			members.sort(by: Self.order)
			return true
		} catch {
			members = previous
			actionError = (error as? SettingsError)?.message ?? "Couldn't change the role."
			return false
		}
	}

	@discardableResult
	public func remove(_ member: WorkspaceMember) async -> Bool {
		guard canRemove(member), !busyIDs.contains(member.id) else { return false }
		let previous = members
		members.removeAll { $0.id == member.id }
		busyIDs.insert(member.id)
		actionError = nil
		defer { busyIDs.remove(member.id) }
		do {
			try await api.remove(
				workspaceId: workspaceId, actorId: member.actorId, idempotencyKey: UUID().uuidString)
			return true
		} catch {
			members = previous
			actionError = (error as? SettingsError)?.message ?? "Couldn't remove \(member.name)."
			return false
		}
	}

	public func dismissError() { actionError = nil }
}
