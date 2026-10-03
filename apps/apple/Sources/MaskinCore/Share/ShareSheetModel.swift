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

	@ObservationIgnored private let loadContent: @Sendable () async -> ShareContent
	@ObservationIgnored private let secretStore: any SecretStore
	@ObservationIgnored private let makeRemote: @Sendable (ShareCredentials) -> any ShareRemote
	@ObservationIgnored private var poster: SharePoster?
	@ObservationIgnored private var credentials: ShareCredentials?

	public init(
		secretStore: any SecretStore, loadContent: @escaping @Sendable () async -> ShareContent,
		makeRemote: @escaping @Sendable (ShareCredentials) -> any ShareRemote
	) {
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
		}
	}

	public var showsTitleField: Bool { destination != .filesOnly }
	public var canPost: Bool {
		switch phase {
		case .ready, .failed: true
		default: false
		}
	}

	/// `maskin://<workspace>/objects/<id>`: where "Open in Maskin" goes. Files have no deep link.
	public var openURL: URL? {
		guard case .posted(let outcome) = phase, let id = outcome.objectID, let workspace = credentials?.workspaceId
		else { return nil }
		return DeepLink.object(workspaceId: workspace, id: id).url
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
		destination = Self.defaultDestination(in: schema, content: loaded)
		phase = .ready

		let remote = makeRemote(credentials)
		poster = SharePoster(remote: remote)
		do {
			let workspace = try await remote.workspace()
			self.workspace = workspace
			if !typeOptions.contains(destination) {
				destination = Self.defaultDestination(in: workspace.schema, content: loaded)
			}
		} catch let error as ShareError where error == .sessionExpired || error == .noWorkspace {
			phase = .blocked(error)
		} catch {
			// Offline or a hiccup: the sheet still works with the standard types.
		}
	}

	static func defaultDestination(in schema: ObjectsSchema, content: ShareContent) -> ShareDestination {
		if schema.types.contains("insight") { return .object(type: "insight") }
		if let first = schema.types.first { return .object(type: first) }
		return .filesOnly
	}

	/// Post, or retry a failed post with the same draft and the same idempotency keys.
	public func post() async {
		guard canPost, let poster else { return }
		let status: String
		switch destination {
		case .object(let type): status = schema.statuses(for: type).first ?? "new"
		case .filesOnly: status = ""
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
			content.cleanUp()
		} catch let error as ShareError {
			phase = error.needsApp ? .blocked(error) : .failed(error)
		} catch {
			phase = .failed(.unknown)
		}
	}

	/// The user dismissed the sheet (or it finished): remove the parked files.
	public func finish() { content.cleanUp() }

	/// Whether a failed post already created the object (the sheet says so on Retry).
	public func createdObjectBeforeFailure() async -> Bool {
		await poster?.progress.objectID != nil
	}
}
