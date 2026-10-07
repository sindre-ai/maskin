import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The "Chats" row under the watch inbox: recent conversations, unread first.
struct WatchChatsSection: View {
	let environment: AppEnvironment

	var body: some View {
		Section("Chats") {
			NavigationLink {
				WatchChatsList(environment: environment)
			} label: {
				Label("Conversations", systemImage: "bubble.left.and.bubble.right")
			}
		}
	}
}

struct WatchChatsList: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore

	init(environment: AppEnvironment) {
		self.environment = environment
		_store = State(
			initialValue: ConversationsStore(
				api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
				events: environment.events, cache: environment.snapshotCache))
	}

	private var items: [ConversationSummary] { WatchChat.glance(store.conversations) }

	var body: some View {
		List {
			if items.isEmpty {
				EmptyState(symbol: "bubble.left", title: "No chats", message: "Start one on your iPhone.")
			}
			ForEach(items) { conversation in
				NavigationLink {
					WatchThread(environment: environment, conversationID: conversation.id)
				} label: {
					WatchChatRow(conversation: conversation)
				}
			}
		}
		.navigationTitle("Chats")
		.task { await store.start() }
		.onDisappear { store.stop() }
	}
}

private struct WatchChatRow: View {
	let conversation: ConversationSummary

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack {
				Text(conversation.title).font(.headline).lineLimit(1)
				if conversation.unreadCount > 0 {
					Spacer(minLength: 0)
					Text("\(conversation.unreadCount)")
						.font(.caption2.weight(.bold))
						.foregroundStyle(MaskinColor.sigInk)
				}
			}
			if let snippet = conversation.snippet, !snippet.isEmpty {
				Text(snippet).font(.footnote).foregroundStyle(MaskinColor.ink3).lineLimit(2)
			}
		}
		.accessibilityElement(children: .combine)
	}
}

/// One conversation: the last few messages and a reply. Sending goes through the same durable
/// outbox as the phone, so a reply typed with the phone out of reach still goes out exactly once.
struct WatchThread: View {
	@State private var chat: ChatStore
	@State private var draft = ""

	init(environment: AppEnvironment, conversationID: String) {
		let session = environment.auth.session
		_chat = State(
			initialValue: ChatStore(
				conversationID: conversationID, currentActorID: session?.actorId ?? "",
				currentActorName: session?.name ?? "You",
				api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
				queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
				cache: environment.snapshotCache))
	}

	private var recent: [ChatMessage] { WatchChat.recent(chat.messages) }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				ForEach(recent) { message in
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(message.actorName).font(.caption2).foregroundStyle(MaskinColor.ink4)
						Text(message.content).font(.footnote)
						if case .failed(let reason) = message.status {
							Text(reason).font(.caption2).foregroundStyle(MaskinColor.danger)
						}
					}
					.accessibilityElement(children: .combine)
				}
				if let working = chat.workingAgents().first {
					Text("\(working.name) is working…").font(.caption2).foregroundStyle(MaskinColor.ink4)
				}
				replyControls
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.navigationTitle(chat.title)
		.task { await chat.start() }
		.onDisappear { chat.stop() }
	}

	@ViewBuilder
	private var replyControls: some View {
		// Dictation, scribble or keyboard, whichever the watch offers.
		TextField("Reply", text: $draft)
			.submitLabel(.send)
			.onSubmit(sendDraft)
		ForEach(WatchChat.quickReplies, id: \.self) { phrase in
			Button(phrase) { chat.send(phrase) }
				.buttonStyle(SecondaryActionButtonStyle())
		}
		if let notice = chat.notice {
			Text(notice).font(.footnote).foregroundStyle(MaskinColor.danger)
		}
	}

	private func sendDraft() {
		chat.send(draft)
		draft = ""
	}
}
