import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Lays its children out left to right and wraps to a new line when the row is full.
struct TagFlowLayout: Layout {
	var spacing: CGFloat

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let limit = proposal.width ?? .infinity
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		var widest: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.unspecified)
			if x > 0, x + size.width > limit {
				y += rowHeight + spacing
				x = 0
				rowHeight = 0
			}
			x += size.width + spacing
			widest = max(widest, x - spacing)
			rowHeight = max(rowHeight, size.height)
		}
		return CGSize(width: widest, height: y + rowHeight)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		var x = bounds.minX
		var y = bounds.minY
		var rowHeight: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.unspecified)
			if x > bounds.minX, x + size.width > bounds.maxX {
				y += rowHeight + spacing
				x = bounds.minX
				rowHeight = 0
			}
			subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
			x += size.width + spacing
			rowHeight = max(rowHeight, size.height)
		}
	}
}

/// One tag as a pill, with a remove button when `onRemove` is given.
struct FileTagChip: View {
	let tag: String
	var onRemove: (() -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			Text(tag).maskinText(.caption).foregroundStyle(MaskinColor.ink).lineLimit(1)
			if let onRemove {
				Button(action: onRemove) {
					Image(systemName: "xmark")
						.maskinSymbol(MaskinSpace.s5, weight: .semibold)
						.foregroundStyle(MaskinColor.ink4)
						// A larger touch area than the glyph.
						.frame(minWidth: MaskinSpace.s9, minHeight: MaskinSpace.s9)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Remove tag \(tag)")
			}
		}
		.padding(.leading, MaskinSpace.s7)
		.padding(.trailing, onRemove == nil ? MaskinSpace.s7 : MaskinSpace.s3)
		.padding(.vertical, MaskinSpace.s3)
		.background(MaskinSurface.fill, in: Capsule())
	}
}

/// The file's tags under its title. A file with none draws nothing, so it looks as it did before.
struct FileTagList: View {
	let store: FileStore

	var body: some View {
		if !store.tags.isEmpty {
			TagFlowLayout(spacing: MaskinSpace.s3) {
				ForEach(store.tags, id: \.self) { tag in
					FileTagChip(tag: tag) {
						Task { await store.removeTag(tag) }
					}
				}
			}
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Tags")
		}
	}
}

/// Picks tags to add: type a new one, or tap one already in use (A to Z, file count beside it).
struct FileTagEditorSheet: View {
	let store: FileStore
	@State private var text = ""
	@Environment(\.dismiss) private var dismiss

	private var normalized: String? { FileTagRules.normalized(text) }

	var body: some View {
		NavigationStack {
			List {
				Section {
					HStack(spacing: MaskinSpace.s7) {
						TextField("Add a tag", text: $text)
							.textFieldStyle(.plain)
							#if os(iOS)
							.textInputAutocapitalization(.never)
							#endif
							.autocorrectionDisabled()
							.submitLabel(.done)
							.onSubmit(addTyped)
							.disabled(!store.canAddTag)
						Button("Add", action: addTyped)
							.buttonStyle(.borderless)
							.disabled(normalized == nil || !store.canAddTag)
					}
					if !store.canAddTag {
						Text("A file can have \(FileTagRules.maxPerFile) tags at most.")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				}
				FormError(store.tagError)
				if !store.suggestedTags.isEmpty {
					Section("Existing tags") {
						ForEach(store.suggestedTags) { option in
							Button {
								Task { await store.addTag(option.tag) }
							} label: {
								HStack {
									Text(option.tag).foregroundStyle(MaskinColor.ink)
									Spacer(minLength: 0)
									Text("\(option.count)").foregroundStyle(MaskinColor.ink4)
								}
								.contentShape(Rectangle())
							}
							.disabled(!store.canAddTag)
							.accessibilityElement(children: .combine)
						}
					}
				}
			}
			.navigationTitle("Tags")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
			.task { await store.loadTagCounts() }
		}
		.presentationDetents([.medium, .large])
	}

	private func addTyped() {
		guard let tag = normalized else { return }
		text = ""
		Task { await store.addTag(tag) }
	}
}

/// The Files list's tag filter: tags in use (A to Z, file count beside the name) and the choice of
/// "has all of these" or "has any of these".
struct FileTagFilterSheet: View {
	let store: FilesListStore
	@State private var editing: String?
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			List {
				Section {
					Picker(
						"Match",
						selection: Binding(
							get: { store.match },
							set: { new in Task { await store.setMatch(new) } })
					) {
						ForEach(FileTagMatch.allCases, id: \.self) { Text($0.label).tag($0) }
					}
					.pickerStyle(.segmented)
				}
				Section("Tags") {
					ForEach(store.tagOptions) { option in
						HStack {
							Button {
								toggle(option.tag)
							} label: {
								HStack {
									Text(option.tag).foregroundStyle(MaskinColor.ink)
									Spacer(minLength: 0)
									Text("\(option.count)").foregroundStyle(MaskinColor.ink4)
									if store.selectedTags.contains(option.tag) {
										Image(systemName: "checkmark").foregroundStyle(MaskinColor.ink)
									}
								}
								.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							.accessibilityElement(children: .combine)
							.accessibilityAddTraits(store.selectedTags.contains(option.tag) ? .isSelected : [])
							// A picked tag no file carries any more has nothing left to change.
							if option.count > 0 {
								Button {
									store.clearTagChangeError()
									editing = option.tag
								} label: {
									Image(systemName: "pencil")
										.foregroundStyle(MaskinColor.ink4)
										.frame(minWidth: MaskinSpace.s9, minHeight: MaskinSpace.s9)
										.contentShape(Rectangle())
								}
								.buttonStyle(.borderless)
								.accessibilityLabel("Edit tag \(option.tag)")
							}
						}
					}
				}
			}
			.navigationTitle("Filter by tag")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
			.sheet(item: Binding(get: { editing.map(TagEditTarget.init) }, set: { editing = $0?.tag })) {
				FileTagEditSheet(store: store, tag: $0.tag)
			}
		}
		.presentationDetents([.medium, .large])
	}

