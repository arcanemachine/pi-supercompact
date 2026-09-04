import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SettingsManager,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const PREPARATION_REQUEST_TYPE = "pi-supercompact:preparation-request";
const DECISION_REQUEST_TYPE = "pi-supercompact:decision-request";
const SUMMARY_REQUEST_TYPE = "pi-supercompact:summary-request";
const CONTEXT_MESSAGE_TYPE = "pi-supercompact:context";
const CONTINUATION_OUTCOME_ENTRY_TYPE = "pi-supercompact:continuation-outcome";
const SESSION_PERMISSION_ENTRY_TYPE = "pi-supercompact:session-permission";
const SESSION_AUTOMATIC_ENTRY_TYPE = "pi-supercompact:session-automatic";
const DECISION_TOOL_NAME = "record_supercompact_decision";
const AGENT_TOOL_NAME = "supercompact";
const SETTINGS_FILE_NAME = "settings.json";
const STATUS_KEY = "pi-supercompact";
const LEGACY_SUMMARY_PLACEHOLDER =
  "Super-summary prepared; compacting context.";
const MAX_WORKFLOW_ATTEMPTS = 3;
const DEFAULT_THRESHOLD_PERCENT = 80;
const DEFAULT_FORCE_THRESHOLD_PERCENT = 90;
const INVALID_THRESHOLDS_MESSAGE =
  "supercompact thresholds must be between 0 and 100, with thresholdPercent below forceThresholdPercent";
const USAGE =
  "Usage: /supercompact [run [--stop|-s|--continue|-c] [extra context] | force [--stop|-s|--continue|-c] [extra context] | auto-enable | auto-disable | agent-driven-allow | agent-driven-allow-once | agent-driven-deny | abort]";

const CONTINUATION_OPTIONS: Array<[string, ContinuationAction]> = [
  ["--stop", "stop"],
  ["-s", "stop"],
  ["--continue", "continue"],
  ["-c", "continue"],
];

export type ContinuationAction = "continue" | "stop";

interface ParsedCommandArguments {
  continuationOverride?: ContinuationAction;
  extraContext: string;
}

function parseCommandArguments(
  remainder: string,
): ParsedCommandArguments | undefined {
  let extraContext = remainder.trim();
  let continuationOverride: ContinuationAction | undefined;

  while (/^-{1,2}\S/.test(extraContext)) {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(extraContext);
    const option = match?.[1];
    const action = CONTINUATION_OPTIONS.find(([flag]) => flag === option);
    if (!action) return undefined;
    if (continuationOverride) return undefined;
    continuationOverride = action[1];
    extraContext = match?.[2]?.trim() ?? "";
  }

  return { continuationOverride, extraContext };
}

function explicitContinuationError(continuation: ContinuationAction): Error {
  return new Error(
    `The explicit --${continuation} flag requires continuation set to ${continuation}. Correct the decision to ${continuation}; do not override the user's command.`,
  );
}

function continuationOverrideNotification(
  continuation: ContinuationAction,
): string {
  return `Continuation override: --${continuation} (${continuation === "stop" ? "wait after compaction" : "continue authorized work after compaction"}).`;
}

export interface ParsedSuperSummary {
  action: ContinuationAction;
  summary: string;
  preparation?: ConfirmedPreparationContext;
}

export interface ConfirmedPreparationContext {
  authorization?:
    | "session-no-confirm"
    | "configured-no-confirm"
    | "prepared-no-confirm"
    | "one-shot-no-confirm"
    | "automatic-no-confirm";
  expectedContinuation: ContinuationAction;
  nextAction: string;
  runExtraContext?: string;
  agentExtraContext?: string;
}

type RequestPhase =
  | "queued-decision"
  | "awaiting-decision"
  | "decision-ready"
  | "queued-summary"
  | "awaiting-summary"
  | "summary-ready"
  | "compacting";

type AgentPermission = "allowed" | "allowed-noconfirm" | "denied";
type ConfiguredPermission = AgentPermission;
type SessionPermissionOverride = "allowed-noconfirm" | "denied";

interface SessionPermissionEntryData {
  permission: SessionPermissionOverride;
}

type SessionAutomaticOverride = boolean;

interface SessionAutomaticEntryData {
  enabled: SessionAutomaticOverride;
}

type PreparationOrigin = "explicit" | "automatic";

type NoConfirmAuthorization = NonNullable<
  ConfirmedPreparationContext["authorization"]
>;

interface PreparationGrant {
  id: string;
  extraContext: string;
  origin: PreparationOrigin;
  consumed: boolean;
  revoked: boolean;
  continuationOverride?: ContinuationAction;
}

interface OneShotNoConfirmGrant {
  id: string;
}

