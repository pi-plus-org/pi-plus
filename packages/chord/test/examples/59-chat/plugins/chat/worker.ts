<<<<<<< HEAD
// The chat plugin on a channel's worker: the room's messages in a table of the worker's store (every message kept),
// written and read by one local object. The newest 100 are live through a live query (`self.query`: read before the
// object goes live, read again after every commit writing the table); older ones are read by page on request. Each
// principal's `Room` posts as them and shares files through the kit's `Files` of this worker.
=======
// The chat plugin on a channel's worker: the room's messages in a document of the worker's store (kept by a local
// object: a persisted state needs a stable identity), and each principal's `Room` posting as them and sharing files
// through the kit's `Files` of this worker.
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)

import {
	Attachment,
	arr,
	defineFacet,
<<<<<<< HEAD
	defineTable,
	int,
	json,
	local,
	lt,
=======
	defineState,
	local,
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
	Message,
	method,
	num,
	obj,
	opt,
<<<<<<< HEAD
	query,
	Room,
	str,
} from "@chat/app/v1";
import { type FileInfo, Files } from "@chat/app/v1/worker";

/** Every message of the channel, by its number. */
const Messages = defineTable("chat.messages", {
	version: 1,
	columns: { id: int(), author: str(), text: str(), at: num(), file: opt(json(Attachment, { version: 1 })) },
	key: ["id"],
});

/** The messages, newest first. */
const NEWEST = query(Messages).orderBy((message) => message.id, "desc");

/** How many messages the live query and a page of history hold. */
const PAGE = 100;

const Store = local("chat.store", {
	version: 1,
	params: {},
	members: {
		messages: arr(Message),
		add: method(obj({ author: str(), text: str(), file: opt(Attachment) })),
		history: method(obj({ before: opt(int()) }), arr(Message)),
	},
=======
	Room,
	str,
} from "@chat/app/v1";
import { Files } from "@chat/app/v1/worker";

/** The newest messages a channel keeps. */
const KEPT = 500;

const Log = defineState("chat.log", {
	schema: obj({ next: num(), messages: arr(Message) }),
	version: 1,
	initial: () => ({ next: 1, messages: [] }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

const Store = local("chat.store", {
	version: 1,
	params: {},
	members: { messages: arr(Message), add: method(obj({ author: str(), text: str(), file: opt(Attachment) })) },
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
<<<<<<< HEAD
		const messages = self.table(Messages);
		// The newest messages, live.
		const newest = self.query(messages, NEWEST, PAGE);
		return {
			// Oldest first, as the room shows them.
			messages: self.derive([newest], ([rows]) => [...rows].reverse()),
			add: async ({ author, text, file }, ctx) => {
				await self.tx(async (tx) => {
					// The number after the newest message's: the store's transactions run one after another.
					const { items: last } = await tx.page(messages, NEWEST, 1);
					const id = (last[0]?.id ?? 0) + 1;
					tx.put(messages, { id, author, text, at: Date.now(), ...(file === undefined ? {} : { file }) });
				}, ctx);
				return null;
			},
			history: async ({ before }, ctx) => {
				const older = before === undefined ? NEWEST : NEWEST.where((message) => lt(message.id, before));
				const { items } = await messages.page(older, PAGE, ctx);
				return [...items].reverse();
			},
=======
		const log = self.state(Log);
		return {
			messages: self.derive([log], ([value]) => value.messages),
			add: async ({ author, text, file }, ctx) => {
				await log.change((draft) => {
					draft.messages.push({
						id: draft.next++,
						author,
						text,
						at: Date.now(),
						...(file === undefined ? {} : { file }),
					});
					if (draft.messages.length > KEPT) draft.messages.splice(0, draft.messages.length - KEPT);
				}, ctx);
				return null;
			},
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
		};
	});
	host.serve(Room, (_params, principal, self) => {
		const store = self.get(Store, {});
		const files = self.get(Files, {});
		const author = (principal as { readonly name?: string }).name ?? principal.kind;
		return {
			variant: "main",
			members: {
				messages: self.derive([store.messages], ([messages]) => messages),
<<<<<<< HEAD
				history: (page, ctx) => store.history(page, ctx),
				post: (text, ctx) => store.add({ author, text }, ctx),
				// Each attachment is a file of the space `attachments`, at its name (a name sent twice is a new version).
				begin: async ({ name, mime }, ctx) => {
					const path = name.replaceAll("/", "_");
					const begun = await files.begin({ space: "attachments", path, mime, source: author }, ctx);
					// Without a key a begin always starts an upload.
					return begun.kind === "upload" ? begun.upload : "";
				},
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					const file = await files.finish(upload, ctx);
					return store.add({ author, text, file: attachment(file) }, ctx);
				},
				attachment: async (id, ctx) => {
					const file = await files.file(id, ctx);
					if (file === null) throw new Error(`no file ${id}`);
					return attachment(file);
=======
				post: (text, ctx) => store.add({ author, text }, ctx),
				begin: (file, ctx) => files.begin(file, ctx),
				append: (chunk, ctx) => files.append(chunk, ctx),
				share: async ({ upload, text }, ctx) => {
					const id = await files.finish(upload, ctx);
					const { name, mime, size } = files.list.value.find((file) => file.id === id)!;
					return store.add({ author, text, file: { id, name, mime, size } }, ctx);
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
				},
				read: (range, ctx) => files.read(range, ctx),
			},
		};
	});
});
<<<<<<< HEAD

/** A file of the channel as an attachment of a message. */
function attachment(file: FileInfo): Attachment {
	return { id: file.id, name: file.path, mime: file.mime, size: file.size };
}
=======
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
