import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Whether the module at `url` is the script node was started with; `import.meta.main` is node 24.2+ only (#375). */
export function isEntry(url: string): boolean {
	const script = process.argv[1];
	if (!script) return false;
	try {
		return realpathSync(script) === realpathSync(fileURLToPath(url));
	} catch {
		return false; // an argv[1] that is not a file (node -e, a REPL) is no entry script
	}
}
