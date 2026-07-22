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

const PREPARATION_REQUEST_TYPE = "pi-supercompact:preparation-request";
const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const DECISION_TOOL_NAME = "record_supercompact_decision";
const AGENT_TOOL_NAME = "supercompact";
const CONFIG_FILE_NAME = "pi-supercompact.json";
const STATUS_KEY = "pi-supercompact";
const LEGACY_SUMMARY_PLACEHOLDER =
  "Super-summary prepared; compacting context.";
const MAX_SUMMARY_ATTEMPTS = 3;
const USAGE =
  "Usage: /supercompact [run [extra context] | force [extra context] | allow | forbid]";

export type ContinuationAction = "continue" | "stop";

export interface ParsedSuperSummary {
  action: ContinuationAction;
  summary: string;
  preparation?: ConfirmedPreparationContext;
}

export interface ConfirmedPreparationContext {
  expectedContinuation: ContinuationAction;
  nextAction: string;
  runExtraContext?: string;
  agentExtraContext?: string;
}

type RequestPhase =
  | "queued"
  | "awaiting-summary"
  | "summary-ready"
  | "compacting";

type AgentPolicy = "allowed" | "forbidden";

interface PreparationGrant {
  id: string;
  extraContext: string;
  consumed: boolean;
  revoked: boolean;
}

interface SupercompactRequest {
  id: string;
  phase: RequestPhase;
  compactionCompleted: boolean;
  attempts: number;
  correctionSent: boolean;
  currentBatchValid: boolean;
  preparation?: ConfirmedPreparationContext;
  action?: ContinuationAction;
  summary?: string;
  error?: string;
}

interface SummaryRequestDetails {
  requestId?: unknown;
}

interface PreparationRequestDetails {
  preparationId?: unknown;
}

interface RestoredContextDetails {
  summary?: unknown;
}

interface DecisionToolDetails {
  requestId: string;
  continuation: ContinuationAction;
}

type ConfigReadResult =
  | { kind: "absent" }
  | { kind: "valid"; enabled: boolean }
  | { kind: "invalid"; error: string };

