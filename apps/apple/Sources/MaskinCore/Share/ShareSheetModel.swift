import Foundation
import Observation

/// State of the share sheet. UI-free (no SwiftUI/UIKit) so the whole flow is tested without a
/// host app: the extension supplies how to load the shared items and where the session lives.
@MainActor
@Observable
public final class ShareSheetModel {
	public enum Phase: Equatable, Sendable {
		case loading
		/// The user can edit and post.
		case ready
		case posting(SharePoster.Step?)
		case posted(SharePoster.Outcome)
		/// Couldn't be sent now; saved for the app to send as soon as it can.
		case queued
		/// Posting failed; the draft is intact and (for retryable errors) Post tries again.
		case failed(ShareError)
		/// Nothing can be posted until something outside the sheet changes (sign in, choose a workspace).
		case blocked(ShareError)
	}

	public private(set) var phase: Phase = .loading
	public private(set) var content = ShareContent()
	public private(set) var workspace: ShareWorkspace?
	public var title = ""
	public var note = ""
	public var destination: ShareDestination = .object(type: "insight")
	/// Every workspace the person is in, for the picker. Empty until loaded (or when offline).
	public private(set) var workspaces: [ShareWorkspace] = []
	/// Conversations of the chosen workspace, for the Chat destination. Empty until loaded.
	public private(set) var conversations: [ShareConversation] = []
	/// True while the chosen workspace's types and statuses are still loading. Sending waits for
	/// it: the first status of a type the server doesn't know would be rejected.
	public private(set) var isLoadingSchema = false
	/// Set when a failed post had already created the object, so Retry only finishes the files.
	public private(set) var createdObjectBeforeFailure = false

	@ObservationIgnored private let loadContent: @Sendable () async -> ShareContent
	@ObservationIgnored private let secretStore: any SecretStore
	@ObservationIgnored private let makeRemote: @Sendable (ShareCredentials) -> any ShareRemote
	@ObservationIgnored private let queue: ShareQueue?
	@ObservationIgnored private let drafts: ShareDraftStore?
	@ObservationIgnored private var postTask: Task<Void, Never>?
	@ObservationIgnored private var poster: SharePoster?
	@ObservationIgnored private var credentials: ShareCredentials?

	public init(
		secretStore: any SecretStore, loadContent: @escaping @Sendable () async -> ShareContent,
		makeRemote: @escaping @Sendable (ShareCredentials) -> any ShareRemote,
		queue: ShareQueue? = nil, drafts: ShareDraftStore? = nil
	) {
		self.queue = queue
		self.drafts = drafts
		self.secretStore = secretStore
		self.loadContent = loadContent
		self.makeRemote = makeRemote
	}

	// MARK: Derived

	/// Real types of the workspace (display names from its settings), insight by default.
	public var schema: ObjectsSchema { workspace?.schema ?? .fallback }

	public var typeOptions: [ShareDestination] {
		var options = schema.types.map { ShareDestination.object(type: $0) }
		if !content.attachments.isEmpty { options.append(.filesOnly) }
		return options
	}

	public func label(for destination: ShareDestination) -> String {
		switch destination {
		case .object(let type): schema.displayName(for: type)
		case .filesOnly: content.attachments.count == 1 ? "File" : "Files"
		case .chat(let id): conversations.first { $0.id == id }?.title ?? "Chat"
		}
	}

	/// Whether the destination is a chat message (no title field, no status).
	public var isChat: Bool { if case .chat = destination { true } else { false } }

	/// The workspace the share currently goes to: the picked one, else the session's.
	public var activeWorkspaceId: String? { credentials?.workspaceId }

	public var showsTitleField: Bool { destination != .filesOnly && !isChat }
	public var canPost: Bool {
		switch phase {
		case .ready, .failed: !isLoadingSchema
		default: false
		}
	}

