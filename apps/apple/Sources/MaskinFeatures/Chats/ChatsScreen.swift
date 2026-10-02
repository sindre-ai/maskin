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
	@Binding var requestedConversationId: String?

	init(
		environment: AppEnvironment, workspaceID: String, requestedConversationId: Binding<String?>
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
		_store = State(
			initialValue: ConversationsStore(
				api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events))
	}

	var body: some View {
		NavigationSplitView {
			ConversationListView(
				store: store, selection: $selection, search: $search,
				currentActorID: environment.auth.session?.actorId,
				isLive: environment.events.connection != .failed,
				onNewChat: { showNewChat = true }
			)
			.shellToolbar(environment: environment)
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
		.sheet(isPresented: $showNewChat) {
			NewChatSheet(store: store, currentActorID: environment.auth.session?.actorId) { created in
				selection = created.id
			}
		}
	}
}

/// Builds the `ChatStore` for one conversation and hosts the thread plus its participants sheet.
private struct ChatThreadHost: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	@State private var chat: ChatStore
	@State private var showParticipants = false

	init(environment: AppEnvironment, conversations: ConversationsStore, conversationID: String) {
		self.environment = environment
		self.conversations = conversations
		let session = environment.auth.session
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You",
			api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
			events: environment.events)
		chat.onMarkedRead = { [conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		_chat = State(initialValue: chat)
	}

	var body: some View {
		ChatThreadView(store: chat, onShowParticipants: { showParticipants = true })
			.sheet(isPresented: $showParticipants) {
				ParticipantsSheet(chat: chat, conversations: conversations)
					.presentationDetents([.medium, .large])
			}
	}
}
