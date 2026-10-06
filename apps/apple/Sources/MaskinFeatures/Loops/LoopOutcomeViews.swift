import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

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

enum OutcomeLabels {
	static func kind(_ kind: FileContentKind) -> String {
		switch kind {
		case .html: "Page"
		case .pdf: "PDF"
		case .markdown: "Document"
		case .image: "Image"
		case .text: "Text"
		case .source, .other: "File"
		}
	}
}

/// The loop's latest page, shown rendered.
struct OutcomeFeatureCard: View {
	let environment: AppEnvironment
	let output: LoopOutput
	let height: CGFloat

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			OutcomeLivePreview(environment: environment, fileID: output.id)
				.frame(height: height)
				.background(MaskinSurface.cardInset2)
				.accessibilityLabel("Preview of \(output.name)")
			OutcomeCaption(output: output)
				.padding(MaskinSpace.s8)
		}
		.outcomeCard()
	}
}

struct OutcomeRow: View {
	let output: LoopOutput

	var body: some View {
		HStack(spacing: MaskinSpace.s6) {
			Image(systemName: output.isHTML ? "rectangle.on.rectangle.angled" : "doc.richtext")
				.font(.title3)
				.foregroundStyle(output.isHTML ? MaskinColor.accent : MaskinColor.ink4)
				.frame(width: MaskinSpace.s14)
				.accessibilityHidden(true)
			OutcomeCaption(output: output)
			Spacer(minLength: 0)
		}
		.padding(MaskinSpace.s8)
		.outcomeCard()
	}
}

private struct OutcomeCaption: View {
	let output: LoopOutput

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(output.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(2)
			HStack(spacing: MaskinSpace.s3) {
				Text(output.sourceTitle ?? OutcomeLabels.kind(output.kind)).lineLimit(1)
				if output.updatedAt != nil {
					Text("·")
					RelativeTime(output.updatedAt)
				}
			}
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
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
