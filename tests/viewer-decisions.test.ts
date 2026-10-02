import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { awaitingScreen, decidedScreen } from "../src/viewer/decision-views.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";
process.env.TZ = "UTC";
const now = Date.parse("2026-09-26T12:00:00Z");
const at = "2026-09-26T11:00:00Z";
const ask = (id:string) => ({type:"open",id,created_at:at,project:"demo",question:"Keep paused?",options:[{label:"Keep",consequence:"Work stays paused"}],recommendation:"Keep",source_escalation:"es-open",job_ids:["cp-demo"]});
function fixture(t: {after(fn: () => void): void}) {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const state = {home:home.path,stateDir:join(home.path, LAYOUT.state)};
 const put = (file:string, value:unknown) => { const path = join(state.stateDir,file); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,typeof value === "string" ? value : JSON.stringify(value)); };
 return {state,put};
}
const escalation = (id:string, extra = {}) => ({id,created_at:at,question:"Proceed?",status:"answered",answered_at:at,answered_by:"operator-delegated",answer:"yes",kind:"plan_approval",job_ids:["cp-demo"],options:[{id:"yes",label:"Proceed"}],...extra});

test("awaiting folds only open operator asks, preserves copy replies and links real escalation provenance", t => {
 const {state,put} = fixture(t);
 const journal = [ask("ask-aa"),ask("ask-bb"),{type:"answer",id:"ask-bb",answer:"Keep",answered_at:at},ask("ask-cc"),{type:"withdraw",id:"ask-cc",reason:"obsolete"}].map(e => JSON.stringify(e)).join("\n")+"\n";
 put("operator/asks.jsonl",journal);
 put("escalations.json",{items:[escalation("es-open",{status:"open",mandate_clause:"spend cap is not delegated"}),escalation("es-parent",{status:"open"}),escalation("es-gone",{status:"withdrawn"})]});
 const data = awaitingScreen(state,now);
 assert.equal(data.awaiting_count,1); assert.deepEqual(data.items.map(a => a.id),["ask-aa"]);
 assert.equal(data.items[0]?.options[0]?.reply,"ask-aa: Keep");
 assert.equal(data.items[0]?.reason,"spend cap is not delegated");
 assert.equal(data.items[0]?.source_created_at,at); assert.equal(data.items[0]?.spend,null);
 assert.deepEqual(data.parent_questions.map(q => q.id),["es-parent"]);
 assert.equal(data.parent_questions[0]?.age_seconds,3600);
 assert.equal(readFileSync(join(state.stateDir,"operator/asks.jsonl"),"utf8"),journal);
});

test("decided includes delegated and answered asks, excludes other authorities and flags only recorded risk, scope and overrides", t => {
 const {state,put} = fixture(t);
 put("operator/asks.jsonl",`${JSON.stringify({...ask("ask-aa"),source_escalation:"es-risk"})}\n${JSON.stringify({type:"answer",id:"ask-aa",answer:"Keep",answered_at:at})}\n`);
 put("escalations.json",{items:[
  escalation("es-risk",{kind:"risk_high_irreversible",delegation_rule:"Evidence clears risk",basis:{operator_quote:"Proceed after checking the risk."}}),
  escalation("es-scope",{kind:"scope_expansion"}),
  escalation("es-override",{answer:"Accept anyway",options:[{id:"override",label:"Accept anyway"}]}),
  escalation("es-old",{answered_at:"2026-09-25T23:59:59Z"}),
  escalation("es-boundary",{answered_at:"2026-09-26T00:00:00Z"}),
  escalation("es-prose",{question:"risk scope override words are not metadata"}),
  escalation("es-human",{answered_by:"operator-quote"}),escalation("es-mandate",{answered_by:"mandate:md-demo"}),escalation("es-withdrawn",{status:"withdrawn"}),
 ]});
 const data = decidedScreen(state,now);
 assert.equal(data.items.length,7); assert.equal(data.decided_today.count,5); assert.equal(data.decided_today.worth_count,3);
 assert.equal(awaitingScreen(state,now).decided_today.count,5);
 assert.equal(data.items.find(d => d.id === "es-risk")?.quote,"Proceed after checking the risk.");
 assert.equal(data.items.find(d => d.id === "es-scope")?.quote,null);
 assert.equal(data.items.at(-1)?.id,"es-old"); assert.equal(data.items.at(-1)?.today,false);
 assert.deepEqual(data.items.find(d => d.id === "es-risk")?.worth,["risk"]);
 assert.deepEqual(data.items.find(d => d.id === "es-scope")?.worth,["scope"]);
 assert.equal(data.items.find(d => d.id === "es-scope")?.kind,"scope_expansion","the escalation kind rides along (Decided folds mission_end closes)");
 assert.deepEqual(data.items.find(d => d.id === "es-override")?.worth,["override"]);
 assert.deepEqual(data.items.find(d => d.id === "es-prose")?.worth,[]);
 assert.equal(data.items.find(d => d.id === "es-risk")?.rule,"Evidence clears risk");
 assert.equal(data.items.find(d => d.id === "es-risk")?.answer,"Proceed");
 assert.equal(data.items.find(d => d.id === "ask-aa")?.source,"you");
 assert.equal(data.items.find(d => d.id === "ask-aa")?.rule,null);
});

test("awaiting joins recorded mandate caps and accounting without turning a corrupt fleet into zero spend", t => {
 const {state,put} = fixture(t);
 put("operator/asks.jsonl",`${JSON.stringify(ask("ask-aa"))}\n`);
 put("escalations.json",{items:[escalation("es-open",{status:"open",mandate_id:"md-demo"})]});
 put("mandates/md-demo.json",{id:"md-demo",status:"paused",issued_at:at,expiry:"2026-09-27T11:00:00Z",projects:["demo"],spend_cap:{usd:20,tokens:1000}});
 put("fleet.json",{jobs:[{job_id:"cp-demo",project:"demo",phase:"held",usage:{cost_usd:3,total_tokens:100}}]});
 let item = awaitingScreen(state,now).items[0]!;
 assert.equal(item.mandate_id,"md-demo"); assert.equal(item.mandate_status,"paused");
 assert.equal(item.spend_cap,20); assert.equal(item.spend,3);
 put("fleet.json","{bad");
 item = awaitingScreen(state,now).items[0]!;
 assert.equal(item.spend,null); assert.equal(item.spend_cap,20);
});

test("missing and corrupt sources remain distinguishable; a partial final journal line does not hide complete records", t => {
 const {state,put} = fixture(t);
 assert.equal(awaitingScreen(state,now).availability.asks,"missing");
 put("operator/asks.jsonl",`${JSON.stringify(ask("ask-aa"))}\n{"type":`);
 assert.equal(awaitingScreen(state,now).awaiting_count,1);
 put("operator/asks.jsonl","bad\n");
 assert.equal(awaitingScreen(state,now).awaiting_count,null);
 assert.equal(decidedScreen(state,now).decided_today.count,null);
 put("escalations.json","{bad");
 assert.equal(decidedScreen(state,now).availability.escalations,"unavailable");
 assert.deepEqual(decidedScreen(state,now).items,[]);
});
