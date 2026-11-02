import Foundation
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

@testable import MaskinCore

/// Answers the draft calls with a draft that approves cleanly, or one that never gets through.
private struct StubReviewRemote: DraftReviewRemote {
	var fails = false

	func detail(objectId: String) async throws -> ObjectDetail {
		let preview = ObjectPreview(kind: "email", label: "Email", body: "Hi", contentHash: "h")
		return ObjectDetail(
			object: WorkObject(id: objectId, type: "task", content: "Hi", status: "todo"),
			workspaceId: "ws-1", preview: preview)
	}

	func save(objectId: String, content: String?, subject: String?, idempotencyKey: String) async throws {}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		if fails { throw ObjectApprovalError.offline }
		return ObjectPreview(kind: "email", label: "Email", body: "Hi", contentHash: "h", delivery: .approved)
	}
}

@MainActor
private func render<V: View>(
	_ view: V, width: CGFloat = 402, dark: Bool = false, type: DynamicTypeSize = .large, name: String
) throws {
	let framed = view
		.padding(MaskinSpace.s9)
		.frame(width: width)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
		.environment(\.dynamicTypeSize, type)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	guard let dir = ProcessInfo.processInfo.environment["FORYOU_SNAPSHOT_DIR"] else { return }
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir)
		.appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

private func card(_ id: String, rank: Int) -> ForYouCard {
	ForYouCard(
		id: id, objectTitle: ["Webhook dedup key", "Keychain storage", "Integration key policy", "Merge window", "Release checklist"][rank % 5],
		objectType: "wiki_page", latestEventId: 10,
		mention: ForYouMention(
			eventId: 5, actorId: "dev", content: "ask",
			decision: DecisionPrompt(
				title: "Publish this page?", summary: "1 page.", ask: "I cannot.",
				options: [DecisionOption(label: "Approve", consequences: ["Goes live", "Visible to all"], recommended: true)])),
		rank: rank)
}

private func group(approved: Int) -> ApprovalGroup {
	let members = (0..<5).map { index in
		ApprovalGroup.Member(
			entry: FeedEntry(card: card("p\(index)", rank: index), bucket: index < approved ? .done : .needs),
			isApproved: index < approved)
	}
	return ApprovalGroup(id: "g", agentName: "Developer", objectType: "wiki_page", members: members)
}

private func email() -> ReviewDraft {
	ReviewDraft(
		objectId: "o-email", target: DecisionTarget(entityId: "c1", parentEventId: 5, latestEventId: 9),
		draftKey: "mette", kind: "email", kindLabel: "Email", agentName: "Sales Assistant",
		label: "Email to Mette", to: "Mette Holm, Northwind",
		recipients: [.init(role: "to", name: "Mette Holm", address: nil)], subject: "Following up on our call",
		body: "Hi Mette,\n\nThanks for the time on Thursday. Would a 20 minute walkthrough next week work?\n\nBest,\nSebastian",
		contentHash: "h")
}

private func post() -> ReviewDraft {
	ReviewDraft(
		objectId: "o-post", target: DecisionTarget(entityId: "c2", parentEventId: 6, latestEventId: 9),
		kind: "linkedin_post", kindLabel: "LinkedIn post", agentName: "Content Writer", label: "LinkedIn post",
		body: "We shipped webhook deduplication this week. Each booking now triggers an action exactly once.",
		contentHash: "h")
}

@Suite("For You v8 snapshots")
@MainActor
struct ForYouV8SnapshotTests {
	private func store(fails: Bool = false, window: TimeInterval = 60) -> DraftReviewStore {
		DraftReviewStore(remote: StubReviewRemote(fails: fails), undoWindow: window, announce: { _ in true })
	}

