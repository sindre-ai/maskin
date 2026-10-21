import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

private let now = Date()
private let me = ChatParticipant(id: "me", name: "Alex Preview", kind: .human)
private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
private let chief = ChatParticipant(id: "chief", name: "Chief of Staff", kind: .agent)
private let sam = ChatParticipant(id: "sam", name: "Sam Berg", kind: .human)
private let ida = ChatParticipant(id: "ida", name: "Ida Berg", kind: .human)

private func convo(
	_ id: String, title: String? = nil, with others: [ChatParticipant], hoursAgo: Double, unread: Int = 0,
	snippet: String? = nil, by: ChatParticipant? = nil, pinned: Bool = false
) -> ConversationSummary {
	ConversationSummary(
		id: id, title: title ?? ThreadLayout.defaultTitle(for: others.map(\.name)),
		lastMessageAt: now.addingTimeInterval(-hoursAgo * 3600), pinned: pinned, unreadCount: unread,
		snippet: snippet, snippetActorName: by?.name, participants: [me] + others)
}

private let relayChat = convo("c1", with: [relay], hoursAgo: 0.5, unread: 2, snippet: "Done. The importer fix is merged.", by: relay)
private let samChat = convo("c2", with: [sam], hoursAgo: 3, snippet: "Can you check the copy before Thursday?", by: me)
private let group = convo("c3", title: "Launch week", with: [sam, ida, chief], hoursAgo: 26, unread: 1, snippet: "Agenda is in the doc", by: ida)
private let idaChat = convo("c4", with: [ida], hoursAgo: 72, snippet: "Thanks, talk tomorrow", by: ida)
private let flow = TeamFlowRoom(
	id: "f1", name: "Weekly pipeline review", lastPostAuthor: "Relay", lastPostText: "Shipped the fix. Next: tests.",
	lastActivity: now.addingTimeInterval(-7200), workingCount: 2)

private func row(_ c: ConversationSummary) -> TeamLayout.Row { TeamLayout.Row(id: c.id, kind: .conversation(c)) }

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	guard let dir = ProcessInfo.processInfo.environment["TEAM_SNAPSHOT_DIR"] else { return }
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir)
		.appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

/// A section as the list draws it: mono header, then rows in one card.
private struct SectionCard<Content: View>: View {
	let label: String
	var count: Int?
	var countColor: Color = MaskinColor.inkPlaceholder
	var markAllRead = false
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4 + 1) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				MonoLabel(label, color: MaskinColor.ink5)
				if let count { Text("\(count)").maskinText(.mono).foregroundStyle(countColor) }
				Spacer()
				if markAllRead {
					Text("Mark all read")
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink4)
				}
			}
			.padding(.horizontal, MaskinSpace.s3)
			VStack(spacing: 0) { content }
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		}
	}
}

