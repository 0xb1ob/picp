# Ledger rows: cp-w5pf

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| `tests/e2e/channel-gateway.test.ts` | cp-w5pf | new e2e, channel gateway phase 1, through the real `src/channels/gateway.ts`, the Claude CLI operator's dashboard-control socket and cp-bridge (claude mock provider) and a fake Slack at HTTP/WebSocket: CG-0 no config exits 78; CG-1 a DM labelled `[cp-channel …]`/`; channel`, Queued then Delivered; CG-1b typed label not a label; CG-1c 4,001 characters Too long; CG-1d Queued behind; CG-2 card then reply in the thread, a dashboard-only ask never posted; CG-2b 429 Retry-After and one write per second; CG-3 tap answer frame; CG-3b one/two/no open cards; CG-4/CG-4b Answered/Withdrawn edits; CG-5 link-only kind; CG-6 nothing rendered reaches the operator; CG-7 off-allowlist refused; CG-8 a 0644 token file refused, no token printed; CG-8b held offline then replayed; CG-9 allowlist on taps and thread replies; CG-10 dropped after 24 h; CG-11 a chat and a dashboard request in one turn post only the dashboard link; CG-12 typed replay text adds no channel id; no conversion owner, no exception or deletion credit claimed |
| `tests/channel-templates-golden.test.ts` | cp-w5pf | golden exception: every Slack template `src/channels/render.ts` posts, pinned as `{text, blocks}` in `tests/golden/channel-*.txt` (cards, notice, closed cards, which-one, replies short/clipped/redacted/secret fallback/home-path scrub, links, receipts) |
<!-- /manifest:incoming -->
