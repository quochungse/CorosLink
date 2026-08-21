import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2
} from "lucide-react";
import type { CorosLinkApi } from "../../coroslink-api";
import type {
  ChatProvider,
  CoachAutomation,
  CoachAutomationBindingView,
  CoachAutomationInput,
  CoachAutomationRun
} from "../../../electron/types";
import { AutomationDefinitionForm } from "./AutomationDefinitionForm";
import { AttachAutomationScreen } from "./AttachAutomationScreen";
import { useAutomationsNav } from "./automationsNav";
import { DeleteAutomationDialog } from "./DeleteAutomationDialog";
import { COACH_AUTOMATION_PRESETS } from "./presets";
import {
  bindingModeLabel,
  describeBindingMode,
  formatDuration,
  formatTimeAgo,
  runStatusLabel,
  skipReasonLabel
} from "./automationLabels";

type Tab = "definition" | "bindings" | "runs";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "definition", label: "Definition" },
  { id: "bindings", label: "Where it runs" },
  { id: "runs", label: "Run log" }
];

/**
 * The definition fields this screen edits. `enabled` is deliberately left out:
 * the master switch lives on the list, and sending a stale copy of it back
 * with a save would silently flip it.
 */
function toInput(automation: CoachAutomation): CoachAutomationInput {
  return {
    name: automation.name,
    playbook: automation.playbook,
    trigger: automation.trigger,
    conditions: automation.conditions,
    runtime: automation.runtime,
    ...(automation.role ? { role: automation.role } : {}),
    ...(automation.presetId ? { presetId: automation.presetId } : {})
  };
}

/**
 * A stable serialisation for telling an edited form from an untouched one.
 * Key order and empty optional fields are normalized away: typing into Role and
 * clearing it again leaves `role: ""` where the stored value simply has no
 * role, which a plain JSON compare would report as a change.
 */
function fingerprint(input: CoachAutomationInput): string {
  const trimmed = (value: string | undefined) => value?.trim() || undefined;
  return JSON.stringify({
    name: trimmed(input.name),
    role: trimmed(input.role),
    playbook: trimmed(input.playbook),
    presetId: trimmed(input.presetId),
    trigger: input.trigger,
    conditions: {
      batchWindowMin: input.conditions?.batchWindowMin,
      cooldownMin: input.conditions?.cooldownMin,
      maxRunsPerDay: input.conditions?.maxRunsPerDay,
      quietHours: input.conditions?.quietHours ?? null
    },
    runtime: {
      provider: input.runtime?.provider ?? null,
      model: trimmed(input.runtime?.model) ?? null,
      effort: input.runtime?.effort ?? null
    }
  });
}

