import assert from "node:assert/strict";
import { test } from "node:test";
import {
	detectGhAuthStatus,
	detectHomeBulkCopy,
	detectHostAuthCopy,
	ghAuthStatusRefusal,
	homeBulkCopyRefusal,
	hostAuthCopyRefusal,
	redactGithubTokens,
} from "../src/worker-credential-guard.ts";

// Synthetic commands only: nothing here reads or copies a real credential file.
test("a copy of the host auth.json is refused, by command position", () => {
	for (const command of [
		"cp ~/.pi/agent/auth.json /tmp/agent/",
		"mkdir -p /tmp/a && cp $HOME/.pi/agent/auth.json /tmp/a/auth.json",
		"cp -p ${HOME}/.pi/agent/models.json ${HOME}/.pi/agent/auth.json /tmp/a/",
		"cp /home/someone/.pi/agent/auth.json /tmp/a/",
		"for f in auth.json models.json; do cp ~/.pi/agent/$f /tmp/a/; done",
		"for f in models.json auth.json; do\n  cp -p $HOME/.pi/agent/${f} /tmp/a/\ndone",
		"cp ~/.pi/agent/mcp-auth.json /tmp/agent/",
		"for f in mcp-auth.json models.json; do cp ~/.pi/agent/$f /tmp/a/; done",
	]) {
		assert.ok(detectHostAuthCopy(command), command);
	}
	const finding = detectHostAuthCopy(`cp ~/.pi/agent/auth.json /tmp/${"x".repeat(300)}`);
	assert.ok(finding && finding.matched.length <= 120);
	const refusal = hostAuthCopyRefusal(finding);
	assert.match(refusal, /models\.json/);
	assert.match(refusal, /blocked/);
});

test("a models.json copy, quoted mentions and heredoc bodies pass", () => {
	for (const command of [
		"cp ~/.pi/agent/models.json /tmp/a/models.json",
		"for f in models.json; do cp ~/.pi/agent/$f /tmp/a/; done",
		'grep -rn "cp ~/.pi/agent/auth.json" docs/',
		"echo 'cp ~/.pi/agent/auth.json /tmp/a'",
		"cat ~/.pi/agent/models.json | head",
		"git commit -F - <<'EOF'\nnever cp ~/.pi/agent/auth.json anywhere\nEOF",
		"gh pr create --title t --body-file - <<EOF\nwe did not run:\ncp $HOME/.pi/agent/auth.json /tmp/a\nEOF",
	]) {
		assert.equal(detectHostAuthCopy(command), undefined, command);
	}
	assert.equal(detectHostAuthCopy(""), undefined);
});

// N1: the cp-xlax commands (session :205, :231, :233) lead the refuse list verbatim.
const XLAX_205 = 'cp -a ~/.pi-command-post/state ~/.pi-command-post/data "$T/.pi-command-post/"';
const XLAX_231 =
	"rsync -a --exclude sessions/ --exclude runs/ --exclude artifacts/ --exclude viewer-dist/ --exclude '*.jsonl.bak*' ~/.pi-command-post/state/ \"$T/.pi-command-post/state/\"";
const XLAX_233 = 'cp -a ~/.pi-command-post/data "$T/.pi-command-post/"';

test("a bulk copy of a command-post home is refused, including --exclude, glob, brace and loop forms (N1)", () => {
	for (const command of [
		XLAX_205,
		XLAX_231,
		XLAX_233,
		"cp -r $HOME/.pi-command-post /tmp/c",
		'rsync -av ~/.pi-command-post/ "$T/.pi-command-post/"',
		"cp -a ${HOME}/.pi-command-post/state/sessions /tmp/s",
		"cp -a /home/u/.pi-command-post/state/runs /tmp/r",
		"cp -a ~/.pi-command-post/state/runs/* /tmp/r/",
		"cp ~/.pi-command-post/state/sessions/*.jsonl /tmp/s/",
		'cp -a ~/.pi-command-post/state/. "$T/state/"',
		"cp -t /tmp/x -a ~/.pi-command-post/state",
		'cp -a ~/.pi-command-post/{state,data} "$T/"',
		'for d in state data; do cp -a ~/.pi-command-post/$d "$T/"; done',
		'mkdir -p "$T" && command cp -a "$HOME"/.pi-command-post/state "$T/"',
		"X=$(cp -a ~/.pi-command-post/state /tmp/x)",
	]) {
		assert.ok(detectHomeBulkCopy(command), command);
	}
	const finding = detectHomeBulkCopy(`${XLAX_205} ${"x".repeat(300)}`);
	assert.ok(finding && finding.matched.length <= 120);
	assert.equal(finding.source, "~/.pi-command-post/state");
	const refusal = homeBulkCopyRefusal(finding);
	assert.match(refusal, /never bulk-copies/);
	assert.match(refusal, /state\/runs\/<id>/);
	assert.match(refusal, /models\.json/);
	assert.match(refusal, /blocked/);
});

