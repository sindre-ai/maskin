import Foundation
import Observation

/// Read-only list of the workspace's skills.
@MainActor
@Observable
public final class SkillsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var skills: [WorkspaceSkill] = []
	public private(set) var phase: Phase = .idle

	@ObservationIgnored private let api: any SkillsAPI
	@ObservationIgnored private let workspaceId: String

	public init(api: any SkillsAPI, workspaceId: String) {
		self.api = api
		self.workspaceId = workspaceId
	}

	public func load() async {
		if skills.isEmpty { phase = .loading }
		do {
			skills = try await api.list(workspaceId: workspaceId)
				.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load skills."
			if skills.isEmpty { phase = .failed(message) }
		}
	}
}
