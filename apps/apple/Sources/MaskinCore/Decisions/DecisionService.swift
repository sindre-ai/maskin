import Foundation
import Observation

// The shared decision brain. UI-free, so For You and the Objects detail screen both use it.
//
// HOW A DECISION WORKS (mirrors the web app, `routes/_authed/$workspaceId/index.tsx`):
//   taking an option or typing a reply is `POST /api/events` (a comment on the object,
//   `content` = the option label or the typed text, `parent_event_id` = the agent's comment so
//   the answer threads under the ask) followed by `POST /api/subscriptions/read` with the
//   thread's high-water mark (`latest_event_id`), which is what drops the card from the feed.
//   "Hold" and "Approve" are not special: they are option labels the agent authored.
//   Dismissing is only the mark-read; Undo of a dismissal is `POST /api/subscriptions/unread`.
//
// EVERYTHING GOES THROUGH THE OUTBOX, so it works offline and survives a relaunch. The comment
// and the mark-read are one outbox group: if the comment is rejected the mark-read is dropped
// with it, and the card comes back instead of vanishing unanswered.
//
// UNDO: the web has no delete-comment endpoint, so an Undo after the write is sent would be a
// lie. Instead the entries are held in the outbox for `undoWindow` seconds; `undo(_:)` inside
// that window removes them before anything is sent. After it, the receipt is final.
//
// REUSE FROM ANOTHER SCREEN (e.g. the Objects detail "Forge asks" card):
//
//     let target = DecisionTarget(card)            // or DecisionTarget(entityId:..., parentEventId:..., latestEventId:...)
//     decisions.choose("Approve", on: target)      // option from the agent's decision block
//     decisions.reply("Ship it Thursday", on: target)
//     decisions.markRead(target)                   // dismiss without answering
//     decisions.undo(target.entityId)              // within the window
//     decisions.record(for: target.entityId)?.phase(…)   // .held / .queued / .sending / .sent / .failed
//
// Read `record(for:)` from a view; it is observable.

/// What a decision is about, as plain ids.
public struct DecisionTarget: Sendable, Equatable {
	/// The object the thread lives on.
	public var entityId: String
	/// The agent's comment being answered (threads the reply under it).
	public var parentEventId: Int?
	/// The thread's high-water mark. `nil`: the reply can go out but cannot mark the thread read.
	public var latestEventId: Int?

	public init(entityId: String, parentEventId: Int? = nil, latestEventId: Int? = nil) {
		self.entityId = entityId
		self.parentEventId = parentEventId
		self.latestEventId = latestEventId
	}

	public init(_ card: ForYouCard) {
		self.init(
			entityId: card.id, parentEventId: card.mention?.eventId, latestEventId: card.latestEventId)
	}
}

/// The network side of a decision. The production adapter wraps the generated client.
public protocol DecisionBackend: Sendable {
	/// `POST /api/events`
	func postComment(entityId: String, content: String, parentEventId: Int?) async throws
	/// `POST /api/subscriptions/read`
	func markRead(entityId: String, lastEventId: Int) async throws
	/// `POST /api/subscriptions/unread`
	func markUnread(entityId: String) async throws
}

/// What the service has done (or is about to do) for one object.
public struct DecisionRecord: Sendable, Equatable {
	public enum Kind: Sendable, Equatable {
		/// Took an agent-authored option.
		case option(String)
		/// Typed an answer.
		case reply(String)
		/// Marked read without answering.
		case dismissed
	}

	public enum Phase: Sendable, Equatable {
		/// Inside the Undo window: nothing has been sent yet.
		case held(until: Date)
		/// Past the window, on the wire or about to be.
		case sending
		/// Past the window but waiting: offline, or backing off after a failed attempt.
		case queued
		case sent
		/// Rejected by the server. The card is back as it was; `message` says why.
		case failed(String)
	}

	public var kind: Kind
	public var phase: Phase
	/// The reply went out but the thread has no high-water mark, so it will come back unread.
	public var staysUnread: Bool
	public var groupId: String

	public init(kind: Kind, phase: Phase, staysUnread: Bool = false, groupId: String = "") {
		self.kind = kind
		self.phase = phase
		self.staysUnread = staysUnread
		self.groupId = groupId
	}
}

@MainActor
@Observable
public final class DecisionService {
	public static let commentKind = "decision.comment"
	public static let markReadKind = "decision.markRead"
	public static let markUnreadKind = "decision.markUnread"

	/// Seconds a decision is held before it is sent, during which Undo is free.
	public let undoWindow: TimeInterval

