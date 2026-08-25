import { isAgentEvent, normalizeSimpleEvent, type AgentEvent, type AgentPhase, type AgentStatus, type EventKind, type SimpleEvent } from "../../src/core/protocol";

export type TelemetryFormat = "protocol" | "hook" | "otlp-traces" | "otlp-logs" | "otlp-metrics" | "opencode" | "acp" | "codex-app-server" | "codex-json";

export interface TelemetryEnvelope {
  source: string;
  product: string;
  transport: string;
  format: TelemetryFormat;
  payload: unknown;
  receivedAt?: number;
  direction?: "client-to-agent" | "agent-to-client";
}

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function numberValue(...values: unknown[]) {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function key(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stableToken(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    if (/^\d+$/.test(value)) value = Number(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e15 ? value / 1e6 : value > 1e12 ? value : value * 1e3;
    return new Date(milliseconds).toISOString();
  }
  return new Date(fallback).toISOString();
}

function nested(value: Json, name: string) {
  return object(value[name]);
}

function firstNestedText(value: Json, names: string[]) {
  for (const name of names) {
    const direct = text(value[name]);
    if (direct) return direct;
  }
  return undefined;
}

function sessionMetadata(payload: Json, envelope: TelemetryEnvelope, extra: Json = {}) {
  const session = nested(payload, "session");
  const thread = nested(payload, "thread");
  const project = nested(payload, "project");
  const agent = nested(payload, "agent");
  const model = nested(payload, "model");
  const sessionId = firstNestedText(payload, ["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId", "task_id", "taskId"])
    ?? text(session.id, thread.id, extra.sessionId);
  const workstreamId = firstNestedText(payload, ["workstream_id", "workstreamId", "project_id", "projectId"])
    ?? text(project.id, extra.workstreamId, sessionId);
  const cwd = firstNestedText(payload, ["cwd", "directory", "workspace", "workspace_path", "workspacePath"]);
  return {
    source: envelope.source,
    product: envelope.product,
    transport: envelope.transport,
    direction: envelope.direction,
    sessionId,
    threadId: text(thread.id, payload.thread_id, payload.threadId),
    turnId: text(payload.turn_id, payload.turnId, extra.turnId),
    workstreamId,
    workstreamName: text(project.name, payload.project_name, payload.projectName, cwd?.split(/[\\/]/).filter(Boolean).pop()),
    project: text(project.name, payload.project_name, payload.projectName, cwd),
    agentName: text(agent.name, payload.agent_name, payload.agentName, extra.agentName, envelope.product),
    modelProvider: text(model.provider, payload.model_provider, payload.modelProvider, extra.modelProvider, envelope.product),
    model: text(model.id, model.name, payload.model_id, payload.modelId, payload.model, extra.model),
    ...extra,
  };
}

function makeEvent(
  envelope: TelemetryEnvelope,
  payload: Json,
  status: AgentStatus,
  kind: EventKind,
  options: Partial<AgentEvent> & { identity?: string } = {},
): AgentEvent {
  const receivedAt = envelope.receivedAt ?? Date.now();
  const { identity: explicitIdentity, meta: optionMeta, ...eventOptions } = options;
  const meta = { ...sessionMetadata(payload, envelope), ...object(optionMeta) };
  const identity = explicitIdentity ?? [
    envelope.source,
    kind,
    status,
    meta.sessionId,
    payload.id,
    payload.event_id,
    payload.eventId,
    payload.timestamp,
    payload.time,
    options.tool,
    options.detail,
  ].map((value) => String(value ?? "")).join("|");
  return {
    version: 1,
    id: `${envelope.source}-${stableToken(identity)}`,
    timestamp: timestamp(payload.timestamp ?? payload.time ?? payload.created_at ?? payload.createdAt, receivedAt),
    kind,
    status,
    ...eventOptions,
    meta,
  };
}

function toolActivity(toolName: string | undefined, detail?: string) {
  const normalized = key(toolName);
  if (/search|web|browser|fetch|grep|find/.test(normalized)) return { status: "searching" as const, phase: "searching" as const, label: "SEARCHING", detail: detail || "Searching", tool: toolName };
  if (/edit|write|patch|replace|notebook|filechange/.test(normalized)) return { status: "editing" as const, phase: "editing" as const, label: "EDITING", detail: detail || "Updating files", tool: toolName };
  if (/test|vitest|jest|pytest|check|lint/.test(normalized)) return { status: "testing" as const, phase: "testing" as const, label: "RUNNING TESTS", detail: detail || "Running tests", tool: toolName };
  if (/spawn|task|subagent|delegate/.test(normalized)) return { status: "working" as const, phase: "delegating" as const, label: "DELEGATING", detail: detail || "Starting another agent", tool: toolName };
  return { status: "command" as const, phase: "executing" as const, label: "RUNNING", detail: detail || (toolName ? `Using ${toolName}` : "Using a tool"), tool: toolName };
}

function protocolEvents(envelope: TelemetryEnvelope): AgentEvent[] {
  return array(envelope.payload).length && Array.isArray(envelope.payload)
    ? envelope.payload.flatMap((payload) => protocolEvents({ ...envelope, payload }))
    : (() => {
      if (isAgentEvent(envelope.payload)) {
        return [{ ...envelope.payload, meta: { ...envelope.payload.meta, source: envelope.source, product: envelope.product, transport: envelope.transport } }];
      }
      const payload = object(envelope.payload);
      if (!("status" in payload)) return [];
      const normalized = normalizeSimpleEvent(payload as unknown as SimpleEvent, `${envelope.source}-${stableToken(JSON.stringify(payload))}`);
      normalized.meta = { ...sessionMetadata(payload, envelope), ...normalized.meta };
      return [normalized];
    })();
}

function hookEvents(envelope: TelemetryEnvelope) {
  const payload = object(envelope.payload);
  const rawName = text(payload.hook_event_name, payload.hookEventName, payload.event_name, payload.eventName, payload.event, payload.type, payload.name) ?? "hook";
  const eventName = key(rawName);
  const toolName = text(payload.tool_name, payload.toolName, nested(payload, "tool").name);
  const identity = text(payload.event_id, payload.eventId, payload.id) ?? `${rawName}|${text(payload.session_id, payload.sessionId)}|${text(payload.timestamp)}|${toolName}`;
  const common = { identity, meta: { rawEventName: rawName } };
  if (/permission|approval/.test(eventName)) return [makeEvent(envelope, payload, "approval", "approval.requested", { ...common, phase: "waiting", label: "NEEDS YOU", detail: "Permission required", tool: toolName })];
  if (/question|inputrequested|userinput/.test(eventName)) return [makeEvent(envelope, payload, "waiting", "input.requested", { ...common, phase: "waiting", label: "NEEDS YOU", detail: "Input required" })];
  if (/error|failure|failed/.test(eventName)) return [makeEvent(envelope, payload, "error", "error", { ...common, phase: "failed", detail: text(payload.error, payload.message, nested(payload, "error").message) || "Agent reported an error" })];
  if (/subagentstart|subagentcreated|taskcreated/.test(eventName)) return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "delegating", label: "DELEGATING", detail: "Starting another agent" })];
  if (/subagentstop|subagentend|taskcompleted/.test(eventName)) return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "receiving", label: "RECEIVING", detail: "Subagent result received" })];
  if (/sessionstart|taskstart|turnstart|beforeagent/.test(eventName)) return [makeEvent(envelope, payload, "thinking", eventName.includes("session") || eventName.includes("task") ? "session.start" : "turn.start", { ...common, phase: "starting", label: "STARTING", detail: "Agent started" })];
  if (/sessionend|taskcomplete|taskend|turnend|afteragent|stop$/.test(eventName)) return [makeEvent(envelope, payload, "complete", "complete", { ...common, phase: "completing", detail: "Agent completed" })];
  if (/pretool|beforetool|toolstart|beforecommand|precommand/.test(eventName)) {
    const activity = toolActivity(toolName, text(payload.command, payload.description));
    return [makeEvent(envelope, payload, activity.status, "command.start", { ...common, ...activity, command: text(payload.command) })];
  }
  if (/posttool|aftertool|toolend|toolcomplete|aftercommand|postcommand/.test(eventName)) return [makeEvent(envelope, payload, "working", "command.end", { ...common, phase: "receiving", label: "RECEIVING", detail: toolName ? `${toolName} finished` : "Tool result received", tool: toolName })];
  if (/beforemodel|premodel|userprompt|promptsubmit|promptsubmitted/.test(eventName)) return [makeEvent(envelope, payload, "thinking", "activity", { ...common, phase: "planning", detail: "Planning the next step" })];
  if (/aftermodel|postmodel|response|thought/.test(eventName)) return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "responding", label: "RESPONDING", detail: "Writing a response" })];
  if (/upload/.test(eventName)) return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "uploading", label: "UPLOADING", detail: "Uploading a result" })];
  if (/compact|retry|backoff/.test(eventName)) return [makeEvent(envelope, payload, "thinking", "activity", { ...common, phase: "retrying", label: "LOADING", detail: "Preparing more context" })];
  if (/notification/.test(eventName)) return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "notifying", label: "NOTIFYING", detail: text(payload.message) || "Agent notification" })];
  return [makeEvent(envelope, payload, "working", "activity", { ...common, phase: "receiving", detail: rawName.replace(/[_./-]+/g, " ") })];
}

