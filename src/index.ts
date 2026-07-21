import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const DECISION_TOOL_NAME = "record_supercompact_decision";
const AGENT_TOOL_NAME = "supercompact";
const CONFIG_FILE_NAME = "pi-supercompact.json";
const STATUS_KEY = "pi-supercompact";
const LEGACY_SUMMARY_PLACEHOLDER =
  "Super-summary prepared; compacting context.";
const MAX_SUMMARY_ATTEMPTS = 3;

export type ContinuationAction = "continue" | "stop";

export interface ParsedSuperSummary {
  action: ContinuationAction;
  summary: string;
}

type RequestPhase =
  | "queued"
  | "awaiting-summary"
  | "summary-ready"
  | "compacting";

interface SupercompactRequest {
  id: string;
  phase: RequestPhase;
  compactionCompleted: boolean;
  attempts: number;
  correctionSent: boolean;
  currentBatchValid: boolean;
  action?: ContinuationAction;
  summary?: string;
  error?: string;
}

interface SummaryRequestDetails {
  requestId?: unknown;
}

interface RestoredContextDetails {
  summary?: unknown;
}

interface DecisionToolDetails {
  requestId: string;
  continuation: ContinuationAction;
}

type AgentToolMode = "disabled" | "once" | "enabled";

type ConfigReadResult =
  | { kind: "absent" }
  | { kind: "valid"; enabled: boolean }
  | { kind: "invalid"; error: string };

const AgentToolParameters = Type.Object(
  {
    extraContext: Type.Optional(
      Type.String({
        description:
          "Optional instructions or emphasis for the super-summary and continuation decision.",
      }),
    ),
  },
  { additionalProperties: false },
);

const DecisionParameters = Type.Object(
  {
    continuation: Type.Unsafe<ContinuationAction>({
      type: "string",
      enum: ["continue", "stop"],
      description:
        "Whether the agent should continue authorized incomplete work after compaction or wait for the user.",
    }),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAgentToolConfig(path: string): ConfigReadResult {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      return { kind: "invalid", error: "the root value must be an object" };
    }
    if (!("agentToolEnabled" in parsed)) return { kind: "absent" };
    if (typeof parsed.agentToolEnabled !== "boolean") {
      return {
        kind: "invalid",
        error: "agentToolEnabled must be true or false",
      };
    }
    return { kind: "valid", enabled: parsed.agentToolEnabled };
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function setWorkingMessage(ctx: ExtensionContext, message?: string): void {
  if (!ctx.hasUI) return;
  if (message === undefined) {
    ctx.ui.setWorkingMessage();
  } else {
    ctx.ui.setWorkingMessage(message);
  }
}

function textFromAssistant(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

interface AssistantToolCall {
  id: string;
  name: string;
}

function toolCallsFromAssistant(message: {
  content: unknown;
}): AssistantToolCall[] {
  if (!Array.isArray(message.content)) return [];

  return message.content.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== "toolCall" ||
      typeof part.id !== "string" ||
      typeof part.name !== "string"
    ) {
      return [];
    }
    return [{ id: part.id, name: part.name }];
  });
}

function isDecisionToolCallPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    value.name === DECISION_TOOL_NAME
  );
}

function staticComponent(lines: string[]) {
  return {
    render: () => lines,
    invalidate: () => {},
  };
}

