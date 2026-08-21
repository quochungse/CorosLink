import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquare, Plus, Sparkles } from "lucide-react";
import type { CorosLinkApi } from "../../coroslink-api";
import type {
  AutomationBindingMode,
  ChatProvider,
  ChatSessionSummary,
  CoachAutomationBindingInput,
  CoachAutomationBindingView
} from "../../../electron/types";
import { formatSessionRelativeTime } from "../chatSessionGroups";

/** Section 2.2: the sixth automation on one conversation is refused. */
const MAX_PER_SESSION = 5;

export function AttachAutomationScreen({
  api,
  provider,
  automationId,
  automationName,
  existingBindings,
  suggestedTitleTemplate,
  onClose,
  onAttached
}: {
  api: CorosLinkApi | undefined;
  provider: ChatProvider;
  automationId: string;
  automationName: string;
  existingBindings: CoachAutomationBindingView[];
  suggestedTitleTemplate?: string;
  onClose: () => void;
  onAttached: () => void | Promise<void>;
}) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleTemplate, setTitleTemplate] = useState(
    suggestedTitleTemplate ?? "{{rule.name}} · {{activity.name}} · {{date}}"
  );

  useEffect(() => {
    let cancelled = false;
    if (!api) return;

    void (async () => {
      try {
        const [list, automations] = await Promise.all([
          api.listChatSessions(provider),
          api.listCoachAutomations()
        ]);
        // Counting from the automations side is O(automations) round-trips
        // rather than one per conversation, and automations are few.
        const perSession: Record<string, number> = {};
        const bindingLists = await Promise.all(
          automations.map((summary) =>
            api.listCoachAutomationBindings(summary.automation.id)
          )
        );
        for (const bindings of bindingLists) {
          for (const binding of bindings) {
            if (!binding.sessionId) continue;
            perSession[binding.sessionId] = (perSession[binding.sessionId] ?? 0) + 1;
          }
        }
        if (cancelled) return;
        setSessions(list);
        setCounts(perSession);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, provider]);

  const attachedSessionIds = useMemo(
    () =>
      new Set(
        existingBindings
          .map((binding) => binding.sessionId)
          .filter((id): id is string => Boolean(id))
      ),
    [existingBindings]
  );
  const hasPerRun = existingBindings.some((binding) => binding.mode === "per-run");

  const attach = async (input: CoachAutomationBindingInput) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.attachCoachAutomation(input);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await onAttached();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const attachMode = (mode: AutomationBindingMode, sessionId?: string) =>
    attach({
      automationId,
      mode,
      ...(sessionId ? { sessionId } : {}),
      ...(mode === "per-run" && titleTemplate.trim()
        ? { titleTemplate: titleTemplate.trim() }
        : {})
    });

  return (
    <div className="coach-automation-attach-screen">
      {error ? <p className="coach-automation-error">{error}</p> : null}

      <div className="coach-automation-attach-body">
        <div className="coach-automation-attach-mode">
          <div className="coach-automation-attach-mode-head">
            <Sparkles size={15} aria-hidden="true" />
            <div>
              <strong>A new conversation each run</strong>
              <p>Every trigger starts its own thread. Best for debriefs.</p>
            </div>
          </div>
          <label className="chat-local-field">
            <span>Conversation title</span>
            <input
              type="text"
              value={titleTemplate}
              disabled={hasPerRun || busy}
              onChange={(event) => setTitleTemplate(event.target.value)}
            />
          </label>
          <p className="coach-automation-hint">
            Variables: {"{{rule.name}}"}, {"{{date}}"}, {"{{activity.name}}"},{" "}
            {"{{activity.sport}}"}, {"{{week.range}}"}
          </p>
          <button
            type="button"
            className="chat-local-action coach-automation-attach-action"
            disabled={hasPerRun || busy || !api}
            title={
              hasPerRun
                ? "This automation already starts a new conversation on every run."
                : undefined
            }
            onClick={() => void attachMode("per-run")}
          >
            {busy ? (
              <Loader2 className="chat-spinner" size={14} aria-hidden="true" />
            ) : (
              <Plus size={14} aria-hidden="true" />
            )}
            {hasPerRun ? "Already set up" : "Use a new conversation each run"}
          </button>
        </div>

        <div className="coach-automation-attach-mode">
          <div className="coach-automation-attach-mode-head">
            <MessageSquare size={15} aria-hidden="true" />
            <div>
              <strong>One dedicated conversation</strong>
              <p>
                Creates a thread named after the automation and always appends
                to it, so the coach sees what it said last time.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="chat-local-action coach-automation-attach-action"
            disabled={busy || !api}
            onClick={() => void attachMode("dedicated")}
          >
            Create a dedicated conversation
          </button>
        </div>

        <div className="coach-automation-attach-existing">
          <h4>Or add it to a conversation you already have</h4>
          {loading ? (
            <p className="chat-settings-copy">
              <Loader2 className="chat-spinner" size={14} aria-hidden="true" />{" "}
              Loading conversations…
            </p>
          ) : sessions.length === 0 ? (
            <p className="chat-settings-copy">No conversations yet.</p>
          ) : (
            <ul className="coach-automation-session-list">
              {sessions.map((session) => {
                const count = counts[session.id] ?? 0;
                const alreadyHere = attachedSessionIds.has(session.id);
                const full = count >= MAX_PER_SESSION;
                const disabled = busy || alreadyHere || full;
                // 2.2: the control is disabled *with the reason shown*, so a
                // full conversation never looks like a broken button.
                const reason = alreadyHere
                  ? "Already running here"
                  : full
                    ? `Full — ${MAX_PER_SESSION} automations already`
                    : count === 1
                      ? "1 automation"
                      : count > 1
                        ? `${count} automations`
                        : "";

                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="coach-automation-session-row"
                      data-disabled={disabled ? "true" : undefined}
                      disabled={disabled}
                      title={full ? `A conversation can run at most ${MAX_PER_SESSION} automations.` : undefined}
                      onClick={() => void attachMode("existing", session.id)}
                    >
                      <span className="coach-automation-session-title">
                        {session.title}
                      </span>
                      <span className="coach-automation-session-meta">
                        {formatSessionRelativeTime(session.updatedAt)}
                        {reason ? ` · ${reason}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
