#!/usr/bin/env node
/**
 * `node scripts/eval.ts [options]` — run the worker-prompt eval corpus (do8.7).
 *
 * All policy lives in `src/evals.ts`; this file is only the edge: argv, fs, and
 * the exit code. Contract cases score prompt text and cost nothing, so the
 * default invocation is free and CI-safe. Model-quality cases need a transport
 * and are otherwise recorded as `skipped`, with the reason, in the result.
 *
 *   --arm <name>        arm label recorded with the result (default: candidate)
 *   --profiles <dir>    profiles dir for this arm (default: ./profiles)
 *   --briefs <dir>      brief templates dir (default: ./prompts/briefs)
 *   --model <id>        model id recorded with the result (default: the planner's)
 *   --corpus <file>     default: ./evals/corpus.json
 *   --role <role>       planner|reviewer|implementer
 *   --kind <kind>       contract|quality
 *   --trials <n>        trials per quality case (default 1)
 *   --replay <dir>      score recorded transcripts instead of calling a model
 *   --live              call a real model; refused unless CP_EVAL_LIVE=1
 *   --out <file>        write the result JSON here (default: stdout)
 *   --check             compare against --out instead of writing it
 *
 * Exit codes: 0 every scored case passed (and, with --check, the file matched);
 * 1 something failed; 2 bad arguments.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type EvalKind,
	type EvalRole,
	type EvalTransport,
	EvalError,
	formatResult,
	liveEvalSkip,
	liveTransport,
	loadCorpus,
	replayTransport,
	runEval,
} from "../src/evals.ts";

function fail(message: string, code = 2): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
let live = false;
let check = false;
for (let index = 0; index < argv.length; index++) {
	const arg = argv[index] as string;
	if (arg === "--live") {
		live = true;
		continue;
	}
	if (arg === "--check") {
		check = true;
		continue;
	}
	if (!arg.startsWith("--")) fail(`unexpected argument ${JSON.stringify(arg)}`);
	const value = argv[++index];
	if (value === undefined) fail(`${arg} needs a value`);
	flags.set(arg.slice(2), value);
}

const root = process.cwd();
const corpusPath = resolve(flags.get("corpus") ?? join(root, "evals/corpus.json"));
const outPath = flags.get("out") ? resolve(flags.get("out") as string) : undefined;
if (check && !outPath) fail("--check needs --out <file> to compare against");

const trials = Number(flags.get("trials") ?? 1);
if (!Number.isInteger(trials) || trials < 1) fail(`--trials must be a positive integer, got ${JSON.stringify(flags.get("trials"))}`);

let transport: EvalTransport | undefined;
if (flags.has("replay")) transport = replayTransport(resolve(flags.get("replay") as string));
if (live) {
	const reason = liveEvalSkip();
	if (reason !== false) fail(`live eval refused: ${reason}`, 2);
	transport = liveTransport();
}

try {
	const result = await runEval({
		corpus: loadCorpus(corpusPath),
		arm: {
			name: flags.get("arm") ?? "candidate",
			profilesDir: resolve(flags.get("profiles") ?? join(root, "profiles")),
			briefsDir: resolve(flags.get("briefs") ?? join(root, "prompts/briefs")),
			model: flags.get("model") ?? "anthropic/claude-sonnet-5",
		},
		...(transport ? { transport } : {}),
		trials,
		...(flags.has("role") ? { role: flags.get("role") as EvalRole } : {}),
		...(flags.has("kind") ? { kind: flags.get("kind") as EvalKind } : {}),
		root,
	});

	const text = formatResult(result);
	if (check) {
		const current = readFileSync(outPath as string, "utf8");
		if (current !== text) {
			fail(`${outPath} is stale — re-run without --check to refresh it`, 1);
		}
	} else if (outPath) {
		writeFileSync(outPath, text);
	} else {
		process.stdout.write(text);
	}

	const failed = result.cases.filter((item) => item.status === "failed");
	for (const item of failed) {
		for (const failedCheck of item.checks.filter((entry) => !entry.ok)) {
			process.stderr.write(`FAIL ${item.case_id} (trial ${item.trial}): ${failedCheck.name}${failedCheck.detail ? ` — ${failedCheck.detail}` : ""}\n`);
		}
	}
	process.stderr.write(
		`${result.metrics.cases_passed}/${result.metrics.cases_scored} scored case(s) passed, ${result.metrics.quality_skipped} skipped (mode ${result.mode})\n`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
	fail(error instanceof EvalError ? error.message : String(error), 2);
}