interface SupercompactRequest {
  id: string;
  phase: RequestPhase;
  compactionCompleted: boolean;
  attempts: number;
  currentBatchValid: boolean;
  extraContext: string;
  automaticForce: boolean;
  preparation?: ConfirmedPreparationContext;
  continuationOverride?: ContinuationAction;
  action?: ContinuationAction;
  summary?: string;
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

interface AutomaticPolicy {
  enabled: boolean;
  thresholdPercent: number;
  forceThresholdPercent: number;
}

interface ConfiguredPolicy {
  permission: ConfiguredPermission;
  automatic: AutomaticPolicy;
}

interface RawConfiguredPolicy {
  allowed?: boolean;
  agentRequestsRequireConfirmation?: boolean;
  automatic?: Partial<AutomaticPolicy>;
}

type ConfigReadResult =
  | { kind: "absent" }
  | { kind: "valid"; config: RawConfiguredPolicy }
  | { kind: "invalid"; error: string };

const AgentToolParameters = Type.Object(
  {
    continuation: Type.Unsafe<ContinuationAction>({
      type: "string",
      enum: ["continue", "stop"],
      description:
        "Continue authorized unfinished work after compaction, or wait for the user.",
    }),
    nextAction: Type.String({
      minLength: 1,
      description:
        "Exact next action after compaction, or state that you will wait.",
    }),
    extraContext: Type.Optional(
      Type.String({
        description: "Optional emphasis for the super-summary.",
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
        "Continue authorized unfinished work after compaction, or wait for the user.",
    }),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAgentRequestConfig(
  settings: unknown,
  sourceLabel: string,
): ConfigReadResult {
  if (!isRecord(settings)) {
    return { kind: "invalid", error: "the settings root must be an object" };
  }

  const namespace = settings[STATUS_KEY];
  if (namespace === undefined) return { kind: "absent" };
  if (!isRecord(namespace)) {
    return { kind: "invalid", error: "pi-supercompact must be an object" };
  }

  const recognizedProperties = [
    "agentRequestsAllowed",
    "agentRequestsRequireConfirmation",
    "supercompact",
  ];
  if (!recognizedProperties.some((property) => property in namespace)) {
    return { kind: "absent" };
  }

  for (const property of [
    "agentRequestsAllowed",
    "agentRequestsRequireConfirmation",
  ]) {
    if (property in namespace && typeof namespace[property] !== "boolean") {
      return {
        kind: "invalid",
        error: `${sourceLabel}.${property} must be true or false`,
      };
    }
  }

  const supercompact = namespace.supercompact;
  if (supercompact !== undefined && !isRecord(supercompact)) {
    return {
      kind: "invalid",
      error: `${sourceLabel}.supercompact must be an object`,
    };
  }
  if (isRecord(supercompact)) {
    for (const property of [
      "enabled",
      "thresholdPercent",
      "forceThresholdPercent",
    ]) {
      if (!(property in supercompact)) continue;
      const value = supercompact[property];
      if (property === "enabled" && typeof value !== "boolean") {
        return {
          kind: "invalid",
          error: `${sourceLabel}.supercompact.enabled must be true or false`,
        };
      }
      if (
        property !== "enabled" &&
        (typeof value !== "number" || !Number.isFinite(value))
      ) {
        return {
          kind: "invalid",
          error: `${sourceLabel}.supercompact.${property} must be a finite number`,
        };
      }
    }
  }

  return {
    kind: "valid",
    config: {
      ...(typeof namespace.agentRequestsAllowed === "boolean"
        ? { allowed: namespace.agentRequestsAllowed }
        : {}),
      ...(typeof namespace.agentRequestsRequireConfirmation === "boolean"
        ? {
            agentRequestsRequireConfirmation:
              namespace.agentRequestsRequireConfirmation,
          }
        : {}),
      ...(isRecord(supercompact)
        ? {
            automatic: {
              ...(typeof supercompact.enabled === "boolean"
                ? { enabled: supercompact.enabled }
                : {}),
              ...(typeof supercompact.thresholdPercent === "number"
                ? { thresholdPercent: supercompact.thresholdPercent }
                : {}),
              ...(typeof supercompact.forceThresholdPercent === "number"
                ? { forceThresholdPercent: supercompact.forceThresholdPercent }
                : {}),
            },
          }
        : {}),
    },
  };
}

function defaultConfiguredPolicy(): ConfiguredPolicy {
  return {
    permission: "denied",
    automatic: {
      enabled: false,
      thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
      forceThresholdPercent: DEFAULT_FORCE_THRESHOLD_PERCENT,
    },
  };
}

function mergeConfiguredPolicy(
  global: RawConfiguredPolicy,
  project: RawConfiguredPolicy,
): RawConfiguredPolicy {
  return {
    ...global,
    ...project,
    automatic:
      global.automatic || project.automatic
        ? { ...global.automatic, ...project.automatic }
        : undefined,
  };
}

function policyFromConfig(
  config: RawConfiguredPolicy,
): ConfiguredPolicy | undefined {
  if (config.automatic && config.automatic.enabled === undefined) {
    return undefined;
  }
  const automatic = {
    enabled: config.automatic?.enabled ?? false,
    thresholdPercent:
      config.automatic?.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT,
    forceThresholdPercent:
      config.automatic?.forceThresholdPercent ??
      DEFAULT_FORCE_THRESHOLD_PERCENT,
  };
  if (
    automatic.thresholdPercent <= 0 ||
    automatic.thresholdPercent >= 100 ||
    automatic.forceThresholdPercent <= 0 ||
    automatic.forceThresholdPercent >= 100 ||
    automatic.thresholdPercent >= automatic.forceThresholdPercent
  ) {
    return undefined;
  }
  return {
    permission:
      config.allowed === true
        ? config.agentRequestsRequireConfirmation
          ? "allowed"
          : "allowed-noconfirm"
        : "denied",
    automatic,
  };
}

export function resolveConfiguredPolicy(
  globalSettings: unknown,
  projectSettings: unknown,
  projectTrusted: boolean,
): ConfiguredPolicy {
  const global = readAgentRequestConfig(globalSettings, "global settings");
  const project = projectTrusted
    ? readAgentRequestConfig(projectSettings, "trusted project settings")
    : { kind: "absent" as const };
  if (global.kind === "invalid" || project.kind === "invalid") {
    return defaultConfiguredPolicy();
  }

  const merged = mergeConfiguredPolicy(
    global.kind === "valid" ? global.config : {},
    project.kind === "valid" ? project.config : {},
  );
  return policyFromConfig(merged) ?? defaultConfiguredPolicy();
}

function noConfirmAuthorizationLabel(
  authorization: NoConfirmAuthorization,
): string {
  if (authorization === "session-no-confirm") {
    return "live-session no-confirm permission";
  }
  if (authorization === "configured-no-confirm") {
    return "configured no-confirm permission";
  }
  if (authorization === "one-shot-no-confirm") {
    return "one-shot no-confirm permission";
  }
  if (authorization === "automatic-no-confirm") {
    return "automatic supercompact authorization";
  }
  return "prepared /supercompact run";
}

function noConfirmAuthorizationSubject(
  authorization: NoConfirmAuthorization,
): string {
  if (authorization === "session-no-confirm") {
    return "Explicit live-session no-confirm permission";
  }
  const label = noConfirmAuthorizationLabel(authorization);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
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
    render: (width: number) => {
      const maxWidth = Math.max(0, width);
      return lines.flatMap((line) =>
        line.split(/\r?\n/).map((part) => truncateToWidth(part, maxWidth, "")),
      );
    },
    invalidate: () => {},
  };
}

export function buildPreparationPrompt(
  extraContext: string,
  automatic = false,
  continuationOverride?: ContinuationAction,
): string {
  const emphasis = extraContext.trim()
    ? [
        "The user supplied this preparation context. Give it high priority within established authorization and scope:",
        "<preparation-context>",
        extraContext.trim(),
        "</preparation-context>",
      ].join("\n")
    : automatic
      ? "No extra preparation context was supplied."
      : "The user supplied no extra preparation context.";

  return [
    automatic
      ? "Automatic supercompact was triggered because context usage crossed a configured threshold; the user did not manually request this checkpoint. Perform a focused pre-compaction checkpoint for the active work. Do not describe it as user-requested, and do not compact immediately."
      : "Perform a focused pre-compaction checkpoint for the active work. Do not compact immediately.",
    ...(automatic
      ? [
          `This is a preparation checkpoint, not the canonical summary turn. Do not write a handoff, claim compaction is complete, or stop after describing the next action. When no user input is needed, finish by calling ${AGENT_TOOL_NAME} with the continuation decision and exact next action; prose alone does not complete preparation. If user input is required, ask the question and wait.`,
        ]
      : []),
    "Use the current conversation, relevant durable sources, and actual current state rather than relying on memory.",
    "Do not broaden the task, invent work, or turn this checkpoint into a broad audit or ceremonial report.",
    "",
    emphasis,
    ...(continuationOverride
      ? [
          "",
          `The user explicitly selected --${continuationOverride} for this run command. The continuation value is fixed and must not be changed by the agent. Call ${AGENT_TOOL_NAME} with continuation set to ${continuationOverride}.`,
        ]
      : []),
    "",
    "Refresh relevant context:",
    "- Re-read applicable plans, instructions, user-facing documentation, and directly referenced durable sources.",
    "- Compare those sources with actual scoped state and focused verification results when applicable.",
    "- Correct scoped staleness introduced by the active work while keeping durable information evergreen and free of transient or diary-style detail.",
    "",
    "Close the active boundary:",
    "- Review the current objective, explicit authorization boundaries, and established non-obvious constraints.",
    "- Identify incomplete requested work, required validation or persistence, blockers, unanswered questions, missing approvals, credentials, and decisions.",
    "- Finish only work that is already authorized, safe to complete, and needs no new user input. Verify or persist completed work when applicable and follow scoped session rules.",
    "- Resolve issues within existing authorization. Surface material blockers or decisions prominently; if user input is required, ask and wait without requesting supercompaction.",
    "- Distinguish real remaining work from optional improvements or speculative follow-ups.",
    "- Establish whether work should continue or stop after compaction. If continuing, identify one exact immediate next action that remains authorized and needs no additional input.",
    ...(automatic
      ? [
          "- Automatic supercompact was triggered by context usage and may have interrupted active work. Preserve momentum: choose continue when authorized work is clearly unfinished and can proceed without new user input, and preserve the active objective, constraints, progress, and one exact next action through compaction. Choose stop only when work is complete, blocked, awaiting user input or approval, or continuation would be unsafe or uncertain. Do not invent, broaden, or continue optional work merely to avoid stopping.",
        ]
      : []),
    "- Re-read changed material when applicable and make a final accuracy pass.",
    "",
    `When the boundary is clean and unambiguous, call ${AGENT_TOOL_NAME} with the expected continuation, exact next action, and any additional summary emphasis. ${automatic ? "Automatic supercompact authorization is already active; no confirmation dialog will open." : "An explicit /supercompact run is itself the authorization, so no confirmation dialog will open before native compaction begins. Agent-driven requests use their configured permission: the final confirmation dialog opens only when agentRequestsRequireConfirmation is true."}`,
    `Do not call ${AGENT_TOOL_NAME} merely because it is available; call it only after these checks are complete.`,
  ].join("\n");
}

export function buildDecisionPrompt(
  preparation?: ConfirmedPreparationContext,
  automaticForce = false,
  continuationOverride?: ContinuationAction,
): string {
  const preparationGuidance = preparation
    ? [
        preparation.authorization
          ? `${noConfirmAuthorizationSubject(preparation.authorization)} authorized this preparation outcome:`
          : "The user confirmed this preparation outcome:",
        `<authorized-preparation>`,
        `Expected continuation: ${preparation.expectedContinuation}`,
        `Exact next action: ${preparation.nextAction}`,
        `</authorized-preparation>`,
        preparation.expectedContinuation === "stop"
          ? "The authorized stop is a hard constraint. The decision must be stop."
          : "The authorized continue permits continuation but does not force it. Choose stop if missing input, a blocker, completed work, or uncertainty makes continuation unsafe.",
      ].join("\n")
    : automaticForce
      ? "Automatic supercompact reached its force threshold. Choose continue only for clearly unfinished authorized work that can proceed without new user input; otherwise choose stop."
      : "No preparation outcome was supplied. Choose continue only when clearly unfinished authorized work can proceed without new user input; otherwise choose stop.";

  return [
    automaticForce
      ? "Automatic supercompact is recording its continuation decision before generating the canonical handoff."
      : "Record the continuation decision for supercompaction before generating the canonical handoff.",
    "Use the current conversation and established authorization boundaries. Do not invent, broaden, or continue optional work.",
    preparationGuidance,
    ...(continuationOverride
      ? [
          `The user explicitly selected --${continuationOverride} for this force command. The continuation value is fixed and must not be changed by the agent. Call ${DECISION_TOOL_NAME} with continuation set to ${continuationOverride}.`,
        ]
      : []),
    "This is a decision-only turn. Do not write prose, call any other tool, or perform any other work.",
    `Call ${DECISION_TOOL_NAME} exactly once with continuation set to ${continuationOverride ?? "continue or stop"}.`,
  ].join("\n\n");
}

export function buildSummaryPrompt(
  extraContext: string,
  preparation?: ConfirmedPreparationContext,
  automaticForce = false,
  continuation?: ContinuationAction,
): string {
  const emphasis = preparation
    ? [
        preparation.authorization
          ? `${noConfirmAuthorizationSubject(preparation.authorization)} authorized the following preparation outcome immediately before this summary request:`
          : "The user confirmed the following preparation outcome immediately before this summary request:",
        "<authorized-preparation>",
        `Authorization: ${preparation.authorization ? noConfirmAuthorizationLabel(preparation.authorization) : "final user confirmation"}`,
        `Expected continuation: ${preparation.expectedContinuation}`,
        `Exact next action: ${preparation.nextAction}`,
        ...(preparation.runExtraContext
          ? [
              `Original /supercompact run context: ${preparation.runExtraContext}`,
            ]
          : []),
        ...(preparation.agentExtraContext
          ? [
              `${preparation.authorization ? `Agent-supplied summary emphasis authorized under ${noConfirmAuthorizationLabel(preparation.authorization)}` : "Agent-supplied summary emphasis confirmed by the user"}: ${preparation.agentExtraContext}`,
            ]
          : []),
        "</authorized-preparation>",
        preparation.expectedContinuation === "stop"
          ? `${preparation.authorization ? "The authorized stop" : "The user-confirmed stop"} is a hard constraint. Preserve the recorded continuation decision as stop.`
          : `Preserve the ${preparation.authorization ? "authorized" : "confirmed"} intent and exact next action in the canonical handoff.`,
        ...(continuation
          ? [`Recorded continuation decision: ${continuation}.`]
          : []),
      ].join("\n")
    : automaticForce
      ? `Automatic supercompact reached its force threshold. No user supplied extra context or confirmed a preparation outcome. Preserve the active objective, constraints, progress, and one exact next action through compaction. The recorded continuation decision is ${continuation ?? "already established"}; do not change it. Do not invent, broaden, or continue optional work merely to avoid stopping.`
      : extraContext.trim()
        ? [
            "The user supplied the following extra context. Give it high priority when shaping the summary within the recorded continuation decision and established scope:",
            "<extra-context>",
            extraContext.trim(),
            "</extra-context>",
          ].join("\n")
        : "The user supplied no extra context.";

  return [
    "Prepare the canonical working-memory handoff for this session before context compaction.",
    "Use the entire conversation context currently available to you, including relevant earlier summaries and user-provided state.",
    `The continuation decision has already been recorded${continuation ? ` as ${continuation}` : ""}. Do not change it or call any tool. Only produce the requested handoff.`,
    "Do not modify files, continue the task, or answer questions from the conversation. Emit only the requested non-empty Markdown handoff.",
    "",
    emphasis,
    "",
    "Prioritize current actionable state over closed history. Use the following section order. Omit sections that have no useful content, except Next action, which is required and must be last:",
    "- Current objective",
    "- Current direction and authorization boundaries",
    "- Current state",
    "- Open decisions or blockers",
    "- Relevant resources by work horizon",
    "- Verified results",
    "- Reported or unverified information",
    "- Completed work, compressed to outcomes and material rationale",
    "- Next action",
    "",
    "Separate durable facts and verified results from mutable observations, unverified information, and future instructions.",
    "Mutable observations include repository state, installed software, executor availability, external services, and other facts that may change. Include them only when they affect continuation, state when they were observed when useful, and require revalidation only when the next action depends on them.",
    "When direction changed during the conversation, state the current direction. Mention an older direction only when doing so prevents incorrect continuation, and clearly state that it no longer applies.",
    "Preserve non-obvious constraints that materially affect how unfinished work must be performed, including explicit prohibitions, source-of-truth or responsibility decisions, and the rationale that makes them actionable. Include only constraints established in the conversation; do not infer new ones.",
    "Organize relevant resources under only the useful work-horizon tiers: Needed now, Needed for confirmed upcoming work, and Durable references. Omit empty tiers. For each resource, identify it precisely and give a short reason it matters; include exact file paths when files materially affect continuation. Do not report historical read status, reproduce a mechanical ledger, or imply that every listed resource must be read immediately. Keep the section focused and explicitly non-exhaustive.",
    "End with a Next action section naming one immediate action, its owner when known, and any approval or input required before it can begin. If no work is authorized, the next action is to wait for the user. Do not place any content after this section.",
    "Use only known facts. Clearly qualify reported or unverified information. Prefer compact headings, bullets, and concrete paths. Refer to the user in the third person.",
    "Do not include commit hashes, blob hashes, forensic provenance identifiers, diary-style narration, or detailed closed history that does not affect continuation.",
    "",
    "Preserve the recorded continuation decision conservatively in the handoff. The decision authorizes or prohibits post-compaction behavior; it does not require inventing work or broadening scope.",
    "Write the handoff as ordinary Markdown with no wrapper, code fence, preamble, or trailing commentary.",
    "Do not call any tools or emit commentary outside the Markdown handoff.",
  ].join("\n");
}

export function buildContinuationMessage(parsed: ParsedSuperSummary): string {
  const directive =
    parsed.action === "continue"
      ? "Continue the previously authorized incomplete work now. Use the summary as authoritative continuation context, do not repeat completed work, and do not merely acknowledge this message. Treat next actions as objectives subject to every recorded constraint, not as permission to broaden scope, move responsibilities, or duplicate an existing source of truth."
      : "Do not automatically continue prior work. Preserve this summary as context and wait for the user's next instruction.";
  const preparation = parsed.preparation
    ? [
        parsed.preparation.authorization
          ? "## Authorized preparation outcome"
          : "## Confirmed preparation outcome",
        "",
        parsed.preparation.authorization
          ? `- Authorization: ${noConfirmAuthorizationLabel(parsed.preparation.authorization)}`
          : `- User-confirmed expectation: ${parsed.preparation.expectedContinuation}`,
        ...(parsed.preparation.authorization
          ? [
              `- Authorized expectation: ${parsed.preparation.expectedContinuation}`,
            ]
          : []),
        `- Validated continuation: ${parsed.action}`,
        `- Proposed next action: ${parsed.preparation.nextAction}`,
        ...(parsed.preparation.runExtraContext
          ? [`- Preparation context: ${parsed.preparation.runExtraContext}`]
          : []),
        ...(parsed.preparation.agentExtraContext
          ? [
              `- Additional summary context: ${parsed.preparation.agentExtraContext}`,
            ]
          : []),
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
    "Resources in the summary are organized by when they are expected to matter. Treat them as focused references, not as proof of current state or instructions to inspect every resource. Read exact contents only when the active task requires them. Native compaction has removed the prior conversation from context; files read before compaction may no longer be in context. Re-read any file whose exact contents matter for the next action.",
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

function isDecisionRequestMessage(
  message: ContextMessage,
): message is CustomContextMessage & {
  customType: typeof DECISION_REQUEST_TYPE;
} {
  return (
    message.role === "custom" && message.customType === DECISION_REQUEST_TYPE
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

function normalizeConfirmationValue(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).join(" ");
}

export function previewConfirmationValue(value: string): string {
  const words = normalizeConfirmationValue(value).split(" ").filter(Boolean);
  const preview = words.slice(0, 10).join(" ");
  return words.length > 10 ? `${preview}…` : preview;
}

export function buildConfirmationText(
  preparation: ConfirmedPreparationContext,
): string {
  return [
    `Post-compaction behavior: ${preparation.expectedContinuation === "continue" ? "continue authorized work" : "stop and wait"}`,
    `Next action: ${previewConfirmationValue(preparation.nextAction)}`,
    ...(preparation.runExtraContext
      ? [
          `Preparation context: ${normalizeConfirmationValue(preparation.runExtraContext)}`,
        ]
      : []),
    ...(preparation.agentExtraContext
      ? [
          `Additional summary context: ${previewConfirmationValue(preparation.agentExtraContext)}`,
        ]
      : []),
    "Confirming will begin the canonical super-summary and native compaction immediately.",
  ].join("\n\n");
}

export default function supercompactExtension(pi: ExtensionAPI): void {
  pi.registerFlag("supercompact-auto", {
    type: "boolean",
    description: "Enable automatic supercompaction for this Pi process",
  });
  pi.registerFlag("no-supercompact-auto", {
    type: "boolean",
    description: "Disable automatic supercompaction for this Pi process",
  });

  pi.registerEntryRenderer(CONTINUATION_OUTCOME_ENTRY_TYPE, (entry) => {
    const message =
      isRecord(entry.data) && typeof entry.data.message === "string"
        ? entry.data.message
        : "";
    return staticComponent(message ? [message] : []);
  });

  let request: SupercompactRequest | undefined;
  let configuredPermission: ConfiguredPermission = "denied";
  let configuredAutomatic: AutomaticPolicy = {
    enabled: false,
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    forceThresholdPercent: DEFAULT_FORCE_THRESHOLD_PERCENT,
  };
  let sessionPermissionOverride: SessionPermissionOverride | undefined;
  let sessionAutomaticOverride: SessionAutomaticOverride | undefined;
  let softThresholdAttempted = false;
  let forceThresholdAttempted = false;
  let preparationGrant: PreparationGrant | undefined;
  let oneShotNoConfirmGrant: OneShotNoConfirmGrant | undefined;
  let confirmationId: string | undefined;
  let confirmationAbortController: AbortController | undefined;
  let confirmationRevoked = false;
  const abortedConfirmationIds = new Set<string>();
  const activeDecisionToolCallIds = new Set<string>();

  const effectivePermission = (): AgentPermission =>
    sessionPermissionOverride ?? configuredPermission;

  const cliAutomaticOverride = (): boolean | undefined => {
    const enabled = pi.getFlag("supercompact-auto") === true;
    const disabled = pi.getFlag("no-supercompact-auto") === true;
    if (disabled) return false;
    return enabled ? true : undefined;
  };

  const automaticEnabled = (): boolean =>
    sessionAutomaticOverride ??
    cliAutomaticOverride() ??
    configuredAutomatic.enabled;

  const resetAutomaticThresholds = (): void => {
    softThresholdAttempted = false;
    forceThresholdAttempted = false;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const status =
      confirmationId && !confirmationRevoked
        ? "Supercompact: awaiting confirmation 🗜️ "
        : preparationGrant && !preparationGrant.consumed
          ? "Supercompact: preparing 🗜️ "
          : oneShotNoConfirmGrant
            ? "Supercompact: agent-driven-allow-once 🗜️ "
            : sessionPermissionOverride === "allowed-noconfirm"
              ? "Supercompact: agent-driven-allow 🗜️ "
              : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const persistSessionPermissionOverride = (): void => {
    if (!sessionPermissionOverride) return;
    pi.appendEntry<SessionPermissionEntryData>(SESSION_PERMISSION_ENTRY_TYPE, {
      permission: sessionPermissionOverride,
    });
  };

  const persistSessionAutomaticOverride = (): void => {
    if (sessionAutomaticOverride === undefined) return;
    pi.appendEntry<SessionAutomaticEntryData>(SESSION_AUTOMATIC_ENTRY_TYPE, {
      enabled: sessionAutomaticOverride,
    });
  };

  const restoreSessionPermissionOverride = (
    ctx: ExtensionContext,
  ): SessionPermissionOverride | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (
        entry?.type !== "custom" ||
        entry.customType !== SESSION_PERMISSION_ENTRY_TYPE
      ) {
        continue;
      }

      if (!isRecord(entry.data)) return "denied";
      const permission = entry.data.permission;
      return permission === "allowed-noconfirm" || permission === "denied"
        ? permission
        : "denied";
    }
    return undefined;
  };

  const restoreSessionAutomaticOverride = (
    ctx: ExtensionContext,
  ): SessionAutomaticOverride | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (
        entry?.type !== "custom" ||
        entry.customType !== SESSION_AUTOMATIC_ENTRY_TYPE
      ) {
        continue;
      }
      if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") {
        return undefined;
      }
      return entry.data.enabled;
    }
    return undefined;
  };

  const unavailableTools = (toolNames: string[]): string[] => {
    const activeTools = pi.getActiveTools();
    return toolNames.filter((toolName) => !activeTools.includes(toolName));
  };

  const unavailableToolsMessage = (toolNames: string[]): string | undefined => {
    const missing = unavailableTools(toolNames);
    if (missing.length === 0) return undefined;

    const descriptions = missing.map((toolName) =>
      toolName === DECISION_TOOL_NAME
        ? `the internal decision tool ${DECISION_TOOL_NAME}`
        : `the public request tool ${AGENT_TOOL_NAME}`,
    );
    return `Supercompaction cannot start because ${descriptions.join(" and ")} ${missing.length === 1 ? "is" : "are"} unavailable in the current Pi tool selection. Re-enable ${missing.length === 1 ? "it" : "them"} or reload with the extension tools available.`;
  };

  const withNoAutomaticRetry = (message: string): string =>
    /(?:no automatic retry|do not retry automatically)/i.test(message)
      ? message
      : `${message.replace(/[.\s]+$/, "")}. No automatic retry will occur.`;

  const loadConfiguredPolicy = (ctx: ExtensionContext): ConfiguredPolicy => {
    const projectTrusted = ctx.isProjectTrusted();
    let manager: SettingsManager;
    try {
      manager = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(
        ctx,
        `Ignoring invalid supercompact config: unable to load settings (${message})`,
        "warning",
      );
      return defaultConfiguredPolicy();
    }
    const settingsErrors = manager.drainErrors();
    if (settingsErrors.length > 0) {
      for (const settingsError of settingsErrors) {
        const path =
          settingsError.scope === "global"
            ? join(getAgentDir(), SETTINGS_FILE_NAME)
            : join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME);
        const message =
          settingsError.error instanceof Error
            ? settingsError.error.message
            : String(settingsError.error);
        notify(
          ctx,
          `Ignoring invalid supercompact config at ${path}: unable to load settings (${message})`,
          "warning",
        );
      }
      return defaultConfiguredPolicy();
    }

    const globalSettings = manager.getGlobalSettings();
    const projectSettings = manager.getProjectSettings();
    const globalResult = readAgentRequestConfig(
      globalSettings,
      "global settings.pi-supercompact",
    );
    const projectResult = projectTrusted
      ? readAgentRequestConfig(
          projectSettings,
          "trusted project settings.pi-supercompact",
        )
      : { kind: "absent" as const };

    for (const [scope, result] of [
      ["global", globalResult],
      ["trusted project", projectResult],
    ] as const) {
      if (result.kind === "invalid") {
        const path =
          scope === "global"
            ? join(getAgentDir(), SETTINGS_FILE_NAME)
            : join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME);
        notify(
          ctx,
          `Ignoring invalid supercompact config at ${path}: ${result.error}`,
          "warning",
        );
      }
    }

    if (globalResult.kind === "invalid" || projectResult.kind === "invalid") {
      return defaultConfiguredPolicy();
    }

    const merged = mergeConfiguredPolicy(
      globalResult.kind === "valid" ? globalResult.config : {},
      projectResult.kind === "valid" ? projectResult.config : {},
    );
    const policy = policyFromConfig(merged);
    if (!policy) {
      const path =
        projectResult.kind === "valid"
          ? join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME)
          : join(getAgentDir(), SETTINGS_FILE_NAME);
      notify(
        ctx,
        `Ignoring invalid supercompact config at ${path}: ${INVALID_THRESHOLDS_MESSAGE}`,
        "warning",
      );
      return defaultConfiguredPolicy();
    }
    return policy;
  };

  const applyConfiguredPolicy = (ctx: ExtensionContext): void => {
    const policy = loadConfiguredPolicy(ctx);
    configuredPermission = policy.permission;
    configuredAutomatic = policy.automatic;
  };

  const clearDecisionState = (ctx?: ExtensionContext): void => {
    activeDecisionToolCallIds.clear();
    if (ctx) setWorkingMessage(ctx);
  };

  const clearConsumedPreparation = (): void => {
    if (preparationGrant?.consumed) preparationGrant = undefined;
  };

  const cancelPreNativeWorkflow = (ctx: ExtensionContext): boolean => {
    if (
      request &&
      (request.phase === "compacting" || request.compactionCompleted)
    ) {
      return false;
    }
    if (!request && !preparationGrant) return false;

    request = undefined;
    preparationGrant = undefined;
    clearDecisionState(ctx);
    updateStatus(ctx);
    return true;
  };

  const fail = (ctx: ExtensionContext, message: string): void => {
    clearDecisionState(ctx);
    request = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    clearConsumedPreparation();
    updateStatus(ctx);
    notify(
      ctx,
      `Supercompact failed: ${withNoAutomaticRetry(message)}`,
      "error",
    );
  };

  pi.registerTool({
    name: DECISION_TOOL_NAME,
    label: "Supercompact Decision",
    description:
      "Internal continuation marker for the dedicated decision turn; call only when requested, otherwise ignored.",
    parameters: DecisionParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (request?.phase !== "awaiting-decision") {
        return {
          content: [],
          details: { ignored: true },
        };
      }
      if (!request.currentBatchValid) {
        throw new Error(
          `Call ${DECISION_TOOL_NAME} exactly once in the decision-only response and do not call any other tool.`,
        );
      }
      if (
        request.continuationOverride &&
        params.continuation !== request.continuationOverride
      ) {
        throw explicitContinuationError(request.continuationOverride);
      }
      if (
        request.preparation?.expectedContinuation === "stop" &&
        params.continuation === "continue"
      ) {
        throw new Error(
          "The authorized stop is a hard constraint. Correct the decision to stop; continuation is not authorized.",
        );
      }

      request.action = params.continuation;
      request.continuationOverride = undefined;
      request.phase = "decision-ready";
      request.attempts = 0;
      clearDecisionState(ctx);

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
    renderResult(result, _options, _theme, context) {
      if (!context.isError) return staticComponent([]);
      const message =
        isRecord(result) && Array.isArray(result.content)
          ? result.content
              .filter(
                (part): part is { type: "text"; text: string } =>
                  isRecord(part) &&
                  part.type === "text" &&
                  typeof part.text === "string",
              )
              .map((part) => part.text)
              .join(" ")
              .trim()
          : "";
      return staticComponent([
        message ||
          "Continuation metadata was invalid; correct it as instructed.",
      ]);
    },
  });

  const beginSupercompact = (
    extraContext: string,
    preparation: ConfirmedPreparationContext | undefined,
    ctx: ExtensionContext,
    automaticForce = false,
    continuationOverride?: ContinuationAction,
  ): { started: true } | { started: false; reason: string } => {
    if (request) {
      return {
        started: false,
        reason:
          "Supercompaction is already in progress. Do not submit another request; wait for the existing workflow to settle.",
      };
    }

    const unavailable = unavailableToolsMessage(
      preparation ? [] : [DECISION_TOOL_NAME],
    );
    if (unavailable) {
      return { started: false, reason: unavailable };
    }

    const idle = ctx.isIdle();
    const id = createId();
    const prepared = preparation !== undefined;
    request = {
      id,
      phase: prepared ? "queued-summary" : "queued-decision",
      compactionCompleted: false,
      attempts: 0,
      currentBatchValid: false,
      extraContext: extraContext.trim(),
      automaticForce,
      preparation,
      ...(continuationOverride ? { continuationOverride } : {}),
      ...(prepared ? { action: preparation.expectedContinuation } : {}),
    };

    if (preparationGrant && preparation) preparationGrant.consumed = true;
    updateStatus(ctx);

    const continuationNotice = continuationOverride
      ? continuationOverrideNotification(continuationOverride)
      : undefined;
    const extraInstructions = extraContext
      ? `Extra instructions: ${extraContext}`
      : undefined;
    if (!idle) {
      notify(
        ctx,
        [
          "Supercompaction queued; finishing the current tool batch first.",
          ...(continuationNotice ? [continuationNotice] : []),
          ...(extraInstructions ? [extraInstructions] : []),
        ].join("\n"),
      );
    } else if (continuationNotice || extraInstructions) {
      notify(
        ctx,
        [
          ...(continuationNotice ? [continuationNotice] : []),
          ...(extraInstructions ? [extraInstructions] : []),
        ].join("\n"),
      );
    }

    try {
      pi.sendMessage(
        prepared
          ? {
              customType: SUMMARY_REQUEST_TYPE,
              content: buildSummaryPrompt(
                extraContext,
                preparation,
                automaticForce,
                preparation.expectedContinuation,
              ),
              display: false,
              details: { version: 4, requestId: id },
            }
          : {
              customType: DECISION_REQUEST_TYPE,
              content: buildDecisionPrompt(
                preparation,
                automaticForce,
                continuationOverride,
              ),
              display: false,
              details: { version: 4, requestId: id },
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
      updateStatus(ctx);
      return {
        started: false,
        reason: `Supercompact failed: ${withNoAutomaticRetry(error instanceof Error ? error.message : String(error))}`,
      };
    }
  };

  const queueSummary = (ctx: ExtensionContext): void => {
    if (!request || request.phase !== "decision-ready" || !request.action) {
      return;
    }

    const id = request.id;
    request.phase = "queued-summary";
    request.currentBatchValid = false;
    notify(ctx, "Creating super-summary.");

    try {
      pi.sendMessage(
        {
          customType: SUMMARY_REQUEST_TYPE,
          content: buildSummaryPrompt(
            request.extraContext,
            request.preparation,
            request.automaticForce,
            request.action,
          ),
          display: false,
          details: { version: 4, requestId: id },
        },
        ctx.isIdle()
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "steer" },
      );
    } catch (error) {
      fail(ctx, error instanceof Error ? error.message : String(error));
    }
  };

  const startCompaction = (ctx: ExtensionContext): void => {
    if (
      !request ||
      request.phase !== "summary-ready" ||
      !request.action ||
      !request.summary
    ) {
      return;
    }

    request.phase = "compacting";
    request.continuationOverride = undefined;
    setWorkingMessage(ctx);
    const outcomeMessage =
      request.action === "continue"
        ? "Super-summary prepared. After compaction, the agent will continue working."
        : "Super-summary prepared. After compaction, the agent will wait for further instructions before proceeding.";
    pi.appendEntry(CONTINUATION_OUTCOME_ENTRY_TYPE, {
      continuation: request.action,
      message: outcomeMessage,
    });

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
    updateStatus(ctx);

    const message = {
      customType: CONTEXT_MESSAGE_TYPE,
      content,
      display: false,
      details: {
        version: 3,
        continuation: parsed.action,
        summary: parsed.summary,
        preparation: parsed.preparation,
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

  const resolveAuthorization = (): {
    permission: AgentPermission;
    grantId?: string;
    oneShotGrantId?: string;
    noConfirmAuthorization?: NoConfirmAuthorization;
  } => {
    if (oneShotNoConfirmGrant) {
      return {
        permission: "allowed-noconfirm",
        oneShotGrantId: oneShotNoConfirmGrant.id,
        noConfirmAuthorization: "one-shot-no-confirm",
      };
    }

    const grant =
      preparationGrant &&
      !preparationGrant.consumed &&
      !preparationGrant.revoked
        ? preparationGrant
        : undefined;

    if (grant) {
      return {
        permission: "allowed-noconfirm",
        grantId: grant.id,
        noConfirmAuthorization:
          grant.origin === "automatic"
            ? "automatic-no-confirm"
            : "prepared-no-confirm",
      };
    }
    if (sessionPermissionOverride === "allowed-noconfirm") {
      return {
        permission: "allowed-noconfirm",
        noConfirmAuthorization: "session-no-confirm",
      };
    }
    const permission = effectivePermission();
    if (permission === "allowed-noconfirm") {
      return {
        permission,
        noConfirmAuthorization: "configured-no-confirm",
      };
    }
    return { permission };
  };

  pi.registerTool({
    name: AGENT_TOOL_NAME,
    label: "Supercompact",
    description:
      "Request supercompaction after preparation: refresh durable context, finish or preserve authorized work, surface blockers, choose continue or stop, and give one exact next action. Availability is not authorization. Call after /supercompact preparation or when agent-driven permission may exist; explicit /supercompact runs need no confirmation, while configured agent-driven requests may require it. Do not retry denied, declined, revoked, busy, unavailable, or confirmation-required headless requests.",
    parameters: AgentToolParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (request) {
        throw new Error(
          "Supercompaction is already in progress. Do not submit another request; wait for the existing workflow to settle.",
        );
      }
      if (confirmationId) {
        throw new Error(
          "A supercompact confirmation is already awaiting the user's response. Do not open or retry another request; wait for the result.",
        );
      }

      const authorization = resolveAuthorization();
      if (authorization.permission === "denied") {
        throw new Error(
          sessionPermissionOverride === "denied"
            ? "The user explicitly denied agent-driven supercompaction requests for this live session. Only the user can reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once. Do not retry automatically; wait for the user."
            : "Agent-driven supercompaction is not authorized. The user must run /supercompact run for a prepared one-off request, /supercompact agent-driven-allow for live-session permission, or /supercompact agent-driven-allow-once for one request. Do not retry automatically; wait for the user.",
        );
      }
      const bypassConfirmation =
        authorization.permission === "allowed-noconfirm";
      if (!ctx.hasUI && !bypassConfirmation) {
        throw new Error(
          "Agent-driven supercompaction requires TUI or RPC confirmation because agentRequestsRequireConfirmation is enabled. The user must invoke /supercompact force explicitly, configure agentRequestsRequireConfirmation as false, or use /supercompact agent-driven-allow or /supercompact agent-driven-allow-once. Do not retry automatically.",
        );
      }

      const nextAction = params.nextAction.trim();
      if (!nextAction) {
        throw new Error(
          "Supply one concrete next action, or explicitly state that the agent will wait for the user.",
        );
      }
      const grantId = authorization.grantId;
      const oneShotGrantId = authorization.oneShotGrantId;
      const grantContinuationOverride =
        grantId && preparationGrant?.id === grantId
          ? preparationGrant.continuationOverride
          : undefined;
      if (
        grantContinuationOverride &&
        params.continuation !== grantContinuationOverride
      ) {
        throw explicitContinuationError(grantContinuationOverride);
      }
      const preparation: ConfirmedPreparationContext = {
        ...(authorization.noConfirmAuthorization
          ? { authorization: authorization.noConfirmAuthorization }
          : {}),
        expectedContinuation: params.continuation,
        nextAction,
        ...(grantId && preparationGrant?.extraContext
          ? { runExtraContext: preparationGrant.extraContext }
          : {}),
        ...(params.extraContext?.trim()
          ? { agentExtraContext: params.extraContext.trim() }
          : {}),
      };

      if (bypassConfirmation) {
        const currentAuthorization = resolveAuthorization();
        if (
          currentAuthorization.permission !== "allowed-noconfirm" ||
          currentAuthorization.grantId !== grantId ||
          currentAuthorization.oneShotGrantId !== oneShotGrantId ||
          currentAuthorization.noConfirmAuthorization !==
            authorization.noConfirmAuthorization
        ) {
          throw new Error(
            "Supercompaction authorization expired before execution began. Do not retry automatically; wait for the user to reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once.",
          );
        }

        const result = beginSupercompact("", preparation, ctx);
        if (!result.started) {
          if (grantId && preparationGrant?.id === grantId) {
            preparationGrant = undefined;
          }
          updateStatus(ctx);
          throw new Error(result.reason);
        }

        if (grantId && preparationGrant?.id === grantId) {
          preparationGrant.continuationOverride = undefined;
        }
        if (oneShotGrantId && oneShotNoConfirmGrant?.id === oneShotGrantId) {
          oneShotNoConfirmGrant = undefined;
          updateStatus(ctx);
        }

        const authorizationSubject = noConfirmAuthorizationSubject(
          authorization.noConfirmAuthorization!,
        );
        notify(
          ctx,
          `Supercompaction is proceeding: ${noConfirmAuthorizationLabel(authorization.noConfirmAuthorization!)}.`,
        );
        return {
          content: [
            {
              type: "text",
              text: `${authorizationSubject} authorized this request. Canonical summary and native compaction were queued without a confirmation dialog.`,
            },
          ],
          details: {
            status: "queued",
            authorization: authorization.noConfirmAuthorization,
            continuation: preparation.expectedContinuation,
            nextAction: preparation.nextAction,
          },
        };
      }

      const currentConfirmationId = createId();
      const currentConfirmationAbortController = new AbortController();
      confirmationId = currentConfirmationId;
      confirmationAbortController = currentConfirmationAbortController;
      confirmationRevoked = false;
      updateStatus(ctx);

      const dialogSignal = signal
        ? AbortSignal.any([signal, currentConfirmationAbortController.signal])
        : currentConfirmationAbortController.signal;
      let confirmed: boolean;
      try {
        confirmed = await ctx.ui.confirm(
          "Confirm agent-driven supercompaction",
          buildConfirmationText(preparation),
          { signal: dialogSignal },
        );
      } catch {
        const aborted = abortedConfirmationIds.delete(currentConfirmationId);
        const revoked =
          !aborted &&
          (confirmationId !== currentConfirmationId || confirmationRevoked);
        if (confirmationId === currentConfirmationId) {
          confirmationId = undefined;
          confirmationAbortController = undefined;
          confirmationRevoked = false;
          if (grantId && preparationGrant?.id === grantId) {
            preparationGrant = undefined;
          }
          updateStatus(ctx);
          notify(
            ctx,
            revoked
              ? "Supercompaction authorization was revoked."
              : aborted
                ? "Supercompaction was aborted."
                : "Supercompaction confirmation was canceled.",
            "warning",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: revoked
                ? "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for the user to reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once."
                : aborted
                  ? "Supercompaction was aborted before native compaction began. Wait for user direction."
                  : "Supercompaction confirmation was canceled. Do not retry automatically; wait for user direction.",
            },
          ],
          details: {
            status: revoked ? "revoked" : aborted ? "aborted" : "canceled",
          },
        };
      }

      if (confirmationId !== currentConfirmationId) {
        const aborted = abortedConfirmationIds.delete(currentConfirmationId);
        return {
          content: [
            {
              type: "text",
              text: aborted
                ? "Supercompaction was aborted before native compaction began. Wait for user direction."
                : "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for the user to reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once.",
            },
          ],
          details: { status: aborted ? "aborted" : "revoked" },
        };
      }
      if (confirmationRevoked) {
        confirmationId = undefined;
        confirmationAbortController = undefined;
        confirmationRevoked = false;
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text",
              text: "Supercompaction authorization was revoked while confirmation was open. Do not retry automatically; wait for the user to reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once.",
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
        updateStatus(ctx);
        notify(ctx, "Agent-driven supercompaction was declined.", "warning");
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
        effectivePermission() !== "denied" ||
        Boolean(
          grantId &&
          preparationGrant?.id === grantId &&
          !preparationGrant.consumed &&
          !preparationGrant.revoked,
        );
      if (!stillAuthorized) {
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text",
              text: "Supercompaction authorization expired before confirmation completed. Do not retry automatically; wait for the user to reauthorize with /supercompact run, /supercompact agent-driven-allow, or /supercompact agent-driven-allow-once.",
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
        updateStatus(ctx);
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

  const setAutomaticMode = (
    enabled: SessionAutomaticOverride,
    ctx: ExtensionContext,
  ): void => {
    if (sessionAutomaticOverride === enabled) {
      notify(
        ctx,
        `Automatic supercompact is already ${enabled ? "enabled" : "disabled"} for this live session.`,
      );
      return;
    }
    sessionAutomaticOverride = enabled;
    persistSessionAutomaticOverride();
    notify(
      ctx,
      `Automatic supercompact is ${enabled ? "enabled" : "disabled"} for this live session.`,
    );
  };

  pi.on("session_start", (event, ctx) => {
    const canceledPreparation = Boolean(
      (preparationGrant && !preparationGrant.consumed) || confirmationId,
    );
    const canceledOneShotPermission = Boolean(oneShotNoConfirmGrant);
    clearDecisionState(ctx);
    request = undefined;
    preparationGrant = undefined;
    oneShotNoConfirmGrant = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    abortedConfirmationIds.clear();
    sessionPermissionOverride =
      event.reason === "reload"
        ? restoreSessionPermissionOverride(ctx)
        : undefined;
    sessionAutomaticOverride =
      event.reason === "reload"
        ? restoreSessionAutomaticOverride(ctx)
        : undefined;
    resetAutomaticThresholds();
    applyConfiguredPolicy(ctx);
    if (
      pi.getFlag("supercompact-auto") === true &&
      pi.getFlag("no-supercompact-auto") === true
    ) {
      notify(
        ctx,
        "Both --supercompact-auto and --no-supercompact-auto were supplied; automatic supercompact is disabled.",
        "warning",
      );
    }
    updateStatus(ctx);
    if (canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
    if (canceledOneShotPermission) {
      notify(ctx, "Pending one-shot agent-driven permission was canceled.");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const canceledPreparation = Boolean(
      (preparationGrant && !preparationGrant.consumed) || confirmationId,
    );
    const canceledOneShotPermission = Boolean(oneShotNoConfirmGrant);
    clearDecisionState(ctx);
    request = undefined;
    preparationGrant = undefined;
    oneShotNoConfirmGrant = undefined;
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    abortedConfirmationIds.clear();
    sessionPermissionOverride = undefined;
    sessionAutomaticOverride = undefined;
    resetAutomaticThresholds();
    applyConfiguredPolicy(ctx);
    updateStatus(ctx);
    if (canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
    if (canceledOneShotPermission) {
      notify(ctx, "Pending one-shot agent-driven permission was canceled.");
    }
  });

  pi.on("context", (event) => {
    const activeDecisionRequestId =
      request?.phase === "queued-decision" ||
      request?.phase === "awaiting-decision"
        ? request.id
        : undefined;
    const activeSummaryRequestId =
      request?.phase === "queued-summary" ||
      request?.phase === "awaiting-summary"
        ? request.id
        : undefined;
    const activePreparationId =
      preparationGrant && !preparationGrant.consumed && !request
        ? preparationGrant.id
        : undefined;
    const preserveActiveDecisionArtifacts =
      request?.phase === "awaiting-decision";

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

      if (isDecisionRequestMessage(message)) {
        if (requestIdFromDetails(message.details) === activeDecisionRequestId) {
          messages.push(message);
        } else {
          changed = true;
        }
        return;
      }

      if (isSummaryRequestMessage(message)) {
        if (requestIdFromDetails(message.details) === activeSummaryRequestId) {
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
    if (request?.phase === "awaiting-decision") {
      if (event.toolName === DECISION_TOOL_NAME && request.currentBatchValid) {
        return;
      }

      return {
        block: true,
        reason:
          event.toolName === DECISION_TOOL_NAME
            ? `Call ${DECISION_TOOL_NAME} exactly once in the decision-only response and do not emit prose or call other tools.`
            : `Tools other than ${DECISION_TOOL_NAME} are disabled while recording the supercompact continuation decision.`,
      };
    }

    if (request?.phase === "awaiting-summary") {
      return {
        block: true,
        reason:
          "Tools are disabled while writing the canonical supercompact Markdown handoff. Emit only the non-empty handoff.",
      };
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!automaticEnabled()) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null) return;

    if (usage.percent < configuredAutomatic.thresholdPercent) {
      resetAutomaticThresholds();
      return;
    }

    const forceReached =
      usage.percent >= configuredAutomatic.forceThresholdPercent;
    if (
      request ||
      confirmationId ||
      oneShotNoConfirmGrant ||
      (preparationGrant && preparationGrant.origin !== "automatic")
    ) {
      if (forceReached) {
        softThresholdAttempted = true;
        forceThresholdAttempted = true;
      } else {
        softThresholdAttempted = true;
      }
      return;
    }

    if (forceReached && !forceThresholdAttempted) {
      softThresholdAttempted = true;
      forceThresholdAttempted = true;
      startForce("", ctx, true);
      return;
    }

    if (!softThresholdAttempted) {
      softThresholdAttempted = true;
      startPreparation("", ctx, true);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (
      event.message.role === "assistant" &&
      event.message.stopReason === "aborted"
    ) {
      if (cancelPreNativeWorkflow(ctx)) {
        notify(
          ctx,
          "Supercompaction was aborted before native compaction began.",
          "warning",
        );
      }
      return;
    }

    if (!request) return;

    if (
      event.message.role === "custom" &&
      event.message.customType === DECISION_REQUEST_TYPE &&
      requestIdFromDetails(event.message.details) === request.id
    ) {
      request.phase = "awaiting-decision";
      setWorkingMessage(ctx, "Beginning supercompaction...");
      return;
    }

    if (
      (request.phase === "queued-summary" ||
        request.phase === "awaiting-summary") &&
      event.message.role === "custom" &&
      event.message.customType === SUMMARY_REQUEST_TYPE &&
      requestIdFromDetails(event.message.details) === request.id
    ) {
      request.phase = "awaiting-summary";
      setWorkingMessage(ctx, "Summarizing…");
      return;
    }

    if (
      (request.phase !== "awaiting-decision" &&
        request.phase !== "awaiting-summary") ||
      event.message.role !== "assistant"
    ) {
      return;
    }

    request.attempts += 1;

    if (
      event.message.stopReason === "error" ||
      event.message.stopReason === "length"
    ) {
      request.currentBatchValid = false;
      return;
    }
    const assistantText = textFromAssistant(event.message);
    const toolCalls = toolCallsFromAssistant(event.message);

    if (request.phase === "awaiting-decision") {
      for (const toolCall of toolCalls) {
        if (toolCall.name === DECISION_TOOL_NAME) {
          activeDecisionToolCallIds.add(toolCall.id);
        }
      }
      request.currentBatchValid =
        toolCalls.length === 1 && toolCalls[0].name === DECISION_TOOL_NAME;
      return;
    }

    if (!request.summary && assistantText && toolCalls.length === 0) {
      request.summary = assistantText;
    }
    request.currentBatchValid =
      assistantText.length > 0 && toolCalls.length === 0;
  });

  pi.on("session_compact", (_event, ctx) => {
    resetAutomaticThresholds();
    if (request) {
      request.compactionCompleted = true;
      return;
    }
    if (
      preparationGrant?.origin === "automatic" &&
      !preparationGrant.consumed
    ) {
      preparationGrant = undefined;
      updateStatus(ctx);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!request) return;

    if (request.phase === "decision-ready") {
      queueSummary(ctx);
      return;
    }

    if (
      request.phase === "queued-decision" ||
      request.phase === "awaiting-decision"
    ) {
      if (
        request.phase === "awaiting-decision" &&
        request.attempts < MAX_WORKFLOW_ATTEMPTS
      ) {
        request.currentBatchValid = false;
        try {
          pi.sendMessage(
            {
              customType: DECISION_REQUEST_TYPE,
              content: request.continuationOverride
                ? `Call ${DECISION_TOOL_NAME} exactly once now with continuation set to ${request.continuationOverride}, as required by the explicit command flag. Emit no prose and call no other tool.`
                : `Call ${DECISION_TOOL_NAME} exactly once now with continuation set to continue or stop. Emit no prose and call no other tool.`,
              display: false,
              details: { version: 4, requestId: request.id, correction: true },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch (error) {
          fail(ctx, error instanceof Error ? error.message : String(error));
        }
        return;
      }

      clearDecisionState(ctx);
      return;
    }

    if (
      request.phase === "queued-summary" ||
      request.phase === "awaiting-summary"
    ) {
      if (
        request.phase === "awaiting-summary" &&
        request.summary &&
        request.currentBatchValid
      ) {
        request.phase = "summary-ready";
      } else if (
        request.phase === "awaiting-summary" &&
        request.attempts < MAX_WORKFLOW_ATTEMPTS
      ) {
        request.currentBatchValid = false;
        try {
          pi.sendMessage(
            {
              customType: SUMMARY_REQUEST_TYPE,
              content: request.summary
                ? "The Markdown super-summary has been captured. Do not repeat it. Emit no tools or additional commentary."
                : "Write the non-empty Markdown super-summary now. Emit no tools or additional commentary.",
              display: false,
              details: { version: 4, requestId: request.id, correction: true },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch (error) {
          fail(ctx, error instanceof Error ? error.message : String(error));
        }
        return;
      } else {
        clearDecisionState(ctx);
        return;
      }
    }

    if (request.phase === "summary-ready") startCompaction(ctx);
  });

  const clearOneShotNoConfirmGrant = (ctx: ExtensionContext): boolean => {
    if (!oneShotNoConfirmGrant) return false;
    oneShotNoConfirmGrant = undefined;
    updateStatus(ctx);
    return true;
  };

  const supersedeOneShotNoConfirmGrant = (ctx: ExtensionContext): void => {
    if (!clearOneShotNoConfirmGrant(ctx)) return;
    notify(ctx, "Pending one-shot agent-driven permission was canceled.");
  };

  const startPreparation = (
    extraContext: string,
    ctx: ExtensionContext,
    automatic = false,
    continuationOverride?: ContinuationAction,
  ): void => {
    if (!automatic) supersedeOneShotNoConfirmGrant(ctx);
    if (request || confirmationId || preparationGrant) {
      notify(
        ctx,
        "A supercompact preparation, confirmation, or compaction is already active.",
        "warning",
      );
      return;
    }

    const unavailable = unavailableToolsMessage([AGENT_TOOL_NAME]);
    if (unavailable) {
      notify(ctx, unavailable, "error");
      return;
    }

    const idle = ctx.isIdle();
    const id = createId();
    preparationGrant = {
      id,
      extraContext: extraContext.trim(),
      origin: automatic ? "automatic" : "explicit",
      consumed: false,
      revoked: false,
      ...(continuationOverride ? { continuationOverride } : {}),
    };
    updateStatus(ctx);

    const notification = automatic
      ? idle
        ? "Automatic pre-compaction wrap started."
        : "Automatic pre-compaction wrap queued; finishing the current tool batch first."
      : idle
        ? "Pre-compaction wrap started."
        : "Pre-compaction wrap queued; finishing the current tool batch first.";
    notify(
      ctx,
      [
        notification,
        ...(continuationOverride
          ? [continuationOverrideNotification(continuationOverride)]
          : []),
        ...(extraContext.trim()
          ? [`Extra instructions: ${extraContext.trim()}`]
          : []),
      ].join("\n"),
    );

    try {
      pi.sendMessage(
        {
          customType: PREPARATION_REQUEST_TYPE,
          content: buildPreparationPrompt(
            extraContext,
            automatic,
            continuationOverride,
          ),
          display: false,
          details: { version: 1, preparationId: id },
        },
        idle
          ? { triggerTurn: true, deliverAs: "steer" }
          : { deliverAs: "steer" },
      );
    } catch (error) {
      preparationGrant = undefined;
      updateStatus(ctx);
      notify(
        ctx,
        `Supercompact preparation failed: ${withNoAutomaticRetry(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
    }
  };

  const startForce = (
    extraContext: string,
    ctx: ExtensionContext,
    automatic = false,
    continuationOverride?: ContinuationAction,
  ): void => {
    if (!automatic) supersedeOneShotNoConfirmGrant(ctx);
    if (confirmationId) {
      notify(
        ctx,
        "Cannot force supercompaction while agent confirmation is open.",
        "warning",
      );
      return;
    }
    if (request) {
      notify(
        ctx,
        "Supercompaction is already in progress; wait for the existing workflow to settle.",
        "warning",
      );
      return;
    }

    const unavailable = unavailableToolsMessage([DECISION_TOOL_NAME]);
    if (unavailable) {
      notify(ctx, unavailable, "error");
      return;
    }

    if (preparationGrant && !preparationGrant.consumed) {
      if (preparationGrant.continuationOverride) {
        notify(
          ctx,
          "Cannot force supercompaction while flagged preparation is active; use /supercompact abort first.",
          "warning",
        );
        return;
      }
      if (!automatic || preparationGrant.origin === "automatic") {
        preparationGrant = undefined;
        updateStatus(ctx);
        notify(ctx, "Pending pre-compaction preparation was canceled.");
      } else {
        notify(
          ctx,
          "Cannot force automatic supercompaction while explicit preparation is active.",
          "warning",
        );
        return;
      }
    }

    const result = beginSupercompact(
      extraContext.trim(),
      undefined,
      ctx,
      automatic,
      continuationOverride,
    );
    if (result.started) return;
    notify(
      ctx,
      result.reason,
      result.reason.startsWith("Supercompact failed:") ? "error" : "warning",
    );
  };

  const notifyPermission = (ctx: ExtensionContext, message: string): void => {
    const unavailable = unavailableTools([AGENT_TOOL_NAME]);
    if (unavailable.length === 0) {
      notify(ctx, message);
      return;
    }

    notify(
      ctx,
      `${message} Execution remains unavailable until ${unavailable.join(" and ")} ${unavailable.length === 1 ? "is" : "are"} re-enabled in the current Pi tool selection.`,
      "warning",
    );
  };

  const allowAgentRequests = (ctx: ExtensionContext): void => {
    supersedeOneShotNoConfirmGrant(ctx);
    const alreadyAllowed = sessionPermissionOverride === "allowed-noconfirm";
    sessionPermissionOverride = "allowed-noconfirm";
    if (!alreadyAllowed) persistSessionPermissionOverride();
    updateStatus(ctx);
    notifyPermission(
      ctx,
      alreadyAllowed
        ? "Agent-driven supercompaction requests are already allowed for this live session."
        : "Agent-driven supercompaction requests are allowed for this live session and will not open a confirmation dialog.",
    );
  };

  const allowAgentRequestsOnce = (ctx: ExtensionContext): void => {
    if (request || confirmationId || preparationGrant) {
      notify(
        ctx,
        "A supercompact preparation, confirmation, or compaction is already active; one-shot agent-driven permission was not armed.",
        "warning",
      );
      return;
    }
    if (oneShotNoConfirmGrant) {
      notify(
        ctx,
        "One-shot agent-driven permission is already armed.",
        "warning",
      );
      return;
    }
    if (effectivePermission() === "allowed-noconfirm") {
      notify(
        ctx,
        "Agent-driven supercompaction requests are already allowed without a confirmation dialog by the effective configured or live-session permission; one-shot permission was not armed.",
        "warning",
      );
      return;
    }

    oneShotNoConfirmGrant = { id: createId() };
    updateStatus(ctx);
    notifyPermission(
      ctx,
      "One-shot agent-driven permission is armed for the next valid supercompaction request without a confirmation dialog.",
    );
  };

  const denyAgentRequests = (ctx: ExtensionContext): void => {
    const permissionWasDenied = sessionPermissionOverride === "denied";
    const canceledOneShotPermission = clearOneShotNoConfirmGrant(ctx);
    const wasAlreadyDenied =
      permissionWasDenied &&
      !preparationGrant &&
      !confirmationId &&
      !canceledOneShotPermission;
    sessionPermissionOverride = "denied";
    if (!permissionWasDenied) persistSessionPermissionOverride();

    const canceledConfirmation = cancelPendingConfirmation();
    const canceledPreparation = Boolean(
      preparationGrant &&
      preparationGrant.origin === "explicit" &&
      !preparationGrant.consumed,
    );
    if (canceledPreparation) {
      preparationGrant = undefined;
    } else if (
      preparationGrant?.origin === "explicit" &&
      preparationGrant.consumed
    ) {
      preparationGrant.revoked = true;
    }
    updateStatus(ctx);

    if (canceledConfirmation || canceledPreparation) {
      notify(ctx, "Pending pre-compaction preparation was canceled.");
    }
    if (canceledOneShotPermission) {
      notify(ctx, "Pending one-shot agent-driven permission was canceled.");
    }
    notifyPermission(
      ctx,
      wasAlreadyDenied
        ? "Agent-driven supercompaction requests are already denied."
        : "Agent-driven supercompaction requests are denied for this live session.",
    );
  };

  const abortSupercompact = (ctx: ExtensionContext): void => {
    if (
      request &&
      (request.phase === "compacting" || request.compactionCompleted)
    ) {
      notify(
        ctx,
        "Native compaction has begun and cannot be canceled by /supercompact abort. Press Escape in the TUI, or use the host's native cancellation mechanism when available.",
        "warning",
      );
      return;
    }

    const hadPreparation = Boolean(preparationGrant);
    const hadOneShotPermission = Boolean(oneShotNoConfirmGrant);
    const hadConfirmation = Boolean(confirmationId);
    const hadRequest = Boolean(request);
    if (
      !hadPreparation &&
      !hadOneShotPermission &&
      !hadConfirmation &&
      !hadRequest
    ) {
      notify(ctx, "No supercompaction is active.", "error");
      return;
    }

    const shouldAbortAgentTurn =
      hadRequest || ((hadPreparation || hadConfirmation) && !ctx.isIdle());
    if (confirmationId) abortedConfirmationIds.add(confirmationId);
    confirmationAbortController?.abort();
    confirmationId = undefined;
    confirmationAbortController = undefined;
    confirmationRevoked = false;
    if (preparationGrant) preparationGrant.revoked = true;
    preparationGrant = undefined;
    oneShotNoConfirmGrant = undefined;
    request = undefined;
    clearDecisionState(ctx);
    updateStatus(ctx);
    notify(
      ctx,
      hadOneShotPermission && !hadPreparation && !hadConfirmation && !hadRequest
        ? "Pending one-shot agent-driven permission was canceled."
        : "Supercompaction was aborted before native compaction began.",
    );
    if (shouldAbortAgentTurn) ctx.abort();
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
    const allow = "Allow agent-driven requests for this session";
    const allowOnce = "Allow the next agent-driven request";
    const deny = "Deny agent-driven supercompaction requests for this session";
    const automatic = automaticEnabled()
      ? "Disable automatic supercompact for this session"
      : "Enable automatic supercompact for this session";
    const abort = "Abort active pre-native supercompaction";
    const cancel = "Cancel";
    const choice = await ctx.ui.select("Supercompact", [
      run,
      force,
      allow,
      allowOnce,
      deny,
      automatic,
      abort,
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
      allowAgentRequests(ctx);
    } else if (choice === allowOnce) {
      allowAgentRequestsOnce(ctx);
    } else if (choice === deny) {
      denyAgentRequests(ctx);
    } else if (choice === automatic) {
      setAutomaticMode(!automaticEnabled(), ctx);
    } else if (choice === abort) {
      abortSupercompact(ctx);
    }
  };

  pi.registerCommand("supercompact", {
    description: "Prepare, force, abort, or manage supercompaction",
    getArgumentCompletions: (prefix) => {
      // The completion value replaces the full argument prefix, so it must
      // include the subcommand, not just the flag token.
      const flagMatch = /^(run|force)\s+(-{1,2}\S*)$/.exec(prefix);
      if (flagMatch) {
        const flags = ["--stop", "-s", "--continue", "-c"].filter((flag) =>
          flag.startsWith(flagMatch[2]),
        );
        const descriptions: Record<string, string> = {
          "--stop": "First option; override continuation to stop",
          "-s": "Shorthand for --stop",
          "--continue": "First option; override continuation to continue",
          "-c": "Shorthand for --continue",
        };
        return flags.length === 0
          ? null
          : flags.map((flag) => ({
              value: `${flagMatch[1]} ${flag}`,
              label: flag,
              description: descriptions[flag],
            }));
      }

      const commands = [
        {
          value: "run",
          label: "run [--stop | --continue]",
          description:
            "Prepare a checkpoint; use flags to override continuation",
        },
        {
          value: "force",
          label: "force [--stop | --continue]",
          description: "Compact now; use flags to override continuation",
        },
        {
          value: "auto-enable",
          description: "Enable automatic supercompaction",
        },
        {
          value: "auto-disable",
          description: "Disable automatic supercompaction",
        },
        {
          value: "agent-driven-allow",
          description: "Allow autonomous agent-driven supercompaction",
        },
        {
          value: "agent-driven-allow-once",
          description: "Allow a single autonomous agent-driven supercompaction",
        },
        {
          value: "agent-driven-deny",
          description: "Deny agent requests and cancel pending supercompaction",
        },
        {
          value: "abort",
          description: "Cancel supercompaction",
        },
      ];
      const matches = commands.filter((command) =>
        command.value.startsWith(prefix),
      );
      return matches.length === 0
        ? null
        : matches.map(({ value, label, description }) => ({
            value,
            label: label ?? value,
            description,
          }));
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

      if (action === "run" || action === "force") {
        const parsed = parseCommandArguments(remainder);
        if (!parsed) {
          notify(ctx, USAGE, "error");
          return;
        }
        if (action === "run") {
          startPreparation(
            parsed.extraContext,
            ctx,
            false,
            parsed.continuationOverride,
          );
        } else {
          startForce(
            parsed.extraContext,
            ctx,
            false,
            parsed.continuationOverride,
          );
        }
      } else if (action === "auto-enable" && !remainder) {
        setAutomaticMode(true, ctx);
      } else if (action === "auto-disable" && !remainder) {
        setAutomaticMode(false, ctx);
      } else if (action === "agent-driven-allow" && !remainder) {
        allowAgentRequests(ctx);
      } else if (action === "agent-driven-allow-once" && !remainder) {
        allowAgentRequestsOnce(ctx);
      } else if (action === "agent-driven-deny" && !remainder) {
        denyAgentRequests(ctx);
      } else if (action === "abort" && !remainder) {
        abortSupercompact(ctx);
      } else {
        notify(ctx, USAGE, "error");
      }
    },
  });
}
