import Foundation
import Observation

/// What a link in a message turned out to be.
public enum LinkedItem: Equatable, Sendable {
	/// A draft an integration can deliver (an email, a LinkedIn message or post, a Slack message).
	case draft(WorkObject, ObjectPreview)
	/// A page, document, picture or text the reader can look at.
	case file(FileReference)
	/// Any other object in this workspace: drawn with the shared card face.
	case object(LinkedObject)
	/// An object the lookup could not find. The lookup cannot tell a deleted object from a private
	/// one, and nothing is private inside a workspace, so the card says it was deleted.
	case deleted(LinkedTarget)
	/// Something that stays a link in the chat (a PDF): the drawer lists it as a compact row.
	case plain(LinkedReference)
	/// A loop in this workspace.
	case loop(LinkedLoop)
	/// A trigger in this workspace, found in the triggers list.
	case trigger(LinkedTrigger)

	/// Whether it is drawn as a card in the message.
	public var isCard: Bool {
		switch self {
		case .draft, .file, .object, .deleted, .loop, .trigger: true
		case .plain: false
		}
	}
}

/// The name and kind of a linked file that has no card.
public struct LinkedReference: Equatable, Sendable {
	public var target: LinkedTarget
	public var title: String
	/// "PDF", "File".
	public var kindLabel: String

	public init(target: LinkedTarget, title: String, kindLabel: String) {
		self.target = target
		self.title = title
		self.kindLabel = kindLabel
	}
}

public enum LinkedItemState: Equatable, Sendable {
	case loading
	/// Not looked up, or the lookup failed or found nothing usable (missing, in another workspace).
	/// The link stays as text; a failure is tried again later.
	case unavailable
	case ready(LinkedItem)

	public var item: LinkedItem? {
		if case .ready(let item) = self { return item }
		return nil
	}
}

/// Where a draft's approval stands, per object.
public enum DraftApprovalPhase: Equatable, Sendable {
	case approving
	case failed(String)
}

/// The start of a text or markdown file, for the card's preview.
public enum LinkedFileText: Equatable, Sendable {
	case loading
	case ready(String, isTruncated: Bool)
	/// Too big to preview, or not text: the card offers Open only.
	case failed
	/// The read did not go through; the card offers Retry.
	case error
}

/// Looks up what the objects and files a message links to are, remembers it, and approves drafts.
/// One lookup per target at a time however many views ask; a failure is retried on a later ask
/// after `retryAfter`, never on every redraw. Nothing here ever removes a link: a target that has
/// not resolved to a card simply stays text.
@MainActor
@Observable
public final class LinkedItemStore {
	private struct Entry {
		var state: LinkedItemState
		var failedAt: Date?
	}

	@ObservationIgnored private let objects: any ObjectDraftsRemote
	@ObservationIgnored private let files: any FilesRemote
	@ObservationIgnored private let loadActors: (@Sendable () async throws -> [ActorRef])?
	@ObservationIgnored private var actorsTask: Task<Void, Never>?
	@ObservationIgnored private let loadLoops: (@Sendable () async throws -> [LoopSummary])?
	@ObservationIgnored private let loadTriggers: (@Sendable () async throws -> TriggerListing)?
	/// The loops list and the triggers list, each read once and shared by every link that needs it
	/// (a message with five loops asks once). A copy older than `retryAfter` is read again, so a loop
	/// or trigger made a minute ago is found.
	@ObservationIgnored private var loopsHeld: Held<[String: LoopSummary]>?
	@ObservationIgnored private var loopsRead: Task<[LoopSummary], Error>?
	@ObservationIgnored private var triggersHeld: Held<TriggerListing>?
	@ObservationIgnored private var triggersRead: Task<TriggerListing, Error>?

