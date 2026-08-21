import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Plus, Settings2, Zap } from "lucide-react";
import type { CorosLinkApi } from "../../coroslink-api";
import type {
  ChatProvider,
  CoachAutomationSummary
} from "../../../electron/types";
import { CoachAutomationDetail } from "./CoachAutomationDetail";
import { CoachAutomationCreate } from "./CoachAutomationCreate";
import {
  describeTrigger,
  formatTimeAgo,
  runStatusLabel,
  skipReasonLabel
} from "./automationLabels";
import { announceRunNow } from "./runNow";

export function CoachAutomationsPanel({
  api,
  provider,
  onChanged,
  onEditingChange
}: {
  api: CorosLinkApi | undefined;
  provider: ChatProvider;
  /** Fired after any mutation so the conversation header can re-read its chips. */
  onChanged?: () => void;
  /**
   * True while a form is open. The modal uses it to stop a stray click on the
   * backdrop from throwing away what the athlete is part-way through writing.
   */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [summaries, setSummaries] = useState<CoachAutomationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<"definition" | "bindings" | "runs">(
    "definition"
  );

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setSummaries(await api.listCoachAutomations());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const editing = creating || openId !== null;
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  // Runs finish in the main process whether or not this screen is open, so the
  // cards follow the push instead of polling.
  useEffect(() => {
    if (!api?.onCoachAutomationRunUpdate) return;
    return api.onCoachAutomationRunUpdate(() => {
      void refresh();
    });
  }, [api, refresh]);

  const withBusy = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  if (creating) {
    return (
      <CoachAutomationCreate
        api={api}
        provider={provider}
        onCancel={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          void refresh();
          onChanged?.();
          // Straight into "where it runs": an automation attached to nothing
          // never fires, which is the likeliest mistake in this model.
          setOpenId(created.id);
          setOpenTab("bindings");
        }}
      />
    );
  }

  if (openId) {
    return (
      <CoachAutomationDetail
        api={api}
        provider={provider}
        automationId={openId}
        initialTab={openTab}
        onBack={() => {
          setOpenId(null);
          setOpenTab("definition");
          void refresh();
        }}
        onChanged={async () => {
          await refresh();
          onChanged?.();
        }}
      />
    );
  }

  return (
    <div className="coach-automations-panel">
      {error ? <p className="coach-automation-error">{error}</p> : null}

      {loading ? (
        <p className="chat-settings-copy">
          <Loader2 className="chat-spinner" size={14} aria-hidden="true" /> Loading…
        </p>
      ) : summaries.length === 0 ? (
        <p className="chat-settings-copy">
          No automations yet. A coach automation runs on its own — after an
          activity, for example — and writes what it finds into a conversation.
        </p>
      ) : (
        <ul className="coach-automation-card-list">
          {summaries.map((summary) => {
            const { automation, lastRun } = summary;
            const busy = busyId === automation.id;
            const runtimeBits = [
              automation.runtime.model,
              automation.runtime.effort ? `effort ${automation.runtime.effort}` : null
            ].filter(Boolean);

            return (
              <li
                key={automation.id}
                className="coach-automation-card"
                data-enabled={automation.enabled ? "true" : "false"}
              >
                <div className="coach-automation-card-head">
                  <span className="coach-automation-card-name">
                    <Zap size={15} aria-hidden="true" />
                    {automation.name}
                  </span>
                  <label className="coach-automation-switch">
                    <input
                      type="checkbox"
                      checked={automation.enabled}
                      disabled={busy || !api}
                      onChange={(event) =>
                        void withBusy(automation.id, () =>
                          (api as CorosLinkApi).setCoachAutomationEnabled(
                            automation.id,
                            event.target.checked
                          )
                        )
                      }
                    />
                    <span>{automation.enabled ? "On" : "Off"}</span>
                  </label>
                </div>

                <p className="coach-automation-card-trigger">
                  {describeTrigger(automation.trigger)}
                  {runtimeBits.length ? ` · ${runtimeBits.join(" · ")}` : ""}
                </p>

                <p className="coach-automation-card-status">
                  {summary.bindingCount === 0 ? (
                    <button
                      type="button"
                      className="chat-inline-link coach-automation-unattached"
                      onClick={() => {
                        setOpenId(automation.id);
                        setOpenTab("bindings");
                      }}
                    >
                      Not attached anywhere — it will never run
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chat-inline-link"
                      onClick={() => {
                        setOpenId(automation.id);
                        setOpenTab("bindings");
                      }}
                    >
                      Runs in {summary.bindingCount} place
                      {summary.bindingCount === 1 ? "" : "s"}
                    </button>
                  )}
                  {lastRun ? (
                    <>
                      {" · "}Last run {formatTimeAgo(lastRun.startedAt)}
                      {lastRun.summary
                        ? ` · “${lastRun.summary}”`
                        : lastRun.skipReason
                          ? ` · skipped (${skipReasonLabel(lastRun.skipReason)})`
                          : ` · ${runStatusLabel(lastRun)}`}
                    </>
                  ) : null}
                </p>

                <div className="coach-automation-card-actions">
                  <button
                    type="button"
                    className="chat-local-action"
                    disabled={busy || !api || summary.enabledBindingCount === 0}
                    title={
                      summary.enabledBindingCount === 0
                        ? "Attach it to a conversation first."
                        : undefined
                    }
                    onClick={() =>
                      void withBusy(automation.id, async () =>
                        announceRunNow(
                          await (api as CorosLinkApi).runCoachAutomationNow(
                            automation.id
                          )
                        )
                      )
                    }
                  >
                    {busy ? (
                      <Loader2 className="chat-spinner" size={14} aria-hidden="true" />
                    ) : (
                      <Play size={14} aria-hidden="true" />
                    )}
                    Run now
                  </button>
                  <button
                    type="button"
                    className="chat-local-action"
                    onClick={() => {
                      setOpenId(automation.id);
                      setOpenTab("definition");
                    }}
                  >
                    <Settings2 size={14} aria-hidden="true" /> Manage
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        className="primary-button coach-automation-new"
        disabled={!api}
        onClick={() => setCreating(true)}
      >
        <Plus size={14} aria-hidden="true" /> New automation
      </button>
    </div>
  );
}