	public private(set) var records: [String: DecisionRecord] = [:]
	/// Bumped when a hold expires so views re-read `phase`.
	private var clockTick = 0

	@ObservationIgnored private let outbox: Outbox
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var holdTimers: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private var listener: Task<Void, Never>?

	public init(
		outbox: Outbox, undoWindow: TimeInterval = 6, now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.outbox = outbox
		self.undoWindow = undoWindow
		self.now = now
		let events = outbox.events()
		listener = Task { [weak self] in
			for await event in events { self?.handle(event) }
		}
	}

	deinit { listener?.cancel() }

	// MARK: Reading state

	/// Reading `clockTick` makes a view re-evaluate when a hold expires.
	public func record(for entityId: String) -> DecisionRecord? {
		_ = clockTick
		guard var record = records[entityId] else { return nil }
		if case .held(let until) = record.phase, until <= now() {
			record.phase = livePhase(for: record)
		}
		return record
	}

	/// The Undo is still free.
	public func canUndo(_ entityId: String) -> Bool {
		guard let record = record(for: entityId) else { return false }
		if case .held = record.phase { return true }
		// A sent dismissal is reversible (mark unread); a sent answer is not.
		if case .dismissed = record.kind, record.phase == .sent { return true }
		return false
	}

	// MARK: Acting

	/// Take one of the agent's options. Optimistic: the record exists the moment this returns.
	public func choose(_ label: String, on target: DecisionTarget) {
		submit(content: label, kind: .option(label), target: target)
	}

	/// Answer in the reader's own words.
	public func reply(_ text: String, on target: DecisionTarget) {
		let text = text.trimmed
		guard !text.isEmpty else { return }
		submit(content: text, kind: .reply(text), target: target)
	}

	/// Mark the thread read without answering.
	public func markRead(_ target: DecisionTarget) {
		let group = UUID().uuidString
		var held = false
		if let eventId = target.latestEventId, eventId > 0 {
			held = enqueue(
				kind: Self.markReadKind, target: target, group: group, summary: "Mark thread as read",
				payload: MarkReadPayload(entityId: target.entityId, lastEventId: eventId))
		}
		guard held else { return }
		install(
			DecisionRecord(
				kind: .dismissed, phase: .held(until: now().addingTimeInterval(undoWindow)),
				staysUnread: false, groupId: group),
			for: target.entityId)
	}

	/// Take the decision back. Free inside the window; after it, only a dismissal can be reversed.
	/// Returns whether anything was undone.
	@discardableResult
	public func undo(_ entityId: String) -> Bool {
		guard let record = record(for: entityId) else { return false }
		if outbox.cancel(groupId: record.groupId) {
			clear(entityId)
			return true
		}
		if case .dismissed = record.kind, record.phase == .sent {
			let group = UUID().uuidString
			let queued = enqueue(
				kind: Self.markUnreadKind, target: DecisionTarget(entityId: entityId), group: group,
				summary: "Mark thread as unread", payload: MarkUnreadPayload(entityId: entityId),
				hold: false)
			if queued { clear(entityId) }
			return queued
		}
		return false
	}

	/// Forget a record (e.g. after showing a failure).
	public func clear(_ entityId: String) {
		holdTimers[entityId]?.cancel()
		holdTimers[entityId] = nil
		records[entityId] = nil
	}

	/// Send everything held right now (app is backgrounding).
	public func commitHeld() {
		outbox.releaseHolds()
		for (id, record) in records {
			if case .held = record.phase { records[id]?.phase = livePhase(for: record) }
		}
	}

	// MARK: Internals

	private func submit(content: String, kind: DecisionRecord.Kind, target: DecisionTarget) {
		let group = UUID().uuidString
		let comment = enqueue(
			kind: Self.commentKind, target: target, group: group,
			summary: "Your reply on \u{201C}\(Self.excerpt(content))\u{201D}",
			payload: CommentPayload(
				entityId: target.entityId, content: content, parentEventId: target.parentEventId))
		guard comment else { return }
		var staysUnread = true
		if let eventId = target.latestEventId, eventId > 0 {
			staysUnread = !enqueue(
				kind: Self.markReadKind, target: target, group: group, summary: "Mark thread as read",
				payload: MarkReadPayload(entityId: target.entityId, lastEventId: eventId))
		}
		install(
			DecisionRecord(
				kind: kind, phase: .held(until: now().addingTimeInterval(undoWindow)),
				staysUnread: staysUnread, groupId: group),
			for: target.entityId)
	}

