import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Team tab. A `NavigationSplitView`: list + thread side by side on iPad and Mac, a
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
					.shellToolbar(environment: environment, title: "Team")
			}
		}
	}
}

private struct ChatsContainer: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore
	@State private var selection: String?
	@State private var search = ""
	@State private var newChat: NewChatRequest?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.liveMeeting) private var liveMeeting
	@Binding var requestedConversationId: String?

	private struct NewChatRequest: Identifiable {
		let id = UUID()
		var prefill = ""
		var recipient: ChatParticipant?
	}

	init(
		environment: AppEnvironment, workspaceID: String, requestedConversationId: Binding<String?>
	) {
		self.environment = environment
		_requestedConversationId = requestedConversationId
		_store = State(
			initialValue: ConversationsStore(
				api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache,
				flowRooms: LoopFlowRoomsSource(api: APILoopsSource(client: environment.client, workspaceID: workspaceID)),
				preferences: TeamPreferences(actorID: environment.auth.session?.actorId, workspaceID: workspaceID)))
	}

	private var session: StoredSession? { environment.auth.session }

	var body: some View {
		NavigationSplitView {
			ConversationListView(
				store: store, selection: $selection, search: $search,
				currentActorID: session?.actorId,
				isLive: environment.events.connection != .failed,
				sendTick: sendTick,
				onNewChat: { recipient in newChat = NewChatRequest(recipient: recipient) },
				onSearchEverywhere: { _ in runtime?.selectedTab = .search }
			)
			.shellToolbar(
				environment: environment, title: "Team",
				actions: ShellActions(
					new: { newChat = NewChatRequest() }, newLabel: "New conversation",
					display: ShellDisplayMenu { ChatsDisplayMenu(store: store) },
					displaySymbol: ShellActions.slidersSymbol, displayActive: !store.displayOptions.isDefault),
				header: ShellHeaderContent(kicker: "TEAM"))
			// iPad spec: the Team column is 430 wide.
			.navigationSplitViewColumnWidth(min: 360, ideal: 430, max: 520)
		} detail: {
			if let selection, let flowID = Self.flowID(from: selection) {
				FlowRoomHost(environment: environment, store: store, flowID: flowID)
					.id(selection)
			} else if let selection {
				ChatThreadHost(
					environment: environment, conversations: store, conversationID: selection,
					onLeft: { self.selection = nil }
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
		.onChange(of: runtime?.newConversationRequested, initial: true) {
			guard runtime?.newConversationRequested == true else { return }
			runtime?.newConversationRequested = false
			newChat = NewChatRequest()
		}
		.onChange(of: runtime?.chatDraft, initial: true) {
			// A build request from Agents or Loops: agents and loops are set up by the Chief of Staff.
			guard let draft = runtime?.chatDraft else { return }
			runtime?.chatDraft = nil
			Task { await startWithChiefOfStaff(text: draft.text) }
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
		.sheet(item: $newChat) { request in
			NewChatSheet(
				store: store, currentActorID: session?.actorId, prefill: request.prefill,
				initialRecipient: request.recipient
			) { created, live in
				selection = created.id
				if live, let lead = created.participants.first(where: { $0.kind == .agent }) {
					// The cover opens once the sheet has finished dismissing.
					Task {
						try? await Task.sleep(for: .milliseconds(450))
						liveMeeting.present(.conversation(id: created.id, lead: lead))
					}
				}
			}
			.presentationDetents([.large])
		}
	}

	/// A flow row's selection key is `flow:<id>`; everything else is a conversation id.
	static func flowID(from selection: String) -> String? {
		let prefix = TeamLayout.flowPinKey("")
		guard selection.hasPrefix(prefix) else { return nil }
		return String(selection.dropFirst(prefix.count))
	}

	/// What your latest message in a conversation is doing, from the send queue and the snippet.
	private func sendTick(_ conversation: ConversationSummary) -> ConversationRowStatus.Tick? {
		let pending = ChatsRuntime.shared(environment: environment).queue.pending(in: conversation.id)
		if pending.contains(where: { if case .failed = $0.state { return true } else { return false } }) { return .failed }
		if !pending.isEmpty { return .sending }
		guard let me = session?.actorId, conversation.snippetActorID == me else { return nil }
		// Read receipts are not in the API yet, so a delivered message stops at one tick.
		return .sent
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
			newChat = NewChatRequest(prefill: text)
			return
		}
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: [chief.participant.name]),
				participantIDs: [chief.id], firstMessage: text)
			MaskinHaptics.play(.success)
			selection = created.id
		} catch {
			newChat = NewChatRequest(prefill: text)
		}
	}
}

