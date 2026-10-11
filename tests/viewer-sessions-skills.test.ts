import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { operatorSessionsFile } from "../src/viewer/operator-sessions.ts";
import { createViewer } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";

test("operator Full transcript: a dashboard message's [cp-skill] lines become chips and leave its text; any other message keeps them as text", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state), dir = mkdtempSync(join(tmpdir(), "cp-operator-skills-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const at = "2026-09-27T08:20:00Z", file = join(dir, "session.jsonl");
 const user = (text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
 writeFileSync(file, [
  user("dispatch with @tdd-x and @lint-y\n\n[cp-skill tdd-x /skills/tdd-x]\n[cp-skill lint-y /skills/lint-y]\n\n[cp-dashboard dc-20260927082500-0123abcd — from the dashboard]"),
  user("plain dashboard words\n\n[cp-dashboard dc-20260927082600-4567cdef — from the dashboard]"),
  user("from the CLI\n\n[cp-skill tdd-x /skills/tdd-x]"),
 ].join("\n") + "\n");
 const record = operatorSessionsFile(join(stateDir, "sessions")); mkdirSync(dirname(record), { recursive: true });
 writeFileSync(record, JSON.stringify({ at, session_file: file }) + "\n");
 const options = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true }; const server = createViewer(options);
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); options.port = (server.address() as AddressInfo).port; t.after(() => server.close());
 const full = await (await fetch(`http://127.0.0.1:${options.port}/api/sessions?view=you&transcript=1`)).json() as { entries: Array<{ tag: string | null; text: string; skills?: string[] }> };
 const [skilled, plain, cli] = full.entries;
 assert.deepEqual([skilled!.tag, skilled!.text, skilled!.skills], ["dashboard", "dispatch with @tdd-x and @lint-y", ["tdd-x", "lint-y"]]);
 assert.deepEqual([plain!.text, plain!.skills], ["plain dashboard words", undefined], "no lines, no skills key");
 assert.equal(cli!.skills, undefined);
 assert.match(cli!.text, /\[cp-skill tdd-x \/skills\/tdd-x\]/, "only dashboard-tagged messages get chips");
});