	private struct Held<Value> {
		var value: Value
		var readAt: Date
	}
	@ObservationIgnored private let workspaceID: @MainActor () -> String?
	@ObservationIgnored private let now: @MainActor () -> Date
	@ObservationIgnored private var inFlight: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private var fileTextOrder: [String] = []
	@ObservationIgnored private var approvalKeys: [String: String] = [:]
	/// A failed lookup is not repeated sooner than this.
	public let retryAfter: TimeInterval

	private var entries: [String: Entry] = [:]
	/// The workspace's people and agents by id, read once: a card names its owner from here, so no
	/// card asks for its own.
	public private(set) var actorsByID: [String: ActorRef] = [:]
	public private(set) var approvals: [String: DraftApprovalPhase] = [:]
	public private(set) var fileTexts: [String: LinkedFileText] = [:]
	/// A file larger than this is opened, not previewed in the message.
	public static let maxPreviewBytes = 1_000_000
	/// How much of a text the card keeps; the viewer has the rest.
	public static let previewCharacters = 30_000
	/// How many file texts are kept; the oldest read goes first.
	public static let maxCachedTexts = 20
	/// How many times a failed lookup is asked again by `resolveWithRetries`.
	public static let maxRetries = 4

	public init(
		objects: any ObjectDraftsRemote, files: any FilesRemote,
		actors: (@Sendable () async throws -> [ActorRef])? = nil,
		loops: (@Sendable () async throws -> [LoopSummary])? = nil,
		triggers: (@Sendable () async throws -> TriggerListing)? = nil, workspaceID: @escaping @MainActor () -> String?,
		retryAfter: TimeInterval = 30, now: @escaping @MainActor () -> Date = { Date() }
	) {
		self.objects = objects
		self.files = files
		self.loadActors = actors
		self.loadLoops = loops
		self.loadTriggers = triggers
		self.workspaceID = workspaceID
		self.retryAfter = retryAfter
		self.now = now
	}

	// MARK: Reading

	/// Nil until something asked for the target.
	public func state(for target: LinkedTarget) -> LinkedItemState? { entries[target.key]?.state }

	public func item(for target: LinkedTarget) -> LinkedItem? { entries[target.key]?.state.item }

	/// True when the target is drawn as a card in a message.
	public func isCard(_ target: LinkedTarget) -> Bool { item(for: target)?.isCard == true }

	/// True when the link should be a card now. An object link counts before its answer is in (the
	/// card is a placeholder), so the message does not jump when the answer arrives; one that cannot
	/// be shown goes back to text.
	public func showsCard(_ target: LinkedTarget) -> Bool {
		guard let state = entries[target.key]?.state else { return target.kind == .object }
		switch state {
		case .loading: return target.kind == .object
		case .unavailable: return false
		case .ready(let item): return item.isCard
		}
	}

	/// The person or agent behind an id, once the workspace's actors have been read.
	public func owner(for id: String?) -> ActorRef? { id.flatMap { actorsByID[$0] } }

	// MARK: Resolving

	/// Looks up whatever is not known yet, in parallel. Returns when every target has settled.
	public func resolve(_ targets: [LinkedTarget]) async {
		var tasks: [Task<Void, Never>] = []
		for target in targets {
			if let task = startLookup(target) { tasks.append(task) }
		}
		for task in tasks { await task.value }
	}

	/// `resolve`, then asks again for what failed (not for what is missing), waiting `retryAfter`
	/// longer each time, up to `maxRetries`. Ends early when the caller's task is cancelled (the row
	/// left the screen).
	public func resolveWithRetries(_ targets: [LinkedTarget]) async {
		await resolve(targets)
		var attempt = 1
		while attempt <= Self.maxRetries, hasFailed(targets) {
			try? await Task.sleep(for: .seconds(retryAfter * Double(attempt)))
			if Task.isCancelled { return }
			await resolve(targets)
			attempt += 1
		}
	}

	/// True when a lookup for one of these failed in a way worth asking again.
	public func hasFailed(_ targets: [LinkedTarget]) -> Bool {
		targets.contains { entries[$0.key]?.failedAt != nil }
	}

