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

private let decision = DecisionPrompt(
	title: "Is the onboarding bet worth running?",
	summary:
		"3 of 5 signups stall on step 2, costing about 40 activations a week. I have drafted the replacement copy and the migration.",
	ask: "This changes what every new customer sees first, so I will not ship it alone.",
	options: [
		DecisionOption(
			label: "7-day window",
			consequences: ["Ships with cycle 1 tomorrow", "Adds 18 support tickets in week one"],
			recommended: true),
		DecisionOption(
			label: "Hold", consequences: ["Nothing ships this cycle", "Keeps losing 40 activations a week"]),
	])

private let decisionCard = ForYouCard(
	id: "o1", objectTitle: "Onboarding redesign", objectType: "bet", status: "active",
	latestEventId: 12, latestActivityAt: now.addingTimeInterval(-3 * 86_400 - 600),
	mention: ForYouMention(eventId: 9, actorId: "forge", content: "ask", decision: decision))

private let threadCard = ForYouCard(
	id: "o2", objectTitle: "Pricing page", objectType: "task", status: "in_progress",
	latestEventId: 20, latestActivityAt: now.addingTimeInterval(-2 * 3600),
	mention: ForYouMention(
		eventId: 14, actorId: "forge",
		content:
			"The tiers are live on staging. Can you check the copy before Thursday?\n\nI changed **Team** from $29 to $39 per seat."))

private let irreversibleCard = ForYouCard(
	id: "o3", objectTitle: "Spring campaign", objectType: "bet", status: "active",
	latestEventId: 30, latestActivityAt: now.addingTimeInterval(-3600),
	mention: ForYouMention(
		eventId: 21, actorId: "forge", content: "ask",
		decision: DecisionPrompt(
			title: "Send the launch email to all customers?",
			summary: "The copy is approved and the list is segmented.",
			ask: "Once sent it reaches 4,200 people and can't be recalled.",
			options: [
				DecisionOption(
					label: "Send now", consequences: ["Reaches 4,200 customers today"], destructive: true),
				DecisionOption(label: "Send a test first", consequences: ["Goes to the team only"], recommended: true),
			])))

private func entry(
	_ card: ForYouCard, bucket: FeedBucket = .needs, record: DecisionRecord? = nil
) -> FeedEntry {
	FeedEntry(card: card, bucket: bucket, record: record)
}

@MainActor
private func cardView(
	_ entry: FeedEntry, expanded: Bool = true
) -> some View {
	DecisionCardView(entry: entry, sender: "Forge", expanded: expanded, now: now)
}

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

@Suite("For You snapshots")
@MainActor
struct ForYouSnapshotTests {
	static let widths: [CGFloat] = [402, 820]

	private func page<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) { content() }
			.padding(MaskinSpace.s9)
	}

	@Test("open decision card renders", arguments: [false, true])
	func openDecision(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					cardView(entry(decisionCard))
				}, width: width, dark: dark, name: "decision-open")
		}
	}

	@Test("irreversible option renders marked", arguments: [false, true])
	func irreversible(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page { cardView(entry(irreversibleCard)) }, width: width, dark: dark, name: "irreversible")
		}
	}

	@Test("thread card with markdown body renders", arguments: [false, true])
	func thread(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page { cardView(entry(threadCard, bucket: .fyi)) }, width: width, dark: dark,
				name: "thread")
		}
	}

	@Test("receipt states render", arguments: [false, true])
	func receipts(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					cardView(
						entry(
							decisionCard, bucket: .done,
							record: DecisionRecord(
								kind: .option("7-day window"), phase: .held(until: now.addingTimeInterval(5)))))
					cardView(
						entry(
							decisionCard, bucket: .done,
							record: DecisionRecord(kind: .option("Hold"), phase: .queued)))
					cardView(
						entry(
							decisionCard, bucket: .waiting,
							record: DecisionRecord(kind: .reply("Go ahead"), phase: .sent)))
					cardView(
						entry(
							threadCard, bucket: .done,
							record: DecisionRecord(kind: .dismissed, phase: .sent)))
				}, width: width, dark: dark, name: "receipts")
		}
	}

	@Test("a rejected decision shows the failure above its options again", arguments: [false, true])
	func failure(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					cardView(
						entry(
							decisionCard,
							record: DecisionRecord(kind: .option("Hold"), phase: .failed("The server rejected this (403)."))))
				}, width: width, dark: dark, name: "failure")
		}
	}

	@Test("list mode row renders", arguments: [false, true])
	func listRow(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					cardView(entry(decisionCard), expanded: false)
					cardView(entry(threadCard, bucket: .fyi), expanded: false)
				}, width: width, dark: dark, name: "list-row")
		}
	}

	@Test("empty state and offline banner render", arguments: [false, true])
	func emptyAndOffline(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					OfflineBanner(message: "You're offline. 2 changes will send when you reconnect.")
					CaughtUp()
				}, width: width, dark: dark, name: "empty-offline")
		}
	}

	@Test("quick questions and the Chief of Staff tile render", arguments: [false, true])
	func chiefPieces(dark: Bool) throws {
		for width in Self.widths {
			try render(
				page {
					HStack { ChiefOfStaffTile(); ChiefOfStaffTile(size: MaskinSpace.s14 + MaskinSpace.s3) }
					QuickQuestionChips(questions: ForYouQuickQuestions.chips(for: decisionCard)) { _ in }
				}, width: width, dark: dark, name: "chief-pieces")
		}
	}

	@Test("the suggested line names the recommended option and its first two consequences")
	func suggested() {
		#expect(
			DecisionCardView.suggestedLine(for: decision)
				== "Suggested: 7-day window. Ships with cycle 1 tomorrow. Adds 18 support tickets in week one.")
		#expect(
			DecisionCardView.suggestedLine(
				for: DecisionPrompt(title: "t", summary: "s", ask: "a", options: [DecisionOption(label: "Hold")])) == nil)
	}
}
