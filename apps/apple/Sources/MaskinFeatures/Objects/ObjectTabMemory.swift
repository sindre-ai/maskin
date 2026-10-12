import Foundation

/// The page an object was last left on (Overview, Related, Activity), remembered per object so
/// coming back lands where the person was. A per-viewer convenience: any failure reads as Overview.
enum ObjectTabMemory {
	private static func key(_ id: String) -> String { "objects.detail.tab.\(id)" }

	static func last(for id: String, defaults: UserDefaults = .standard) -> ObjectDetailPart {
		guard let raw = defaults.string(forKey: key(id)), let part = ObjectDetailPart(rawValue: raw),
			[.overview, .related, .activity].contains(part)
		else { return .overview }
		return part
	}

	static func remember(_ part: ObjectDetailPart, for id: String, defaults: UserDefaults = .standard) {
		guard [.overview, .related, .activity].contains(part) else { return }
		defaults.set(part.rawValue, forKey: key(id))
	}
}