	/// Starts (or joins) the lookup for a target unless it is settled or recently failed.
	private func startLookup(_ target: LinkedTarget) -> Task<Void, Never>? {
		if let running = inFlight[target.key] { return running }
		if let entry = entries[target.key] {
			switch entry.state {
			case .ready, .loading: return nil
			case .unavailable:
				// Only a failure is retried; a settled "not a card" is final (see `settle`).
				guard let failedAt = entry.failedAt, now().timeIntervalSince(failedAt) >= retryAfter else { return nil }
			}
		}
		entries[target.key] = Entry(state: .loading)
		if target.kind != .file { loadActorsOnce() }
		let task = Task { [weak self] in
			guard let self else { return }
			await self.lookup(target)
		}
		inFlight[target.key] = task
		return task
	}

	/// Reads the workspace's actors the first time an object is looked up; a failed read is tried
	/// again with the next lookup.
	private func loadActorsOnce() {
		guard actorsTask == nil, let loadActors else { return }
		actorsTask = Task { [weak self] in
			let loaded = try? await loadActors()
			guard let self else { return }
			if let loaded {
				self.actorsByID = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
			} else {
				self.actorsTask = nil
			}
		}
	}

	private func fetch(_ target: LinkedTarget, workspace: String?) async throws -> LinkedItem? {
		switch target.kind {
		case .object:
			return classify(try await objects.detail(objectId: target.uuid), workspace: workspace)
		case .file:
			let found = try await files.summaries(ids: [target.uuid]).first { $0.id.lowercased() == target.uuid }
			guard let found else { return nil }
			return classify(found)
		case .loop:
			return try await fetchLoop(target, workspace: workspace)
		case .trigger:
			return try await fetchTrigger(target)
		}
	}

	/// A loop is a card when it is in this workspace. The loops list has the counts; a loop the list
	/// does not hold (made since it was read) is read as an object, which has no counts, so the
	/// card leaves those facts out.
	private func fetchLoop(_ target: LinkedTarget, workspace: String?) async throws -> LinkedItem? {
		if loadLoops != nil, let found = try await loopSummaries()[target.uuid] {
			return .loop(LinkedLoop(target: target, summary: found))
		}
		let detail = try await objects.detail(objectId: target.uuid)
		if let current = workspace, detail.workspaceId.lowercased() != current.lowercased() { return nil }
		guard detail.object.type == "loop" else { return nil }
		return .loop(LinkedLoop(target: target, object: detail.object))
	}

	/// A trigger is read from the triggers list: there is no read of one trigger. One missing from a
	/// list that is known to be whole is gone. One missing from a list cut short, or no list at all,
	/// stays a link.
	private func fetchTrigger(_ target: LinkedTarget) async throws -> LinkedItem? {
		guard loadTriggers != nil else { return nil }
		let listing = try await triggerListing()
		if let found = listing.triggers.first(where: { $0.id.lowercased() == target.uuid }) {
			return .trigger(LinkedTrigger(target: target, trigger: found))
		}
		return listing.isComplete ? .deleted(target) : nil
	}

	private func loopSummaries() async throws -> [String: LoopSummary] {
		if let held = loopsHeld, now().timeIntervalSince(held.readAt) < retryAfter { return held.value }
		guard let loadLoops else { return [:] }
		let started = loopsRead == nil
		let task: Task<[LoopSummary], Error>
		if let running = loopsRead {
			task = running
		} else {
			task = Task { try await loadLoops() }
			loopsRead = task
		}
		defer { if started { loopsRead = nil } }
		let list = try await task.value
		let byID = Dictionary(list.map { ($0.id.lowercased(), $0) }, uniquingKeysWith: { _, last in last })
		loopsHeld = Held(value: byID, readAt: now())
		return byID
	}

