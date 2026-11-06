import Foundation
import Observation

/// The three calls the For you draft cards make on the object that holds a message: read it,
/// save an edit, approve it (see `ObjectDraftsRemote`).
public protocol DraftReviewRemote: ObjectDraftsRemote {}

/// Production remote: the objects client behind the three calls.
public struct APIDraftReviewRemote: DraftReviewRemote {
	private let objects: APIObjectsRemote

	public init(objects: APIObjectsRemote) { self.objects = objects }

	public func detail(objectId: String) async throws -> ObjectDetail {
		try await objects.detail(objectId: objectId)
	}

	public func save(objectId: String, content: String?, subject: String?, idempotencyKey: String) async throws {
		let patch = ObjectPatch(content: content, metadata: subject.map { ["subject": $0] })
		_ = try await objects.update(objectId: objectId, patch: patch, idempotencyKey: idempotencyKey)
	}

	public func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		try await objects.approve(objectId: objectId, contentHash: contentHash, idempotencyKey: idempotencyKey)
	}
}

/// A reason a draft could not go, already in plain words.
struct DraftReviewError: Error, Equatable {
	var message: String
	init(_ message: String) { self.message = message }
}

/// Editing and approving drafts from For you.
///
/// Approve and send is two steps for the reader and a short hold for the app: the card turns into a
/// receipt with Undo for `undoWindow` seconds, and only then is the edit saved, the draft approved
/// and the agent told. A send reaches a real person, so the hold is the only chance to take it back.
/// A failure keeps the edit and offers Retry; the edit is only ever lost by Revert.
@MainActor
@Observable
public final class DraftReviewStore {
	public enum Phase: Equatable, Sendable {
		/// The card is open for reading and editing.
		case editing
		/// Approved, inside the Undo window: nothing has been saved or sent yet.
		case held(until: Date)
		/// Saving the edit, approving, telling the agent.
		case sending
		/// Did not go; the message says why. The edit is kept.
		case failed(String)
		case sent
	}

	/// Seconds the receipt offers Undo before anything is sent.
	public let undoWindow: TimeInterval

	public private(set) var phases: [String: Phase] = [:]
	public private(set) var edits: [String: DraftEdit] = [:]
	/// Drafts that left the editing state, in the order they did, so their receipts stay on screen
	/// after the card they came from is gone.
	public private(set) var receipts: [ReviewDraft] = []

	@ObservationIgnored private let saver: DraftSaveAndApprove
	/// Tells the agent to send: queues the same "Send: …" reply a stacked card sends. False when it
	/// could not be queued.
	@ObservationIgnored private let announce: @MainActor (ReviewDraft) -> Bool
	/// Called once a draft is approved and the agent told.
	@ObservationIgnored public var didSend: @MainActor (ReviewDraft) -> Void = { _ in }
	@ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private let now: @Sendable () -> Date

	public init(
		remote: any DraftReviewRemote, undoWindow: TimeInterval = 6,
		now: @escaping @Sendable () -> Date = { Date() },
		announce: @escaping @MainActor (ReviewDraft) -> Bool
	) {
		self.saver = DraftSaveAndApprove(remote: remote)
		self.undoWindow = undoWindow
		self.now = now
		self.announce = announce
	}

	// MARK: Reading

	public func phase(of draft: ReviewDraft) -> Phase { phases[draft.id] ?? .editing }

	/// What the card shows: the reader's edit, else the original.
	public func edit(for draft: ReviewDraft) -> DraftEdit { edits[draft.id] ?? DraftEdit(draft) }

	/// The text differs from the original ("Edited").
	public func isEdited(_ draft: ReviewDraft) -> Bool { edits[draft.id] != nil }

	/// The card is open for typing.
	public func isEditable(_ draft: ReviewDraft) -> Bool {
		switch phase(of: draft) {
		case .editing, .failed: true
		case .held, .sending, .sent: false
		}
	}

	/// Approve is available: nothing required is missing and the text and subject are not empty.
	public func canApprove(_ draft: ReviewDraft) -> Bool {
		let edit = edit(for: draft)
		guard draft.missing.isEmpty, !edit.body.trimmed.isEmpty else { return false }
		return !draft.isEmail || !(edit.subject ?? "").trimmed.isEmpty
	}

	/// Why Approve is off, as one line for the card; nil when it is available.
	public func blockedReason(_ draft: ReviewDraft) -> String? {
		if canApprove(draft) { return nil }
		if let first = draft.missing.first { return "Still needs: \(first)" }
		if draft.isEmail, (edit(for: draft).subject ?? "").trimmed.isEmpty { return "Add a subject to approve." }
		return "Add some text to approve."
	}

