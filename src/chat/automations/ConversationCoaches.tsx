import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Plus, Trash2, Zap } from "lucide-react";
import type { CorosLinkApi } from "../../coroslink-api";
import type {
  CoachAutomationBindingView,
  CoachAutomationSummary
} from "../../../electron/types";
import { describeTrigger, formatTimeAgo } from "./automationLabels";
import { AttachCoachToConversationDialog } from "./AttachCoachToConversationDialog";
import { announceRunNow } from "./runNow";

/** Section 2.2: a conversation runs at most five automations. */
const MAX_PER_SESSION = 5;

/**
 * The coaches attached to the open conversation, plus the popover to manage
 * them. This is the second entry point into the binding model and the one most
 * athletes will use, so it mirrors the settings screen rather than replacing it.
 */
export function ConversationCoaches({
  api,
  sessionId,
  refreshVersion = 0,
  onManageAutomations
}: {
  api: CorosLinkApi | undefined;
  sessionId: string | null;
  /** Bumped by the Automations screen so the chips follow what it changed. */
  refreshVersion?: number;
  onManageAutomations: () => void;
}) {
  const [bindings, setBindings] = useState<CoachAutomationBindingView[]>([]);
  const [automations, setAutomations] = useState<CoachAutomationSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!api || !sessionId) {
      setBindings([]);
      return;
    }
    try {
      // The chips need the automation's name, which a binding does not carry.
      const [attached, all] = await Promise.all([
        api.listCoachAutomationsForSession(sessionId),
        api.listCoachAutomations()
      ]);
      setBindings(attached);
      setAutomations(all);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    // refreshVersion is not read in the body: it is here purely so the
    // Automations screen can force a re-read by bumping it.
  }, [api, sessionId, refreshVersion]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Runs finish in the main process even with this view closed, so the chips
  // follow the push rather than polling.
  useEffect(() => {
    if (!api?.onCoachAutomationRunUpdate) return;
    return api.onCoachAutomationRunUpdate((run) => {
      if (run.sessionId && run.sessionId !== sessionId) return;
      void refresh();
    });
  }, [api, sessionId, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const withBusy = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  const move = (binding: CoachAutomationBindingView, delta: number) => {
    if (!api || !sessionId) return;
    const ordered = [...bindings].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = ordered.findIndex((entry) => entry.id === binding.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    void withBusy(binding.id, () =>
      api.reorderCoachAutomationBindings(
        sessionId,
        ordered.map((entry) => entry.id)
      )
    );
  };

  if (!sessionId) return null;

  const sorted = [...bindings].sort((a, b) => a.sortOrder - b.sortOrder);
  const automationOf = (automationId: string) =>
    automations.find((entry) => entry.automation.id === automationId)?.automation;
  /**
   * A binding only runs when its own switch AND the automation's master switch
   * are on, which is what the runner checks. The UI has to show the same thing
   * or an athlete reads "on" beside a coach that will never fire.
   */
  const isLive = (binding: CoachAutomationBindingView) =>
    binding.enabled && automationOf(binding.automationId)?.enabled !== false;
  const liveCount = bindings.filter((binding) => isLive(binding)).length;

  return (
    <div className="chat-coaches" ref={containerRef}>
      {/* A single chip, whatever is attached: five separate chips crowded the
          header and told the athlete nothing they could not get by opening it. */}
      <button
        type="button"
        className="chat-coaches-pill"
        data-empty={bindings.length === 0 ? "true" : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        title={
          liveCount
            ? `${liveCount} automation${liveCount === 1 ? "" : "s"} run in this conversation`
            : "No automations run in this conversation"
        }
      >
        <Zap size={13} aria-hidden="true" />
        Automation Coaches
        {liveCount ? (
          <span className="chat-coaches-count">{liveCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="chat-coaches-panel" role="dialog" aria-label="Manage coaches">
          <div className="chat-coaches-panel-head">
            <strong>Coaches in this conversation</strong>
            <span>
              {liveCount}/{MAX_PER_SESSION}
            </span>
          </div>

          {error ? <p className="coach-automation-error">{error}</p> : null}

          {bindings.length === 0 ? (
            <p className="chat-coaches-empty">
              No automation writes into this conversation yet.
            </p>
          ) : (
            <ul className="chat-coaches-list">
              {sorted.map((binding, index, all) => {
                  const summary = automations.find(
                    (entry) => entry.automation.id === binding.automationId
                  );
                  const busy = busyId === binding.id;
                  const name = summary?.automation.name ?? "Automation";
                  const masterOff = summary?.automation.enabled === false;
                  const live = isLive(binding);
                  return (
                    <li
                      key={binding.id}
                      className="chat-coaches-row"
                      data-off={live ? undefined : "true"}
                    >
                      <label
                        className="coach-automation-switch chat-coaches-row-switch"
                        title={
                          masterOff
                            ? `${name} is switched off everywhere. Turn it on from Manage automations.`
                            : live
                              ? "Running here"
                              : "Paused here"
                        }
                      >
                        <input
                          type="checkbox"
                          aria-label={
                            live
                              ? `Pause ${name} in this conversation`
                              : `Resume ${name} in this conversation`
                          }
                          checked={live}
                          disabled={busy || !api || masterOff}
                          onChange={(event) =>
                            void withBusy(binding.id, () =>
                              (api as CorosLinkApi).setCoachAutomationBindingEnabled(
                                binding.id,
                                event.target.checked
                              )
                            )
                          }
                        />
                      </label>
                      <div className="chat-coaches-row-main">
                        <span className="chat-coaches-row-name">
                          <Zap size={12} aria-hidden="true" />
                          {summary?.automation.name ?? "Automation"}
                        </span>
                        <span className="chat-coaches-row-meta">
                          {summary
                            ? describeTrigger(summary.automation.trigger)
                            : "—"}
                          {binding.lastRunAt
                            ? ` · last run ${formatTimeAgo(binding.lastRunAt)}`
                            : " · never run"}
                        </span>
                      </div>
                      <div className="chat-coaches-row-actions">
                        {/* Order only matters once several coaches share the
                            conversation: they run sequentially in it. */}
                        {all.length > 1 ? (
                          <>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Run earlier"
                              disabled={busy || index === 0}
                              onClick={() => move(binding, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Run later"
                              disabled={busy || index === all.length - 1}
                              onClick={() => move(binding, 1)}
                            >
                              ↓
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Run now here"
                          title="Run now here"
                          disabled={busy || !api}
                          onClick={() =>
                            void withBusy(binding.id, async () =>
                              announceRunNow(
                                await (api as CorosLinkApi).runCoachAutomationNow(
                                  binding.automationId,
                                  [binding.id]
                                )
                              )
                            )
                          }
                        >
                          {busy ? (
                            <Loader2
                              className="chat-spinner"
                              size={14}
                              aria-hidden="true"
                            />
                          ) : (
                            <Play size={14} aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Detach"
                          title="Detach — this conversation is kept"
                          disabled={busy || !api}
                          onClick={() =>
                            void withBusy(binding.id, () =>
                              (api as CorosLinkApi).detachCoachAutomation(binding.id)
                            )
                          }
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}

          <div className="chat-coaches-panel-foot">
            <button
              type="button"
              className="chat-coaches-attach"
              disabled={busyId !== null || !api}
              onClick={() => setAttachOpen(true)}
            >
              <Plus size={13} aria-hidden="true" /> Attach Automation Coach
            </button>
            <button
              type="button"
              className="chat-coaches-manage"
              onClick={() => {
                setOpen(false);
                onManageAutomations();
              }}
            >
              Manage automations
            </button>
          </div>
        </div>
      ) : null}

      {attachOpen && sessionId ? (
        <AttachCoachToConversationDialog
          api={api}
          sessionId={sessionId}
          attached={bindings}
          onClose={() => setAttachOpen(false)}
          onAttached={refresh}
        />
      ) : null}
    </div>
  );
}
