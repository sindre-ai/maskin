// Task list node shared by `./react/editor.tsx` and `./roundtrip.ts`.
//
// Stock `TaskList` breaks markdown round-trips in two ways:
//
//   1. A list that mixes plain bullets and checkboxes ("- a" next to
//      "- [ ] b") is parsed by markdown-it as one task list. Its schema only
//      allows task items, so ProseMirror pads the list with an empty task item
//      in front of the plain bullet. Accepting `listItem` as well keeps the
//      list as written.
//   2. `tiptap-markdown` only puts its `tight` attribute on bullet and ordered
//      lists. Without it the serializer treats a task list as loose and adds a
//      blank line between every item.
//
// Both files must use this one extension so the CI fixture suite and the app
// cannot drift.

import TaskList from '@tiptap/extension-task-list'

export const MarkdownTaskList = TaskList.extend({
	content: '(taskItem | listItem)+',

	addAttributes() {
		return {
			...this.parent?.(),
			// Same parse rule and class names as `tiptap-markdown`'s own tight-list
			// extension: a list is tight when markdown-it emitted no <p> inside it.
			tight: {
				default: true,
				parseHTML: (element) =>
					element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
				renderHTML: (attributes) => ({
					class: attributes.tight ? 'tight' : null,
					'data-tight': attributes.tight ? 'true' : null,
				}),
			},
		}
	},
})