export function buildSummaryPrompt(extraContext: string): string {
  const emphasis = extraContext.trim()
    ? [
        "The user supplied the following extra context. It has highest priority when shaping the summary and continuation decision. Treat it as a continuation instruction only when it explicitly requests further work, continuation, resumption, stopping, or waiting:",
        "<extra-context>",
        extraContext.trim(),
        "</extra-context>",
      ].join("\n")
    : "The user supplied no extra context.";

  return [
    "Prepare the canonical working-memory handoff for this session before context compaction.",
    "Use the entire conversation context currently available to you, including relevant earlier summaries and user-provided state.",
    "Do not modify files, continue the task, answer questions from the conversation, or call any tool except the required continuation-decision tool. Only produce the requested handoff.",
    "",
    emphasis,
    "",
    "Prioritize current actionable state over closed history. Use the following section order. Omit sections that have no useful content, except Next action, which is required and must be last:",
    "- Current objective",
    "- Current direction and authorization boundaries",
    "- Current state",
    "- Open decisions or blockers",
    "- Files by work horizon",
    "- Verified results",
    "- Reported or unverified information",
    "- Completed work, compressed to outcomes and material rationale",
    "- Next action",
    "",
    "Separate durable facts and verified results from mutable observations, unverified information, and future instructions.",
    "Mutable observations include repository state, installed software, executor availability, external services, and other facts that may change. Include them only when they affect continuation, state when they were observed when useful, and require revalidation only when the next action depends on them.",
    "When direction changed during the conversation, state the current direction. Mention an older direction only when doing so prevents incorrect continuation, and clearly state that it no longer applies.",
    "Preserve non-obvious constraints that materially affect how unfinished work must be performed, including explicit prohibitions, source-of-truth or responsibility decisions, and the rationale that makes them actionable. Include only constraints established in the conversation; do not infer new ones.",
    "Organize files under only the useful work-horizon tiers: Needed now, Needed for confirmed upcoming work, and Durable references. Omit empty tiers. For each file, give its exact path and a short reason it matters. Do not report historical read status, reproduce a mechanical file ledger, or imply that every listed file must be read immediately. Keep the section focused and explicitly non-exhaustive.",
    "End with a Next action section naming one immediate action, its owner when known, and any approval or input required before it can begin. If no work is authorized, the next action is to wait for the user. Do not place any content after this section.",
    "Use only known facts. Clearly qualify reported or unverified information. Prefer compact headings, bullets, and concrete paths. Refer to the user in the third person.",
    "Do not include commit hashes, blob hashes, forensic provenance identifiers, diary-style narration, or detailed closed history that does not affect continuation.",
    "",
    "Choose the continuation decision conservatively. When uncertain, choose stop.",
    "Choose continue only when at least one of these conditions holds:",
    "- The user explicitly requests continuing or resuming an identifiable user-authorized task.",
    "- Immediately before this summarization request, the assistant was actively executing a specific user-authorized task, a concrete next action remains, and that action requires no new user input or approval.",
    "Choose stop when any of these conditions holds:",
    "- The requested work has been completed, or the assistant has delivered a result, conclusion, or final response.",
    "- The assistant is awaiting clarification, approval, credentials, access, or a user decision.",
    "- Remaining possibilities are merely optional improvements, speculative ideas, backlog items, cleanup, or work that was not explicitly authorized.",
    "- There is no clear, concrete next action, or the correct decision is uncertain.",
    "Do not invent work, broaden the task, or treat potentially useful follow-up work as authorized.",
    "Only explicit language requesting further work, continuation, resumption, stopping, or waiting overrides these rules. Extra context that merely emphasizes part of the summary does not imply continuation.",
    "",
    "Write the handoff as ordinary Markdown with no wrapper, code fence, preamble, or trailing commentary.",
    `In the same response, after writing the Markdown, call ${DECISION_TOOL_NAME} exactly once with continuation set to continue or stop. Do not call any other tool.`,
  ].join("\n");
}

export function buildContinuationMessage(parsed: ParsedSuperSummary): string {
  const directive =
    parsed.action === "continue"
      ? "Continue the previously authorized incomplete work now. Use the summary as authoritative continuation context, do not repeat completed work, and do not merely acknowledge this message. Treat next actions as objectives subject to every recorded constraint, not as permission to broaden scope, move responsibilities, or duplicate an existing source of truth."
      : "Do not automatically continue prior work. Preserve this summary as context and wait for the user's next instruction.";

  return [
    "# Supercompaction context",
    "",
    "## Continuation directive",
    "",
    directive,
    "",
    "## File-reference guidance",
    "",
    "File paths in the summary are organized by when they are expected to matter. Treat them as focused references, not as proof of current contents or instructions to read every file. Read exact contents only when the active task requires them.",
    "",
    parsed.summary,
  ].join("\n");
}

type ContextMessage = ContextEvent["messages"][number];
type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;

function isSummaryRequestMessage(
  message: ContextMessage,
): message is CustomContextMessage {
  return (
    message.role === "custom" && message.customType === SUMMARY_REQUEST_TYPE
  );
}

function isRestoredContextMessage(
  message: ContextMessage,
): message is CustomContextMessage {
  return (
    message.role === "custom" && message.customType === CONTEXT_MESSAGE_TYPE
  );
}

function requestIdFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const requestId = (details as SummaryRequestDetails).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function summaryFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const summary = (details as RestoredContextDetails).summary;
  return typeof summary === "string" ? summary : undefined;
}