const AgentToolParameters = Type.Object(
  {
    continuation: Type.Unsafe<ContinuationAction>({
      type: "string",
      enum: ["continue", "stop"],
      description:
        "Whether authorized incomplete work should continue after compaction or the agent should wait for the user.",
    }),
    nextAction: Type.String({
      minLength: 1,
      description:
        "One concrete immediate action after compaction, or an explicit statement that the agent will wait for the user.",
    }),
    extraContext: Type.Optional(
      Type.String({
        description:
          "Optional additional emphasis for the canonical super-summary.",
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

export function buildPreparationPrompt(extraContext: string): string {
  const emphasis = extraContext.trim()
    ? [
        "The user supplied this preparation context. Give it high priority within the existing authorization boundaries:",
        "<preparation-context>",
        extraContext.trim(),
        "</preparation-context>",
      ].join("\n")
    : "The user supplied no extra preparation context.";

  return [
    "Perform a focused pre-compaction wrap for the active work. Do not compact immediately.",
    "Use the current conversation and actual scoped repository state rather than relying on memory.",
    "Do not broaden the task, invent work, or turn this into a repository-wide audit or ceremonial report.",
    "",
    emphasis,
    "",
    "Freshen the active context:",
    "- Re-read the relevant plan, user-facing documentation, agent instructions, and directly referenced companion documents.",
    "- Compare them with current command names, implementation paths, repository state, and focused verification results.",
    "- Fix obvious staleness introduced by the active work, while keeping durable documentation evergreen and free of transient hashes, branch counts, push status, or diary narration.",
    "",
    "Wrap the active boundary:",
    "- Review the current objective, explicit authorization boundaries, and established non-obvious constraints.",
    "- Identify incomplete requested work, unfinished active items, required validation or commits, blockers, unanswered questions, missing approvals, credentials, and decisions.",
    "- Complete only work that is already authorized, safe to complete, and needs no new user input. Run required focused verification and observe repository commit rules.",
    "- Resolve issues you are authorized to resolve. Surface material blockers or decisions prominently; if user input is required, ask and wait without requesting supercompaction.",
    "- Distinguish real remaining work from optional improvements or speculative follow-ups.",
    "- Establish whether work should continue or stop after compaction. If continuing, identify one exact immediate next action that remains authorized and needs no additional input.",
    "- Re-read anything you changed and make a final accuracy pass.",
    "",
    `When the boundary is clean and unambiguous, call ${AGENT_TOOL_NAME} with the expected continuation, exact next action, and any additional summary emphasis. The user will receive a final confirmation dialog before native compaction begins.`,
    `Do not call ${AGENT_TOOL_NAME} merely because it is available; call it only after these checks are complete.`,
  ].join("\n");
}

export function buildSummaryPrompt(
  extraContext: string,
  preparation?: ConfirmedPreparationContext,
): string {
  const emphasis = preparation
    ? [
        "The user confirmed the following preparation outcome immediately before this summary request:",
        "<confirmed-preparation>",
        `Expected continuation: ${preparation.expectedContinuation}`,
        `Exact next action: ${preparation.nextAction}`,
        ...(preparation.runExtraContext
          ? [
              `Original /supercompact run context: ${preparation.runExtraContext}`,
            ]
          : []),
        ...(preparation.agentExtraContext
          ? [
              `Agent-supplied summary emphasis confirmed by the user: ${preparation.agentExtraContext}`,
            ]
          : []),
        "</confirmed-preparation>",
        preparation.expectedContinuation === "stop"
          ? `The confirmed stop is a hard constraint. The ${DECISION_TOOL_NAME} continuation must be stop.`
          : "The confirmed continue authorizes continuation but does not force it. Choose stop if missing input, a blocker, completed work, or uncertainty makes continuation unsafe.",
        "Preserve the confirmed intent, exact next action, and any conservative downgrade to stop in the canonical handoff.",
      ].join("\n")
    : extraContext.trim()
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
  const preparation = parsed.preparation
    ? [
        "## Confirmed preparation outcome",
        "",
        `- User-confirmed expectation: ${parsed.preparation.expectedContinuation}`,
        `- Validated continuation: ${parsed.action}`,
        `- Proposed next action: ${parsed.preparation.nextAction}`,
        ...(parsed.preparation.expectedContinuation === "continue" &&
        parsed.action === "stop"
          ? [
              "- Safety outcome: continuation was conservatively downgraded to stop; wait for user direction rather than executing the proposed next action.",
            ]
          : []),
        "",
      ]
    : [];

  return [
    "# Supercompaction context",
    "",
    "## Continuation directive",
    "",
    directive,
    "",
    ...preparation,
    "## File-reference guidance",
    "",
    "File paths in the summary are organized by when they are expected to matter. Treat them as focused references, not as proof of current contents or instructions to read every file. Read exact contents only when the active task requires them.",
    "",
    parsed.summary,
  ].join("\n");
}

type ContextMessage = ContextEvent["messages"][number];
type CustomContextMessage = Extract<ContextMessage, { role: "custom" }>;

function isPreparationRequestMessage(
  message: ContextMessage,
): message is CustomContextMessage & {
  customType: typeof PREPARATION_REQUEST_TYPE;
} {
  return (
    message.role === "custom" && message.customType === PREPARATION_REQUEST_TYPE
  );
}

function isSummaryRequestMessage(
  message: ContextMessage,
): message is CustomContextMessage & {
  customType: typeof SUMMARY_REQUEST_TYPE;
} {
  return (
    message.role === "custom" && message.customType === SUMMARY_REQUEST_TYPE
  );
}

function isRestoredContextMessage(
  message: ContextMessage,
): message is CustomContextMessage & {
  customType: typeof CONTEXT_MESSAGE_TYPE;
} {
  return (
    message.role === "custom" && message.customType === CONTEXT_MESSAGE_TYPE
  );
}

function requestIdFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const requestId = (details as SummaryRequestDetails).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function preparationIdFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const preparationId = (details as PreparationRequestDetails).preparationId;
  return typeof preparationId === "string" ? preparationId : undefined;
}

function summaryFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const summary = (details as RestoredContextDetails).summary;
  return typeof summary === "string" ? summary : undefined;
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function confirmationText(preparation: ConfirmedPreparationContext): string {
  return [
    `Post-compaction behavior: ${preparation.expectedContinuation === "continue" ? "continue authorized work" : "stop and wait"}`,
    `Next action: ${preparation.nextAction}`,
    ...(preparation.runExtraContext
      ? [`Preparation context: ${preparation.runExtraContext}`]
      : []),
    ...(preparation.agentExtraContext
      ? [`Additional summary context: ${preparation.agentExtraContext}`]
      : []),
    "",
    "Confirming will begin the canonical super-summary and native compaction immediately.",
  ].join("\n");
}

export default function supercompactExtension(pi: ExtensionAPI): void {
  let request: SupercompactRequest | undefined;
  let configuredPolicy: AgentPolicy = "forbidden";
  let sessionPolicyOverride: AgentPolicy | undefined;
  let preparationGrant: PreparationGrant | undefined;
  let confirmationId: string | undefined;
  let confirmationAbortController: AbortController | undefined;
  let confirmationRevoked = false;
  let decisionToolRegistered = false;
  const activeDecisionToolCallIds = new Set<string>();

  const effectivePolicy = (): AgentPolicy =>
    sessionPolicyOverride ?? configuredPolicy;

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
      confirmationId && !confirmationRevoked
        ? "supercompact: awaiting confirmation"
        : preparationGrant && !preparationGrant.consumed
          ? "supercompact: preparing"
          : effectivePolicy() === "allowed"
            ? "supercompact: allowed"
            : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const shouldAgentToolBeActive = (): boolean =>
    effectivePolicy() === "allowed" ||
    Boolean(preparationGrant && !preparationGrant.revoked);

  const reconcileAgentTool = (
    ctx: ExtensionContext,
    reportFailure = true,
  ): boolean => {
    const shouldBeActive = shouldAgentToolBeActive();
    if (setToolActive(AGENT_TOOL_NAME, shouldBeActive)) {
      updateAgentToolStatus(ctx);
      return true;
    }

    setToolActive(AGENT_TOOL_NAME, false);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    if (reportFailure) {
      notify(
        ctx,
        "Supercompact agent tool is unavailable in this session.",
        "error",
      );
    }
    return false;
  };

  const loadConfiguredPolicy = (ctx: ExtensionContext): AgentPolicy => {
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
    return enabled ? "allowed" : "forbidden";
  };

  const deactivateDecisionTool = (): void => {
    setToolActive(DECISION_TOOL_NAME, false);
  };

  const clearDecisionState = (ctx?: ExtensionContext): void => {
    deactivateDecisionTool();
    activeDecisionToolCallIds.clear();
    if (ctx) setWorkingMessage(ctx);
  };

  const clearConsumedPreparation = (): void => {
    if (preparationGrant?.consumed) preparationGrant = undefined;
  };

  const fail = (ctx: ExtensionContext, message: string): void => {
    clearDecisionState(ctx);
    request = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    clearConsumedPreparation();
    reconcileAgentTool(ctx);
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
          if (
            request.preparation?.expectedContinuation === "stop" &&
            params.continuation === "continue"
          ) {
            throw new Error(
              "The user-confirmed stop is a hard constraint. Record continuation as stop.",
            );
          }

          request.action = params.continuation;
          request.phase = "summary-ready";
          request.error = undefined;
          clearDecisionState(ctx);
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
    preparation: ConfirmedPreparationContext | undefined,
    ctx: ExtensionContext,
  ): { started: true } | { started: false; reason: string } => {
    if (request) {
      return { started: false, reason: "Supercompact is already in progress." };
    }

    const idle = ctx.isIdle();
    const id = createId();
    request = {
      id,
      phase: "queued",
      compactionCompleted: false,
      attempts: 0,
      correctionSent: false,
      currentBatchValid: false,
      preparation,
    };

    if (!ensureDecisionTool()) {
      request = undefined;
      return {
        started: false,
        reason:
          "Supercompact failed: the internal continuation-decision tool is unavailable in this session.",
      };
    }

    if (preparationGrant && preparation) preparationGrant.consumed = true;
    updateAgentToolStatus(ctx);

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
    } else {
      notify(ctx, "Creating super-summary.");
    }

    try {
      pi.sendMessage(
        {
          customType: SUMMARY_REQUEST_TYPE,
          content: buildSummaryPrompt(extraContext, preparation),
          display: false,
          details: { version: 3, requestId: id },
        },
        idle
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "steer" },
      );
      return { started: true };
    } catch (error) {
      clearDecisionState(ctx);
      request = undefined;
      clearConsumedPreparation();
      reconcileAgentTool(ctx);
      return {
        started: false,
        reason: `Supercompact failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

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
      preparation: request.preparation,
    };
    const content = buildContinuationMessage(parsed);
    request = undefined;
    clearConsumedPreparation();
    reconcileAgentTool(ctx);

    const message = {
      customType: CONTEXT_MESSAGE_TYPE,
      content,
      display: false,
      details: {
        version: 3,
        continuation: parsed.action,
        summary: parsed.summary,
      },
    };

    try {
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
    } catch (error) {
      notify(
        ctx,
        `Supercompact failed to restore its canonical context: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const cancelPendingConfirmation = (): boolean => {
    if (!confirmationId) return false;
    confirmationRevoked = true;
    confirmationAbortController?.abort();
    return true;
  };

  pi.registerTool({
    name: AGENT_TOOL_NAME,
    label: "Supercompact",
    description:
      "Request final user confirmation for supercompaction after completing the focused pre-compaction preparation checks. Before calling: resolve authorized unfinished work, run required focused verification, freshen relevant durable context, ask and wait on blockers or missing input, decide whether work should continue or stop, and identify one exact next action. Do not call merely because this tool is available. Confirmation is required before the canonical super-summary and native compaction begin.",
    parameters: AgentToolParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (request) {
        throw new Error("Supercompact is already in progress.");
      }
      if (confirmationId) {
        throw new Error("Supercompact confirmation is already in progress.");
      }
      if (
        effectivePolicy() !== "allowed" &&
        (!preparationGrant ||
          preparationGrant.consumed ||
          preparationGrant.revoked)
      ) {
        throw new Error(
          "Agent-triggered supercompaction is not authorized. The user must run /supercompact run or /supercompact allow.",
        );
      }
      if (!ctx.hasUI) {
        throw new Error(
          "Agent-triggered supercompaction requires confirmation in TUI or RPC mode.",
        );
      }

      const nextAction = params.nextAction.trim();
      if (!nextAction) throw new Error("nextAction must not be empty.");
      const grantId =
        preparationGrant &&
        !preparationGrant.consumed &&
        !preparationGrant.revoked
          ? preparationGrant.id
          : undefined;
      const preparation: ConfirmedPreparationContext = {
        expectedContinuation: params.continuation,
        nextAction,
        ...(grantId && preparationGrant?.extraContext
          ? { runExtraContext: preparationGrant.extraContext }
          : {}),
        ...(params.extraContext?.trim()
          ? { agentExtraContext: params.extraContext.trim() }
          : {}),
      };

      const currentConfirmationId = createId();
      const currentConfirmationAbortController = new AbortController();
      confirmationId = currentConfirmationId;
      confirmationAbortController = currentConfirmationAbortController;
      confirmationRevoked = false;
      updateAgentToolStatus(ctx);

      const dialogSignal = signal
        ? AbortSignal.any([signal, currentConfirmationAbortController.signal])
        : currentConfirmationAbortController.signal;
      let confirmed: boolean;
      try {
        confirmed = await ctx.ui.confirm(
          "Confirm agent-requested supercompaction",
          confirmationText(preparation),
          { signal: dialogSignal },
        );
      } catch {
        const revoked =
          confirmationId === currentConfirmationId && confirmationRevoked;
        if (confirmationId === currentConfirmationId) {
          confirmationId = undefined;
          confirmationAbortController = undefined;
          confirmationRevoked = false;
          if (grantId && preparationGrant?.id === grantId) {
            preparationGrant = undefined;
          }
          reconcileAgentTool(ctx);
          notify(
            ctx,
            revoked
              ? "Supercompaction authorization was revoked."
              : "Supercompaction confirmation was canceled.",
            "warning",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: revoked
                ? "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for user direction."
                : "Supercompaction confirmation was canceled. Do not retry automatically; wait for user direction.",
            },
          ],
          details: { status: revoked ? "revoked" : "canceled" },
        };
      }

      if (confirmationId !== currentConfirmationId) {
        return {
          content: [
            {
              type: "text",
              text: "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for user direction.",
            },
          ],
          details: { status: "revoked" },
        };
      }
      if (confirmationRevoked) {
        confirmationId = undefined;
        confirmationAbortController = undefined;
        confirmationRevoked = false;
        reconcileAgentTool(ctx);
        return {
          content: [
            {
              type: "text",
              text: "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for user direction.",
            },
          ],
          details: { status: "revoked" },
        };
      }

      confirmationId = undefined;
      confirmationAbortController = undefined;
      confirmationRevoked = false;
      if (!confirmed) {
        if (grantId && preparationGrant?.id === grantId) {
          preparationGrant = undefined;
        }
        reconcileAgentTool(ctx);
        notify(ctx, "Agent-requested supercompaction was declined.", "warning");
        return {
          content: [
            {
              type: "text",
              text: "The user declined supercompaction. Do not retry automatically; wait for user direction.",
            },
          ],
          details: { status: "declined" },
        };
      }

      const stillAuthorized =
        effectivePolicy() === "allowed" ||
        Boolean(
          grantId &&
          preparationGrant?.id === grantId &&
          !preparationGrant.consumed &&
          !preparationGrant.revoked,
        );
      if (!stillAuthorized) {
        reconcileAgentTool(ctx);
        return {
          content: [
            {
              type: "text",
              text: "Supercompaction authorization expired before confirmation completed. Do not retry automatically; wait for user direction.",
            },
          ],
          details: { status: "expired" },
        };
      }

      const result = beginSupercompact("", preparation, ctx);
      if (!result.started) {
        if (grantId && preparationGrant?.id === grantId) {
          preparationGrant = undefined;
        }
        reconcileAgentTool(ctx);
        throw new Error(result.reason);
      }

      return {
        content: [
          {
            type: "text",
            text: "Supercompaction confirmed and queued.",
          },
        ],
        details: {
          status: "queued",
          continuation: preparation.expectedContinuation,
          nextAction: preparation.nextAction,
        },
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const canceledPreparation = Boolean(
      (preparationGrant && !preparationGrant.consumed) || confirmationId,
    );
    clearDecisionState(ctx);
    request = undefined;
    preparationGrant = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    sessionPolicyOverride = undefined;
    configuredPolicy = loadConfiguredPolicy(ctx);
    reconcileAgentTool(ctx);
    if (canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const canceledPreparation = Boolean(
      (preparationGrant && !preparationGrant.consumed) || confirmationId,
    );
    clearDecisionState(ctx);
    request = undefined;
    preparationGrant = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    sessionPolicyOverride = undefined;
    configuredPolicy = "forbidden";
    setToolActive(AGENT_TOOL_NAME, false);
    updateAgentToolStatus(ctx);
    if (canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
  });

  pi.on("context", (event) => {
    const activeRequestId =
      request?.phase === "queued" || request?.phase === "awaiting-summary"
        ? request.id
        : undefined;
    const activePreparationId =
      preparationGrant && !preparationGrant.consumed && !request
        ? preparationGrant.id
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
      if (isPreparationRequestMessage(message)) {
        if (preparationIdFromDetails(message.details) === activePreparationId) {
          messages.push(message);
        } else {
          changed = true;
        }
        return;
      }

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
    clearDecisionState(ctx);
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
      clearDecisionState(ctx);
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
        try {
          pi.sendMessage(
            {
              customType: SUMMARY_REQUEST_TYPE,
              content: `The Markdown super-summary has been captured. Do not repeat it. Call ${DECISION_TOOL_NAME} exactly once now with continuation set to continue or stop. Do not call any other tool or emit additional commentary.`,
              display: false,
              details: { version: 3, requestId: request.id, correction: true },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch (error) {
          fail(ctx, error instanceof Error ? error.message : String(error));
        }
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

    try {
      ctx.compact({
        onComplete: () => finish(ctx),
        onError: (error) => fail(ctx, error.message),
      });
    } catch (error) {
      fail(ctx, error instanceof Error ? error.message : String(error));
    }
  });

  const startPreparation = (
    extraContext: string,
    ctx: ExtensionContext,
  ): void => {
    if (!ctx.hasUI) {
      notify(
        ctx,
        "Pre-compaction preparation requires TUI or RPC mode for final confirmation.",
        "error",
      );
      return;
    }
    if (request || confirmationId || preparationGrant) {
      notify(
        ctx,
        "A supercompact preparation, confirmation, or compaction is already active.",
        "warning",
      );
      return;
    }

    const idle = ctx.isIdle();
    const id = createId();
    preparationGrant = {
      id,
      extraContext: extraContext.trim(),
      consumed: false,
      revoked: false,
    };
    if (!reconcileAgentTool(ctx)) {
      preparationGrant = undefined;
      reconcileAgentTool(ctx, false);
      return;
    }

    const notification = idle
      ? "Pre-compaction wrap started."
      : "Pre-compaction wrap queued; finishing the current tool batch first.";
    notify(
      ctx,
      extraContext.trim()
        ? `${notification}\nExtra instructions: ${extraContext.trim()}`
        : notification,
    );

    try {
      pi.sendMessage(
        {
          customType: PREPARATION_REQUEST_TYPE,
          content: buildPreparationPrompt(extraContext),
          display: false,
          details: { version: 1, preparationId: id },
        },
        idle
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "steer" },
      );
    } catch (error) {
      preparationGrant = undefined;
      reconcileAgentTool(ctx);
      notify(
        ctx,
        `Supercompact preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const startForce = (extraContext: string, ctx: ExtensionContext): void => {
    if (confirmationId) {
      notify(
        ctx,
        "Cannot force supercompaction while agent confirmation is open.",
        "warning",
      );
      return;
    }
    if (request) {
      notify(ctx, "Supercompact is already in progress.", "warning");
      return;
    }
    if (preparationGrant && !preparationGrant.consumed) {
      preparationGrant = undefined;
      reconcileAgentTool(ctx);
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }

    const result = beginSupercompact(extraContext.trim(), undefined, ctx);
    if (result.started) return;
    notify(
      ctx,
      result.reason,
      result.reason.startsWith("Supercompact failed:") ? "error" : "warning",
    );
  };

  const allowAgentTool = (ctx: ExtensionContext): void => {
    if (sessionPolicyOverride === "allowed") {
      notify(ctx, "Agent supercompaction requests are already allowed.");
      return;
    }

    sessionPolicyOverride = "allowed";
    if (reconcileAgentTool(ctx)) {
      notify(
        ctx,
        "Agent supercompaction requests are allowed for this live session.",
      );
    }
  };

  const forbidAgentTool = (ctx: ExtensionContext): void => {
    const wasAlreadyForbidden =
      sessionPolicyOverride === "forbidden" &&
      !preparationGrant &&
      !confirmationId;
    sessionPolicyOverride = "forbidden";

    const canceledConfirmation = cancelPendingConfirmation();
    const canceledPreparation = Boolean(
      preparationGrant && !preparationGrant.consumed,
    );
    if (canceledPreparation) {
      preparationGrant = undefined;
    } else if (preparationGrant?.consumed) {
      preparationGrant.revoked = true;
    }
    reconcileAgentTool(ctx);

    if (canceledConfirmation || canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
    notify(
      ctx,
      wasAlreadyForbidden
        ? "Agent supercompaction requests are already forbidden."
        : "Agent supercompaction requests are forbidden for this live session.",
    );
  };

  const showContextEditor = async (
    title: string,
    ctx: ExtensionContext,
  ): Promise<string | undefined> => ctx.ui.editor(title, "");

  const showCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      notify(
        ctx,
        `The supercompact menu requires TUI or RPC mode. ${USAGE}`,
        "error",
      );
      return;
    }

    const run = "Run pre-compaction wrap";
    const force = "Force supercompaction now";
    const allow = "Allow agent supercompaction requests for this session";
    const forbid = "Forbid agent supercompaction requests for this session";
    const cancel = "Cancel";
    const choice = await ctx.ui.select("Supercompact", [
      run,
      force,
      allow,
      forbid,
      cancel,
    ]);

    if (choice === run) {
      const extraContext = await showContextEditor(
        "Optional context for the pre-compaction wrap",
        ctx,
      );
      if (extraContext !== undefined) startPreparation(extraContext, ctx);
    } else if (choice === force) {
      const extraContext = await showContextEditor(
        "Optional extra context for the super-summary",
        ctx,
      );
      if (extraContext !== undefined) startForce(extraContext, ctx);
    } else if (choice === allow) {
      allowAgentTool(ctx);
    } else if (choice === forbid) {
      forbidAgentTool(ctx);
    }
  };

  pi.registerCommand("supercompact", {
    description: "Prepare, force, allow, or forbid supercompaction",
    getArgumentCompletions: (prefix) => {
      const commands = ["run", "force", "allow", "forbid"];
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
        startPreparation(remainder, ctx);
      } else if (action === "force") {
        startForce(remainder, ctx);
      } else if (action === "allow" && !remainder) {
        allowAgentTool(ctx);
      } else if (action === "forbid" && !remainder) {
        forbidAgentTool(ctx);
      } else {
        notify(ctx, USAGE, "error");
      }
    },
  });
}