function anyValue(value: unknown): unknown {
  const item = object(value);
  if ("stringValue" in item) return item.stringValue;
  if ("intValue" in item) return typeof item.intValue === "string" ? Number(item.intValue) : item.intValue;
  if ("doubleValue" in item) return item.doubleValue;
  if ("boolValue" in item) return item.boolValue;
  if ("bytesValue" in item) return item.bytesValue;
  if ("arrayValue" in item) return array(object(item.arrayValue).values).map(anyValue);
  if ("kvlistValue" in item) return attributes(object(item.kvlistValue).values);
  return value;
}

function attributes(value: unknown) {
  const result: Json = {};
  for (const attribute of array(value).map(object)) {
    const name = text(attribute.key);
    if (name) result[name] = anyValue(attribute.value);
  }
  return result;
}

function attributeText(values: Json, ...names: string[]) {
  return text(...names.map((name) => values[name]));
}

function otlpActivity(name: string, values: Json, ended: boolean) {
  const operation = key(attributeText(values, "gen_ai.operation.name", "event.name", "event_name") ?? name);
  const toolName = attributeText(values, "gen_ai.tool.name", "tool.name", "tool_name");
  const error = attributeText(values, "error.message", "exception.message");
  if (error || /error|failure|failed/.test(operation)) return { status: "error" as const, kind: "error" as const, phase: "failed" as const, detail: error || "Agent reported an error", tool: toolName };
  if (/permission|approval/.test(operation)) return { status: "approval" as const, kind: "approval.requested" as const, phase: "waiting" as const, detail: "Permission required", tool: toolName };
  if (/inputrequested|question/.test(operation)) return { status: "waiting" as const, kind: "input.requested" as const, phase: "waiting" as const, detail: "Input required", tool: toolName };
  if (/createagent|subagent|delegate|spawn/.test(operation)) return { status: "working" as const, kind: "activity" as const, phase: "delegating" as const, detail: "Starting another agent", tool: toolName };
  if (/tool|execute|command/.test(operation) || toolName) {
    if (ended) return { status: "working" as const, kind: "command.end" as const, phase: "receiving" as const, detail: toolName ? `${toolName} finished` : "Tool result received", tool: toolName };
    return { ...toolActivity(toolName), kind: "command.start" as const };
  }
  if (/search|retriev/.test(operation)) return { status: "searching" as const, kind: "activity" as const, phase: "searching" as const, detail: "Searching", tool: toolName };
  if (/response|message|completion|chat/.test(operation)) return { status: "working" as const, kind: "activity" as const, phase: "responding" as const, detail: "Writing a response", tool: toolName };
  if (/upload/.test(operation)) return { status: "working" as const, kind: "activity" as const, phase: "uploading" as const, detail: "Uploading a result", tool: toolName };
  if (/notification|notify/.test(operation)) return { status: "working" as const, kind: "activity" as const, phase: "notifying" as const, detail: "Agent notification", tool: toolName };
  if (/retry|backoff|compact/.test(operation)) return { status: "thinking" as const, kind: "activity" as const, phase: "retrying" as const, detail: "Preparing more context", tool: toolName };
  if (/sessionstart|agentstart|invokeagent|turnstart/.test(operation)) return { status: "thinking" as const, kind: "turn.start" as const, phase: "starting" as const, detail: "Agent started", tool: toolName };
  if (/complete|sessionend|turnend|stop/.test(operation)) return { status: "complete" as const, kind: "complete" as const, phase: "completing" as const, detail: "Agent completed", tool: toolName };
  return { status: "thinking" as const, kind: "activity" as const, phase: "planning" as const, detail: "Agent is working", tool: toolName };
}

