import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";
// Evidenced in design screens 00, 03, 04, 05, 06, 07, 10, 11, 14, 16, plus awaiting trail (09/15), decided badge (01), and Sessions/Files (02/08/13).
const palette = new Set("#0b0b0a #111110 #141413 #191917 #1f1f1d #22221f #2a2926 #2c2b27 #eceae4 #d6d4cd #c9c7bf #a3a198 #8a887f #55544e #7fd49b #f0b35a #1c1810 #4d3b1f #93b4f5 #f2917f #5a2f28 #ffffff #20201d #131613 #243027 #2f4a37 #17201a #b9b7b0 #e2e0d9 #262521 #1a1408 #161615 #34332f #3a3322 #3a3935 #1a1a18 #6b6a64 #151514 #1b1b19 #6f6e67 #8a6a33 #34425e".split(" "));
function violations(path: string, text: string): string[] {
 const out: string[] = [];
 for (const [i,line] of text.split("\n").entries()) {
  for (const match of line.matchAll(/#([\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/gi)) {
   let hex = match[1]!.toLowerCase(); if (hex.length <= 4) hex = [...hex].map(c => c+c).join("");
   if (!palette.has(`#${hex}`) || !path.endsWith("styles/tokens.css")) out.push(`${path}:${i+1}: ${match[0]}`);
  }
  if (/\b(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\s*\(/i.test(line) || /\bstyle\s*=/.test(line)) out.push(`${path}:${i+1}: bypass`);
 }
 return out;
}
function files(path: string): string[] { return readdirSync(path,{withFileTypes:true}).flatMap(e => e.isDirectory() ? files(join(path,e.name)) : /\.(?:css|tsx?)$/.test(e.name) ? [join(path,e.name)] : []); }
test("app uses only cited design colors in tokens, never inline styles or color-function bypasses", () => {
 const root = join(REPO_ROOT,"viewer-app");
 assert.ok(readFileSync(join(root,"styles/tokens.css"),"utf8").includes("#111110"));
 assert.deepEqual(files(root).flatMap(path => violations(relative(root,path),readFileSync(path,"utf8"))),[]);
});
test("palette guard rejects short, alpha, uppercase and functional bypasses", () => {
 for (const input of ["color:#abc;", "color:#ABCD;", "color:#abcdef01;", "color:rgb(1,2,3)", "color:oklch(1 2 3)", '<p style={{color:"red"}}>']) assert.ok(violations("screen.tsx",input).length,input);
 assert.equal(violations("styles/tokens.css","color:#FFF;").length,0);
 assert.equal(violations("styles/tokens.css","color:#123456;").length,1);
 assert.equal(violations("routes.ts",'"#decided"').length,0);
});
/** Amber/coral (and the ask/error/stranded tokens that paint them) only on an open human decision or CI that is actually red. */
const KEEP = [
 /^\.awaiting-(?:card|index|reason|origin)(?![\w-])/,
 /^\.session-pinned(?![\w-])/,
 /^\.session-pinned-open(?![\w-])/,
 /^\.decision-card-option\.decision-card-recommended(?![\w-])/,
 /^\.shell-count(?![\w-])/,
 /^\.overview-square(?![\w-])/,
 /^\.job-question-awaiting(?![\w-])/,
 /^\.session-notice:has\(\.session-awaiting\)/,
 /^\.session-awaiting(?![\w-])/,
 /^\.session-notice \.session-awaiting(?![\w-])/,
 /^\.decision-overdue(?![\w-])/,
 /^\.decisions-handled-overdue(?![\w-])/,
 /^\.job-ci-red(?![\w-])/,
 /^\.job-badge\.job-ci-red(?![\w-])/,
 /^\.job-event-red(?![\w-])/,
 /^\.map-red-text(?![\w-])/,
 /^\.overview-dot-ci-red(?![\w-])/,
 // Light Sessions reassigns the same tokens; it is not a coloured surface.
 /^\.shell-main:has\(> \.sessions\)/,
];
const PAINT = /var\(--(?:amber|coral|ask-border|ask-background|error-border|map-stranded-border)\)/;
function painted(css: string): {selector:string; body:string}[] {
 const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
 const out: {selector:string; body:string}[] = [];
 let i = 0;
 while (i < text.length) {
  const open = text.indexOf("{", i);
  if (open < 0) break;
  const selector = text.slice(i, open).trim();
  let depth = 1, j = open + 1;
  while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
  const inner = text.slice(open + 1, j - 1);
  if (selector.startsWith("@") || inner.includes("{")) out.push(...painted(inner));
  else if (PAINT.test(inner)) out.push({selector, body:inner});
  i = j;
 }
 return out;
}
const allowed = (selector: string) => selector.split(",").every(part => KEEP.some(re => re.test(part.trim())));
test("amber and coral only on open human decisions and CI that is red", () => {
 const root = join(REPO_ROOT, "viewer-app");
 const offenders = files(root).filter(path => path.endsWith(".css")).flatMap(path => painted(readFileSync(path, "utf8")).filter(rule => !allowed(rule.selector)).map(rule => `${relative(root, path)}: ${rule.selector}`));
 assert.deepEqual(offenders, []);
 assert.equal(allowed(".overview-alarm"), false);
 assert.equal(allowed(".job-failure"), false);
 assert.equal(allowed(".job-ci-red > span"), true);
 assert.equal(allowed(".overview-dot-ci-red"), true);
});
