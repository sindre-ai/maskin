import Foundation

/// `GET /api/objects/board` for one type: a column per status, the first `limit` objects of each.
public struct ObjectsBoardQuery: Sendable, Equatable {
	public var type: String
	/// Only this column (by its `value`), for paging one column on.
	public var column: String?
	public var sort: ObjectsSort
	public var limit: Int
	public var offset: Int

	public init(type: String, column: String? = nil, sort: ObjectsSort = .needsYou, limit: Int = 20, offset: Int = 0) {
		self.type = type
		self.column = column
		self.sort = sort
		self.limit = limit
		self.offset = offset
	}
}

public struct ObjectsBoardColumn: Identifiable, Sendable, Equatable {
	public var id: String
	/// The status this column holds; empty for objects without one.
	public var value: String
	/// How many objects the column holds on the server, loaded or not.
	public var total: Int
	public var objects: [WorkObject]

	public init(id: String, value: String, total: Int, objects: [WorkObject]) {
		self.id = id
		self.value = value
		self.total = total
		self.objects = objects
	}

	public var hasMore: Bool { objects.count < total }
}
