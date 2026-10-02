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
