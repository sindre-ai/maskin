import Foundation

/// Server-side request caps the client must stay under. Over-cap requests are rejected with a 400
/// (zod `.max()`), not clamped, so a too-large `limit` fails the whole call.
///
/// Sources: `limit` max 100 in `packages/shared/src/schemas/{objects,conversations,notifications}.ts`
/// and `apps/dev/src/routes/actors.ts` (`limit` 100; `ids=` up to 200 but still bounded by `limit`).
public enum ServerLimits {
	public static let maxPageSize = 100

	/// Page size for re-reading a list that already holds `loaded` rows: as many as are on screen
	/// (so a refresh doesn't drop paged-in rows) but never over the cap.
	public static func refreshLimit(minimum: Int, loaded: Int) -> Int {
		min(maxPageSize, max(minimum, loaded))
	}

	/// Walks a limit/offset endpoint a capped page at a time until a short page (or `maxPages`).
	public static func fetchAll<T: Sendable>(
		maxPages: Int = 20,
		_ fetch: (_ limit: Int, _ offset: Int) async throws -> [T]
	) async throws -> [T] {
		var all: [T] = []
		for page in 0..<maxPages {
			let rows = try await fetch(maxPageSize, page * maxPageSize)
			all += rows
			if rows.count < maxPageSize { break }
		}
		return all
	}

	/// Splits `ids` into groups that fit one capped request (an `ids=` filter is still limited by `limit`).
	public static func chunks<T>(_ ids: [T]) -> [[T]] {
		stride(from: 0, to: ids.count, by: maxPageSize).map {
			Array(ids[$0..<min($0 + maxPageSize, ids.count)])
		}
	}

	/// Merges a freshly fetched head with the already paged-in rows beyond it.
	public static func mergeHead<T: Identifiable>(head: [T], previous: [T]) -> [T] where T.ID: Hashable {
		let tail = previous.dropFirst(head.count)
		let known = Set(head.map(\.id))
		return head + tail.filter { !known.contains($0.id) }
	}
}
