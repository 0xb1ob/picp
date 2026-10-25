import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths, REVIEW_ORIGINAL_TASK_MAX_BYTES } from "./contracts.ts";

/** Full prepared context stays separate from the dispatcher's current task generation. */
export function plannerInputFiles(home: string, jobId: string): string[] {
	const dir = join(home, paths.runDir(jobId));
	return [paths.originalTaskFile(jobId), paths.taskAddendaFile(jobId)].map((file) => join(home, file))
		.concat(["previous-original-task.md", "previous-task-addenda.md", "previous-plan.md", "revision-task.md", "task-addenda.md"].map((file) => join(dir, file)),
			existsSync(dir) ? readdirSync(dir).filter((file) => {
				const match = /^gate-(\d+)-raw\.json$/.exec(file);
				return match && !existsSync(join(home, paths.gateRunDir(jobId, Number(match[1]))));
			}).sort().map((file) => join(dir, file)) : [])
		.filter((file) => existsSync(file));
}

export function plannerInputText(files: readonly string[]): string {
	return files.map((file) => {
		const text = readFileSync(file, "utf8");
		if (Buffer.byteLength(text) > REVIEW_ORIGINAL_TASK_MAX_BYTES) throw new Error(`${file}: complete planner input exceeds the byte cap; nothing truncated`);
		return text;
	}).join("\n");
}
