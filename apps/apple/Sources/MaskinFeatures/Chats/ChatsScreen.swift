import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Chats tab. A `NavigationSplitView`: list + thread side by side on iPad and Mac, a
/// push stack on iPhone. Owns its navigation and applies the shell toolbar.
///
/// `requestedConversationId` is the entry point for deep links: when it becomes non-nil the
/// screen selects that conversation (list and thread on iPad/Mac, a pushed thread on iPhone)
/// and resets the binding to nil, so the same link can be requested again later.
public struct ChatsScreen: View {
	private let environment: AppEnvironment
	@Binding private var requestedConversationId: String?

	public init(
		environment: AppEnvironment, requestedConversationId: Binding<String?> = .constant(nil)
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
	}

	/// Moves a pending request into the selection. Returns whether one was applied.
	@discardableResult
	static func consume(request: inout String?, into selection: inout String?) -> Bool {
		guard let id = request else { return false }
		selection = id
		request = nil
		return true
	}

	public var body: some View {
		if let workspaceID = environment.workspaceId {
			// Rebuilt per workspace so no conversation from the previous one lingers.
			ChatsContainer(
				environment: environment, workspaceID: workspaceID,
				requestedConversationId: $requestedConversationId
			)
			.id(workspaceID)
		} else {
			NavigationStack {
				EmptyState(symbol: "bubble.left.and.bubble.right", title: "Choose a workspace")
					.shellToolbar(environment: environment, title: "Chats")
			}
		}
	}
}

private struct ChatsContainer: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore
	@State private var selection: String?
	@State private var search = ""
	@State private var showNewChat = false
	@State private var pendingText = ""
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Binding var requestedConversationId: String?

	init(
		environment: AppEnvironment, workspaceID: String, requestedConversationId: Binding<String?>
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
		_store = State(
			initialValue: ConversationsStore(
				api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		NavigationSplitView {
			ConversationListView(
				store: store, selection: $selection, search: $search,
				currentActorID: environment.auth.session?.actorId,
				isLive: environment.events.connection != .failed,
				onNewChat: { showNewChat = true }
			)
			.shellToolbar(
				environment: environment, title: store.scope == .archived ? "Archived" : "Chats",
				actions: ShellActions(
					new: { showNewChat = true }, display: ShellDisplayMenu { ChatsDisplayMenu(store: store) }))
			.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			if let selection {
				ChatThreadHost(
					environment: environment, conversations: store, conversationID: selection
				)
				.id(selection)
			} else {
				EmptyState(
					symbol: "bubble.left.and.bubble.right", title: "Select a conversation",
					message: "Chat with your team and your agents.")
			}
		}
		.onChange(of: requestedConversationId, initial: true) {
			ChatsScreen.consume(request: &requestedConversationId, into: &selection)
		}
		.onChange(of: runtime?.chatDraft, initial: true) {
			// A build request from Agents or Loops: agents and loops are set up by the Chief of Staff.
			guard let draft = runtime?.chatDraft else { return }
			runtime?.chatDraft = nil
			Task { await startWithChiefOfStaff(text: draft.text) }
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
		.sheet(isPresented: $showNewChat, onDismiss: { pendingText = "" }) {
			NewChatSheet(
				store: store, currentActorID: environment.auth.session?.actorId, prefill: pendingText
			) { created in
				selection = created.id
			}
		}
	}
}

extension ChatsContainer {
	/// Agents and loops are never built through a form: the Chief of Staff scopes them with the
	/// person and creates them. Opens a chat with it, or the new-chat sheet with the text filled in
	/// when the workspace has no Chief of Staff (or the chat can't be created).
	fileprivate func startWithChiefOfStaff(text: String) async {
		await store.loadActors()
		guard
			let chief = store.actors.first(where: {
				$0.isSystem && $0.participant.kind == .agent && $0.participant.name == "Chief of Staff"
			})
		else {
			pendingText = text
			showNewChat = true
			return
		}
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: [chief.participant.name]),
				participantIDs: [chief.id], firstMessage: text)
			MaskinHaptics.play(.success)
			selection = created.id
		} catch {
			pendingText = text
			showNewChat = true
		}
	}
}

/// Builds the `ChatStore` for one conversation and hosts the thread plus its participants sheet.
private struct ChatThreadHost: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	let conversationID: String
	/// The store and composer are built once, on first render. They were `@State(initialValue:)`
	/// built in `init`, which runs on every parent re-render (each list update) and paid for a
	/// disk-cache decode and a store each time before SwiftUI discarded the result.
	@State private var holder = ThreadHolder()
	@State private var showParticipants = false
	/// Opens the People sheet straight on its picker ("Invite people").
	@State private var inviting = false

	init(environment: AppEnvironment, conversations: ConversationsStore, conversationID: String) {
		self.environment = environment
		self.conversations = conversations
		self.conversationID = conversationID
	}

	@MainActor
	private final class ThreadHolder {
		var built: (chat: ChatStore, composer: ChatComposerModel)?
	}

	private func make() -> (chat: ChatStore, composer: ChatComposerModel) {
		let conversationID = conversationID
		let session = environment.auth.session
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		chat.trace = ActivityStore(
			source: HTTPSessionActivitySource(environment: environment), cache: environment.snapshotCache)
		chat.onMarkedRead = { [conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		chat.onSessionsRefreshed = { [weak chat, weak environment] sessions in
			// Foreground fallback for the Live Activity; background updates come from APNs.
			guard let coordinator = TurnActivityCoordinator.shared, let chat,
				let workspaceId = environment?.workspaceId
			else { return }
			let turns = LiveTurn.turns(
				from: sessions, workspaceId: workspaceId, conversationId: conversationID,
				agentName: { id in chat.workspaceActors.first { $0.id == id }?.participant.name },
				now: Date())
			Task { await coordinator.reconcile(turns) }
		}
		let composer = ChatComposerModel(uploader: source, selfActorID: session?.actorId ?? "")
		composer.text = ChatDraftStore.text(for: conversationID)
		return (chat, composer)
	}

	var body: some View {
		let built = holder.built ?? make()
		let _ = { holder.built = built }()
		let chat = built.chat
		let composer = built.composer
		return ChatThreadView(store: chat, composer: composer, conversations: conversations,
			onShowParticipants: { showParticipants = true },
			onInvite: {
				inviting = true
				showParticipants = true
			})
			.onDisappear { ChatDraftStore.set(composer.text, for: chat.conversationID) }
			.sheet(isPresented: $showParticipants, onDismiss: { inviting = false }) {
				PeopleSheet(chat: chat, conversations: conversations, startAdding: inviting)
				.presentationDetents([.medium, .large])
			}
	}
}