	private func triggerListing() async throws -> TriggerListing {
		if let held = triggersHeld, now().timeIntervalSince(held.readAt) < retryAfter { return held.value }
		guard let loadTriggers else { return TriggerListing(triggers: [], isComplete: false) }
		let started = triggersRead == nil
		let task: Task<TriggerListing, Error>
		if let running = triggersRead {
			task = running
		} else {
			task = Task { try await loadTriggers() }
			triggersRead = task
		}
		defer { if started { triggersRead = nil } }
		let listing = try await task.value
		triggersHeld = Held(value: listing, readAt: now())
		return listing
	}

	private func lookup(_ target: LinkedTarget) async {
		defer { inFlight[target.key] = nil }
		// What counts as "this workspace" is fixed when the lookup starts: an answer that arrives
		// after a switch is dropped, not recorded as a permanent "not here".
		let workspace = workspaceID()
		do {
			let item = try await fetch(target, workspace: workspace)
			guard workspaceID() == workspace else {
				entries[target.key] = nil
				return
			}
			settle(target, with: item)
		} catch {
			if target.kind != .file, Self.isGone(error) {
				// Gone is final, and it is an answer: the card says so.
				entries[target.key] =
					workspaceID() == workspace ? Entry(state: .ready(.deleted(target)), failedAt: nil) : nil
				return
			}
			// A missing file is final; anything else (offline, a 5xx) is tried again later.
			entries[target.key] = Entry(state: .unavailable, failedAt: Self.isGone(error) ? nil : now())
		}
	}

	private func settle(_ target: LinkedTarget, with item: LinkedItem?) {
		entries[target.key] = Entry(state: item.map(LinkedItemState.ready) ?? .unavailable, failedAt: nil)
	}

	private static func isGone(_ error: Error) -> Bool {
		if let error = error as? ObjectsError { return error.message == ObjectsRemoteMessages.notFound }
		if let error = error as? FileError { return error.isNotFound }
		return false
	}

