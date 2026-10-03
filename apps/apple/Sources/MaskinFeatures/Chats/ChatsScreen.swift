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
					.navigationTitle("Chats")
					.shellToolbar(environment: environment)
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
				onStart: { text in Task { await start(with: text) } }
			)
			.shellToolbar(environment: environment)
			.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			if let selection {
				ChatThreadHost(environment: environment, conversations: store, conversationID: selection)
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
	/// The bar's text starts a chat with the agent you talk to most recently, or the only agent
	/// there is. With no obvious choice the new-chat sheet opens with the text filled in.
	fileprivate func start(with text: String) async {
		await store.loadActors()
		let agents = store.actors.filter { $0.participant.kind == .agent && !$0.isSystem }
		let recent = store.recentCollaboratorIDs
		let target =
			recent.lazy.compactMap { id in agents.first { $0.id == id } }.first
			?? (agents.count == 1 ? agents.first : nil)
		guard let target else {
			pendingText = text
			showNewChat = true
			return
		}
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: [target.participant.name]),
				participantIDs: [target.id], firstMessage: text)
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
	@State private var chat: ChatStore
	@State private var composer: ChatComposerModel
	@State private var showParticipants = false

	init(environment: AppEnvironment, conversations: ConversationsStore, conversationID: String) {
		self.environment = environment
		self.conversations = conversations
		let session = environment.auth.session
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		chat.onMarkedRead = { [conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		_chat = State(initialValue: chat)
		let composer = ChatComposerModel(uploader: source, selfActorID: session?.actorId ?? "")
		composer.text = ChatDraftStore.text(for: conversationID)
		_composer = State(initialValue: composer)
	}

	var body: some View {
		ChatThreadView(store: chat, composer: composer, conversations: conversations, onShowParticipants: { showParticipants = true })
			.onDisappear { ChatDraftStore.set(composer.text, for: chat.conversationID) }
			.sheet(isPresented: $showParticipants) {
				ParticipantsSheet(chat: chat, conversations: conversations)
					.presentationDetents([.medium, .large])
			}
	}
}
