/** `gpt-x · high`: the provider-less model, `model unknown` when unrecorded, and the thinking level only when known. Pure: the server subtitle and the client cards share it. */
export function modelText(usage: { model?: string | null | undefined; thinking?: string | null | undefined }): string {
	return [usage.model ? usage.model.slice(usage.model.indexOf("/") + 1) : "model unknown", usage.thinking].filter(Boolean).join(" · ");
}