	/// An object is a card when it is in this workspace: the approval card for a draft worth acting
	/// on (it has a preview and text), the shared card face for anything else.
	func classify(_ detail: ObjectDetail, workspace: String?) -> LinkedItem? {
		if let current = workspace, detail.workspaceId.lowercased() != current.lowercased() { return nil }
		let object = detail.object
		let hasText = !(object.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		if let preview = detail.preview, hasText { return .draft(object, preview) }
		return .object(LinkedObject(object: object, kindLabel: Self.label(forType: object.type)))
	}

	/// A file is a card when it can be read in place: a page, a document, a picture or plain text.
	func classify(_ summary: FileSummary) -> LinkedItem {
		let reference = FileReference(
			id: summary.id, name: summary.name, mimeType: summary.mimeType, sizeBytes: summary.sizeBytes)
		switch summary.kind {
		case .markdown, .text, .html, .image: return .file(reference)
		case .pdf, .source, .other:
			return .plain(
				LinkedReference(
					target: LinkedTarget(kind: .file, uuid: summary.id), title: summary.name,
					kindLabel: FileContentKind.label(forMime: summary.mimeType)))
		}
	}

	/// "bet" becomes "Bet", "customer_note" "Customer note".
	static func label(forType type: String) -> String {
		let words = type.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
		return words.isEmpty ? "Object" : words.prefix(1).uppercased() + words.dropFirst()
	}

	// MARK: File text

	/// Reads the start of a markdown or text file once. A file too large to preview, or not valid
	/// text, is `failed` (Open only); a read that did not go through is `error` (Retry).
	public func loadText(of file: FileReference) async {
		guard fileTexts[file.id] == nil else { return }
		guard file.sizeBytes <= Self.maxPreviewBytes else {
			remember(.failed, for: file.id)
			return
		}
		remember(.loading, for: file.id)
		do {
			let detail = try await files.file(id: file.id)
			guard let text = detail.text else {
				remember(.failed, for: file.id)
				return
			}
			let cut = text.count > Self.previewCharacters
			remember(.ready(cut ? String(text.prefix(Self.previewCharacters)) : text, isTruncated: cut), for: file.id)
		} catch {
			remember(.error, for: file.id)
		}
	}

	/// Reads again after an error.
	public func retryText(of file: FileReference) async {
		guard fileTexts[file.id] == .error else { return }
		fileTexts[file.id] = nil
		await loadText(of: file)
	}

	private func remember(_ text: LinkedFileText, for id: String) {
		fileTexts[id] = text
		fileTextOrder.removeAll { $0 == id }
		fileTextOrder.append(id)
		while fileTextOrder.count > Self.maxCachedTexts {
			fileTexts[fileTextOrder.removeFirst()] = nil
		}
	}

	// MARK: Approving

	public func phase(of objectID: String) -> DraftApprovalPhase? { approvals[objectID] }

	public enum ApprovalResult: Equatable, Sendable {
		case approved(ObjectPreview)
		case failed(ObjectApprovalError)
	}

	/// A person's yes to a draft as it reads now. On success the card shows the new state and the
	/// caller tells the agent; a refusal because the draft changed re-reads it, so the card shows the
	/// text that would go out now.
	@discardableResult
	public func approve(objectID: String, preview: ObjectPreview) async -> ApprovalResult {
		guard approvals[objectID] != .approving else { return .failed(.other("Already approving.")) }
		approvals[objectID] = .approving
		// One key per draft text until the server has answered for it: a retry after a lost reply
		// is the same request, not a second approval.
		let keyName = "\(objectID)|\(preview.contentHash)"
		let key = approvalKeys[keyName] ?? UUID().uuidString
		approvalKeys[keyName] = key
		let target = LinkedTarget(kind: .object, uuid: objectID)
		do {
			let updated = try await objects.approve(
				objectId: objectID, contentHash: preview.contentHash, idempotencyKey: key)
			approvalKeys[keyName] = nil
			approvals[objectID] = nil
			replacePreview(objectID: objectID, with: updated)
			return .approved(updated)
		} catch {
			let failure = (error as? ObjectApprovalError) ?? .other("Couldn't approve this draft.")
			switch failure {
			case .offline, .other: break  // no answer: keep the key
			default: approvalKeys[keyName] = nil
			}
			if failure == .changed || failure == .notFound { await refresh(target) }
			// A draft that now reads approved or sent was approved already (a reply that never
			// reached us, or someone else): that is a yes, and the agent is told.
			if failure == .changed, case .draft(_, let now)? = item(for: target),
				now.delivery == .approved || now.delivery == .sent
			{
				approvals[objectID] = nil
				return .approved(now)
			}
			approvals[objectID] = .failed(failure.message)
			return .failed(failure)
		}
	}

	public func clearApprovalFailure(_ objectID: String) {
		if case .failed = approvals[objectID] { approvals[objectID] = nil }
	}

	private func replacePreview(objectID: String, with preview: ObjectPreview) {
		let key = LinkedTarget(kind: .object, uuid: objectID).key
		guard case .ready(.draft(let object, _))? = entries[key]?.state else { return }
		entries[key] = Entry(state: .ready(.draft(object, preview)), failedAt: nil)
	}

	/// Reads a target again, replacing what is held (a draft that changed). The card stays up
	/// while it reads, and stays if the read fails.
	public func refresh(_ target: LinkedTarget) async {
		if let running = inFlight[target.key] { await running.value }
		guard let item = try? await fetch(target, workspace: workspaceID()) else { return }
		settle(target, with: item)
	}
}

/// The words sent to the agent after a person approves a draft: what was approved, quoted exactly
/// as it reads so the agent doesn't have to guess.
public enum LinkedDraftMessage {
	public static func approved(title: String?, body: String) -> String {
		let name = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		let quoted = body.components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
		return "Approved \"\(name.isEmpty ? "Untitled" : name)\". Send it exactly as it reads:\n\n\(quoted)"
	}
}