@Suite("Team snapshots")
@MainActor
struct TeamSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	private func page<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s11 + MaskinSpace.s1) { content() }
			.padding(MaskinSpace.s9)
	}

	@Test("sections: pinned tiles, UNREAD, FLOWS and a time group render", arguments: [false, true])
	func sections(dark: Bool) throws {
		let tiles = [
			TeamLayout.Tile(id: "c1", kind: .conversation(relayChat), title: "Relay", subtitle: "Importer fix", unreadCount: 2),
			TeamLayout.Tile(id: "flow:f1", kind: .flow(flow), title: flow.name, subtitle: "Flow", unreadCount: 0),
			TeamLayout.Tile(id: "c2", kind: .conversation(samChat), title: "Sam Berg", subtitle: "Pricing copy", unreadCount: 0),
		]
		for width in Self.widths {
			try render(
				page {
					VStack(alignment: .leading, spacing: MaskinSpace.s4 + 1) {
						MonoLabel("Pinned", color: MaskinColor.ink5).padding(.horizontal, MaskinSpace.s3)
						LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 9), count: 3), spacing: 9) {
							ForEach(tiles) { PinnedTile(tile: $0, currentActorID: "me", workingAgentIDs: ["relay"], lifted: $0.id == "c2") }
						}
					}
					SectionCard(label: "Unread", count: 2, countColor: MaskinColor.sig, markAllRead: true) {
						TeamRow(
							row: row(relayChat), status: ConversationRowStatus.make(conversation: relayChat, workingAgents: 1, mentionsYou: true),
							currentActorID: "me", now: now, workingAgentIDs: ["relay"])
						Divider().padding(.leading, 67)
						TeamRow(row: row(group), status: ConversationRowStatus.make(conversation: group), currentActorID: "me", now: now)
					}
					SectionCard(label: "Flows", count: 1) {
						TeamRow(row: TeamLayout.Row(id: flow.pinKey, kind: .flow(flow)), status: ConversationRowStatus.make(flow: flow), currentActorID: "me", now: now)
					}
					SectionCard(label: "Today", count: 2) {
						TeamRow(row: row(samChat), status: ConversationRowStatus.make(conversation: samChat, tick: .sent), currentActorID: "me", now: now)
						Divider().padding(.leading, 67)
						TeamRow(row: row(idaChat), status: ConversationRowStatus.make(conversation: idaChat, draft: "Let's move it to Friday"), currentActorID: "me", now: now)
					}
				}, width: width, dark: dark, name: "team-sections")
		}
	}

	@Test("live status: typing, working, every tick and a failed send render", arguments: [false, true])
	func statuses(dark: Bool) throws {
		let ticks: [ConversationRowStatus.Tick] = [.sending, .sent, .read, .failed]
		for width in Self.widths {
			try render(
				page {
					SectionCard(label: "Status") {
						TeamRow(row: row(relayChat), status: ConversationRowStatus.make(conversation: relayChat, typing: true), currentActorID: "me", now: now)
						TeamRow(row: row(relayChat), status: ConversationRowStatus.make(conversation: relayChat, workingAgents: 3), currentActorID: "me", now: now)
						ForEach(ticks, id: \.symbol) { tick in
							TeamRow(row: row(samChat), status: ConversationRowStatus.make(conversation: samChat, tick: tick), currentActorID: "me", now: now)
						}
					}
				}, width: width, dark: dark, name: "team-status")
		}
	}

	@Test("by person: a person row with several conversations expands; one list renders", arguments: [false, true])
	func personAndOneList(dark: Bool) throws {
		let person = TeamPerson(
			id: relay.id, name: relay.name, kind: .agent, participants: [relay],
			conversations: [relayChat, convo("c9", title: "Q4 pipeline", with: [relay], hoursAgo: 30, snippet: "Numbers are in", by: relay)])
		let personRow = TeamLayout.Row(id: "person:relay", kind: .person(person))
		var status = ConversationRowStatus.make(conversation: relayChat)
		status.preview = "2 conversations · \(relayChat.title)"
		for width in Self.widths {
			try render(
				page {
					SectionCard(label: "People", count: 1) {
						TeamRow(row: personRow, status: status, currentActorID: "me", now: now, workingAgentIDs: ["relay"], expanded: true)
					}
					SectionCard(label: "All", count: 3, markAllRead: true) {
						TeamRow(row: row(relayChat), status: ConversationRowStatus.make(conversation: relayChat), currentActorID: "me", now: now)
						Divider().padding(.leading, 67)
						TeamRow(row: TeamLayout.Row(id: flow.pinKey, kind: .flow(flow)), status: ConversationRowStatus.make(flow: flow), currentActorID: "me", now: now)
						Divider().padding(.leading, 67)
						TeamRow(row: row(samChat), status: ConversationRowStatus.make(conversation: samChat, tick: .sent), currentActorID: "me", now: now)
					}
				}, width: width, dark: dark, name: "team-person-onelist")
		}
	}

	@Test("filter chips, Archived row and every empty state render", arguments: [false, true])
	func chipsArchivedEmpty(dark: Bool) throws {
		let empties: [TeamLayout.Empty] = [.nothing, .noResults("northwind"), .caughtUp, .noKind(.agents)]
		for width in Self.widths {
			try render(
				page {
					TeamFilterChips(chip: .constant(.unread), unreadCount: 3)
					ArchivedRow(items: [idaChat, group], currentActorID: "me", expanded: .constant(true)) { _ in }
					ArchivedRow(items: [idaChat], currentActorID: "me", expanded: .constant(false)) { _ in }
					ForEach(Array(empties.enumerated()), id: \.offset) { _, empty in
						TeamEmptyState(empty: empty) {}
					}
				}, width: width, dark: dark, name: "team-chips-archived-empty")
		}
	}

	@Test("EmptyState plain and circled styles render", arguments: [false, true])
	func emptyStateStyles(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					EmptyState(symbol: "tray", title: "Nothing needs you", message: "Agents are working.") {
						Button("Refresh") {}.buttonStyle(.secondaryAction)
					}
					EmptyState(symbol: "tray", title: "Nothing needs you", message: "Agents are working.", style: .circled) {
						Button("Refresh") {}.buttonStyle(InkPillButtonStyle())
					}
				}, width: width, dark: dark, name: "empty-state-styles")
		}
	}

	@Test("the New conversation sheet renders with recipients and suggestions", arguments: [false, true])
	func newConversation(dark: Bool) async throws {
		let api = SnapshotListAPI(actors: [
			ChatActor(participant: chief, summary: "Runs the daily briefing. Escalates blockers.", isSystem: true),
			ChatActor(participant: relay, agentState: .running, summary: "Developer for the importer and CI"),
			ChatActor(participant: ChatParticipant(id: "quill", name: "Quill", kind: .agent), summary: "Researcher"),
			ChatActor(participant: sam), ChatActor(participant: ida),
			ChatActor(participant: ChatParticipant(id: "cpo", name: "Compass", kind: .agent), summary: "CPO"),
		])
		let store = ConversationsStore(api: api, events: nil)
		await store.loadActors()
		struct Host: View {
			let store: ConversationsStore
			@State var draft: NewConversationDraft
			@State var query: String
			@State var highlighted: String?
			@State var showAll = false
			@FocusState var focused: Bool
			var body: some View {
				NewConversationForm(
					store: store, currentActorID: "me", initialRecipient: nil, error: nil, draft: $draft, query: $query,
					highlightedChip: $highlighted, showAll: $showAll, toFocused: $focused)
			}
		}
		var picked = NewConversationDraft()
		picked.toggle("sam")
		picked.toggle("chief")
		for width in Self.widths {
			try render(
				VStack(spacing: MaskinSpace.s9) {
					Host(store: store, draft: picked, query: "", highlighted: "chief")
					Host(store: store, draft: NewConversationDraft(), query: "research")
				},
				width: width, dark: dark, name: "new-conversation")
		}
	}
}

private actor SnapshotListAPI: ConversationsAPI {
	let actorList: [ChatActor]
	init(actors: [ChatActor]) { actorList = actors }
	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		ConversationPage(conversations: [], hasMore: false)
	}
	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String) async throws -> ConversationSummary {
		throw ChatsError("offline")
	}
	func updateState(conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool) async throws {}
	func actors() async throws -> [ChatActor] { actorList }
	func latestMessageID(conversationID: String) async throws -> Int? { nil }
}