export default function supercompactExtension(pi: ExtensionAPI): void {
  let request: SupercompactRequest | undefined;
  let agentToolMode: AgentToolMode = "disabled";
  let decisionToolRegistered = false;
  const activeDecisionToolCallIds = new Set<string>();

  const setToolActive = (toolName: string, active: boolean): boolean => {
    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(toolName);
    if (isActive === active) return true;

    pi.setActiveTools(
      active
        ? [...activeTools, toolName]
        : activeTools.filter((name) => name !== toolName),
    );
    return pi.getActiveTools().includes(toolName) === active;
  };

  const updateAgentToolStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const status =
      agentToolMode === "enabled"
        ? "supercompact: agent enabled"
        : agentToolMode === "once"
          ? "supercompact: allowed once"
          : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const applyAgentToolMode = (
    mode: AgentToolMode,
    ctx: ExtensionContext,
  ): boolean => {
    agentToolMode = mode;
    const active = mode !== "disabled";
    if (!setToolActive(AGENT_TOOL_NAME, active)) {
      agentToolMode = "disabled";
      setToolActive(AGENT_TOOL_NAME, false);
      updateAgentToolStatus(ctx);
      notify(
        ctx,
        "Supercompact agent tool is unavailable in this session.",
        "error",
      );
      return false;
    }
    updateAgentToolStatus(ctx);
    return true;
  };

  const loadConfiguredAgentToolMode = (
    ctx: ExtensionContext,
  ): AgentToolMode => {
    const configs: Array<{ path: string; result: ConfigReadResult }> = [];
    const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
    configs.push({ path: globalPath, result: readAgentToolConfig(globalPath) });

    if (ctx.isProjectTrusted()) {
      const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
      configs.push({
        path: projectPath,
        result: readAgentToolConfig(projectPath),
      });
    }

    let enabled = false;
    for (const config of configs) {
      if (config.result.kind === "valid") {
        enabled = config.result.enabled;
      } else if (config.result.kind === "invalid") {
        enabled = false;
        notify(
          ctx,
          `Ignoring invalid supercompact config at ${config.path}: ${config.result.error}`,
          "warning",
        );
      }
    }
    return enabled ? "enabled" : "disabled";
  };

  const deactivateDecisionTool = (): void => {
    setToolActive(DECISION_TOOL_NAME, false);
  };

  const clearTransientState = (ctx?: ExtensionContext): void => {
    deactivateDecisionTool();
    activeDecisionToolCallIds.clear();
    if (ctx) setWorkingMessage(ctx);
  };

  const settleAgentToolAfterRequest = (ctx: ExtensionContext): void => {
    applyAgentToolMode(agentToolMode, ctx);
  };

  const fail = (ctx: ExtensionContext, message: string): void => {
    clearTransientState(ctx);
    request = undefined;
    settleAgentToolAfterRequest(ctx);
    notify(ctx, `Supercompact failed: ${message}`, "error");
  };

  const ensureDecisionTool = (): boolean => {
    if (!decisionToolRegistered) {
      pi.registerTool({
        name: DECISION_TOOL_NAME,
        label: "Supercompact Decision",
        description:
          "Record whether supercompaction should continue authorized incomplete work or wait after compaction. Use exactly once after writing the requested Markdown handoff.",
        parameters: DecisionParameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          if (!request || request.phase !== "awaiting-summary") {
            throw new Error("No supercompact summary is awaiting a decision.");
          }
          if (!request.currentBatchValid) {
            throw new Error(
              `Call ${DECISION_TOOL_NAME} exactly once and do not call other tools in the same response.`,
            );
          }
          if (!request.summary) {
            throw new Error(
              "Write the requested non-empty Markdown handoff before recording its continuation decision.",
            );
          }

          request.action = params.continuation;
          request.phase = "summary-ready";
          request.error = undefined;
          clearTransientState(ctx);
          notify(
            ctx,
            params.continuation === "continue"
              ? "Super-summary prepared. After compaction, the agent will continue working."
              : "Super-summary prepared. After compaction, the agent will wait for further instructions before proceeding.",
          );

          return {
            content: [
              {
                type: "text",
                text: `Recorded supercompact continuation decision: ${params.continuation}.`,
              },
            ],
            details: {
              requestId: request.id,
              continuation: params.continuation,
            } satisfies DecisionToolDetails,
            terminate: true,
          };
        },
        renderCall() {
          return staticComponent([]);
        },
        renderResult(_result, _options, _theme, context) {
          return staticComponent(
            context.isError
              ? [
                  "Continuation metadata was invalid; asking the agent to correct it.",
                ]
              : [],
          );
        },
      });
      decisionToolRegistered = true;
    }

    return setToolActive(DECISION_TOOL_NAME, true);
  };

  const beginSupercompact = (
    extraContext: string,
    ctx: ExtensionContext,
  ): { started: true } | { started: false; reason: string } => {
    if (request) {
      return { started: false, reason: "Supercompact is already in progress." };
    }

    const idle = ctx.isIdle();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    request = {
      id,
      phase: "queued",
      compactionCompleted: false,
      attempts: 0,
      correctionSent: false,
      currentBatchValid: false,
    };

    if (!ensureDecisionTool()) {
      request = undefined;
      return {
        started: false,
        reason:
          "Supercompact failed: the internal continuation-decision tool is unavailable in this session.",
      };
    }

    if (extraContext) {
      notify(
        ctx,
        `${idle ? "Creating super-summary." : "Supercompaction queued; finishing the current tool batch first."}\nExtra instructions: ${extraContext}`,
      );
    } else if (!idle) {
      notify(
        ctx,
        "Supercompaction queued; finishing the current tool batch first.",
      );
    }

    pi.sendMessage(
      {
        customType: SUMMARY_REQUEST_TYPE,
        content: buildSummaryPrompt(extraContext),
        display: false,
        details: { version: 2, requestId: id },
      },
      idle ? { triggerTurn: true, deliverAs: "steer" } : { deliverAs: "steer" },
    );
    return { started: true };
  };

  pi.registerTool({
    name: AGENT_TOOL_NAME,
    label: "Supercompact",
    description:
      "Prepare a full-context working-memory handoff, run native compaction, and resume authorized unfinished work when appropriate. This tool is callable only while the user has authorized agent-triggered supercompaction.",
    parameters: AgentToolParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (request) {
        throw new Error("Supercompact is already in progress.");
      }
      if (agentToolMode === "disabled") {
        throw new Error(
          "Agent-triggered supercompaction is not authorized. The user must run /supercompact allow or /supercompact enable.",
        );
      }

      const authorization = agentToolMode;
      const result = beginSupercompact(params.extraContext?.trim() ?? "", ctx);
      if (!result.started) throw new Error(result.reason);

      if (authorization === "once") {
        agentToolMode = "disabled";
        updateAgentToolStatus(ctx);
      }

      return {
        content: [
          {
            type: "text",
            text:
              authorization === "once"
                ? "Supercompaction queued. The one-time authorization has been consumed."
                : "Supercompaction queued.",
          },
        ],
        details: {
          authorization,
          extraContext: params.extraContext?.trim() || undefined,
        },
      };
    },
  });

  const finish = (ctx: ExtensionContext): void => {
    if (
      !request ||
      request.phase !== "compacting" ||
      !request.action ||
      !request.summary
    ) {
      return;
    }

    const parsed: ParsedSuperSummary = {
      action: request.action,
      summary: request.summary,
    };
    const content = buildContinuationMessage(parsed);
    request = undefined;
    settleAgentToolAfterRequest(ctx);

    const message = {
      customType: CONTEXT_MESSAGE_TYPE,
      content,
      display: false,
      details: {
        version: 2,
        continuation: parsed.action,
        summary: parsed.summary,
      },
    };

    if (parsed.action === "continue") {
      pi.sendMessage(message, {
        triggerTurn: true,
        deliverAs: "steer",
      });
      return;
    }

    pi.sendMessage(
      message,
      ctx.isIdle() ? undefined : { deliverAs: "nextTurn" },
    );
  };

  pi.on("session_start", (_event, ctx) => {
    clearTransientState(ctx);
    request = undefined;
    applyAgentToolMode(loadConfiguredAgentToolMode(ctx), ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTransientState(ctx);
    request = undefined;
    agentToolMode = "disabled";
    setToolActive(AGENT_TOOL_NAME, false);
    updateAgentToolStatus(ctx);
  });

  pi.on("context", (event) => {
    const activeRequestId =
      request?.phase === "queued" || request?.phase === "awaiting-summary"
        ? request.id
        : undefined;
    const preserveActiveDecisionArtifacts =
      request?.phase === "awaiting-summary";

    let latestContextIndex = -1;
    const restoredSummaries = new Set<string>();
    event.messages.forEach((message, index) => {
      if (!isRestoredContextMessage(message)) return;
      latestContextIndex = index;
      const summary = summaryFromDetails(message.details);
      if (summary) restoredSummaries.add(summary);
    });

    let changed = false;
    const messages: ContextMessage[] = [];

    event.messages.forEach((message, index) => {
      if (isSummaryRequestMessage(message)) {
        if (requestIdFromDetails(message.details) === activeRequestId) {
          messages.push(message);
        } else {
          changed = true;
        }
        return;
      }

      if (isRestoredContextMessage(message)) {
        if (index === latestContextIndex) {
          messages.push(message);
        } else {
          changed = true;
        }
        return;
      }

      if (
        message.role === "toolResult" &&
        message.toolName === DECISION_TOOL_NAME
      ) {
        if (
          preserveActiveDecisionArtifacts &&
          activeDecisionToolCallIds.has(message.toolCallId)
        ) {
          messages.push(message);
        } else {
          changed = true;
        }
        return;
      }

      if (message.role === "assistant") {
        const assistantText = textFromAssistant(message);
        if (
          assistantText === LEGACY_SUMMARY_PLACEHOLDER ||
          restoredSummaries.has(assistantText)
        ) {
          changed = true;
          return;
        }

        if (!Array.isArray(message.content)) {
          messages.push(message);
          return;
        }

        const content = message.content.filter((part) => {
          if (!isDecisionToolCallPart(part)) return true;
          if (
            preserveActiveDecisionArtifacts &&
            isRecord(part) &&
            typeof part.id === "string" &&
            activeDecisionToolCallIds.has(part.id)
          ) {
            return true;
          }
          changed = true;
          return false;
        });

        if (content.length === 0) {
          if (content.length !== message.content.length) changed = true;
          return;
        }
        if (content.length !== message.content.length) {
          messages.push({ ...message, content });
        } else {
          messages.push(message);
        }
        return;
      }

      messages.push(message);
    });

    return changed ? { messages } : undefined;
  });

  pi.on("tool_call", (event) => {
    if (request?.phase !== "awaiting-summary") return;

    if (event.toolName === DECISION_TOOL_NAME && request.currentBatchValid) {
      return;
    }

    return {
      block: true,
      reason:
        event.toolName === DECISION_TOOL_NAME
          ? `Call ${DECISION_TOOL_NAME} exactly once and do not call other tools in the same response.`
          : `Tools other than ${DECISION_TOOL_NAME} are disabled while preparing a supercompact summary.`,
    };
  });

  pi.on("tool_result", (event, ctx) => {
    if (
      request?.phase !== "awaiting-summary" ||
      !event.isError ||
      request.attempts < MAX_SUMMARY_ATTEMPTS
    ) {
      return;
    }

    request.error = `the continuation decision remained invalid after ${MAX_SUMMARY_ATTEMPTS} attempts`;
    clearTransientState(ctx);
    ctx.abort();
  });

  pi.on("message_end", (event, ctx) => {
    if (!request) return;

    if (
      event.message.role === "custom" &&
      event.message.customType === SUMMARY_REQUEST_TYPE &&
      requestIdFromDetails(event.message.details) === request.id
    ) {
      request.phase = "awaiting-summary";
      setWorkingMessage(ctx, "Creating super-summary…");
      return;
    }

    if (
      request.phase !== "awaiting-summary" ||
      event.message.role !== "assistant"
    ) {
      return;
    }

    request.attempts += 1;
    if (request.attempts > MAX_SUMMARY_ATTEMPTS) {
      request.error = `the summary remained invalid after ${MAX_SUMMARY_ATTEMPTS} attempts`;
      clearTransientState(ctx);
      ctx.abort();
      return;
    }

    if (
      event.message.stopReason === "aborted" ||
      event.message.stopReason === "error" ||
      event.message.stopReason === "length"
    ) {
      request.error = `summary response ended with ${event.message.stopReason}`;
      request.currentBatchValid = false;
      return;
    }

    const summary = textFromAssistant(event.message);
    if (!request.summary && summary) request.summary = summary;

    const toolCalls = toolCallsFromAssistant(event.message);
    for (const toolCall of toolCalls) {
      if (toolCall.name === DECISION_TOOL_NAME) {
        activeDecisionToolCallIds.add(toolCall.id);
      }
    }

    request.currentBatchValid =
      toolCalls.length === 1 && toolCalls[0].name === DECISION_TOOL_NAME;
    request.error = undefined;
  });

  pi.on("session_compact", () => {
    if (request) request.compactionCompleted = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!request) return;

    if (request.phase === "queued" || request.phase === "awaiting-summary") {
      if (request.error) {
        fail(ctx, request.error);
        return;
      }

      if (
        request.phase === "awaiting-summary" &&
        request.summary &&
        !request.correctionSent &&
        request.attempts < MAX_SUMMARY_ATTEMPTS
      ) {
        request.correctionSent = true;
        request.currentBatchValid = false;
        pi.sendMessage(
          {
            customType: SUMMARY_REQUEST_TYPE,
            content: `The Markdown super-summary has been captured. Do not repeat it. Call ${DECISION_TOOL_NAME} exactly once now with continuation set to continue or stop. Do not call any other tool or emit additional commentary.`,
            display: false,
            details: { version: 2, requestId: request.id, correction: true },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }

      fail(
        ctx,
        request.summary
          ? "the summary turn settled without a valid continuation decision"
          : "the summary turn settled without a usable summary",
      );
      return;
    }

    if (request.phase !== "summary-ready") return;

    request.phase = "compacting";
    if (request.compactionCompleted) {
      finish(ctx);
      return;
    }

    ctx.compact({
      onComplete: () => finish(ctx),
      onError: (error) => fail(ctx, error.message),
    });
  });

  const startFromCommand = (
    extraContext: string,
    ctx: ExtensionContext,
  ): void => {
    const result = beginSupercompact(extraContext.trim(), ctx);
    if (result.started) return;
    notify(
      ctx,
      result.reason,
      result.reason.startsWith("Supercompact failed:") ? "error" : "warning",
    );
  };

  const allowAgentToolOnce = (ctx: ExtensionContext): void => {
    if (request) {
      notify(
        ctx,
        "Cannot grant a new one-time authorization while supercompact is already in progress.",
        "warning",
      );
      return;
    }
    if (agentToolMode === "enabled") {
      notify(ctx, "The supercompact agent tool is already enabled.");
      return;
    }
    if (agentToolMode === "once") {
      notify(ctx, "One agent supercompaction is already authorized.");
      return;
    }
    if (applyAgentToolMode("once", ctx)) {
      notify(ctx, "The agent may run supercompact once.");
    }
  };

  const enableAgentTool = (ctx: ExtensionContext): void => {
    if (agentToolMode === "enabled") {
      notify(ctx, "The supercompact agent tool is already enabled.");
      return;
    }
    if (applyAgentToolMode("enabled", ctx)) {
      notify(ctx, "The supercompact agent tool is enabled for this session.");
    }
  };

  const disableAgentTool = (ctx: ExtensionContext): void => {
    if (
      agentToolMode === "disabled" &&
      !pi.getActiveTools().includes(AGENT_TOOL_NAME)
    ) {
      notify(ctx, "The supercompact agent tool is already disabled.");
      return;
    }
    if (applyAgentToolMode("disabled", ctx)) {
      notify(ctx, "The supercompact agent tool is disabled for this session.");
    }
  };

  const showCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify(
        ctx,
        "The supercompact menu requires TUI or RPC mode. Use /supercompact run, allow, enable, or disable.",
        "error",
      );
      return;
    }

    const run = "Run supercompact now";
    const allow = "Allow one agent supercompaction";
    const enable = "Enable the agent tool for this session";
    const disable = "Disable the agent tool for this session";
    const choice = await ctx.ui.select("Supercompact", [
      run,
      allow,
      enable,
      disable,
    ]);

    if (choice === run) {
      const extraContext = await ctx.ui.editor(
        "Optional extra context for the super-summary",
        "",
      );
      if (extraContext !== undefined) startFromCommand(extraContext, ctx);
    } else if (choice === allow) {
      allowAgentToolOnce(ctx);
    } else if (choice === enable) {
      enableAgentTool(ctx);
    } else if (choice === disable) {
      disableAgentTool(ctx);
    }
  };

  pi.registerCommand("supercompact", {
    description: "Run or configure supercompaction",
    getArgumentCompletions: (prefix) => {
      const commands = ["run", "allow", "enable", "disable"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length === 0
        ? null
        : matches.map((command) => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        await showCommandMenu(ctx);
        return;
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const action = match?.[1]?.toLowerCase();
      const remainder = match?.[2]?.trim() ?? "";

      if (action === "run") {
        startFromCommand(remainder, ctx);
      } else if (action === "allow" && !remainder) {
        allowAgentToolOnce(ctx);
      } else if (action === "enable" && !remainder) {
        enableAgentTool(ctx);
      } else if (action === "disable" && !remainder) {
        disableAgentTool(ctx);
      } else {
        notify(
          ctx,
          "Usage: /supercompact [run [extra context] | allow | enable | disable]",
          "error",
        );
      }
    },
  });
}
