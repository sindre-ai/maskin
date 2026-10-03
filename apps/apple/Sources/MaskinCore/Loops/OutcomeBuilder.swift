import Foundation

/// Something a loop produced that a person can look at: a page, a document, a PDF.
public struct Outcome: Identifiable, Equatable, Sendable {
	public var id: String { fileID }
	public var fileID: String
	public var name: String
	public var kind: FileContentKind
	public var loopID: String
	public var loopName: String
	/// The object it is attached to, when that is a member rather than the loop itself.
	public var sourceTitle: String?
	public var updatedAt: Date?

	public init(
		fileID: String, name: String, kind: FileContentKind, loopID: String, loopName: String,
		sourceTitle: String? = nil, updatedAt: Date? = nil
	) {
		self.fileID = fileID
		self.name = name
		self.kind = kind
		self.loopID = loopID
		self.loopName = loopName
		self.sourceTitle = sourceTitle
		self.updatedAt = updatedAt
	}

	/// An output known only from the graph edge: the kind is read from the name, and there is no date.
	public init(output: LoopOutput, loop: LoopSummary) {
		self.init(
			fileID: output.id, name: output.name, kind: output.kind, loopID: loop.id,
			loopName: loop.displayName, sourceTitle: output.sourceTitle)
	}

	public var isHTML: Bool { kind == .html }
}

/// One loop's outcomes, newest first.
public struct OutcomeGroup: Identifiable, Equatable, Sendable {
	public var id: String { loopID }
	public var loopID: String
	public var loopName: String
	public var outcomes: [Outcome]

	public init(loopID: String, loopName: String, outcomes: [Outcome]) {
		self.loopID = loopID
		self.loopName = loopName
		self.outcomes = outcomes
	}

	public var latest: Date? { outcomes.compactMap(\.updatedAt).max() }
}

/// Turns each loop's produced files, plus the file metadata that fills in kind and date, into the
/// Outcomes feed. Pure, so the ordering rules are tested without a server.
public enum OutcomeBuilder {
	/// Files a person can look at. Source dumps and unknown binaries aren't outcomes.
	static func isPresentable(_ kind: FileContentKind) -> Bool {
		switch kind {
		case .html, .markdown, .pdf, .image, .text: true
		case .source, .other: false
		}
	}

	/// - Parameters:
	///   - entries: each loop with the outputs its graph yielded.
	///   - files: metadata by file id. A file with no row (deleted, no access) is dropped.
	public static func groups(
		entries: [(loop: LoopSummary, outputs: [LoopOutput])], files: [String: FileSummary]
	) -> [OutcomeGroup] {
		var claimed = Set<String>()
		var groups: [OutcomeGroup] = []
		for (loop, outputs) in entries {
			var outcomes: [Outcome] = []
			for output in outputs {
				guard let file = files[output.id], isPresentable(file.kind),
					claimed.insert(output.id).inserted
				else { continue }
				outcomes.append(
					Outcome(
						fileID: output.id, name: file.name, kind: file.kind, loopID: loop.id,
						loopName: loop.displayName, sourceTitle: output.sourceTitle, updatedAt: file.updatedAt))
			}
			guard !outcomes.isEmpty else { continue }
			// Presentable pages lead, then the most recently changed.
			outcomes.sort { a, b in
				if a.isHTML != b.isHTML { return a.isHTML }
				return (a.updatedAt ?? .distantPast, a.fileID) > (b.updatedAt ?? .distantPast, b.fileID)
			}
			groups.append(OutcomeGroup(loopID: loop.id, loopName: loop.displayName, outcomes: outcomes))
		}
		return groups.sorted { ($0.latest ?? .distantPast, $0.loopID) > ($1.latest ?? .distantPast, $1.loopID) }
	}
}