	/// The receipts that are still in flight or done, newest last.
	public var receiptDrafts: [ReviewDraft] {
		receipts.filter { !isEditable($0) }
	}

	// MARK: Editing

	public func setBody(_ text: String, for draft: ReviewDraft) {
		guard isEditable(draft) else { return }
		var edit = edit(for: draft)
		edit.body = text
		keep(edit, for: draft)
	}

	public func setSubject(_ text: String, for draft: ReviewDraft) {
		guard isEditable(draft), draft.isEmail else { return }
		var edit = edit(for: draft)
		edit.subject = text
		keep(edit, for: draft)
	}

	/// Back to the draft as the agent wrote it.
	public func revert(_ draft: ReviewDraft) {
		guard isEditable(draft) else { return }
		edits[draft.id] = nil
		clearFailure(draft)
	}

	private func keep(_ edit: DraftEdit, for draft: ReviewDraft) {
		edits[draft.id] = edit.differs(from: draft) ? edit : nil
		clearFailure(draft)
	}

	private func clearFailure(_ draft: ReviewDraft) {
		if case .failed = phase(of: draft) { phases[draft.id] = nil }
	}

	// MARK: Approving

	/// Approve and send: the receipt appears with Undo, and the draft goes when the window closes.
	public func approve(_ draft: ReviewDraft) {
		switch phase(of: draft) {
		case .editing, .failed: break
		case .held, .sending, .sent: return
		}
		guard canApprove(draft) else { return }
		remember(draft)
		phases[draft.id] = .held(until: now().addingTimeInterval(undoWindow))
		timers[draft.id]?.cancel()
		timers[draft.id] = Task { [weak self, undoWindow] in
			try? await Task.sleep(for: .seconds(undoWindow))
			guard !Task.isCancelled else { return }
			await self?.send(draft)
		}
	}

	/// Take the approval back inside the window: the card returns with the edit as it was.
	public func undo(_ draft: ReviewDraft) {
		guard case .held = phase(of: draft) else { return }
		timers[draft.id]?.cancel()
		timers[draft.id] = nil
		phases[draft.id] = nil
		receipts.removeAll { $0.id == draft.id }
	}

	/// Try again after a failure, at once: the reader already decided.
	public func retry(_ draft: ReviewDraft) {
		guard case .failed = phase(of: draft) else { return }
		remember(draft)
		Task { [weak self] in await self?.send(draft) }
	}

	/// Send everything held now (the app is going to the background).
	public func commitHeld() {
		for receipt in receipts {
			guard case .held = phase(of: receipt) else { continue }
			timers[receipt.id]?.cancel()
			Task { [weak self] in await self?.send(receipt) }
		}
	}

	/// Forget everything (another workspace or account).
	public func reset() {
		for timer in timers.values { timer.cancel() }
		timers = [:]
		phases = [:]
		edits = [:]
		receipts = []
		saver.reset()
	}

	private func remember(_ draft: ReviewDraft) {
		receipts.removeAll { $0.id == draft.id }
		receipts.append(draft)
	}

	// MARK: Sending

	func send(_ draft: ReviewDraft) async {
		let id = draft.id
		timers[id] = nil
		phases[id] = .sending
		do {
			try await perform(draft)
			phases[id] = .sent
			edits[id] = nil
			didSend(draft)
		} catch {
			phases[id] = .failed(Self.message(for: error))
		}
	}

	/// Read the draft fresh, save the edit if there is one, approve exactly the text that is now
	/// saved, then tell the agent. Nothing is approved that the reader has not seen: a draft that
	/// changed under them stops here.
	private func perform(_ draft: ReviewDraft) async throws {
		let outcome = try await saver.run(DraftShown(draft), edit: edit(for: draft))
		if outcome == .alreadySent { return }
		guard announce(draft) else {
			throw DraftReviewError("Approved, but couldn't tell the agent. Try again.")
		}
	}

	static func message(for error: any Error) -> String {
		if let error = error as? DraftReviewError { return error.message }
		if let error = error as? ObjectApprovalError {
			if error == .offline { return "You're offline. Your edit is kept." }
			return error.message
		}
		if let error = error as? ObjectsError {
			return error.isOffline ? "You're offline. Your edit is kept." : error.message
		}
		return "Couldn't send this. Your edit is kept."
	}
}
