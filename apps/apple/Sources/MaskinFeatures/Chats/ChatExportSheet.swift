import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Header menu → Export chat (design 2d): Markdown as a file to share, and the chat's link.
/// PDF and audio-only exports are drawn in the design but need server support the app lacks, so
/// they are not offered.
struct ChatExportSheet: View {
	let title: String
	let messages: [ChatMessage]
	/// The Markdown file, built only when shared.
	let markdown: ExportedChat?
	let link: URL?
	@Environment(\.dismiss) private var dismiss
	@State private var copied = false
	@State private var pdf: URL?

	var body: some View {
		NavigationStack {
			List {
				Section {
					if let markdown {
						ShareLink(item: markdown, preview: SharePreview(markdown.fileName)) {
							row("doc.plaintext", "Markdown", "Messages, cards and transcripts")
						}
					}
					#if os(iOS)
					if let pdf {
						ShareLink(item: pdf) { row("doc.richtext", "PDF", "Formatted for reading") }
					}
					#endif
					if let link {
						Button {
							Clipboard.copy(link.absoluteString)
							MaskinHaptics.play(.success)
							copied = true
						} label: {
							row(copied ? "checkmark" : "link", copied ? "Copied" : "Copy link", "Members only")
						}
					}
				} footer: {
					Text(summary)
				}
			}
			#if os(iOS)
			.task {
				let lines = messages.filter { $0.kind != "system" && !$0.content.isEmpty }.map {
					ChatMessageLine(
						header: [$0.actorName, $0.createdAt?.formatted(date: .abbreviated, time: .shortened)]
							.compactMap { $0 }.joined(separator: " · "),
						text: $0.content)
				}
				pdf = ChatPDF.render(title: title, messages: lines)
			}
			#endif
			.navigationTitle("Export chat")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
	}

	private func row(_ symbol: String, _ name: String, _ detail: String) -> some View {
		HStack(spacing: MaskinSpace.s7) {
			Image(systemName: symbol).foregroundStyle(MaskinColor.ink2)
				.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 0) {
				Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink)
				Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private var summary: String { ChatMarkdownExport.summary(of: messages) }
}