export function CoachAutomationDetail({
  api,
  provider,
  automationId,
  initialTab = "definition",
  onBack,
  onChanged
}: {
  api: CorosLinkApi | undefined;
  provider: ChatProvider;
  automationId: string;
  initialTab?: Tab;
  onBack: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [automation, setAutomation] = useState<CoachAutomation | null>(null);
  const [draft, setDraft] = useState<CoachAutomationInput | null>(null);
  /** The last-saved definition, to tell an edited form from an untouched one. */
  const [saved, setSaved] = useState<CoachAutomationInput | null>(null);
  const [bindings, setBindings] = useState<CoachAutomationBindingView[]>([]);
  const [runs, setRuns] = useState<CoachAutomationRun[]>([]);
  const [runFilter, setRunFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyBindingId, setBusyBindingId] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so `refresh` does not change identity when the parent
  // re-renders — the list screen refreshes on every run update, which would
  // otherwise refetch this screen each time.
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const detail = await api.getCoachAutomation(automationId);
      if (!detail) {
        onBackRef.current();
        return;
      }
      setAutomation(detail.automation);
      const stored = toInput(detail.automation);
      setSaved(stored);
      setDraft((current) => current ?? stored);
      setBindings(detail.bindings);
      setRuns(await api.listCoachAutomationRuns({ automationId, limit: 50 }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [api, automationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A run started from here finishes in the main process, so the screen
  // follows the push rather than polling for it.
  useEffect(() => {
    if (!api?.onCoachAutomationRunUpdate) return;
    return api.onCoachAutomationRunUpdate((run) => {
      if (run.automationId !== automationId) return;
      setRuns((previous) => [
        run,
        ...previous.filter((entry) => entry.id !== run.id)
      ]);
    });
  }, [api, automationId]);

  const patchDraft = (patch: Partial<CoachAutomationInput>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async () => {
    if (!api || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveCoachAutomation(draft, automationId);
      // The store clamps and normalizes, so show what was stored rather than
      // leaving the form displaying a value that was never accepted.
      if (result) {
        const stored = toInput(result);
        setDraft(stored);
        setSaved(stored);
      }
      await refresh();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const withBindingBusy = async (bindingId: string, work: () => Promise<unknown>) => {
    setBusyBindingId(bindingId);
    setError(null);
    try {
      await work();
      await refresh();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyBindingId(null);
    }
  };

  const move = (binding: CoachAutomationBindingView, delta: number) => {
    if (!api || !binding.sessionId) return;
    const siblings = bindings
      .filter((entry) => entry.sessionId === binding.sessionId)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const index = siblings.findIndex((entry) => entry.id === binding.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    void withBindingBusy(binding.id, () =>
      api.reorderCoachAutomationBindings(
        binding.sessionId as string,
        reordered.map((entry) => entry.id)
      )
    );
  };

  const closeAttach = useCallback(() => setAttachOpen(false), []);
  useAutomationsNav(
    attachOpen
      ? { title: `Where should ${automation?.name ?? "this coach"} run?`, onBack: closeAttach }
      : { title: automation?.name ?? "Automation", onBack }
  );

  if (loading || !automation || !draft) {
    return (
      <div className="coach-automation-detail">
        <p className="chat-settings-copy">
          <Loader2 className="chat-spinner" size={14} aria-hidden="true" /> Loading…
        </p>
      </div>
    );
  }

  const dirty = saved !== null && fingerprint(draft) !== fingerprint(saved);
  const complete = draft.name.trim().length > 0 && draft.playbook.trim().length > 0;
  const filteredRuns =
    runFilter === "all" ? runs : runs.filter((run) => run.bindingId === runFilter);
  // Several coaches in one conversation run in order, so reordering is only
  // offered where that order actually means something (2.2 constraint 4).
  const sharedSessions = new Set(
    bindings
      .map((binding) => binding.sessionId)
      .filter(
        (sessionId, index, all): sessionId is string =>
          Boolean(sessionId) && all.indexOf(sessionId) !== index
      )
  );

  if (attachOpen) {
    return (
      <AttachAutomationScreen
        api={api}
        provider={provider}
        automationId={automationId}
        automationName={automation.name}
        existingBindings={bindings}
        suggestedTitleTemplate={
          COACH_AUTOMATION_PRESETS.find(
            (preset) => preset.id === automation.presetId
          )?.suggestedBinding.titleTemplate
        }
        onClose={() => setAttachOpen(false)}
        onAttached={async () => {
          await refresh();
          await onChanged();
        }}
      />
    );
  }

  return (
    <div className="coach-automation-detail">
      <nav className="coach-automation-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className="coach-automation-tab"
            data-active={tab === entry.id ? "true" : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === "bindings" ? ` (${bindings.length})` : ""}
          </button>
        ))}
      </nav>

      {error ? <p className="coach-automation-error">{error}</p> : null}

      {tab === "definition" ? (
        <div className="coach-automation-tabpanel">
          <AutomationDefinitionForm
            draft={draft}
            provider={provider}
            disabled={saving}
            onChange={patchDraft}
          />

          <div className="coach-automation-save-row">
            {/* The label and the enabled state must answer to the same
                condition. Driving the label off `dirty` alone left the button
                reading "Save changes" while still greyed out because the
                playbook was empty, with nothing on screen saying why. */}
            {!complete ? (
              <span className="coach-automation-save-reason">
                A name and a playbook are required before this can be saved.
              </span>
            ) : null}
            <button
              type="button"
              className="primary-button"
              disabled={saving || !dirty || !complete}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="chat-spinner" size={14} aria-hidden="true" />
              ) : null}
              {dirty || !complete ? "Save changes" : "Saved"}
            </button>
          </div>

          <div className="coach-automation-danger-zone">
            <div>
              <strong>Delete this automation</strong>
              <p>
                Removes it from every conversation it runs in. The conversations
                and what it already wrote are kept.
              </p>
            </div>
            <button
              type="button"
              className="chat-local-action is-danger"
              disabled={saving || !api}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} aria-hidden="true" /> Delete
            </button>
          </div>
        </div>
      ) : null}

      {tab === "bindings" ? (
        <div className="coach-automation-tabpanel">
          <div className="coach-automation-bindings-head">
            <p className="chat-settings-copy">
              {bindings.length === 0
                ? "Not attached anywhere yet — this automation will never run."
                : `Runs in ${bindings.length} place${bindings.length === 1 ? "" : "s"} → ${bindings.length} model call${bindings.length === 1 ? "" : "s"} per trigger.`}
            </p>
            <button
              type="button"
              className="primary-button"
              disabled={!api}
              onClick={() => setAttachOpen(true)}
            >
              <Plus size={14} aria-hidden="true" /> Attach to a conversation
            </button>
          </div>

          <ul className="coach-automation-binding-list">
            {bindings.map((binding) => {
              const busy = busyBindingId === binding.id;
              // Same rule the runner applies: the master switch gates every
              // place the automation is attached.
              const masterOff = !automation.enabled;
              const live = binding.enabled && !masterOff;
              const lastRun = runs.find((run) => run.bindingId === binding.id);
              const canReorder =
                Boolean(binding.sessionId) && sharedSessions.has(binding.sessionId as string);
              return (
                <li
                  key={binding.id}
                  className="coach-automation-binding-row"
                  data-broken={binding.sessionMissing ? "true" : undefined}
                  data-off={live ? undefined : "true"}
                >
                  <label
                    className="coach-automation-switch coach-automation-binding-switch"
                    title={
                      masterOff
                        ? "This automation is switched off, so none of its places run."
                        : live
                          ? "Runs here"
                          : "Paused here"
                    }
                  >
                    <input
                      type="checkbox"
                      aria-label={
                        live ? "Pause this place" : "Resume this place"
                      }
                      checked={live}
                      disabled={busy || !api || masterOff}
                      onChange={(event) =>
                        void withBindingBusy(binding.id, () =>
                          (api as CorosLinkApi).setCoachAutomationBindingEnabled(
                            binding.id,
                            event.target.checked
                          )
                        )
                      }
                    />
                  </label>
                  <div className="coach-automation-binding-main">
                    <span className="coach-automation-binding-title">
                      {binding.mode === "per-run" ? (
                        <Sparkles size={14} aria-hidden="true" />
                      ) : null}
                      {bindingModeLabel(binding)}
                    </span>
                    <span className="coach-automation-binding-meta">
                      {describeBindingMode(binding)}
                      {lastRun
                        ? ` · last run ${formatTimeAgo(lastRun.startedAt)} · ${runStatusLabel(lastRun)}`
                        : " · never run"}
                    </span>
                    {binding.sessionMissing ? (
                      <span className="coach-automation-binding-warning">
                        That conversation was deleted. Attach it somewhere else.
                      </span>
                    ) : null}
                  </div>

                  <div className="coach-automation-binding-actions">
                    {canReorder ? (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Run earlier in this conversation"
                          disabled={busy}
                          onClick={() => move(binding, -1)}
                        >
                          <ArrowUp size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Run later in this conversation"
                          disabled={busy}
                          onClick={() => move(binding, 1)}
                        >
                          <ArrowDown size={15} aria-hidden="true" />
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Run here now"
                      title="Run here now"
                      disabled={busy || !api}
                      onClick={() =>
                        void withBindingBusy(binding.id, () =>
                          (api as CorosLinkApi).runCoachAutomationNow(automationId, [
                            binding.id
                          ])
                        )
                      }
                    >
                      <Play size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Detach"
                      title="Detach — the conversation is kept"
                      disabled={busy || !api}
                      onClick={() =>
                        void withBindingBusy(binding.id, () =>
                          (api as CorosLinkApi).detachCoachAutomation(binding.id)
                        )
                      }
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="coach-automation-tabpanel">
          <label className="chat-local-field coach-automation-run-filter">
            <span>Filter</span>
            <select
              value={runFilter}
              onChange={(event) => setRunFilter(event.target.value)}
            >
              <option value="all">All places</option>
              {bindings.map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {bindingModeLabel(binding)}
                </option>
              ))}
            </select>
          </label>

          {filteredRuns.length === 0 ? (
            <p className="chat-settings-copy">
              No runs yet. Every run is logged here, including the ones that found
              nothing to report.
            </p>
          ) : (
            <ul className="coach-automation-run-list">
              {filteredRuns.map((run) => (
                <li key={run.id} className="coach-automation-run-row">
                  <span
                    className="coach-automation-run-status"
                    data-status={run.status}
                  >
                    {runStatusLabel(run)}
                  </span>
                  <div className="coach-automation-run-body">
                    <span className="coach-automation-run-summary">
                      {run.summary ??
                        (run.skipReason
                          ? `Skipped — ${skipReasonLabel(run.skipReason)}`
                          : run.error ?? "—")}
                    </span>
                    <span className="coach-automation-run-meta">
                      {formatTimeAgo(run.startedAt)} · {formatDuration(run)}
                      {run.model ? ` · ${run.model}` : ""}
                      {run.effort ? ` · effort ${run.effort}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {deleteOpen ? (
        <DeleteAutomationDialog
          api={api}
          automationId={automationId}
          automationName={automation.name}
          bindings={bindings}
          onClose={() => setDeleteOpen(false)}
          onDeleted={async () => {
            setDeleteOpen(false);
            await onChanged();
            onBack();
          }}
        />
      ) : null}
    </div>
  );
}