function otlpEvents(envelope: TelemetryEnvelope) {
  if (envelope.format === "otlp-metrics") return [];
  const root = object(envelope.payload);
  const events: AgentEvent[] = [];
  const resourceGroups = envelope.format === "otlp-traces" ? array(root.resourceSpans) : array(root.resourceLogs);
  for (const resourceGroupValue of resourceGroups) {
    const resourceGroup = object(resourceGroupValue);
    const resourceAttributes = attributes(nested(resourceGroup, "resource").attributes);
    const scopes = envelope.format === "otlp-traces" ? array(resourceGroup.scopeSpans) : array(resourceGroup.scopeLogs);
    for (const scopeValue of scopes) {
      const scope = object(scopeValue);
      const records = envelope.format === "otlp-traces" ? array(scope.spans) : array(scope.logRecords);
      for (const recordValue of records) {
        const record = object(recordValue);
        const recordAttributes = attributes(record.attributes);
        const values = { ...resourceAttributes, ...recordAttributes };
        const body = anyValue(record.body);
        const bodyObject = object(body);
        const safeBodyName = typeof body === "string" && /^[a-zA-Z0-9_.:/-]{1,80}$/.test(body) ? body : undefined;
        const rawName = text(record.name, values["event.name"], values.event_name, bodyObject.name, safeBodyName) ?? "telemetry event";
        const ended = Boolean(record.endTimeUnixNano || record.end_time_unix_nano);
        const activity = otlpActivity(rawName, values, ended);
        const traceId = text(record.traceId, record.trace_id);
        const spanId = text(record.spanId, record.span_id);
        const payload: Json = {
          ...record,
          sessionId: attributeText(values, "session.id", "session_id", "gen_ai.conversation.id", "gen_ai.session.id", "conversation_id") ?? traceId,
          workstreamId: attributeText(values, "project.id", "project_id", "workspace.id"),
          projectName: attributeText(values, "project.name", "workspace.name", "service.namespace"),
          agentName: attributeText(values, "gen_ai.agent.name", "agent.name"),
          modelProvider: attributeText(values, "gen_ai.provider.name", "gen_ai.system"),
          model: attributeText(values, "gen_ai.request.model", "gen_ai.response.model"),
          timestamp: record.timeUnixNano ?? record.startTimeUnixNano ?? record.observedTimeUnixNano,
        };
        const product = attributeText(values, "service.name", "gen_ai.provider.name") ?? envelope.product;
        events.push(makeEvent({ ...envelope, product }, payload, activity.status, activity.kind, {
          ...activity,
          identity: `${envelope.source}|${traceId}|${spanId}|${rawName}|${payload.timestamp}`,
          meta: { rawEventName: rawName, traceId, spanId, telemetryScope: nested(scope, "scope").name },
        }));
        if (envelope.format === "otlp-traces") {
          for (const spanEventValue of array(record.events)) {
            const spanEvent = object(spanEventValue);
            const spanValues = { ...values, ...attributes(spanEvent.attributes) };
            const spanName = text(spanEvent.name) ?? "span event";
            const spanActivity = otlpActivity(spanName, spanValues, false);
            events.push(makeEvent({ ...envelope, product }, { ...payload, timestamp: spanEvent.timeUnixNano }, spanActivity.status, spanActivity.kind, {
              ...spanActivity,
              identity: `${envelope.source}|${traceId}|${spanId}|${spanName}|${spanEvent.timeUnixNano}`,
              meta: { rawEventName: spanName, traceId, spanId },
            }));
          }
        }
      }
    }
  }
  return events;
}

