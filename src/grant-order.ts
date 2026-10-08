/** Active-grant precedence only; latest-speaking fallback keeps its supplied order. */
export function compareActiveGrants(a: { id: string; issued_at: string; job_ids?: readonly string[] }, b: { id: string; issued_at: string; job_ids?: readonly string[] }): number {
	return Number(Boolean(b.job_ids?.length)) - Number(Boolean(a.job_ids?.length))
		|| (a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0)
		|| (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