test("models.json, named runs, single files, destination-only homes and quoted mentions pass (N1)", () => {
	for (const command of [
		'cp ~/.pi/agent/models.json "$T/agent/models.json"',
		'cp -a ~/.pi-command-post/state/runs/cp-xlax "$T/.pi-command-post/state/runs/"',
		'rsync -a ~/.pi-command-post/state/runs/cp-xlax/ "$T/runs/cp-xlax/"',
		'cp -a ~/.pi-command-post/state/runs/$CP_JOB_ID "$T/runs/"',
		'cp -a ~/.pi-command-post/state/runs/cp-a ~/.pi-command-post/state/runs/cp-b "$T/runs/"',
		"cp ~/.pi-command-post/state/runs/cp-x/events.jsonl /tmp/x/",
		'cp fixture.json "$T/.pi-command-post/state/fleet.json"',
		'cp fixture.json "$T/.pi-command-post/" 2>&1',
		'rsync -a src/ "$T/.pi-command-post/state/" --exclude x',
		"echo 'cp -a ~/.pi-command-post/state /tmp/x'",
		'grep -rn "rsync -a ~/.pi-command-post/state/" docs/',
		"ls ~/.pi-command-post/state/runs",
		"du -sh ~/.pi-command-post/state",
		`cat > "$A" <<'EOF'\n${XLAX_205}\nEOF`,
		"",
	]) {
		assert.equal(detectHomeBulkCopy(command), undefined, command);
	}
});

test("gh auth status (any flag) and gh auth token are refused; quoted mentions and other gh auth calls pass (N2)", () => {
	for (const command of [
		"gh auth status",
		"gh auth status --active",
		"gh auth status -a",
		"gh auth status 2>&1",
		"gh auth status -t",
		"gh auth status --json hosts",
		'echo "$(gh auth status)"',
		"GH_HOST=github.com gh auth status",
		"gh auth token",
	]) {
		assert.ok(detectGhAuthStatus(command), command);
	}
	const token = detectGhAuthStatus("gh auth token");
	assert.equal(token?.subcommand, "token");
	const finding = detectGhAuthStatus("gh auth status 2>&1");
	assert.ok(finding);
	assert.equal(finding.subcommand, "status");
	assert.match(ghAuthStatusRefusal(finding), /gh api user --jq \.login/);
	for (const command of [
		"gh api user --jq .login",
		"gh auth login",
		"gh auth setup-git",
		"echo 'gh auth status'",
		'grep -rn "gh auth status" src/',
		"git commit -F - <<'EOF'\nnever run gh auth status in a worker\nEOF",
		"",
	]) {
		assert.equal(detectGhAuthStatus(command), undefined, command);
	}
});

// Every token value is built at runtime: no literal token shape lives in source.
const body36 = "C".repeat(36);
// gh 2.96's partial mask: github_pat_<22>_<59 *>
const maskedPat = ["github", "pat", "A".repeat(22), "*".repeat(59)].join("_");
const jwtApp = `${"gh"}${"s_"}12345_eyJhbGciOiJSUzI1NiJ9.${"x-y_z".repeat(4)}`;

test("redactGithubTokens: every prefix, gh's partial mask and a JWT tail become [REDACTED]; prose is untouched (N2)", () => {
	for (const prefix of ["gh" + "p", "gh" + "o", "gh" + "u", "gh" + "s", "gh" + "r", "github" + "_pat"]) {
		assert.equal(redactGithubTokens(`t=${prefix}_${body36} end`), "t=[REDACTED] end", prefix);
	}
	assert.equal(redactGithubTokens(`Token: ${maskedPat}`), "Token: [REDACTED]");
	assert.equal(redactGithubTokens(`app ${jwtApp}\n`), "app [REDACTED]\n");
	for (const prose of ["the ghp_ prefix", "gh" + "p_short", `x${"gh"}p_${body36}`]) {
		assert.equal(redactGithubTokens(prose), prose);
	}
	const mixed = `a ${"gh"}p_${body36} b Token: ${maskedPat} c ${jwtApp}`;
	assert.equal(redactGithubTokens(redactGithubTokens(mixed)), redactGithubTokens(mixed));
	assert.ok(!redactGithubTokens(mixed).includes(body36));
	assert.equal(redactGithubTokens(undefined as unknown as string), undefined);
});