function opencodeEvents(envelope: TelemetryEnvelope) {
  const root = object(envelope.payload);
  const wrapped = object(root.data);
  const payload = Object.keys(wrapped).length ? wrapped : object(root.properties);
  const rawName = text(root.event, root.type, payload.type) ?? "opencode.event";
  const eventName = key(rawName);
  const info = object(payload.info);
  const part = object(payload.part);
  const partState = object(part.state);
  const sessionId = text(payload.sessionID, payload.sessionId, info.sessionID, info.sessionId, part.sessionID, part.sessionId, info.id);
  const basePayload = { ...payload, sessionId, projectName: text(payload.directory, info.directory) };
  const common = { identity: text(root.id) ?? `${rawName}|${sessionId}|${text(info.id, part.id)}|${text(root.timestamp)}`, meta: { rawEventName: rawName } };
  if (eventName === "serverconnected") return [];
  if (/permissionasked|permissionupdated/.test(eventName)) return [makeEvent(envelope, basePayload, "approval", "approval.requested", { ...common, phase: "waiting", detail: "Permission required" })];
  if (/questionasked/.test(eventName)) return [makeEvent(envelope, basePayload, "waiting", "input.requested", { ...common, phase: "waiting", detail: "Input required" })];
  if (/sessionerror/.test(eventName)) return [makeEvent(envelope, basePayload, "error", "error", { ...common, phase: "failed", detail: text(payload.error, nested(payload, "error").message) || "OpenCode reported an error" })];
  if (/sessioncreated/.test(eventName)) return [makeEvent(envelope, basePayload, "thinking", "session.start", { ...common, phase: "starting", detail: "OpenCode session started" })];
  if (/sessionidle|sessiondeleted/.test(eventName)) return [makeEvent(envelope, basePayload, "complete", "complete", { ...common, phase: "completing", detail: "OpenCode completed" })];
  if (/sessionstatus/.test(eventName)) {
    const status = key(object(payload.status).type || payload.status);
    if (/retry/.test(status)) return [makeEvent(envelope, basePayload, "thinking", "activity", { ...common, phase: "retrying", label: "RETRYING", detail: text(object(payload.status).message) || "OpenCode is retrying" })];
    if (/idle/.test(status)) return [makeEvent(envelope, basePayload, "complete", "complete", { ...common, phase: "completing", detail: "OpenCode completed" })];
    return [makeEvent(envelope, basePayload, "thinking", "activity", { ...common, phase: "planning", detail: "OpenCode is working" })];
  }
  if (/sessiondiff/.test(eventName)) return [makeEvent(envelope, basePayload, "editing", "files.changed", { ...common, phase: "editing", detail: "Updating files" })];
  if (/todoupdated|plan/.test(eventName)) return [makeEvent(envelope, basePayload, "thinking", "plan", { ...common, phase: "planning", detail: "Updating the plan" })];
  if (/commandexecuted/.test(eventName)) return [makeEvent(envelope, basePayload, "command", "command.start", { ...common, phase: "executing", command: text(payload.command), detail: text(payload.command) || "Running a command" })];
  if (/messagepart/.test(eventName)) {
    const partType = key(part.type);
    const partCommon = { ...common, identity: `${rawName}|${sessionId}|${text(part.id)}|${partType}` };
    if (/reasoning|stepstart/.test(partType)) return [makeEvent(envelope, basePayload, "thinking", "reasoning.summary", { ...partCommon, phase: "planning", detail: "Reasoning" })];
    if (/text/.test(partType)) return [makeEvent(envelope, basePayload, "working", "activity", { ...partCommon, phase: "responding", label: "RESPONDING", detail: "Writing a response" })];
    if (/tool/.test(partType)) {
      const toolName = text(part.tool, part.name);
      const state = key(partState.status);
      const toolCommon = { ...partCommon, identity: `${partCommon.identity}|${state || "running"}` };
      if (/complete/.test(state)) return [makeEvent(envelope, basePayload, "working", "command.end", { ...toolCommon, phase: "receiving", detail: toolName ? `${toolName} finished` : "Tool result received", tool: toolName })];
      if (/error|failed/.test(state)) return [makeEvent(envelope, basePayload, "error", "error", { ...toolCommon, phase: "failed", detail: text(partState.error) || "Tool failed", tool: toolName })];
      const activity = toolActivity(toolName);
      return [makeEvent(envelope, basePayload, activity.status, "command.start", { ...toolCommon, ...activity })];
    }
    if (/subtask|task/.test(partType)) return [makeEvent(envelope, basePayload, "working", "activity", { ...common, phase: "delegating", label: "DELEGATING", detail: "Starting another agent" })];
  }
  return [makeEvent(envelope, basePayload, "working", "activity", { ...common, phase: "receiving", detail: rawName.replace(/[._/-]+/g, " ") })];
}

