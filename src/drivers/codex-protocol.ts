/**
 * The `codex app-server` messages the C0 spike uses, hand-written from the 0.170.0 schema dump
 * (`codex app-server generate-json-schema --experimental`). Wire lines carry no `jsonrpc` member.
 */

export const CODEX_METHODS = {
	initialize: "initialize",
	initialized: "initialized",
	accountRead: "account/read",
	hooksList: "hooks/list",
	mcpServerStatusList: "mcpServerStatus/list",
	skillsList: "skills/list",
	threadStart: "thread/start",
	threadResume: "thread/resume",
	threadDelete: "thread/delete",
	turnStart: "turn/start",
	turnInterrupt: "turn/interrupt",
	terminalsList: "thread/backgroundTerminals/list",
	terminalsTerminate: "thread/backgroundTerminals/terminate",
	commandApproval: "item/commandExecution/requestApproval",
	fileChangeApproval: "item/fileChange/requestApproval",
	toolCall: "item/tool/call",
	turnStarted: "turn/started",
	turnCompleted: "turn/completed",
	itemStarted: "item/started",
	itemCompleted: "item/completed",
	tokenUsageUpdated: "thread/tokenUsage/updated",
	hookStarted: "hook/started",
	hookCompleted: "hook/completed",
	error: "error",
} as const;

export type RequestId = number | string;
export interface JsonRpcRequest { id: RequestId; method: string; params?: unknown }
export interface JsonRpcResponse { id: RequestId; result: unknown }
export interface JsonRpcError { id: RequestId; error: { code: number; message: string; data?: unknown } }
export interface JsonRpcNotification { method: string; params?: unknown }

export interface InitializeParams {
	clientInfo: { name: string; version: string; title?: string };
	capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: string[] };
}
export interface InitializeResponse { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string | null; planType: string } | { type: string };
export interface GetAccountResponse { account?: Account | null; requiresOpenaiAuth: boolean }

export type HookEventName = "preToolUse" | "postToolUse" | "permissionRequest" | "sessionStart" | "stop" | string;
export type HookSource = "system" | "user" | "project" | "mdm" | "sessionFlags" | "plugin" | string;
export type HookTrustStatus = "managed" | "untrusted" | "trusted" | "modified";
export interface HookMetadata {
	key: string;
	currentHash: string;
	eventName: HookEventName;
	source: HookSource;
	trustStatus: HookTrustStatus;
	enabled: boolean;
	isManaged: boolean;
	timeoutSec: number;
	handlerType: "command" | "mcpTool" | "prompt" | "agent";
	command?: string;
}
export interface HooksListEntry { cwd: string; hooks: HookMetadata[]; errors: unknown[]; warnings: unknown[] }
export interface HooksListResponse { data: HooksListEntry[] }

export interface McpServerStatus { name: string }
export interface ListMcpServerStatusResponse { data: McpServerStatus[]; nextCursor?: string | null }

export type SkillScope = "user" | "repo" | "system" | "admin";
export interface SkillMetadata { name: string; scope: SkillScope; enabled: boolean }
export interface SkillsListEntry { cwd: string; skills: SkillMetadata[]; errors: unknown[] }
export interface SkillsListResponse { data: SkillsListEntry[] }

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "untrusted" | "on-request" | "never" | string;
export interface DynamicToolSpec { type: "function"; name: string; description: string; inputSchema: unknown }
export interface ThreadStartParams {
	cwd: string;
	model?: string;
	approvalPolicy: AskForApproval;
	sandbox?: SandboxMode;
	permissions?: string;
	developerInstructions?: string;
	dynamicTools?: DynamicToolSpec[];
	config?: Record<string, unknown>;
	ephemeral?: boolean;
}
export interface ThreadResumeParams extends Omit<ThreadStartParams, "dynamicTools" | "ephemeral"> { threadId: string; excludeTurns?: boolean }
/** `sandbox` reads back as a policy object (`{type: "readOnly"}`), not the mode string the request sent. */
export interface ThreadStartResponse {
	thread: { id: string };
	approvalPolicy: AskForApproval;
	sandbox: { type: string } | null;
	cwd: string;
	instructionSources?: string[];
	activePermissionProfile?: { id: string } | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export interface Turn { id: string; status: TurnStatus; error?: { message?: string; codexErrorInfo?: unknown } | null }
export interface TurnStartParams { threadId: string; input: Array<{ type: "text"; text: string }>; effort?: string }
export interface TurnStartResponse { turn: Turn }

export interface TokenUsageBreakdown {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens?: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
}
export interface ThreadTokenUsage { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow?: number | null }

export interface ThreadBackgroundTerminal { processId: string; osPid?: number | null; command: string; cwd: string; itemId: string }
export interface TerminalsListResponse { data: ThreadBackgroundTerminal[]; nextCursor?: string | null }

export type ThreadItem =
	| { type: "userMessage"; id: string }
	| { type: "agentMessage"; id: string; text: string }
	| { type: "reasoning"; id: string }
	| { type: "commandExecution"; id: string; command: string; cwd: string; status: "inProgress" | "completed" | "failed" | "declined"; processId?: string | null }
	| { type: "dynamicToolCall"; id: string; tool: string; arguments: unknown; status: string }
	| { type: "fileChange"; id: string; status: string };

export interface CommandApprovalParams {
	itemId: string;
	threadId: string;
	turnId: string;
	command?: string | null;
	cwd?: string | null;
	additionalPermissions?: unknown;
	networkApprovalContext?: unknown;
	availableDecisions?: unknown[] | null;
}
/** picp answers only these two; never `acceptForSession` or an amendment. */
export interface CommandApprovalResponse { decision: "accept" | "decline" }
export interface FileChangeApprovalParams { itemId: string; threadId: string; turnId: string }
export interface DynamicToolCallParams { tool: string; arguments: unknown; callId: string; threadId: string; turnId: string }
export interface DynamicToolCallResponse { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }

export interface TurnCompletedNotification { threadId: string; turn: Turn }
export interface ItemNotification { threadId: string; turnId: string; item: ThreadItem }
export interface TokenUsageUpdatedNotification { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage }
export type HookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped";
export interface HookCompletedNotification { threadId: string; turnId?: string | null; run: { id: string; status: HookRunStatus; eventName: HookEventName } }
