import Foundation
import Observation

/// Object types and their properties and statuses. Every edit is optimistic and rolls back if
/// the server refuses. Only the schema keys that changed are sent.
@MainActor
@Observable
public final class SchemaStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var schema = WorkspaceSchema()
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var isSaving = false
	public let currentRole: MemberRole

	@ObservationIgnored private let api: any SchemaAPI

	public init(api: any SchemaAPI, currentRole: MemberRole) {
		self.api = api
		self.currentRole = currentRole
	}

	public var canEdit: Bool { currentRole.canManage }

	public func load() async {
		if phase != .loaded { phase = .loading }
		do {
			schema = try await api.load()
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load object types."
			if phase == .loaded { actionError = message } else { phase = .failed(message) }
		}
	}

	public func properties(of type: String) -> [PropertyDefinition] {
		schema.fieldDefinitions[type] ?? []
	}

	public func statuses(of type: String) -> [String] { schema.statuses[type] ?? [] }

	// MARK: Validation

	public static func normalizedName(_ raw: String) -> String {
		raw.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	/// Parses "a, b ,c" into trimmed unique values, preserving order.
	public static func parseValues(_ raw: String) -> [String] {
		var seen = Set<String>()
		return raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { !$0.isEmpty && seen.insert($0).inserted }
	}

	/// A readable problem with a would-be property, or nil when it is fine to save.
	public func problem(
		with draft: PropertyDefinition, on type: String, replacing original: String? = nil
	) -> String? {
		let name = Self.normalizedName(draft.name)
		if name.isEmpty { return "Give the property a name." }
		if properties(of: type).contains(where: { $0.name == name && $0.name != original }) {
			return "This type already has a property with that name."
		}
		if draft.kind == .enum && draft.values.isEmpty { return "Add at least one choice." }
		return nil
	}

	// MARK: Property edits

	@discardableResult
	public func addProperty(_ draft: PropertyDefinition, to type: String) async -> Bool {
		guard canEdit, problem(with: draft, on: type) == nil else {
			if canEdit { actionError = problem(with: draft, on: type) }
			return false
		}
		var next = schema
		next.fieldDefinitions[type, default: []].append(Self.clean(draft))
		return await commit(next, keys: [.fieldDefinitions])
	}

	@discardableResult
	public func updateProperty(
		_ draft: PropertyDefinition, original: String, on type: String
	) async -> Bool {
		guard canEdit else { return false }
		if let problem = problem(with: draft, on: type, replacing: original) {
			actionError = problem
			return false
		}
		var next = schema
		guard let index = next.fieldDefinitions[type]?.firstIndex(where: { $0.name == original })
		else { return false }
		next.fieldDefinitions[type]?[index] = Self.clean(draft)
		return await commit(next, keys: [.fieldDefinitions])
	}

	@discardableResult
	public func removeProperty(_ name: String, from type: String) async -> Bool {
		guard canEdit, properties(of: type).contains(where: { $0.name == name }) else { return false }
		var next = schema
		next.fieldDefinitions[type]?.removeAll { $0.name == name }
		return await commit(next, keys: [.fieldDefinitions])
	}

	// MARK: Status edits

	public static func isValidStatus(_ raw: String) -> Bool {
		let s = normalizedName(raw)
		return !s.isEmpty && s.count <= 40
	}

	@discardableResult
	public func addStatus(_ raw: String, to type: String) async -> Bool {
		let status = Self.normalizedName(raw)
		guard canEdit, Self.isValidStatus(status) else { return false }
		if statuses(of: type).contains(where: { $0.caseInsensitiveCompare(status) == .orderedSame }) {
			actionError = "That status already exists."
			return false
		}
		var next = schema
		next.statuses[type, default: []].append(status)
		return await commit(next, keys: [.statuses])
	}

	/// The last status can't go: objects always need somewhere to be.
	@discardableResult
	public func removeStatus(_ status: String, from type: String) async -> Bool {
		guard canEdit, statuses(of: type).count > 1 else {
			if canEdit { actionError = "An object type needs at least one status." }
			return false
		}
		var next = schema
		next.statuses[type]?.removeAll { $0 == status }
		return await commit(next, keys: [.statuses])
	}

	@discardableResult
	public func moveStatuses(of type: String, from offsets: IndexSet, to destination: Int) async -> Bool {
		guard canEdit else { return false }
		var list = statuses(of: type)
		let moving = offsets.sorted().map { list[$0] }
		for index in offsets.sorted().reversed() { list.remove(at: index) }
		let shift = offsets.filter { $0 < destination }.count
		list.insert(contentsOf: moving, at: max(0, min(list.count, destination - shift)))
		guard list != statuses(of: type) else { return false }
		var next = schema
		next.statuses[type] = list
		return await commit(next, keys: [.statuses])
	}

	// MARK: Display name

	@discardableResult
	public func rename(type: String, to raw: String) async -> Bool {
		let name = Self.normalizedName(raw)
		guard canEdit, !name.isEmpty, name != schema.displayName(for: type) else { return false }
		var next = schema
		next.displayNames[type] = name
		return await commit(next, keys: [.displayNames])
	}

	// MARK: Commit

	private static func clean(_ draft: PropertyDefinition) -> PropertyDefinition {
		PropertyDefinition(
			name: normalizedName(draft.name), kind: draft.kind, isRequired: draft.isRequired,
			values: draft.kind == .enum ? draft.values : [])
	}

	private func commit(_ next: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>) async -> Bool {
		guard !isSaving else { return false }
		let previous = schema
		schema = next
		isSaving = true
		actionError = nil
		defer { isSaving = false }
		do {
			try await api.save(next, keys: keys, idempotencyKey: UUID().uuidString)
			return true
		} catch {
			schema = previous
			actionError = (error as? SettingsError)?.message ?? "Couldn't save that change."
			return false
		}
	}

	public func dismissError() { actionError = nil }
}
