import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A page, document, picture or text an agent made, as a card in the conversation. A picture shows
/// inline; markdown and text fold open to their first lines; an HTML page (and anything heavy) opens
/// in the file viewer, which is where it can be read, pinned and commented on.
struct LinkedFileCard: View {
	let file: FileReference
	@Environment(\.linkedItems) private var store
	@State private var expanded: Bool
	private let open = LinkedOpener()

	init(file: FileReference, defaultExpanded: Bool = false) {
		self.file = file
		_expanded = State(initialValue: defaultExpanded)
	}

	private var kind: FileContentKind { .classify(mimeType: file.mimeType, name: file.name) }
	private var target: LinkedTarget { LinkedTarget(kind: .file, uuid: file.id) }
	private var foldsOpen: Bool { kind == .markdown || kind == .text }

	var body: some View {
		LinkedCardChrome {
			VStack(alignment: .leading, spacing: 0) {
				head
				if kind == .image {
					AttachmentThumbnail(
						file: ChatAttachmentRef(
							fileID: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes),
						style: .large
					)
					.environment(\.openAttachment, { _ in open(target) })
					.padding(.horizontal, MaskinSpace.s6)
					.padding(.bottom, MaskinSpace.s6)
				}
				if foldsOpen, expanded { preview }
			}
		}
		.accessibilityElement(children: .contain)
	}

	private var headLabel: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s4) {
				LinkedKindChip(text: FileContentKind.label(forMime: file.mimeType))
				Text(FileStore.sizeText(file.sizeBytes)).maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
				Spacer(minLength: 0)
				if foldsOpen { LinkedChevron(expanded: expanded) }
			}
			Text(file.name)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(expanded ? nil : 1).truncationMode(.middle)
				.multilineTextAlignment(.leading)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(.vertical, MaskinSpace.s5)
		.contentShape(Rectangle())
	}

	private var head: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s3) {
			Button {
				if foldsOpen {
					withAnimation(MaskinMotion.standard) { expanded.toggle() }
				} else {
					open(target)
				}
			} label: { headLabel }
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("\(FileContentKind.label(forMime: file.mimeType)), \(file.name)")
				.accessibilityHint(foldsOpen ? (expanded ? "Contracts the preview" : "Expands the preview") : "Opens the file")
			LinkedOpenButton(target: target).padding(.top, MaskinSpace.s1)
		}
		.padding(.leading, MaskinSpace.s6)
		.padding(.trailing, MaskinSpace.s3)
	}

	@ViewBuilder
	private var preview: some View {
		Rectangle().fill(MaskinSurface.separator).frame(height: 1)
		Group {
			switch store?.fileTexts[file.id] {
			case .ready(let text, let isTruncated):
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					Group {
						if kind == .markdown {
							MarkdownContent(text, style: .chat)
						} else {
							Text(text).font(MaskinTypeface.mono(MaskinFontSize.t13, relativeTo: .footnote))
								.foregroundStyle(MaskinColor.ink).frame(maxWidth: .infinity, alignment: .leading)
						}
					}
					if isTruncated {
						Text("Showing the start of the file. Open it to read the rest.")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				}
			case .failed:
				Text("This file is too big or isn't text. Open it to read it.")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					.frame(maxWidth: .infinity, alignment: .leading)
			case .error:
				HStack(spacing: MaskinSpace.s4) {
					Text("Couldn't load this file.").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					Spacer(minLength: 0)
					Button("Retry") { Task { await store?.retryText(of: file) } }
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650))
						.foregroundStyle(MaskinColor.ink3)
						.frame(minHeight: MaskinSpace.touchMin)
						.buttonStyle(.maskinPressed)
				}
			case .loading, nil:
				ProgressView().controlSize(.small).frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s5)
		.task(id: expanded) { await store?.loadText(of: file) }
	}
}
