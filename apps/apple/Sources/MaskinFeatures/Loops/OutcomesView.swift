import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the loops have produced, newest first and grouped by loop. A loop's latest page leads
/// as a live preview; everything else is a compact row. Tapping opens the full presenter.
struct OutcomesView: View {
	let store: OutcomesStore
	let environment: AppEnvironment
	var isLive = true
	var onOpenLoop: (String) -> Void = { _ in }

	@State private var presented: Outcome?
	@Environment(\.horizontalSizeClass) private var sizeClass

	var body: some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: MaskinSpace.s11) {
				if !isLive {
					OfflineBanner(message: "Live updates paused. Reconnecting…")
				}
				ForEach(store.groups) { group in
					groupSection(group)
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 760)
			.frame(maxWidth: .infinity)
		}
		.overlay { overlay }
		.refreshable { await store.refresh() }
		.sheet(item: $presented) { outcome in
			OutcomePresenter(environment: environment, outcome: outcome)
		}
	}

	private func groupSection(_ group: OutcomeGroup) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Button { onOpenLoop(group.loopID) } label: {
				SectionHeader(group.loopName) {
					Text("\(group.outcomes.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens the loop")
			ForEach(Array(group.outcomes.enumerated()), id: \.element.id) { index, outcome in
				Button { presented = outcome } label: {
					if index == 0 && outcome.isHTML {
						OutcomeFeatureCard(environment: environment, outcome: outcome, height: previewHeight)
					} else {
						OutcomeRow(outcome: outcome)
					}
				}
				.buttonStyle(.plain)
				.accessibilityHint("Opens it full screen")
			}
		}
	}

	private var previewHeight: CGFloat { sizeClass == .regular ? 340 : 220 }

	@ViewBuilder
	private var overlay: some View {
		switch store.phase {
		case .idle, .loading:
			if store.groups.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load outcomes", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if store.groups.isEmpty {
				EmptyState(
					symbol: "rectangle.on.rectangle.angled", title: "No outcomes yet",
					message: "When a loop produces a page, a report or a document, it shows up here.")
			}
		}
	}
}

private extension View {
	func outcomeCard() -> some View {
		frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
			)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.contentShape(Rectangle())
	}
}

/// The latest page a loop produced, shown rendered.
struct OutcomeFeatureCard: View {
	let environment: AppEnvironment
	let outcome: Outcome
	let height: CGFloat

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			OutcomeLivePreview(environment: environment, fileID: outcome.fileID)
				.frame(height: height)
				.background(MaskinSurface.cardInset2)
				.accessibilityLabel("Preview of \(outcome.name)")
			OutcomeCaption(outcome: outcome)
				.padding(MaskinSpace.s8)
		}
		.outcomeCard()
	}
}

struct OutcomeRow: View {
	let outcome: Outcome

	var body: some View {
		HStack(spacing: MaskinSpace.s6) {
			Image(systemName: outcome.isHTML ? "rectangle.on.rectangle.angled" : "doc.text")
				.font(.title3)
				.foregroundStyle(outcome.isHTML ? MaskinColor.accent : MaskinColor.ink4)
				.frame(width: MaskinSpace.s14)
				.accessibilityHidden(true)
			OutcomeCaption(outcome: outcome)
			Spacer(minLength: 0)
		}
		.padding(MaskinSpace.s8)
		.outcomeCard()
	}
}

private struct OutcomeCaption: View {
	let outcome: Outcome

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(outcome.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(2)
			HStack(spacing: MaskinSpace.s3) {
				Text(outcome.sourceTitle ?? OutcomeLabels.kind(outcome.kind))
					.lineLimit(1)
				if outcome.updatedAt != nil {
					Text("·")
					RelativeTime(outcome.updatedAt)
				}
			}
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
	}
}

enum OutcomeLabels {
	static func kind(_ kind: FileContentKind) -> String {
		switch kind {
		case .html: "Page"
		case .markdown: "Document"
		case .pdf: "PDF"
		case .image: "Image"
		case .text: "Text"
		case .source, .other: "File"
		}
	}
}

/// A non-interactive rendering of a page: laid out at three times the card's width, then scaled
/// down, so it reads as a thumbnail of the whole page rather than a cropped corner of it.
private struct OutcomeLivePreview: View {
	let environment: AppEnvironment
	let fileID: String
	@State private var html: String?
	@State private var failed = false

	private static let zoomOut: CGFloat = 3

	var body: some View {
		GeometryReader { geo in
			if let html {
				PresentedHTMLView(html: html, isInteractive: false)
					.frame(width: geo.size.width * Self.zoomOut, height: geo.size.height * Self.zoomOut)
					.scaleEffect(1 / Self.zoomOut, anchor: .topLeading)
					.frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
			} else {
				Image(systemName: failed ? "exclamationmark.triangle" : "rectangle.on.rectangle.angled")
					.font(.title)
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.clipped()
		.task(id: fileID) {
			let remote = APIFilesRemote(
				client: environment.client, credentials: environment.auth.credentialsProvider)
			if let file = try? await remote.file(id: fileID), let text = file.text {
				html = text
			} else {
				failed = true
			}
		}
	}
}
