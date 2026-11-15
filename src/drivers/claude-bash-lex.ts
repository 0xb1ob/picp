/**
 * WP2: the shell lexer the native Bash scope (claude-bash-scope.ts) reads commands with. It quotes like the shell,
 * cuts command and process substitutions out as their own scripts, and keeps redirect targets apart from words.
 */

/**
 * One shell word as written; `open` when the shell still expands it (`$`, a glob, braces, `~`), `glob` for a glob.
 */
export interface Word { text: string; open: boolean; glob: boolean }
/**
 * A simple command: its words, output redirect targets, input redirect sources, the operator after it, its `(` depth.
 */
export interface Cmd { words: Word[]; dests: Word[]; reads: Word[]; sep: string; depth: number }

/** Closing index of a `$(…)`/`<(…)` (from inside its paren) or a backtick span; quotes hide parens. */
function closing(src: string, from: number, end: "`" | ")"): number {
	let depth = 1;
	let quote: string | undefined;
	for (let i = from; i < src.length; i++) {
		const c = src[i] as string;
		if (c === "\\" && quote !== "'") i++;
		else if (quote !== undefined) quote = c === quote ? undefined : quote;
		else if (c === "'" || c === '"') quote = c;
		else if (end === "`" ? c === "`" : c === ")" && --depth === 0) return i;
		else if (c === "(") depth++;
	}
	return src.length;
}

/**
 * Cuts each `$(…)`, backtick and `<(…)`/`>(…)` into `nested`, leaving an unresolved `$_`; `quotes` false in a heredoc.
 */
export function extract(src: string, nested: string[], quotes = true): string {
	let out = "";
	let quote: string | undefined;
	for (let i = 0; i < src.length; i++) {
		const c = src[i] as string;
		const next = src[i + 1];
		if (quote === "'") {
			quote = c === "'" ? undefined : quote;
			out += c;
		} else if (c === "\\") {
			out += src.slice(i, i + 2);
			i++;
		} else if (c === "`" || (next === "(" && (c === "$" || (quote === undefined && (c === "<" || c === ">"))))) {
			const start = c === "`" ? i + 1 : i + 2;
			const end = closing(src, start, c === "`" ? "`" : ")");
			nested.push(src.slice(start, end));
			out += "$_";
			i = end;
		} else {
			if (quotes && c === '"') quote = quote === '"' ? undefined : "\"";
			else if (quotes && c === "'" && quote === undefined) quote = "'";
			out += c;
		}
	}
	return out;
}

const NAME_START = /[\w{@*#?$!-]/;

/** Simple commands with their words, redirect targets and the operator after each; `(`…`)` nest by depth. */
export function lexCommands(text: string): Cmd[] {
	const cmds: Cmd[] = [];
	let depth = 0;
	let cmd: Cmd = { words: [], dests: [], reads: [], sep: "", depth };
	let [word, inWord, open, glob] = ["", false, false, false];
	let quote: string | undefined;
	let target: "dest" | "read" | "dup" | "skip" | undefined;
	const flush = () => {
		if (inWord) {
			const w = { text: word, open, glob };
			if (target === undefined) cmd.words.push(w);
			else if (target === "dest" || (target === "dup" && !/^(\d+|-)$/.test(word))) cmd.dests.push(w);
			else if (target === "read") cmd.reads.push(w);
			target = undefined;
		}
		[word, inWord, open, glob] = ["", false, false, false];
	};
	const end = (op: string, nextDepth = depth) => {
		flush();
		target = undefined;
		cmds.push({ ...cmd, sep: op });
		depth = Math.max(0, nextDepth);
		cmd = { words: [], dests: [], reads: [], sep: "", depth };
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		const next = text[i + 1];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
		} else if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && next !== undefined && "$`\"\\\n".includes(next)) word += text[++i];
			else {
				open ||= c === "$" && next !== undefined && NAME_START.test(next);
				word += c;
			}
		} else if (c === "'" || c === '"') {
			open ||= word.endsWith("$");
			quote = c;
			inWord = true;
		} else if (c === "\\") {
			if (next !== undefined && next !== "\n") [word, inWord] = [word + next, true];
			i++;
		} else if (c === " " || c === "\t") {
			flush();
		} else if (c === "#" && !inWord) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
			// `2>f` names a stream; any other word before the operator is an argument.
			if (inWord && !open && /^\d+$/.test(word)) [word, inWord] = ["", false];
			else flush();
			const op = /^(<<<|<<-?|<>|<&|>>|>\||>&|&>>|&>|<|>)/.exec(text.slice(i))?.[0] ?? c;
			i += op.length - 1;
			target = op.startsWith("<<") || op === "<&" ? "skip" : op === "<" ? "read" : op === ">&" ? "dup" : "dest";
		} else if (c === "(" || c === ")") {
			end(c, depth + (c === "(" ? 1 : -1));
		} else if (c === ";" || c === "\n" || c === "|" || c === "&") {
			const op = (c === "|" || c === "&") && (next === c || (c === "|" && next === "&")) ? `${c}${next}` : c;
			i += op.length - 1;
			end(op === "|&" ? "|" : op === "\n" ? ";" : op);
		} else {
			open ||= (c === "$" && next !== undefined && NAME_START.test(next)) || c === "{" || (c === "~" && !inWord) || "*?[".includes(c);
			glob ||= "*?[".includes(c);
			word += c;
			inWord = true;
		}
	}
	end("");
	return cmds;
}

/** Non-option words (all after `--`); a `valued` flag's next word is its value, not an operand. */
export function operands(args: readonly Word[], valued: readonly string[] = []): Word[] {
	const out: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const text = (args[i] as Word).text;
		if (text === "--") return [...out, ...args.slice(i + 1)];
		if (valued.includes(text)) i++;
		else if (!text.startsWith("-") || text === "-") out.push(args[i] as Word);
	}
	return out;
}

/**
 * The values of `short` flags, alone or in a bundle (`-o X`, `-oX`, `-so X`, `-nOrm`), and of `long` (`--long X`,
 * `--long=X`, or a GNU abbreviation of three letters or more, such as `--outp=X`) among `args`.
 */
export function values(args: readonly Word[], short: readonly string[], long?: string): Word[] {
	return args.flatMap((w, i) => {
		const next = args[i + 1] ? [args[i + 1] as Word] : [];
		const abbrev = long === undefined ? null : /^--([\w-]{3,})(?:=(.*))?$/s.exec(w.text);
		if (abbrev !== null && (long as string).slice(2).startsWith(abbrev[1] as string)) return abbrev[2] !== undefined ? [{ ...w, text: abbrev[2] }] : next;
		if (w.text.startsWith("--")) return [];
		const letters = /^-([a-zA-Z]+)/.exec(w.text)?.[1] ?? "";
		const at = Math.min(...short.map((flag) => letters.indexOf(flag.slice(1))).filter((k) => k >= 0));
		if (!Number.isFinite(at)) return [];
		const attached = w.text.slice(at + 2);
		return attached === "" ? next : [{ ...w, text: attached }];
	});
}