/// Flow rooms for the Team list, from the flows API: the flow, its latest post and who wrote it.
/// Conversations carry no flow link yet, so this is the only source of FLOWS rows.
struct LoopFlowRoomsSource: FlowRoomsSource {
	let api: any LoopsAPI
	/// The latest post is fetched per flow, so only this many of the most recent flows get one.
	var previewLimit = 8

	func flowRooms() async throws -> [TeamFlowRoom] {
		let loops = try await api.loops().filter { $0.status != .draft }
			.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
		let directory = ActorDirectory((try? await api.actors()) ?? [])
		let previewed = Set(loops.prefix(previewLimit).map(\.id))
		return await withTaskGroup(of: TeamFlowRoom.self, returning: [TeamFlowRoom].self) { group in
			for loop in loops {
				group.addTask {
					var room = TeamFlowRoom(
						id: loop.id, name: loop.displayName, lastActivity: loop.updatedAt, loop: loop)
					if previewed.contains(loop.id), let last = try? await api.latestPost(loopID: loop.id) {
						room.lastPostAuthor = directory.name(last.actorID)
						room.lastPostText = last.text
						room.lastActivity = last.date ?? loop.updatedAt
					}
					return room
				}
			}
			var rooms: [TeamFlowRoom] = []
			for await room in group { rooms.append(room) }
			return rooms.sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
		}
	}
}

/// A flow opened from the Team list: its channel, which is the flow's timeline.
private struct FlowRoomHost: View {
	let environment: AppEnvironment
	let store: ConversationsStore
	let flowID: String

	var body: some View {
		if let room = store.flowRooms.first(where: { $0.id == flowID }) {
			FlowChannelScreen(environment: environment, store: store, room: room)
		} else {
			EmptyState(symbol: "arrow.triangle.2.circlepath", title: "This flow isn't here any more")
		}
	}
}

/// Builds the `ChatStore` for one conversation and hosts the thread plus its participants sheet.
private struct ChatThreadHost: View {
	let environment: AppEnvironment
	let conversations: ConversationsStore
	let conversationID: String
	var onLeft: () -> Void = {}
	/// The store and composer are built once, on first render. They were `@State(initialValue:)`
	/// built in `init`, which runs on every parent re-render (each list update) and paid for a
	/// disk-cache decode and a store each time before SwiftUI discarded the result.
	@State private var holder = ThreadHolder()
	@State private var showParticipants = false
	/// Opens the People sheet straight on its picker ("Invite people").
	@State private var inviting = false

	init(
		environment: AppEnvironment, conversations: ConversationsStore, conversationID: String,
		onLeft: @escaping () -> Void = {}
	) {
		self.onLeft = onLeft
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
			cache: environment.snapshotCache,
			knownLastMessageAt: conversations.conversation(id: conversationID)?.lastMessageAt)
		chat.trace = ActivityStore(
			source: HTTPSessionActivitySource(environment: environment), cache: environment.snapshotCache)
		chat.onMarkedRead = { [conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		chat.onSessionsRefreshed = { [weak chat, weak environment, conversations] sessions in
			// Foreground fallback for the Live Activity; background updates come from APNs.
			guard let coordinator = TurnActivityCoordinator.shared, let chat,
				let workspaceId = environment?.workspaceId
			else { return }
			let turns = LiveTurn.turns(
				from: sessions.filter { !chat.isIdle($0) }, workspaceId: workspaceId, conversationId: conversationID,
				agentName: { id in chat.workspaceActors.first { $0.id == id }?.participant.name },
				topic: conversations.conversation(id: conversationID)?.title, now: Date())
			Task {
				await coordinator.reconcile(turns)
				await coordinator.sweep()
			}
		}
		let composer = ChatComposerModel(uploader: source, selfActorID: session?.actorId ?? "")
		composer.bind(conversationID: conversationID)
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
			.sheet(isPresented: $showParticipants, onDismiss: { inviting = false }) {
				PeopleSheet(chat: chat, conversations: conversations, startAdding: inviting, onLeft: onLeft)
				.presentationDetents([.medium, .large])
			}
	}
}