function acpEvents(envelope: TelemetryEnvelope) {
  const payload = object(envelope.payload);
  const method = text(payload.method) ?? "";
  const params = object(payload.params);
  const update = object(params.update);
  const updateType = key(update.sessionUpdate || update.type);
  const basePayload = { ...params, sessionId: text(params.sessionId, params.session_id) };
  const common = { identity: `${text(payload.id) ?? "notification"}|${method}|${updateType}|${text(update.toolCallId, update.id)}|${text(update.status)}|${text(update.timestamp)}`, meta: { rawEventName: method || updateType } };
  if (method === "session/new") return [makeEvent(envelope, basePayload, "thinking", "session.start", { ...common, phase: "starting", detail: "ACP agent session started" })];
  if (method === "session/prompt") return [makeEvent(envelope, basePayload, "thinking", "turn.start", { ...common, phase: "planning", detail: "Agent is planning" })];
  if (/requestpermission/.test(key(method))) return [makeEvent(envelope, basePayload, "approval", "approval.requested", { ...common, phase: "waiting", detail: "Permission required" })];
  if (method !== "session/update") return [];
  if (/agentmessagechunk|agentthoughtchunk/.test(updateType)) return [makeEvent(envelope, basePayload, updateType.includes("thought") ? "thinking" : "working", "activity", { ...common, phase: updateType.includes("thought") ? "planning" : "responding", label: updateType.includes("thought") ? "THINKING" : "RESPONDING", detail: updateType.includes("thought") ? "Reasoning" : "Writing a response" })];
  if (/plan/.test(updateType)) return [makeEvent(envelope, basePayload, "thinking", "plan", { ...common, phase: "planning", detail: "Updating the plan" })];
  if (/toolcall/.test(updateType)) {
    const toolName = text(update.title, update.name, update.kind);
    const status = key(update.status);
    if (/complete/.test(status)) return [makeEvent(envelope, basePayload, "working", "command.end", { ...common, phase: "receiving", detail: toolName ? `${toolName} finished` : "Tool result received", tool: toolName })];
    if (/failed|error/.test(status)) return [makeEvent(envelope, basePayload, "error", "error", { ...common, phase: "failed", detail: text(update.error) || "Tool failed", tool: toolName })];
    const activity = toolActivity(toolName);
    return [makeEvent(envelope, basePayload, activity.status, "command.start", { ...common, ...activity })];
  }
  if (/usage/.test(updateType)) return [makeEvent(envelope, basePayload, "working", "usage", { ...common, phase: "receiving", usage: { inputTokens: numberValue(update.inputTokens, update.input_tokens), outputTokens: numberValue(update.outputTokens, update.output_tokens) } })];
  return [];
}

