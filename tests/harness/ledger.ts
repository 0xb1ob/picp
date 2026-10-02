/**
 * Scratch ledger: a throwaway home with an empty jobs document, so ledger
 * suites exercise the real class without touching this build's own ledger.
 * Replaces the br-backed `beads.ts`; no binary is needed any more.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobsDocument } from "../../src/contracts.ts";
import { initJobsDocument, Ledger, type LedgerOptions, readJobsDocument } from "../../src/ledger.ts";

export interface ScratchLedger {
	/** The home the document lives under. */
	path: string;
	ledger: Ledger;
	/** The document as it is on disk right now (for asserting on state the class does not expose). */
	document(): JobsDocument;
	cleanup(): void;
}

export interface ScratchLedgerOptions {
	prefix?: string;
	knownProjects?: readonly string[];
	/** Put the document under an existing home instead of a fresh temp dir. */
	home?: string;
}

export function createScratchLedger(options: ScratchLedgerOptions = {}): ScratchLedger {
	const path = options.home ?? mkdtempSync(join(tmpdir(), "cp-ledger-"));
	initJobsDocument(path, options.prefix ?? "cp");
	const ledgerOptions: LedgerOptions = {
		home: path,
		actor: "cp-test",
		...(options.knownProjects ? { knownProjects: options.knownProjects } : {}),
	};
	return {
		path,
		ledger: new Ledger(ledgerOptions),
		document: () => readJobsDocument(path),
		cleanup() {
			if (!options.home) rmSync(path, { recursive: true, force: true });
		},
	};
}
