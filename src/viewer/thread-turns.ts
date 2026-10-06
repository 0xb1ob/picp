import type { SessionEntry } from "./api-types.ts";

/** The head of the one user message that replays held dashboard messages (src/dashboard-control.ts). */
export const INBOX_REPLAY_PREFIX = "[cp-dashboard inbox — ";

const isShared = (e: SessionEntry): boolean => e.kind === "system" || (e.kind === "say" && e.who === "Operator" && e.text.startsWith(INBOX_REPLAY_PREFIX));
const isOpener = (e: SessionEntry): boolean => (e.kind === "say" || e.kind === "via") && (e.who === "Operator" || e.who === "Operator (dashboard)");

/**
 * cp-xmw2 turn rule: file each Full transcript entry under a thread (a `th-` id) or mark it `shared`. `refs` maps a
 * `dc-`/`ask-`/`ans-` id to its thread (readThreads, newest bind wins). System entries and the inbox replay are shared
 * and end the current turn; an Operator say/via opens one. An entry takes its own ref's thread, else its turn's thread
 * (the opener's own, else the first own one in the turn); entries outside any turn use only their own ref.
 */
export function assignThreads(entries: SessionEntry[], refs: ReadonlyMap<string, string>): void {
	const own = (e: SessionEntry): string | undefined => (e.dashboard_id && refs.get(e.dashboard_id)) || (e.ask_id && refs.get(e.ask_id)) || (e.answer_id && refs.get(e.answer_id)) || undefined;
	const turns: SessionEntry[][] = [];
	let turn: SessionEntry[] | null = null;
	for (const e of entries) {
		if (isShared(e)) {
			e.shared = true;
			turn = null;
			continue;
		}
		if (isOpener(e)) turns.push((turn = []));
		if (turn) turn.push(e);
		else {
			const thread = own(e);
			if (thread) e.thread = thread;
		}
	}
	for (const members of turns) {
		const turnThread = members.map(own).find(Boolean);
		for (const e of members) {
			const thread = own(e) ?? turnThread;
			if (thread) e.thread = thread;
		}
	}
}
