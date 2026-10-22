/** Ledger lines recording the landing.test.ts split keep naming it; shared by the rewrite script and its guard test. */
export const HISTORY_ROWS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /^\| [^|]+ \| 05 \| `tests\/e2e\/landing\.test\.ts` \|/, reason: "ledger manifest row: the file the slice added (p3.md records the split)" },
	{ pattern: /split from landing\.test\.ts/, reason: "p3.md rows recording which new file each split stage created" },
	{ pattern: /^\| P3b? \(|^P3b? \([^)]*\) adds /, reason: "main ledger rows and prose for the P3/P3b slices that added landing.test.ts" },
];

export const isHistoryRow = (line: string): boolean => HISTORY_ROWS.some((row) => row.pattern.test(line));