	@Test("header with a sentence, with none, and as the date only", arguments: [false, true])
	func header(dark: Bool) throws {
		try render(
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				ForYouHeaderView(
					dateLine: "SUN 18 OCT", spokenDate: "Sunday 18 October",
					summary: "Forge needs a call: Is the onboarding bet worth running?")
				ForYouHeaderView(dateLine: "SUN 18 OCT", spokenDate: "Sunday 18 October", summary: "Nothing is blocked on you.")
				ForYouHeaderView(dateLine: "SUN 18 OCT", spokenDate: "Sunday 18 October", summary: nil)
			}, dark: dark, name: "header")
	}

	@Test("group card: open, partly approved, done", arguments: [false, true])
	func groups(dark: Bool) throws {
		try render(
			VStack(spacing: MaskinSpace.s7) {
				ApprovalGroupCard(group: group(approved: 0), typeLabel: "Wiki page", undoableCount: 0)
				ApprovalGroupCard(group: group(approved: 2), typeLabel: "Wiki page", undoableCount: 0)
				ApprovalGroupCard(group: group(approved: 5), typeLabel: "Wiki page", undoableCount: 5)
				ApprovalGroupCard(group: group(approved: 5), typeLabel: "Wiki page", undoableCount: 3)
			}, dark: dark, name: "group")
	}

	@Test("group card at the largest text size")
	func groupAccessibility() throws {
		try render(
			ApprovalGroupCard(group: group(approved: 0), typeLabel: "Wiki page", undoableCount: 0),
			type: .accessibility3, name: "group-ax")
	}

	@Test("draft cards: post, email, edited", arguments: [false, true])
	func drafts(dark: Bool) throws {
		let reviews = store()
		let edited = email()
		reviews.setBody("Hi Mette,\n\nShort version: can we talk next week?", for: edited)
		try render(
			VStack(spacing: MaskinSpace.s7) {
				EditableDraftCard(draft: post(), store: reviews)
				EditableDraftCard(draft: email(), store: store())
				EditableDraftCard(draft: edited, store: reviews)
			}, dark: dark, name: "draft")
	}

	@Test("draft card at the largest text size")
	func draftAccessibility() throws {
		try render(EditableDraftCard(draft: email(), store: store()), type: .accessibility3, name: "draft-ax")
	}

	@Test("draft with nothing to send says why Approve is off", arguments: [false, true])
	func draftWithoutText(dark: Bool) throws {
		let reviews = store()
		let blank = email()
		reviews.setBody("", for: blank)
		let other = store()
		let noSubject = email()
		other.setSubject("", for: noSubject)
		try render(
			VStack(spacing: MaskinSpace.s7) {
				EditableDraftCard(draft: blank, store: reviews)
				EditableDraftCard(draft: noSubject, store: other)
			}, dark: dark, name: "draft-empty")
	}

	private func editWaitingCard() -> some View {
		let ask = ForYouCard(
			id: "c1", objectTitle: "Follow up with Mette", objectType: "task", latestEventId: 10,
			mention: ForYouMention(
				eventId: 5, actorId: "dev", content: "ask",
				decision: DecisionPrompt(
					title: "Send it?", summary: "One email to Mette Holm.", ask: "Send it?",
					options: [
						DecisionOption(label: "Send", consequences: ["Goes out now"], recommended: true),
						DecisionOption(label: "Hold", consequences: ["Waits"]),
					])),
			rank: 0)
		return DecisionCardView(
			entry: FeedEntry(card: ask, bucket: .needs), sender: "Sales Assistant", expanded: false,
			unsentEditNote: ForYouStore.unsentEditNote)
	}

	@Test("a card whose Send is off while an edit waits", arguments: [false, true])
	func cardWithEditWaiting(dark: Bool) throws {
		try render(editWaitingCard(), dark: dark, name: "card-edit-waiting")
	}

	@Test("the other new views at the largest text size")
	func largestTextSize() throws {
		try render(
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				ForYouHeaderView(
					dateLine: "SUN 18 OCT", spokenDate: "Sunday 18 October",
					summary: "Forge needs a call: Is the onboarding bet worth running?")
				ForYouHeaderView(dateLine: "SUN 18 OCT", spokenDate: "Sunday 18 October", summary: nil)
			}, type: .accessibility3, name: "header-ax")
		try render(
			ApprovalGroupCard(group: group(approved: 5), typeLabel: "Wiki page", undoableCount: 3),
			type: .accessibility3, name: "group-done-ax")
		try render(editWaitingCard(), type: .accessibility3, name: "card-edit-waiting-ax")
		let reviews = store()
		let blank = email()
		reviews.setBody("", for: blank)
		try render(EditableDraftCard(draft: blank, store: reviews), type: .accessibility3, name: "draft-empty-ax")
		let held = store()
		let d = post()
		held.approve(d)
		try render(DraftReceiptStrip(draft: d, store: held), type: .accessibility3, name: "draft-receipt-ax")
	}

	@Test("draft receipt while Undo is free, and the send failure")
	func receiptsAndFailure() async throws {
		let held = store()
		let d = post()
		held.approve(d)
		try render(DraftReceiptStrip(draft: d, store: held), name: "draft-receipt-held")

		let failing = store(fails: true, window: 0.01)
		let e = email()
		failing.setBody("An edit that must survive", for: e)
		failing.approve(e)
		for _ in 0..<200 {
			if case .failed = failing.phase(of: e) { break }
			try await Task.sleep(for: .milliseconds(10))
		}
		guard case .failed = failing.phase(of: e) else {
			Issue.record("the send should have failed")
			return
		}
		#expect(failing.edit(for: e).body == "An edit that must survive")
		try render(EditableDraftCard(draft: e, store: failing), name: "draft-failed")
	}
}
