/**
 * Forge PR 1 (T1): remote and change-request identity, pure. No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	changeRequestBelongsTo,
	changeRequestUrl,
	forgeConfigErrors,
	isSafeChangeRequestUrl,
	normalizeBaseUrl,
	parseChangeRequestUrl,
	parseRemote,
	resolveForgeRepository,
} from "../src/forge-url.ts";

test("https, scp-style and ssh:// remotes agree on one identity, nested groups intact", () => {
	const expected = { host: "gitlab.com", path: "group/sub/app" };
	for (const url of [
		"https://gitlab.com/group/sub/app.git",
		"https://GitLab.com/group/sub/app/",
		"git@gitlab.com:group/sub/app.git",
		"ssh://git@gitlab.com/group/sub/app.git",
		"ssh://git@GITLAB.COM:2222/group/sub/app",
	]) {
		const remote = parseRemote(url);
		assert.ok(remote, url);
		assert.deepEqual({ host: remote.host, path: remote.path }, expected, url);
	}
	assert.equal(parseRemote("https://git.example.com:8443/a/b.git")?.host, "git.example.com:8443", "an https port is identity");
	assert.equal(parseRemote("https://gitlab.com/Group/App")?.path, "Group/App", "the project path is never case-folded");
});

test("credentials, queries, fragments, traversal and non-remotes are refused", () => {
	for (const url of [
		"https://user:secret@gitlab.com/group/app.git",
		"https://oauth2@gitlab.com/group/app.git",
		"ssh://git:secret@gitlab.com/group/app.git",
		"https://gitlab.com/group/app.git?x=1",
		"https://gitlab.com/group/app.git#frag",
		"https://gitlab.com/group/../app",
		"https://gitlab.com/group/./app",
		"https://gitlab.com/app",
		"git@gitlab.com:/abs/app.git",
		"file:///tmp/repo.git",
		"/tmp/repo.git",
		"https://gitlab.com/group//app",
		"git@gitlab.com:group/a%2fb.git",
	]) {
		assert.equal(parseRemote(url), undefined, url);
	}
});

test("public hosts auto-detect; unknown hosts are unsupported, never assumed GitLab", () => {
	const github = resolveForgeRepository("git@github.com:owner/repo.git");
	assert.deepEqual(github, { ok: true, repository: { kind: "github", web_base_url: "https://github.com", path: "owner/repo" } });
	const gitlab = resolveForgeRepository("https://gitlab.com/group/sub/app.git");
	assert.deepEqual(gitlab, {
		ok: true,
		repository: { kind: "gitlab", web_base_url: "https://gitlab.com", api_base_url: "https://gitlab.com/api/v4", path: "group/sub/app", token_env: "GITLAB_TOKEN" },
	});
	const unknown = resolveForgeRepository("git@git.example.com:group/app.git");
	assert.equal(unknown.ok, false);
	assert.equal(!unknown.ok && unknown.reason, "unsupported");
	assert.match(!unknown.ok ? unknown.detail : "", /cp_project forge/);
	assert.equal(resolveForgeRepository("https://github.com/a/b/c").ok, false, "GitHub is owner/repo");
	assert.equal(resolveForgeRepository("https://x:y@gitlab.com/g/a").ok, false);
});

test("self-managed GitLab: explicit config, ssh alias with a port, installation prefix, no default token", () => {
	const config = { kind: "gitlab" as const, web_base_url: "https://code.example.com/gitlab/", token_env: "EXAMPLE_GL_TOKEN" };
	const ssh = resolveForgeRepository("ssh://git@ssh-alias:2222/team/sub/app.git", config);
	assert.deepEqual(ssh, {
		ok: true,
		repository: {
			kind: "gitlab",
			web_base_url: "https://code.example.com/gitlab",
			api_base_url: "https://code.example.com/gitlab/api/v4",
			path: "team/sub/app",
			token_env: "EXAMPLE_GL_TOKEN",
		},
	});
	const https = resolveForgeRepository("https://code.example.com/gitlab/team/sub/app.git", config);
	assert.ok(https.ok && https.repository.path === "team/sub/app", "the installation prefix is stripped from an https remote");
	assert.equal(resolveForgeRepository("https://other.example.com/gitlab/team/app.git", config).ok, false, "an https remote on another host never gets this config");
	assert.equal(resolveForgeRepository("https://code.example.com/team/app.git", config).ok, false, "outside the installation prefix");
	const noToken = resolveForgeRepository("git@code.example.com:team/app.git", { kind: "gitlab" });
	assert.ok(noToken.ok && noToken.repository.token_env === undefined, "a custom host never inherits GITLAB_TOKEN");
	const api = resolveForgeRepository("git@code.example.com:team/app.git", { kind: "gitlab", api_base_url: "https://api.example.com/v4/" });
	assert.ok(api.ok && api.repository.api_base_url === "https://api.example.com/v4");
	assert.equal(resolveForgeRepository("git@github.com:o/r.git", { kind: "gitlab", web_base_url: "https://gitlab.example.com" }).ok, true, "explicit config wins over host detection");
	assert.equal(resolveForgeRepository("git@ghe.example.com:o/r.git", { kind: "github" }).ok, false, "no GitHub Enterprise");
});

test("forge config errors never echo a value and refuse non-https roots and token-shaped names", () => {
	assert.deepEqual(forgeConfigErrors({ kind: "gitlab", web_base_url: "https://gitlab.example.com", token_env: "GL_TOKEN" }), []);
	const secret = "glpat-canary-value-123";
	for (const config of [
		{ kind: "gitlab" as const, web_base_url: "http://gitlab.example.com" },
		{ kind: "gitlab" as const, web_base_url: `https://user:${secret}@gitlab.example.com` },
		{ kind: "gitlab" as const, api_base_url: `https://gitlab.example.com/api/v4?private_token=${secret}` },
		{ kind: "gitlab" as const, token_env: secret },
		{ kind: "github" as const, token_env: "GH_TOKEN" },
		{ kind: "bitbucket" as never },
	]) {
		const errors = forgeConfigErrors(config);
		assert.ok(errors.length > 0, JSON.stringify(Object.keys(config)));
		assert.ok(!errors.join(" ").includes(secret));
	}
	assert.equal(normalizeBaseUrl("https://Gitlab.Example.com:443/root/"), "https://gitlab.example.com/root");
	assert.equal(normalizeBaseUrl("https://gitlab.example.com/../x"), undefined, "dot segments are refused, not resolved");
	assert.equal(parseRemote("https://gitlab.com/group/%2e%2e/app"), undefined, "encoded dot segments too");
});

test("change-request links: GitHub /pull/N on github.com, GitLab /-/merge_requests/N on any https host", () => {
	assert.deepEqual(parseChangeRequestUrl("https://github.com/o/r/pull/12"), { kind: "github", origin: "https://github.com", path: "o/r", number: 12 });
	assert.deepEqual(parseChangeRequestUrl("https://code.example.com/gitlab/team/sub/app/-/merge_requests/7/"), {
		kind: "gitlab",
		origin: "https://code.example.com",
		path: "gitlab/team/sub/app",
		number: 7,
	});
	for (const bad of [
		"http://gitlab.com/g/a/-/merge_requests/1",
		"https://gitlab.com/g/a/-/merge_requests/0",
		"https://gitlab.com/g/a/-/merge_requests/01",
		"https://gitlab.com/g/a/-/merge_requests/1?x",
		"https://gitlab.com/g/a/-/merge_requests/1#note",
		"https://u:p@gitlab.com/g/a/-/merge_requests/1",
		"https://gitlab.com/-/merge_requests/1",
		"https://ghe.example.com/o/r/pull/1",
		"https://github.com/o/r/pull/abc",
		"javascript:alert(1)//gitlab.com/g/a/-/merge_requests/1",
	]) {
		assert.equal(isSafeChangeRequestUrl(bad), false, bad);
	}
});

test("a change request belongs only to its exact host, prefix and whole project path", () => {
	const resolved = resolveForgeRepository("git@ssh-alias:team/sub/app.git", { kind: "gitlab", web_base_url: "https://code.example.com/gitlab" });
	assert.ok(resolved.ok);
	const repo = resolved.repository;
	assert.equal(changeRequestUrl(repo, 7), "https://code.example.com/gitlab/team/sub/app/-/merge_requests/7");
	const own = parseChangeRequestUrl("https://CODE.example.com/gitlab/team/sub/app/-/merge_requests/7");
	assert.ok(own && changeRequestBelongsTo(own, repo));
	for (const other of [
		"https://code.example.com/gitlab/team/app/-/merge_requests/7",
		"https://code.example.com/team/sub/app/-/merge_requests/7",
		"https://evil.example.com/gitlab/team/sub/app/-/merge_requests/7",
		"https://code.example.com/gitlab/team/sub/app-two/-/merge_requests/7",
	]) {
		const ref = parseChangeRequestUrl(other);
		assert.ok(ref && !changeRequestBelongsTo(ref, repo), other);
	}
});
