# Architecture: parent, worker, daemon

A map, not a contract. Where this page and the code disagree, the code wins;
the invariants live in the linked pages and are not repeated here.

## Three processes

- **Parent** — one headless `pi --mode rpc` per home. It owns every fleet tool
  (`cp_dispatch`, `cp_gate`, `cp_integrate`, `cp_teardown`, …) and is the single
  writer of the fleet and its outboxes. It classifies, dispatches, relays and
  tears down; it never does a worker's job. Tiers and the mandate:
  [`docs/autonomy.md`](autonomy.md).
- **Worker** — a `pi --mode rpc` child the parent spawns per job in a leased
  worktree, driven only through [`src/worker-process.ts`](../src/worker-process.ts):
  id-correlated RPC, busy/idle from events, death is an observed child close.
  It finishes by calling `report_result`; nothing is polled.
- **Daemon** — `cp-daemon` ([`src/service/daemon.ts`](../src/service/daemon.ts))
  keeps the parent, the dashboard viewer, the health watchdog and the updater
  running across crashes and reboots. It never dispatches, decides or merges.
  Backends, restart rules and install: [`docs/service.md`](service.md).

## Durable versus side effect

**Durable** is a file under the home's runtime root (`data/`, `state/`,
`projects/`, `operator/`): the fleet record, the ledger, mandates, escalations,
run records, outboxes. A restart rebuilds from these, never from memory. Layout
and writers: [`docs/storage.md`](storage.md).

**Side effect** is anything outside that record: a running worker process, a
worktree lease, a pushed branch, a PR, a merge, a CI run. A side effect is only
a fact once an observation is recorded (a spawn receipt, an observed close, a
`gh` read), so recovery re-reads the world instead of trusting the last write.
Job phases and wake-ups: [`docs/contracts.md`](contracts.md#fleet-state).
