import Foundation

extension TeamDisplayOptions {
	/// The sheet's "Group by" chips: Sections (the grouped list) or None (one list).
	public var isSectioned: Bool {
		get { layout == .sections }
		set { layout = newValue ? .sections : .oneList }
	}

	/// Anything off its default, so Display can show it and Reset can appear.
	public var isCustomised: Bool { !isDefault }
}

extension ConversationRowStatus {
	/// The row's second line with the Display properties applied: the live working / typing line
	/// and the preview each hide on their own. A tick on your last message stays.
	public func applying(_ options: TeamDisplayOptions) -> ConversationRowStatus {
		var status = self
		if !options.showsWorkingLine {
			switch status.prefix {
			case .typing, .working: status.prefix = nil
			default: break
			}
		}
		if !options.showsPreview {
			status.preview = ""
		}
		return status
	}
}