function codexEvents(envelope: TelemetryEnvelope) {
  const root = object(envelope.payload);
  const params = object(root.params);
  const result = object(root.result);
  const item = object(params.item || root.item);
  const rawType = text(root.method, root.type, root.event, item.type) ?? "codex.event";
  const eventType = key(rawType);
  const itemType = key(item.type);
  const thread = object(params.thread || result.thread);
  const turn = object(params.turn || result.turn);
  const basePayload = {
    ...params,
    sessionId: text(params.threadId, params.thread_id, thread.id, root.thread_id),
    threadId: text(params.threadId, params.thread_id, thread.id, root.thread_id),
    turnId: text(params.turnId, params.turn_id, turn.id, root.turn_id),
    projectName: text(params.cwd, thread.cwd),
  };
  const common = { identity: `${text(root.id) ?? "notification"}|${rawType}|${text(item.id)}|${text(params.timestamp)}`, meta: { rawEventName: rawType } };
  if (/threadstarted|threadstart/.test(eventType)) return [makeEvent(envelope, basePayload, "thinking", "session.start", { ...common, phase: "starting", detail: "Codex session started" })];
  if (/turnstarted|turnstart/.test(eventType)) return [makeEvent(envelope, basePayload, "thinking", "turn.start", { ...common, phase: "planning", detail: "Codex is planning" })];
  if (/turncompleted|turncomplete/.test(eventType)) {
    const status = key(turn.status || params.status);
    return [makeEvent(envelope, basePayload, /fail|error|interrupt/.test(status) ? "error" : "complete", /fail|error|interrupt/.test(status) ? "error" : "complete", { ...common, phase: /fail|error|interrupt/.test(status) ? "failed" : "completing", detail: /fail|error|interrupt/.test(status) ? "Codex stopped with an error" : "Codex completed" })];
  }
  if (/planupdated|plan/.test(eventType) || itemType === "plan") return [makeEvent(envelope, basePayload, "thinking", "plan", { ...common, phase: "planning", detail: "Updating the plan" })];
  if (/agentmessagedelta|agentmessage/.test(eventType) || itemType === "agentmessage") return [makeEvent(envelope, basePayload, "working", "activity", { ...common, phase: "responding", label: "RESPONDING", detail: "Writing a response" })];
  if (/reasoning/.test(eventType) || itemType === "reasoning") return [makeEvent(envelope, basePayload, "thinking", "reasoning.summary", { ...common, phase: "planning", detail: "Reasoning" })];
  if (/filechange|patch/.test(eventType) || itemType === "filechange") {
    const changes = array(item.changes).map(object);
    const files = changes.map((change) => text(change.path)).filter((value): value is string => Boolean(value));
    return [makeEvent(envelope, basePayload, "editing", "files.changed", { ...common, phase: "editing", files, tool: "apply_patch", detail: files.length ? `Updating ${files.slice(0, 2).join(", ")}` : "Updating files" })];
  }
  if (/websearch/.test(eventType) || itemType === "websearch") return [makeEvent(envelope, basePayload, "searching", "activity", { ...common, phase: "searching", tool: "web", detail: "Searching the web" })];
  if (/commandexecution/.test(eventType) || itemType === "commandexecution") {
    const command = text(item.command, params.command);
    const finished = /completed|itemcompleted/.test(eventType);
    if (finished) return [makeEvent(envelope, basePayload, "working", "command.end", { ...common, phase: "receiving", command, detail: "Command finished" })];
    const activity = toolActivity(command?.split(/\s+/, 1)[0], command);
    return [makeEvent(envelope, basePayload, activity.status, "command.start", { ...common, ...activity, command })];
  }
  if (/toolcall|mcptool|dynamictool/.test(eventType) || /toolcall/.test(itemType)) {
    const toolName = text(item.tool, item.name, params.tool);
    const finished = /completed|itemcompleted/.test(eventType);
    if (finished) return [makeEvent(envelope, basePayload, "working", "command.end", { ...common, phase: "receiving", tool: toolName, detail: toolName ? `${toolName} finished` : "Tool result received" })];
    const activity = toolActivity(toolName);
    return [makeEvent(envelope, basePayload, activity.status, "command.start", { ...common, ...activity })];
  }
  if (/error|failed/.test(eventType)) return [makeEvent(envelope, basePayload, "error", "error", { ...common, phase: "failed", detail: text(params.message, root.message) || "Codex reported an error" })];
  return [];
}

export function normalizeTelemetry(envelope: TelemetryEnvelope): AgentEvent[] {
  if (envelope.format === "protocol") return protocolEvents(envelope);
  if (envelope.format === "hook") return hookEvents(envelope);
  if (envelope.format.startsWith("otlp-")) return otlpEvents(envelope);
  if (envelope.format === "opencode") return opencodeEvents(envelope);
  if (envelope.format === "acp") return acpEvents(envelope);
  if (envelope.format === "codex-app-server" || envelope.format === "codex-json") return codexEvents(envelope);
  return [];
}