	@discardableResult
	private func enqueue<P: Encodable>(
		kind: String, target: DecisionTarget, group: String, summary: String, payload: P,
		hold: Bool = true
	) -> Bool {
		(try? outbox.enqueue(
			kind: kind, lane: "object:\(target.entityId)", groupId: group, summary: summary,
			payload: payload, holdFor: hold ? undoWindow : 0)) != nil
	}

	private func install(_ record: DecisionRecord, for entityId: String) {
		if let old = records[entityId], old.groupId != record.groupId {
			// Answering again supersedes a previous attempt (e.g. after a failure).
			_ = outbox.cancel(groupId: old.groupId)
		}
		records[entityId] = record
		holdTimers[entityId]?.cancel()
		if case .held(let until) = record.phase {
			let delay = max(until.timeIntervalSince(now()), 0) + 0.05
			holdTimers[entityId] = Task { [weak self] in
				try? await Task.sleep(for: .seconds(delay))
				guard !Task.isCancelled else { return }
				self?.holdExpired(entityId)
			}
		}
	}

	private func holdExpired(_ entityId: String) {
		guard var record = records[entityId], case .held = record.phase else { return }
		record.phase = livePhase(for: record)
		records[entityId] = record
		clockTick += 1
	}

	private func livePhase(for record: DecisionRecord) -> DecisionRecord.Phase {
		let pending = outbox.entries(inGroup: record.groupId)
		if pending.isEmpty { return .sent }
		if !outbox.isOnline || pending.contains(where: { $0.attempts > 0 }) { return .queued }
		return .sending
	}

	private func handle(_ event: OutboxEvent) {
		switch event {
		case .sent(let entry):
			guard let group = entry.groupId,
				let (id, record) = records.first(where: { $0.value.groupId == group })
			else { return }
			if outbox.entries(inGroup: group).isEmpty {
				if case .failed = record.phase { return }
				records[id]?.phase = .sent
				clockTick += 1
			} else if case .held = record.phase {
				// still waiting on the rest of the group
			} else {
				records[id]?.phase = livePhase(for: record)
			}
		case .rejected(let entry, let message):
			guard let group = entry.groupId,
				let id = records.first(where: { $0.value.groupId == group })?.key
			else { return }
			records[id]?.phase = .failed(message)
			holdTimers[id]?.cancel()
			clockTick += 1
		}
	}

	static func excerpt(_ text: String) -> String {
		let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
		return line.count > 40 ? String(line.prefix(40)) + "…" : line
	}
}

// MARK: - Payloads and executor

struct CommentPayload: Codable, Sendable, Equatable {
	var entityId: String
	var content: String
	var parentEventId: Int?
}

struct MarkReadPayload: Codable, Sendable, Equatable {
	var entityId: String
	var lastEventId: Int
}

struct MarkUnreadPayload: Codable, Sendable, Equatable {
	var entityId: String
}

/// Replays decision writes through a `DecisionBackend`. Register one per outbox.
public struct DecisionOutboxExecutor: OutboxExecuting {
	private let backend: any DecisionBackend

	public init(backend: any DecisionBackend) { self.backend = backend }

	public func execute(kind: String, payload: Data) async throws {
		let decoder = JSONDecoder()
		switch kind {
		case DecisionService.commentKind:
			let p = try decoder.decode(CommentPayload.self, from: payload)
			try await backend.postComment(
				entityId: p.entityId, content: p.content, parentEventId: p.parentEventId)
		case DecisionService.markReadKind:
			let p = try decoder.decode(MarkReadPayload.self, from: payload)
			try await backend.markRead(entityId: p.entityId, lastEventId: p.lastEventId)
		case DecisionService.markUnreadKind:
			let p = try decoder.decode(MarkUnreadPayload.self, from: payload)
			try await backend.markUnread(entityId: p.entityId)
		default:
			throw OutboxRejection(message: "Unknown queued action \(kind).")
		}
	}
}

/// Routes outbox kinds to several executors, so Chats can share the same outbox later.
public struct CompositeOutboxExecutor: OutboxExecuting {
	private let routes: [(prefix: String, executor: any OutboxExecuting)]

	public init(_ routes: [(prefix: String, executor: any OutboxExecuting)]) { self.routes = routes }

	public func execute(kind: String, payload: Data) async throws {
		guard let route = routes.first(where: { kind.hasPrefix($0.prefix) }) else {
			throw OutboxRejection(message: "No handler for \(kind).")
		}
		try await route.executor.execute(kind: kind, payload: payload)
	}
}
