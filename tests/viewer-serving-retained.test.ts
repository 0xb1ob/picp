/** P21 units no dashboard entry point reaches; each test names the function and why (docs/testing-migration/p21.md). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appPage } from "../src/viewer/app-page.ts";
import { buildViewer } from "../src/viewer/build.ts";
import { LAYOUT } from "../src/contracts.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createScratchHome } from "./harness/index.ts";

// `appPage` escaping: the build names its assets `main-<HASH>.js|css`, so no served page carries markup in a URL.
test("app asset URLs cannot break out of HTML attributes", () => {
	const page = appPage({ script: '/assets/viewer/a"<>&\'.js', stylesheet: '/assets/viewer/b"<>&\'.css', assets: {}, duration_ms: 0, bytes: 0 });
	assert.ok(page.includes('src="/assets/viewer/a&quot;&lt;&gt;&amp;&#39;.js"'));
	assert.ok(page.includes('href="/assets/viewer/b&quot;&lt;&gt;&amp;&#39;.css"'));
});

// `buildViewer`'s `packageRoot`: cp-view and scripts/build-viewer.ts always build from this package's own entry.
test("build refuses a missing package entry", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	await assert.rejects(buildViewer({ stateDir: join(home.path, "other"), packageRoot: home.path }));
});

// `buildViewer`'s 30 s deadline: only a mocked timer makes a real esbuild run outlast it.
test("the compilation deadline cancels and disposes without publishing a partial snapshot", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const schedule = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
		const timer = schedule(callback, ms);
		if (ms === 30_000) queueMicrotask(callback);
		return timer;
	});
	await assert.rejects(buildViewer({ stateDir: join(home.path, LAYOUT.state) }), /exceeded 30 seconds/);
	assert.deepEqual(readdirSync(join(home.path, LAYOUT.state, "viewer-dist")), []);
});
