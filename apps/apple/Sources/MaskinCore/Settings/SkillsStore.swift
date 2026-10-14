import Foundation
import Observation

/// The workspace's skills: list, read, create, edit, delete.
@MainActor
@Observable
public final class SkillsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var skills: [WorkspaceSkill] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var isSaving = false
	public private(set) var busyIDs: Set<String> = []

	@ObservationIgnored private let api: any SkillsAPI
	@ObservationIgnored private let workspaceId: String

	public init(api: any SkillsAPI, workspaceId: String) {
		self.api = api
		self.workspaceId = workspaceId
	}

	/// The server's rule: lowercase letters, digits and hyphens, 1...64 characters.
	public static func isValidName(_ name: String) -> Bool {
		guard (1...64).contains(name.count) else { return false }
		return name.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") }
	}

	/// Turns "Weekly Review!" into "weekly-review" as the person types a title.
	public static func suggestedName(from title: String) -> String {
		var out = ""
		for ch in title.lowercased() {
			if ch.isASCII && (ch.isLetter || ch.isNumber) { out.append(ch) }
			else if ch == " " || ch == "-" || ch == "_" { if out.last != "-" { out.append("-") } }
		}
		return String(out.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(64))
	}

	public static let maxContentBytes = 256_000

	public static func validate(name: String, content: String, isNew: Bool) -> String? {
		if isNew && !isValidName(name) {
			return "Use lowercase letters, numbers and hyphens for the name."
		}
		if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Add some content." }
		if content.utf8.count > maxContentBytes { return "That skill is too long." }
		return nil
	}

	public func load() async {
		if skills.isEmpty { phase = .loading }
		do {
			skills = try await api.list(workspaceId: workspaceId).sorted(by: Self.order)
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load skills."
			if skills.isEmpty { phase = .failed(message) } else { actionError = message }
		}
	}

	private static func order(_ a: WorkspaceSkill, _ b: WorkspaceSkill) -> Bool {
		a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
	}

	/// The markdown body of a skill, for the editor.
	public func content(of skill: WorkspaceSkill) async throws -> String {
		do { return try await api.content(workspaceId: workspaceId, name: skill.name) }
		catch { throw SettingsError((error as? SettingsError)?.message ?? "Couldn't open that skill.") }
	}

	@discardableResult
	public func create(name: String, content: String) async -> Bool {
		await save(name: name, content: content, isNew: true)
	}

	@discardableResult
	public func update(name: String, content: String) async -> Bool {
		await save(name: name, content: content, isNew: false)
	}

	private func save(name: String, content: String, isNew: Bool) async -> Bool {
		guard !isSaving else { return false }
		if let problem = Self.validate(name: name, content: content, isNew: isNew) {
			actionError = problem
			return false
		}
		if isNew, skills.contains(where: { $0.name == name }) {
			actionError = "A skill with that name already exists."
			return false
		}
		isSaving = true
		actionError = nil
		defer { isSaving = false }
		do {
			if isNew {
				try await api.create(
					workspaceId: workspaceId, name: name, content: content,
					idempotencyKey: UUID().uuidString)
			} else {
				try await api.update(
					workspaceId: workspaceId, name: name, content: content,
					idempotencyKey: UUID().uuidString)
			}
			await load()
			return true
		} catch {
			actionError = (error as? SettingsError)?.message ?? "Couldn't save the skill."
			return false
		}
	}

	/// Optimistic; restored if the server refuses.
	@discardableResult
	public func delete(_ skill: WorkspaceSkill) async -> Bool {
		guard !busyIDs.contains(skill.id) else { return false }
		let previous = skills
		skills.removeAll { $0.id == skill.id }
		busyIDs.insert(skill.id)
		actionError = nil
		defer { busyIDs.remove(skill.id) }
		do {
			try await api.delete(
				workspaceId: workspaceId, name: skill.name, idempotencyKey: UUID().uuidString)
			return true
		} catch {
			skills = previous
			actionError = (error as? SettingsError)?.message ?? "Couldn't delete \(skill.name)."
			return false
		}
	}

	public func dismissError() { actionError = nil }
}