	/// Whether dismissing now would throw away something the person typed.
	public var hasUnsentText: Bool {
		switch phase {
		case .ready, .failed: break
		default: return false
		}
		let typed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let edited = !typed.isEmpty && typed != content.suggestedTitle
		return edited || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	/// Why nothing could be shared, when skipped items explain it (a file over the size limit).
	public var blockedDetail: String? {
		guard case .blocked(.nothingToShare) = phase else { return nil }
		return content.skipped.first?.message
	}

	/// The words and link of this share as plain text, for Copy on a screen that can't send.
	public var copyableText: String {
		let own = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let body = ShareComposer.objectContent(note: note, content: content)
		return [own.isEmpty ? nil : own, body.isEmpty ? nil : body].compactMap { $0 }.joined(separator: "\n\n")
	}

	/// `maskin://<workspace>/objects|chats/<id>`: where "Open in Maskin" goes. Files have no deep link.
	public var openURL: URL? {
		guard case .posted(let outcome) = phase, let workspace = credentials?.workspaceId else { return nil }
		if let id = outcome.objectID { return DeepLink.object(workspaceId: workspace, id: id).url }
		if let id = outcome.conversationID { return DeepLink.chat(workspaceId: workspace, id: id).url }
		return nil
	}

	// MARK: Flow

	public func start() async {
		guard phase == .loading else { return }
		let credentials: ShareCredentials
		do {
			credentials = try ShareSession.credentials(from: secretStore)
		} catch {
			phase = .blocked(error)
			return
		}
		self.credentials = credentials
		let loaded = await loadContent()
		content = loaded
		guard !loaded.isEmpty else {
			phase = .blocked(.nothingToShare)
			return
		}
		title = loaded.suggestedTitle
		if let saved = drafts?.load(fingerprint: loaded.fingerprint) {
			if !saved.title.isEmpty { title = saved.title }
			note = saved.note
		}
		destination = Self.defaultDestination(in: schema, content: loaded)
		isLoadingSchema = true
		phase = .ready

		await connect(credentials)
		// The picker is a nicety: its failure (offline) never blocks the share.
		if let all = try? await makeRemote(credentials).workspaces() { workspaces = all }
	}

	/// Points the sheet at `credentials`' workspace: a fresh remote and poster (so a retry can
	/// never mix idempotency keys across workspaces), its schema, and its conversations.
	private func connect(_ credentials: ShareCredentials) async {
		self.credentials = credentials
		let remote = makeRemote(credentials)
		poster = SharePoster(remote: remote)
		workspace = nil
		conversations = []
		isLoadingSchema = true
		defer { isLoadingSchema = false }
		do {
			let workspace = try await remote.workspace()
			self.workspace = workspace
			if !typeOptions.contains(destination), !isChat {
				destination = Self.defaultDestination(in: workspace.schema, content: content)
			}
		} catch let error as ShareError where error == .sessionExpired || error == .noWorkspace {
			phase = .blocked(error)
			return
		} catch {
			// Offline or a hiccup: the sheet still works with the standard types.
		}
		conversations = (try? await remote.conversations()) ?? []
	}

	/// Sends the share to another workspace. Types and conversations are that workspace's own,
	/// so a destination that doesn't exist there falls back to the default.
	public func selectWorkspace(_ id: String) async {
		guard canPost, let current = credentials, id != current.workspaceId else { return }
		if isChat { destination = Self.defaultDestination(in: schema, content: content) }
		await connect(ShareCredentials(apiKey: current.apiKey, workspaceId: id))
		if let name = workspaces.first(where: { $0.id == id })?.name, workspace == nil {
			workspace = ShareWorkspace(id: id, name: name, schema: .fallback)
		}
		if !typeOptions.contains(destination), !isChat {
			destination = Self.defaultDestination(in: schema, content: content)
		}
	}

	static func defaultDestination(in schema: ObjectsSchema, content: ShareContent) -> ShareDestination {
		if schema.types.contains("insight") { return .object(type: "insight") }
		if let first = schema.types.first { return .object(type: first) }
		return .filesOnly
	}

	// Known limit (review item 17): the post runs inside the extension's process, so swiping the
	// sheet away mid-upload ends it and loses the files. "Create the object first, show Sent, then
	// upload" would not fix that (the process still dies after `completeRequest`); real continuation
	// needs a background URLSession with an app-group container and a relaunch handler, which the
	// OpenAPI client doesn't support. What protects the person today: transient failures park the
	// whole share in `ShareQueue` for the app to finish, and Cancel stops cleanly with the same
	// idempotency keys. Don't show "Sent" before the files are up: it would be a lie on a swipe-away.

	/// Post, or retry a failed post with the same draft and the same idempotency keys.
	public func post() async {
		guard canPost, postTask == nil else { return }
		let task = Task { await self.perform() }
		postTask = task
		await task.value
		postTask = nil
	}

	/// Stops a post in flight (Cancel while posting). The sheet returns to editable; a retry or
	/// the next share resumes with the same idempotency keys, so nothing is duplicated.
	public func cancelPosting() { postTask?.cancel() }

	private func perform() async {
		guard let poster else { return }
		let status: String
		switch destination {
		case .object(let type): status = schema.statuses(for: type).first ?? "new"
		case .filesOnly, .chat: status = ""
		}
		let request = ShareRequest(
			destination: destination, title: title, note: note, content: content, status: status)
		phase = .posting(nil)
		do {
			let outcome = try await poster.post(request) { [weak self] step in
				Task { @MainActor in
					if case .posting = self?.phase { self?.phase = .posting(step) }
				}
			}
			phase = .posted(outcome)
			createdObjectBeforeFailure = false
			drafts?.clear()
			content.cleanUp()
		} catch let error as ShareError {
			if Task.isCancelled { phase = .ready; return }
			if error.isTransient, await park(request) { return }
			createdObjectBeforeFailure = await poster.progress.objectID != nil
			phase = error.needsApp ? .blocked(error) : .failed(error)
		} catch {
			if Task.isCancelled { phase = .ready; return }
			phase = .failed(.unknown)
		}
	}

	// MARK: Draft

	/// Keeps the title and note so a dismissed sheet doesn't lose them. Call as they change.
	public func saveDraft() {
		guard let drafts else { return }
		if hasUnsentText {
			drafts.save(fingerprint: content.fingerprint, title: title, note: note)
		} else {
			drafts.clear()
		}
	}

	/// The person chose to throw the words away.
	public func discardDraft() { drafts?.clear() }

	/// Saves a share that couldn't go out for the app to send later. `false` when there is nowhere
	/// to save it, in which case the sheet shows the failure and keeps the draft.
	private func park(_ request: ShareRequest) async -> Bool {
		guard let queue, let workspaceId = credentials?.workspaceId, let poster else { return false }
		guard
			(try? queue.enqueue(
				request, workspaceId: workspaceId, idempotencyBase: poster.idempotencyBase)) != nil
		else { return false }
		phase = .queued
		drafts?.clear()
		content.cleanUp()
		return true
	}

	/// The user dismissed the sheet (or it finished): remove the parked files.
	public func finish() { content.cleanUp() }
}