	private func toggle(_ tag: String) {
		var next = store.selectedTags
		if let index = next.firstIndex(of: tag) { next.remove(at: index) } else { next.append(tag) }
		Task { await store.setTags(next) }
	}
}

/// The picked tags above the list, each removable. Draws nothing when none is picked.
struct FileTagFilterChips: View {
	let store: FilesListStore

	var body: some View {
		if !store.selectedTags.isEmpty {
			TagFlowLayout(spacing: MaskinSpace.s3) {
				ForEach(store.selectedTags, id: \.self) { tag in
					FileTagChip(tag: tag) {
						Task { await store.setTags(store.selectedTags.filter { $0 != tag }) }
					}
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.top, MaskinSpace.s7)
			.frame(maxWidth: 760, alignment: .leading)
			.frame(maxWidth: .infinity)
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Picked tags")
		}
	}
}

private struct TagEditTarget: Identifiable {
	let tag: String
	var id: String { tag }
}

/// Changes one tag on every file in the workspace: rename it, or merge it into another tag.
struct FileTagEditSheet: View {
	let store: FilesListStore
	let tag: String
	@State private var newName = ""
	@State private var mergeInto = ""
	@Environment(\.dismiss) private var dismiss

	private var normalized: String? { FileTagRules.normalized(newName) }
	private var otherTags: [String] { store.tagOptions.filter { $0.tag != tag && $0.count > 0 }.map(\.tag) }

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("New name", text: $newName)
						#if os(iOS)
						.textInputAutocapitalization(.never)
						#endif
						.autocorrectionDisabled()
						.submitLabel(.done)
						.onSubmit(rename)
					Button("Rename", action: rename)
						.disabled(normalized == nil || normalized == tag || store.isChangingTag)
				} header: {
					Text("New name")
				} footer: {
					Text("Changes the tag on every file in the workspace.")
				}
				if !otherTags.isEmpty {
					Section("Merge into") {
						Picker("Merge into", selection: $mergeInto) {
							Text("Pick a tag").tag("")
							ForEach(otherTags, id: \.self) { Text($0).tag($0) }
						}
						Button("Merge", action: merge)
							.disabled(mergeInto.isEmpty || store.isChangingTag)
					}
				}
				FormError(store.tagChangeError)
			}
			.navigationTitle("Edit tag \"\(tag)\"")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
		}
		.presentationDetents([.medium, .large])
	}

	private func rename() {
		guard let name = normalized, name != tag else { return }
		Task { if await store.renameTag(tag, to: name) != nil { dismiss() } }
	}

	private func merge() {
		guard !mergeInto.isEmpty else { return }
		Task { if await store.mergeTag(tag, into: mergeInto) != nil { dismiss() } }
	}
}
