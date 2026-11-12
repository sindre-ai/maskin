import Foundation

/// One custom view pinned to a loop: a tab with a name, backed by an HTML file.
public struct LoopView: Equatable, Hashable, Sendable {
	public var name: String
	public var fileID: String

	public init(name: String, fileID: String) {
		self.name = name
		self.fileID = fileID
	}
}

/// A loop's custom views in tab order. Same rules as `packages/shared/src/loops/loop-views.ts`:
/// they live on the loop as `metadata.views = [{ name, file_id }]`; a loop pinned before tabs
/// existed carries one `metadata.view_file_id`, which reads as a single view named "Custom view".
/// Once `views` is a list it wins, even when empty.
public enum LoopViews {
	public static let legacyName = "Custom view"

	public static func read(metadata: JSONValue?) -> [LoopView] {
		if case .array(let rows)? = metadata?["views"] {
			return rows.compactMap { row in
				guard let name = row["name"]?.stringValue, let fileID = row["file_id"]?.stringValue else {
					return nil
				}
				return LoopView(name: name, fileID: fileID)
			}
		}
		if let legacy = metadata?["view_file_id"]?.stringValue {
			return [LoopView(name: legacyName, fileID: legacy)]
		}
		return []
	}
}
