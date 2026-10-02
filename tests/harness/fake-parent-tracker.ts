import assert from "node:assert/strict";
import { after, afterEach } from "node:test";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suppliedPidFile = process.env.FAKE_PARENT_PID_FILE;
const file = suppliedPidFile ?? join(tmpdir(), `cp-fake-parent-${process.pid}.pids`);
const historyFile = `${file}.all`;
for (const path of [file, historyFile]) {
	try { unlinkSync(path); } catch { /* no prior run */ }
}
process.env.FAKE_PARENT_PID_FILE = file;

type TrackedProcess = { pid: number; startTime: string | null };

function pidsFromFile(path: string): TrackedProcess[] {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function isSameFakeParent(record: TrackedProcess): boolean {
	if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !record.startTime) return false;
	// Fail closed when process identity cannot be verified, including without Linux procfs.
	try {
		const stat = readFileSync(`/proc/${record.pid}/stat`, "utf8");
		const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
		return !isZombieProcessStat(stat) && startTime === record.startTime
			&& readFileSync(`/proc/${record.pid}/cmdline`, "utf8").includes("fake-parent");
	} catch { return false; }
}

export function isZombieProcessStat(stat: string): boolean {
	const closeParen = stat.lastIndexOf(")");
	return closeParen >= 0 && stat.slice(closeParen + 1).trimStart().startsWith("Z ");
}

export function isFakeParentAlive(pid: number): boolean {
	if (process.platform === "linux") {
		try {
			if (isZombieProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		}
	}
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pids: readonly TrackedProcess[], ms: number): Promise<TrackedProcess[]> {
	const deadline = Date.now() + ms;
	let remaining = pids.filter(isSameFakeParent);
	while (remaining.length && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		remaining = remaining.filter(isSameFakeParent);
	}
	return remaining;
}

async function terminate(pids: readonly TrackedProcess[]): Promise<TrackedProcess[]> {
	for (const record of pids) {
		if (!isSameFakeParent(record)) continue;
		try { process.kill(record.pid, "SIGTERM"); } catch { /* already exited */ }
	}
	const survivors = await waitForExit(pids, 10_000);
	for (const record of survivors) {
		if (!isSameFakeParent(record)) continue;
		try { process.kill(record.pid, "SIGKILL"); } catch { /* exited between probe and signal */ }
	}
	return waitForExit(survivors, 10_000);
}

export async function cleanupTrackedFakeParents(): Promise<void> {
	const pids = pidsFromFile(file);
	if (pids.length) appendFileSync(historyFile, pids.map((record) => `${JSON.stringify(record)}\n`).join(""));
	const survivors = await terminate(pids);
	writeFileSync(file, "");
	assert.deepEqual(survivors, [], `fake-parent processes survived cleanup: ${survivors.map(({ pid }) => pid).join(", ")}`);
}

afterEach(cleanupTrackedFakeParents);

after(async () => {
	const pids = [...pidsFromFile(file), ...pidsFromFile(historyFile)];
	const survivors = await terminate(pids);
	for (const path of [file, historyFile]) {
		if (existsSync(path)) unlinkSync(path);
	}
	assert.deepEqual(survivors, [], `fake-parent processes survived file cleanup: ${survivors.map(({ pid }) => pid).join(", ")}`);
});
