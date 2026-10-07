/** The project registry — data/projects.json. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Delivery, DeliverySchema, IsoTimestampSchema, PROJECT_NAME_PATTERN, validate, type ValidationResult } from "./core.ts";
import { type MandateAction, MandateActionSchema, type MandateAskOn, MandateAskOnSchema } from "./mandates.ts";
import type { Narrow, Replace } from "./internal.ts";
import { ReviewerModelSchema } from "./routing.ts";

export const ProjectSchema = Type.Object(
	{
		name: Type.String({ pattern: PROJECT_NAME_PATTERN }),
		/** git remote we clone/fetch from. */
		clone_url: Type.String({ minLength: 1, maxLength: 500 }),
		/** Default delivery for jobs in this repo. */
		delivery: DeliverySchema,
		notes: Type.Optional(Type.String({ maxLength: 1000 })),
		registered_at: IsoTimestampSchema,
		/** Default base branch; resolved from the clone when absent (T12). */
		base_branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		/** Retired registration: absent means false. Kept for history/lookups, skipped by pollers, refused for new work. */
		archived: Type.Optional(Type.Boolean()),
		/** Who lands a reviewed, green PR: absent or `repo` means cp_integrate merges when the repo permits; `human_handoff` hands it to a human on GitHub and never merges. */
		merge_policy: Type.Optional(StringEnum(["repo", "human_handoff"])),
		reviewer_model: Type.Optional(ReviewerModelSchema),
		/**
		 * Per-project mandate defaults (autonomy-programme-cur.2.5): overrides
		 * `data/mandate-defaults.json` field-by-field, absent means "use the home
		 * default". An explicit `cp_mandate issue` argument still wins over this.
		 */
		mandate: Type.Optional(
			Type.Object(
				{
					expiry_hours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 24 * 30 })),
					spend_usd: Type.Optional(Type.Number({ minimum: 0 })),
					spend_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
					job_cap: Type.Optional(Type.Integer({ minimum: 1 })),
					dispatch_parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
					allowed_actions: Type.Optional(Type.Array(MandateActionSchema, { minItems: 1, maxItems: 8 })),
					ask_on: Type.Optional(Type.Array(MandateAskOnSchema, { maxItems: 16 })),
					exclude_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type ProjectMandateOverride = {
	expiry_hours?: number;
	spend_usd?: number;
	spend_tokens?: number;
	job_cap?: number;
	dispatch_parallelism?: number;
	allowed_actions?: MandateAction[];
	ask_on?: MandateAskOn[];
	exclude_paths?: string[];
};
export type MergePolicy = "repo" | "human_handoff";
export type Project = Replace<
	Narrow<Static<typeof ProjectSchema>, "delivery", Delivery>,
	{ mandate?: ProjectMandateOverride; merge_policy?: MergePolicy }
>;

export const ProjectRegistrySchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		updated_at: IsoTimestampSchema,
		projects: Type.Array(ProjectSchema),
	},
	{ additionalProperties: false },
);
export type ProjectRegistryFile = Narrow<Static<typeof ProjectRegistrySchema>, "projects", Project[]>;

/**
 * Registry contract: names are unique (a project's clone path is derived from
 * its name via `paths.projectDir`, never stored), and a clone url is registered once — a
 * second name for the same remote is how a fleet ends up leasing from the
 * wrong checkout.
 */
export function validateProjectRegistry(value: unknown): ValidationResult<ProjectRegistryFile> {
	const result = validate<ProjectRegistryFile>(ProjectRegistrySchema, value);
	if (!result.ok) return result;
	const errors: string[] = [];
	const names = new Set<string>();
	const urls = new Map<string, string>();
	for (const project of result.value.projects) {
		if (names.has(project.name)) {
			errors.push(`/projects: duplicate name "${project.name}" — the registry is keyed by name`);
		}
		names.add(project.name);
		const owner = urls.get(project.clone_url);
		if (owner) {
			errors.push(
				`/projects/${project.name}: clone url ${project.clone_url} is already registered as "${owner}" — one canonical clone per remote`,
			);
		}
		urls.set(project.clone_url, project.name);
	}
	return errors.length === 0 ? result : { ok: false, errors };
}
