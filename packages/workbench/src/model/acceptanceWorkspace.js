import {
  DEVICE_TEMPLATE_LIMITS,
  normalizeDeviceTemplate,
} from './deviceTemplates.js';
import {
  ACCEPTANCE_LIMITS,
  acceptanceId,
  freezeJson,
  jsonBytes,
  normalizeAcceptancePlan,
  requireShape,
} from './acceptancePlan.js';
import { normalizeAcceptanceReport } from './acceptanceRunner.js';
import { mutateSettings } from './settingsMutation.js';
import { formatTimestamp } from './dateTime.js';
export const ACCEPTANCE_SETTING_KEY = 'acceptanceWorkspace';
export const EMPTY_ACCEPTANCE_DOCUMENT =
  '{"version":1,"plans":[],"reports":[]}';

// Native hosts validate this bounded opaque envelope. Full domain validation lives here.
export function normalizeAcceptanceDocument(text = EMPTY_ACCEPTANCE_DOCUMENT) {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > ACCEPTANCE_LIMITS.workspaceBytes
  )
    throw new TypeError('acceptanceWorkspace must be a bounded JSON string');
  return validateDocument(JSON.parse(text));
}
function validateDocument(doc) {
  requireShape(
    doc,
    [
      'version',
      'plans',
      'reports',
      ...(Object.hasOwn(doc, 'templates') ? ['templates'] : []),
    ],
    'acceptance workspace',
  );
  if (Object.hasOwn(doc, 'templates')) {
    if (
      !Array.isArray(doc.templates) ||
      doc.templates.length > DEVICE_TEMPLATE_LIMITS.revisions
    )
      throw new TypeError('模板库最多保留 50 个版本');
    doc.templates = doc.templates.map(normalizeDeviceTemplate);
    if (
      new Set(doc.templates.map((t) => JSON.stringify([t.id, t.version])))
        .size !== doc.templates.length
    )
      throw new TypeError('重复的模板版本');
  }
  if (
    doc.version !== 1 ||
    !Array.isArray(doc.plans) ||
    doc.plans.length > ACCEPTANCE_LIMITS.plans ||
    !Array.isArray(doc.reports) ||
    doc.reports.length > ACCEPTANCE_LIMITS.reports
  )
    throw new TypeError('acceptance workspace envelope is invalid');
  doc.plans = doc.plans.map(normalizeAcceptancePlan);
  doc.reports = doc.reports.map(normalizeAcceptanceReport);
  for (const rows of [doc.plans, doc.reports])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new TypeError('duplicate acceptance document ID');
  return doc;
}
function retained(plans, reports, templates = []) {
  const doc = {
    version: 1,
    plans,
    reports: reports.slice(-ACCEPTANCE_LIMITS.reports),
    ...(templates.length ? { templates } : {}),
  };
  while (
    jsonBytes(doc) > ACCEPTANCE_LIMITS.workspaceBytes &&
    doc.reports.length > 1
  )
    doc.reports.shift();
  // Never discard plans or the newest report to make the data fit.
  return validateDocument(doc);
}
function importedPlanId(plan, plans) {
  const taken = new Set([plan.id, ...plans.map((value) => value.id)]);
  const generated = acceptanceId();
  if (
    !taken.has(generated) &&
    jsonBytes({ ...plan, id: generated }) <= ACCEPTANCE_LIMITS.planBytes
  ) {
    return generated;
  }
  // At the byte boundary a UUID may grow a short ID. With at most 50 saved
  // plans, these 62 one-byte IDs always include an unused, different ID.
  const compact =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return [...compact].find((id) => !taken.has(id));
}
export function createAcceptanceWorkspace(
  runtime,
  { runner, onChange = () => {} },
) {
  const state = {
    plans: [],
    reports: [],
    templates: [],
    loaded: false,
    saving: false,
    error: '',
    dirty: false,
    pendingReport: null,
  };
  const listeners = new Set();
  let queue = Promise.resolve(),
    generation = 0,
    disposed = false;
  let reportOwner = null;
  const publish = () => {
    if (!disposed) {
      onChange(state);
      listeners.forEach((listener) => listener(state));
    }
  };
  function apply(doc) {
    state.plans = freezeJson(doc.plans);
    state.reports = freezeJson(doc.reports);
    state.templates = freezeJson(doc.templates ?? []);
    publish();
  }
  function schedule(operation) {
    const pending = queue.catch(() => {}).then(operation);
    queue = pending.catch(() => {});
    return pending;
  }
  async function persist() {
    if (!state.loaded)
      throw new Error('Load valid acceptance data before saving');
    state.saving = true;
    state.error = '';
    publish();
    try {
      if (state.pendingReport) normalizeAcceptanceReport(state.pendingReport);
      await mutateSettings(runtime, async () => {
        const current = await runtime.settings.getAll();
        // Validate disk data before any write, even when memory contains an unsaved draft.
        normalizeAcceptanceDocument(
          current[ACCEPTANCE_SETTING_KEY] ?? EMPTY_ACCEPTANCE_DOCUMENT,
        );
        const document = normalizeAcceptanceDocument(
          JSON.stringify(retained(state.plans, state.reports, state.templates)),
        );
        await runtime.settings.saveAll({
          ...current,
          [ACCEPTANCE_SETTING_KEY]: JSON.stringify(document),
        });
        apply(document);
        state.dirty = false;
      });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      state.saving = false;
      publish();
    }
  }
  async function edit(mutator) {
    if (!state.loaded)
      throw new Error('Load valid acceptance data before editing');
    const doc = retained(state.plans, state.reports, state.templates);
    mutator(doc);
    const next = retained(doc.plans, doc.reports, doc.templates);
    state.dirty = true;
    apply(next);
    await persist();
  }
  function ownsReport(report) {
    return (
      report &&
      reportOwner?.id === report.id &&
      reportOwner.generation === generation
    );
  }
  async function retainReport(report) {
    let snapshot;
    try {
      snapshot = normalizeAcceptanceReport(report);
    } catch (error) {
      state.pendingReport = freezeJson(structuredClone(report));
      state.dirty = true;
      state.error = error instanceof Error ? error.message : String(error);
      publish();
      throw error;
    }
    state.pendingReport = null;
    await edit((doc) => {
      doc.reports = doc.reports.filter((row) => row.id !== snapshot.id);
      doc.reports.push(snapshot);
    });
  }
  function addReport(report, expectedGeneration = generation) {
    return schedule(() => {
      if (expectedGeneration !== generation) return;
      return retainReport(report);
    });
  }
  async function reload() {
    generation++;
    reportOwner = null;
    runner.stop();
    return schedule(async () => {
      if (state.dirty)
        throw new Error('Flush unsaved acceptance data before reloading');
      try {
        const settings = await runtime.settings.getAll();
        const doc = normalizeAcceptanceDocument(
          settings[ACCEPTANCE_SETTING_KEY] ?? EMPTY_ACCEPTANCE_DOCUMENT,
        );
        apply(doc);
        state.loaded = true;
        state.error = '';
        publish();
        return state;
      } catch (error) {
        state.loaded = false;
        state.error = error instanceof Error ? error.message : String(error);
        publish();
        throw error;
      }
    });
  }
  return {
    state,
    runner,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: reload,
    reload,
    savePlan(input) {
      return schedule(async () => {
        const plan = normalizeAcceptancePlan(input);
        await edit((doc) => {
          const index = doc.plans.findIndex((row) => row.id === plan.id);
          if (index < 0) doc.plans.push(plan);
          else doc.plans[index] = plan;
        });
        return freezeJson(plan);
      });
    },
    saveTemplate(input) {
      return schedule(async () => {
        const template = normalizeDeviceTemplate(input);
        const revisions = state.templates.filter((t) => t.id === template.id);
        template.version = revisions.length
          ? Math.max(...revisions.map((t) => t.version)) + 1
          : 1;
        await edit((doc) => {
          doc.templates = [...(doc.templates ?? []), template];
        });
        return freezeJson(template);
      });
    },
    importTemplate(input) {
      if (
        typeof input === 'string' &&
        new TextEncoder().encode(input).length > DEVICE_TEMPLATE_LIMITS.bytes
      )
        throw new TypeError('模板文件超过 256 KiB');
      const template = normalizeDeviceTemplate(
        typeof input === 'string' ? JSON.parse(input) : input,
      );
      template.id = acceptanceId();
      return this.saveTemplate(template);
    },
    deletePlan(id) {
      return schedule(() =>
        edit((doc) => {
          doc.plans = doc.plans.filter((plan) => plan.id !== id);
        }),
      );
    },
    async importPlan(text) {
      if (
        typeof text !== 'string' ||
        new TextEncoder().encode(text).length > ACCEPTANCE_LIMITS.planBytes
      )
        throw new TypeError('plan import exceeds 64 KiB');
      const plan = normalizeAcceptancePlan(JSON.parse(text));
      return schedule(async () => {
        plan.id = importedPlanId(plan, state.plans);
        await edit((doc) => {
          doc.plans.push(plan);
        });
        return freezeJson(plan);
      });
    },
    exportPlan(input) {
      return JSON.stringify(normalizeAcceptancePlan(input));
    },
    async run(plan, endpointId) {
      if (!state.loaded)
        throw new Error('Load valid acceptance data before running');
      const currentGeneration = generation;
      const previousReportId = runner.state.report?.id;
      const running = runner.run(plan, endpointId);
      const startedReportId = runner.state.report?.id;
      if (startedReportId && startedReportId !== previousReportId) {
        reportOwner = { id: startedReportId, generation: currentGeneration };
      }
      const report = await running;
      if (currentGeneration === generation && !disposed && ownsReport(report)) {
        await addReport(report, currentGeneration);
      }
      return report;
    },
    stop() {
      const report = runner.stop();
      return ownsReport(report) && report.status !== 'running' && state.loaded
        ? addReport(report)
        : Promise.resolve();
    },
    flush() {
      return schedule(async () => {
        if (state.pendingReport) await retainReport(state.pendingReport);
        else if (state.dirty) await persist();
      });
    },
    async dispose() {
      const report = runner.stop();
      const shouldSave =
        ownsReport(report) && report.status !== 'running' && state.loaded;
      generation++;
      reportOwner = null;
      if (shouldSave) await addReport(report, generation);
      await queue;
      if (state.dirty) await persist();
      disposed = true;
      listeners.clear();
    },
  };
}
export function formatAcceptanceReport(input, format) {
  const report = normalizeAcceptanceReport(input);
  if (format === 'json') return JSON.stringify(report);
  if (format !== 'markdown')
    throw new TypeError('report format must be json or markdown');
  const safe = (value) =>
    String(value)
      .replace(/[\\`*_{}[\]()#+.!|<>]/g, '\\$&')
      .replace(/[\r\n]/g, ' ');
  const lines = [
    `# ${safe(report.plan.name)}`,
    '',
    `Report: ${safe(report.id)}`,
    `Target: ${safe(report.target.name)} (${safe(report.target.identity)})`,
    `Protocol: ${report.target.protocol}`,
    `Session: ${safe(report.target.sessionId)}`,
    `Started: ${formatTimestamp(report.startedAt)}`,
    `Ended: ${formatTimestamp(report.endedAt)}`,
    `Result: ${report.status}`,
    '',
  ];
  report.results.forEach((row, index) => {
    lines.push(
      `## ${index + 1}. ${safe(report.plan.checks[index].name)}`,
      '',
      `Result: ${row.status}`,
      `Started: ${formatTimestamp(row.startedAt)}`,
      `Ended: ${formatTimestamp(row.endedAt)}`,
      '',
      '```json',
      // Compact JSON is one physical line starting with "{"; embedded newlines
      // are escaped, so backticks in data cannot become closing fence lines.
      JSON.stringify({
        query: report.plan.checks[index].query,
        assertion: report.plan.checks[index].assertion,
        actual: row.actual,
        quality: row.quality,
        evidence: row.evidence,
        error: row.error,
      }),
      '```',
      '',
    );
  });
  return lines.join('\n');
}
