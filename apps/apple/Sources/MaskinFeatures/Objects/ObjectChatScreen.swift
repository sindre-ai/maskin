import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The group chat about one object. Commenting on an object happens here: the chat opens with the
/// object's earlier comments and keeps up with new ones. The server hands back the chat that
/// already exists for the object, or makes it the first time anyone opens it.
struct ObjectChatScreen: View {
	let environment: AppEnvironment
	let objectID: String
	let title: String

	@State private var conversations: ConversationsStore
	@State private var conversationID: String?
	@State private var failure: String?

	init(environment: AppEnvironment, objectID: String, title: String) {
		self.environment = environment
		self.objectID = objectID
		self.title = title
		let session = environment.auth.session
		let workspaceID = environment.workspaceId ?? ""
		_conversations = State(
			initialValue: ConversationsStore(
				api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache,
				preferences: TeamPreferences(actorID: session?.actorId, workspaceID: workspaceID)))
	}

	var body: some View {
		Group {
			if let conversationID {
				ChatThreadHost(environment: environment, conversations: conversations, conversationID: conversationID)
			} else if let failure {
				EmptyState(
					symbol: "bubble.left.and.exclamationmark.bubble.right", title: "Couldn't open the chat",
					message: failure
				) {
					Button("Try again") { Task { await open() } }
				}
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.ambientBackground()
		.task { await open() }
	}

	private func open() async {
		failure = nil
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		do {
			let chat = try await source.chat(
				about: .object(objectID), title: title, idempotencyKey: UUID().uuidString)
			conversationID = chat.id
		} catch {
			failure = (error as? ChatsError)?.message ?? "Check your connection and try again."
		}
	}
}
