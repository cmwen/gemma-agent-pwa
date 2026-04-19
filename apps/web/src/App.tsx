import {
  type ChatSession,
  type ChatTurn,
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_FAST_PRESET_ID,
  GEMMA_PRESETS,
  getPresetById,
  type PartialChatRuntimeConfig,
} from "@gemma-agent-pwa/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyPresetRuntimeConfig,
  buildMessages,
  formatTime,
} from "./app-utils";
import {
  getAgent,
  getAgents,
  getHealth,
  getModels,
  getSession,
  getSessions,
  streamChat,
} from "./lib/api";
import {
  buildDraftKey,
  getSelectedSessionId,
  hasStoredSessionSelection,
  useAppStore,
} from "./lib/store";

interface StreamingState {
  sending: boolean;
  assistantText?: string;
  thinkingText?: string;
  skillActivity?: string;
  error?: string;
}

type MobileSection = "agents" | "history" | "chat" | "details";

const MOBILE_SECTIONS: Array<{ id: MobileSection; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "details", label: "Details" },
];

export default function App() {
  const queryClient = useQueryClient();
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const selectedSessionIds = useAppStore((state) => state.selectedSessionIds);
  const drafts = useAppStore((state) => state.drafts);
  const setSelectedAgentId = useAppStore((state) => state.setSelectedAgentId);
  const setSelectedSessionId = useAppStore(
    (state) => state.setSelectedSessionId
  );
  const setDraft = useAppStore((state) => state.setDraft);

  const [runtimeConfig, setRuntimeConfig] = useState<PartialChatRuntimeConfig>(
    {}
  );
  const [mobileSection, setMobileSection] = useState<MobileSection>("chat");
  const [streaming, setStreaming] = useState<StreamingState>({
    sending: false,
  });
  const [liveThread, setLiveThread] = useState<ChatSession | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 15_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: getModels,
    refetchInterval: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  });

  useEffect(() => {
    if (!selectedAgentId && agentsQuery.data?.[0]) {
      setSelectedAgentId(agentsQuery.data[0].id);
    }
  }, [agentsQuery.data, selectedAgentId, setSelectedAgentId]);

  const selectedAgent = useMemo(
    () => agentsQuery.data?.find((agent) => agent.id === selectedAgentId),
    [agentsQuery.data, selectedAgentId]
  );

  const agentDetailQuery = useQuery({
    queryKey: ["agent", selectedAgentId],
    queryFn: () => getAgent(selectedAgentId ?? ""),
    enabled: Boolean(selectedAgentId),
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions", selectedAgentId],
    queryFn: () => getSessions(selectedAgentId ?? ""),
    enabled: Boolean(selectedAgentId),
  });

  useEffect(() => {
    if (!selectedAgentId) {
      return;
    }
    if (
      !hasStoredSessionSelection(selectedSessionIds, selectedAgentId) &&
      sessionsQuery.data?.[0]
    ) {
      setSelectedSessionId(selectedAgentId, sessionsQuery.data[0].sessionId);
    }
  }, [
    selectedAgentId,
    selectedSessionIds,
    sessionsQuery.data,
    setSelectedSessionId,
  ]);

  const activeSessionId = getSelectedSessionId(
    selectedSessionIds,
    selectedAgentId
  );

  const sessionQuery = useQuery({
    queryKey: ["session", selectedAgentId, activeSessionId],
    queryFn: () => getSession(selectedAgentId ?? "", activeSessionId ?? ""),
    enabled: Boolean(selectedAgentId && activeSessionId),
  });

  const thread =
    liveThread?.sessionId === activeSessionId ? liveThread : sessionQuery.data;

  useEffect(() => {
    const agentConfig = agentDetailQuery.data?.runtimeConfig;
    const sessionConfig = thread?.runtimeConfig;
    const fallbackModel =
      modelsQuery.data?.find((model) => /gemma-4/i.test(model.id))?.id ??
      modelsQuery.data?.find((model) => model.isGemma)?.id ??
      modelsQuery.data?.[0]?.id;
    setRuntimeConfig({
      presetId:
        sessionConfig?.presetId ??
        agentConfig?.presetId ??
        GEMMA_BALANCED_PRESET_ID,
      model: sessionConfig?.model ?? agentConfig?.model ?? fallbackModel,
      lmStudioEnableThinking:
        sessionConfig?.lmStudioEnableThinking ??
        agentConfig?.lmStudioEnableThinking,
      maxCompletionTokens:
        sessionConfig?.maxCompletionTokens ?? agentConfig?.maxCompletionTokens,
      temperature: sessionConfig?.temperature ?? agentConfig?.temperature,
      topP: sessionConfig?.topP ?? agentConfig?.topP,
    });
    setLiveThread(undefined);
    setStreaming({ sending: false });
  }, [agentDetailQuery.data, thread?.sessionId, modelsQuery.data]);

  const draftKey = buildDraftKey(selectedAgentId, activeSessionId);
  const draft = drafts[draftKey] ?? "";
  const activePreset = getPresetById(runtimeConfig.presetId);
  const modeValue =
    runtimeConfig.presetId === GEMMA_FAST_PRESET_ID ? "fast" : "think";
  const messages = buildMessages(thread, streaming);
  const status = streaming.sending
    ? "Generating"
    : healthQuery.data?.lmStudioReachable
      ? "Ready"
      : "Offline";
  const selectedModel = modelsQuery.data?.find(
    (model) => model.id === runtimeConfig.model
  );
  const modelTone = /gemma-4/i.test(runtimeConfig.model ?? "")
    ? "Gemma 4 tuned"
    : selectedModel?.isGemma
      ? "Gemma tuned"
      : "Model fallback";

  const canSend =
    Boolean(selectedAgentId) &&
    draft.trim().length > 0 &&
    !streaming.sending &&
    Boolean(runtimeConfig.model);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    timeline.scrollTop = timeline.scrollHeight;
  }, [
    messages.length,
    streaming.assistantText,
    streaming.thinkingText,
    streaming.sending,
  ]);

  async function handleSend() {
    if (!selectedAgentId || !draft.trim()) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming({
      sending: true,
    });

    const prompt = draft.trim();
    setDraft(draftKey, "");

    try {
      await streamChat(
        selectedAgentId,
        {
          sessionId: activeSessionId,
          title: thread?.title,
          prompt,
          config: runtimeConfig,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "thread":
                setLiveThread(event.thread);
                if (!activeSessionId) {
                  setSelectedSessionId(selectedAgentId, event.thread.sessionId);
                }
                break;
              case "assistant_snapshot":
                setStreaming((state) => ({
                  ...state,
                  assistantText: event.assistantText,
                  thinkingText: event.thinkingText,
                  skillActivity: undefined,
                }));
                break;
              case "skill_call":
                setStreaming((state) => ({
                  ...state,
                  skillActivity: `Running skill: ${event.skillName}…`,
                }));
                break;
              case "skill_result":
                setStreaming((state) => ({
                  ...state,
                  skillActivity: `Skill ${event.skillName} completed (exit ${event.exitCode})`,
                }));
                break;
              case "complete":
                setLiveThread(event.response.thread);
                setSelectedSessionId(
                  selectedAgentId,
                  event.response.thread.sessionId
                );
                void queryClient.invalidateQueries({
                  queryKey: ["sessions", selectedAgentId],
                });
                void queryClient.invalidateQueries({
                  queryKey: [
                    "session",
                    selectedAgentId,
                    event.response.thread.sessionId,
                  ],
                });
                setStreaming({
                  sending: false,
                });
                break;
              case "error":
                setStreaming({
                  sending: false,
                  error: event.error,
                });
                setDraft(draftKey, prompt);
                break;
            }
          },
        }
      );
    } catch (error) {
      setStreaming({
        sending: false,
        error: error instanceof Error ? error.message : "Unknown error.",
      });
      setDraft(draftKey, prompt);
    } finally {
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming({
      sending: false,
      error: "Generation stopped.",
    });
  }

  function handleNewChat() {
    if (!selectedAgentId) {
      return;
    }
    setSelectedSessionId(selectedAgentId, null);
    setLiveThread(undefined);
    setStreaming({ sending: false });
    setMobileSection("chat");
  }

  function handleModeChange(nextMode: "fast" | "think") {
    setRuntimeConfig((current) =>
      applyPresetRuntimeConfig(
        current,
        nextMode === "fast" ? GEMMA_FAST_PRESET_ID : GEMMA_BALANCED_PRESET_ID
      )
    );
  }

  return (
    <div className="app-shell">
      <nav className="mobile-nav" aria-label="Primary navigation">
        {MOBILE_SECTIONS.map((section) => (
          <button
            className={mobileSection === section.id ? "is-active" : ""}
            key={section.id}
            onClick={() => setMobileSection(section.id)}
            type="button"
          >
            {section.label}
          </button>
        ))}
      </nav>

      <aside
        className={buildPanelClassName("panel rail", "agents", mobileSection)}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Agents</p>
            <h1>Gemma Agent</h1>
          </div>
          <button
            className="ghost-button"
            onClick={handleNewChat}
            type="button"
          >
            New chat
          </button>
        </div>
        <div className="agent-list">
          {agentsQuery.data?.map((agent) => (
            <button
              className={`agent-card ${agent.id === selectedAgentId ? "is-active" : ""}`}
              key={agent.id}
              onClick={() => {
                setSelectedAgentId(agent.id);
                setMobileSection("chat");
              }}
              type="button"
            >
              <div className="agent-card-top">
                <strong>{agent.title}</strong>
                <span>{agent.sessionCount} chats</span>
              </div>
              <p>{agent.description}</p>
              <div className="chip-row">
                <span className="chip">{agent.id}</span>
                <span className="chip">{agent.skillNames.length} skills</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <aside
        className={buildPanelClassName(
          "panel sessions-panel",
          "history",
          mobileSection
        )}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">History</p>
            <h2>{selectedAgent?.title ?? "Select an agent"}</h2>
          </div>
          <span className={`status-chip status-${status.toLowerCase()}`}>
            {status}
          </span>
        </div>
        <div className="session-list">
          {(sessionsQuery.data ?? []).map((session) => (
            <button
              className={`session-card ${session.sessionId === activeSessionId ? "is-active" : ""}`}
              key={session.sessionId}
              onClick={() => {
                if (!selectedAgentId) {
                  return;
                }
                setSelectedSessionId(selectedAgentId, session.sessionId);
                setMobileSection("chat");
              }}
              type="button"
            >
              <strong>{session.title}</strong>
              <p>{session.summary}</p>
              <span>{formatTime(session.lastTurnAt ?? session.startedAt)}</span>
            </button>
          ))}
          {!sessionsQuery.data?.length && (
            <div className="empty-state small">
              <p>Start a new thread for this agent to create local history.</p>
            </div>
          )}
        </div>
      </aside>

      <main
        className={buildPanelClassName(
          "panel chat-panel",
          "chat",
          mobileSection
        )}
      >
        <header className="chat-header">
          <div>
            <p className="eyebrow">Local Gemma chat</p>
            <h2>
              {thread?.title ?? selectedAgent?.title ?? "Choose an agent"}
            </h2>
            <p className="support-text">
              {streaming.skillActivity
                ? streaming.skillActivity
                : streaming.sending
                  ? "Streaming live"
                  : "Streaming ready"}{" "}
              · {modelTone}
            </p>
          </div>
          <div className="chat-header-controls">
            <select
              className="select"
              onChange={(event) =>
                setRuntimeConfig((current) => ({
                  ...current,
                  model: event.target.value,
                }))
              }
              value={runtimeConfig.model ?? ""}
            >
              {(modelsQuery.data ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
            <fieldset className="mode-toggle" aria-label="Thinking mode">
              <button
                className={modeValue === "fast" ? "is-active" : ""}
                onClick={() => handleModeChange("fast")}
                type="button"
              >
                Fast
              </button>
              <button
                className={modeValue === "think" ? "is-active" : ""}
                onClick={() => handleModeChange("think")}
                type="button"
              >
                Think
              </button>
            </fieldset>
          </div>
        </header>

        <div className="timeline" ref={timelineRef}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <h3>Local-first Gemma 4 chat</h3>
              <p>
                Use Fast for quick drafting and Think for slower, deeper Gemma
                runs. Agents and history are loaded from your min-kb-store
                checkout.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageCard
                key={message.key}
                turn={message.turn}
                streaming={message.streaming}
              />
            ))
          )}
        </div>

        <footer className="composer">
          {streaming.error ? (
            <p className="error-text">{streaming.error}</p>
          ) : null}
          <textarea
            className="composer-input"
            onChange={(event) => setDraft(draftKey, event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              modeValue === "fast"
                ? "Ask for a quick answer..."
                : "Ask for planning, debugging, or multi-step reasoning..."
            }
            value={draft}
          />
          <div className="composer-toolbar">
            <div className="hint-list">
              <span className="chip">{activePreset.title}</span>
              <span className="chip">
                {healthQuery.data?.lmStudioReachable
                  ? "LM Studio connected"
                  : "History-only mode"}
              </span>
            </div>
            <div className="composer-actions">
              {streaming.sending ? (
                <button
                  className="secondary-button"
                  onClick={handleStop}
                  type="button"
                >
                  Stop
                </button>
              ) : null}
              <button
                className="primary-button"
                disabled={!canSend}
                onClick={() => void handleSend()}
                type="button"
              >
                Send
              </button>
            </div>
          </div>
        </footer>
      </main>

      <aside
        className={buildPanelClassName(
          "panel detail-panel",
          "details",
          mobileSection
        )}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Details</p>
            <h2>{agentDetailQuery.data?.title ?? "No agent selected"}</h2>
          </div>
        </div>
        <section className="detail-section">
          <h3>Agent</h3>
          <p>
            {agentDetailQuery.data?.description ??
              "Select an agent to inspect its prompt bundle."}
          </p>
          <div className="chip-row">
            {(agentDetailQuery.data?.skillNames ?? []).map((skillName) => (
              <span className="chip" key={skillName}>
                {skillName}
              </span>
            ))}
          </div>
        </section>
        <section className="detail-section">
          <h3>Gemma preset</h3>
          <select
            className="select"
            onChange={(event) =>
              setRuntimeConfig((current) =>
                applyPresetRuntimeConfig(current, event.target.value)
              )
            }
            value={runtimeConfig.presetId ?? GEMMA_BALANCED_PRESET_ID}
          >
            {GEMMA_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.title}
              </option>
            ))}
          </select>
          <p>{activePreset.description}</p>
          <dl className="stats-grid">
            <div>
              <dt>Thinking</dt>
              <dd>{activePreset.lmStudioEnableThinking ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt>Max tokens</dt>
              <dd>
                {runtimeConfig.maxCompletionTokens ??
                  activePreset.maxCompletionTokens}
              </dd>
            </div>
            <div>
              <dt>Temperature</dt>
              <dd>{runtimeConfig.temperature ?? activePreset.temperature}</dd>
            </div>
            <div>
              <dt>Top P</dt>
              <dd>{runtimeConfig.topP ?? activePreset.topP}</dd>
            </div>
          </dl>
        </section>
        <section className="detail-section">
          <h3>Local status</h3>
          <p>{healthQuery.data?.message ?? "Checking LM Studio..."}</p>
          <dl className="stats-grid">
            <div>
              <dt>Store root</dt>
              <dd>{healthQuery.data?.workspace.storeRoot ?? "—"}</dd>
            </div>
            <div>
              <dt>Agents</dt>
              <dd>{healthQuery.data?.workspace.agentCount ?? 0}</dd>
            </div>
            <div>
              <dt>Models</dt>
              <dd>{healthQuery.data?.modelCount ?? 0}</dd>
            </div>
            <div>
              <dt>Default</dt>
              <dd>{healthQuery.data?.defaultModel ?? "—"}</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  );
}

function MessageCard(props: { turn: ChatTurn; streaming?: boolean }) {
  return (
    <article
      className={`message-card ${props.turn.sender === "user" ? "user" : "assistant"}`}
    >
      <div className="message-header">
        <strong>{props.turn.sender === "user" ? "You" : "Assistant"}</strong>
        <span>
          {props.streaming ? "Streaming..." : formatTime(props.turn.createdAt)}
        </span>
      </div>
      <div className={`message-body ${props.streaming ? "is-streaming" : ""}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {props.turn.bodyMarkdown}
        </ReactMarkdown>
      </div>
      {props.turn.thinkingMarkdown ? (
        <details className="thinking-details">
          <summary>Reasoning trace</summary>
          <pre>{props.turn.thinkingMarkdown}</pre>
        </details>
      ) : null}
    </article>
  );
}

function buildPanelClassName(
  baseClassName: string,
  section: MobileSection,
  activeSection: MobileSection
): string {
  return `${baseClassName} ${
    activeSection === section ? "mobile-panel-active" : "mobile-panel-hidden"
  }`;
}
