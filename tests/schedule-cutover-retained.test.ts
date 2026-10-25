import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {join} from "node:path";
import { test } from "node:test";

/** Retained structural scan (docs/testing-migration/p13a.md); the cutover fires run in tests/e2e/schedules.test.ts. */
test("policy writers are confined to the store, serialized scheduler and authenticated controls",()=>{
 const allowed = new Set(["src/schedule-runs.ts","src/schedule-run-fire.ts","src/schedule-control.ts","src/schedule-migrations.ts","src/schedule-native-migration.ts","src/scheduler.ts","extensions/command-post/tools-schedule.ts"]);
 function scan(dir:string):void {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
   const file=join(dir,entry.name);
   if(entry.isDirectory()) scan(file);
   else if(/\.[cm]?tsx?$/.test(file) && !allowed.has(file)) assert.doesNotMatch(readFileSync(file,"utf8"),/\.(?:activatePolicy|savePolicyRevision)\s*\(/,file);
  }
 }
 scan("src");scan("extensions");
});
