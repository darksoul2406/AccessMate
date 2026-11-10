import { SETTINGS_LIMITS } from "../profiles/profile-manager.js";

const PREFIX = "accessmate:page-zoom:v1:";
const near = (a, b) => Math.abs(a - b) < 0.000001;
const same = (a, b) => near(a.factor, b.factor) && a.mode === b.mode && a.scope === b.scope;
const validZoom = (value) => value === null || (typeof value === "number" && Number.isFinite(value) &&
  value >= SETTINGS_LIMITS.zoom.min && value <= SETTINGS_LIMITS.zoom.max);
const validSnapshot = (value) => value && typeof value.factor === "number" && Number.isFinite(value.factor) &&
  value.factor > 0 && value.factor <= 10 && ["automatic", "manual", "disabled"].includes(value.mode) &&
  ["per-tab", "per-origin"].includes(value.scope);

/**
 * Native browser zoom belongs in an extension page, outside the DOM adapters.
 * Importing/creating this controller does not change zoom or register listeners.
 *
 * The caller must serialize it with page commands and provide an isCurrent
 * callback that checks its pinned tab/document session. Chrome zoom setters take
 * a tab ID, so check that session again before each browser write. Page-history
 * integration supplies the desired percentage after preview, Undo, or Restore;
 * this controller does not maintain a second, competing undo history.
 *
 * Session storage retains the original zoom when the panel closes/reopens.
 * Records are per tab AND document; navigation starts a fresh baseline because
 * Chrome resets per-tab zoom on navigation. Same-document URL changes keep the
 * baseline. Session records store no URLs, page text, or form values.
 */
export function createPageZoomController({
  tabs = globalThis.chrome?.tabs,
  storage = globalThis.chrome?.storage?.session,
  isCurrent,
} = {}) {
  if (!tabs || ["get", "getZoom", "getZoomSettings", "setZoom", "setZoomSettings"].some((key) => typeof tabs[key] !== "function") ||
    !storage || ["get", "set", "remove"].some((key) => typeof storage[key] !== "function") || typeof isCurrent !== "function") {
    throw new TypeError("Page zoom requires browser APIs, session storage, and a current-document check.");
  }
  let work = Promise.resolve();
  function queue(task) {
    const result = work.then(task, task);
    work = result.then(() => {}, () => {});
    return result;
  }
  function targetOf(target) {
    if (!target || !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
      typeof target.documentId !== "string" || !target.documentId.length || target.documentId.length > 200 ||
      typeof target.url !== "string" || target.url.length > 8192 || !/^https?:\/\//.test(target.url)) {
      throw new TypeError("A pinned HTTP or HTTPS page is required for zoom.");
    }
    const url = new URL(target.url);
    if (url.username || url.password) throw new TypeError("Page credentials are not a zoom target.");
    return { tabId: target.tabId, documentId: target.documentId, url: target.url };
  }
  async function check(target) {
    if (!await isCurrent(target)) throw new Error("The page changed before zoom could update.");
    const tab = await tabs.get(target.tabId);
    if (tab.url !== target.url || tab.status !== "complete" || !await isCurrent(target)) {
      throw new Error("The page changed before zoom could update.");
    }
  }
  async function inspect(target) {
    await check(target);
    const [factor, settings] = await Promise.all([tabs.getZoom(target.tabId), tabs.getZoomSettings(target.tabId)]);
    await check(target);
    const snapshot = { factor, mode: settings.mode, scope: settings.scope };
    if (!validSnapshot(snapshot)) throw new Error("Chrome did not return valid zoom settings.");
    return snapshot;
  }
  async function load(target) {
    const value = (await storage.get(PREFIX + target.tabId))[PREFIX + target.tabId];
    if (value === undefined) return null;
    if (!value || value.version !== 1 || typeof value.documentId !== "string" ||
      !validSnapshot(value.baseline) || !validSnapshot(value.expected) ||
      (value.pendingBefore != null && !validSnapshot(value.pendingBefore)) || !validZoom(value.requested) || typeof value.owned !== "boolean") {
      throw new Error("The saved zoom session is invalid; it was left unchanged.");
    }
    return value.documentId === target.documentId ? structuredClone(value) : null;
  }
  const save = (target, record) => storage.set({ [PREFIX + target.tabId]: record });
  const remove = (target) => storage.remove(PREFIX + target.tabId);
  const result = (current, record, manualOverride = false) => ({
    percentage: Number((current.factor * 100).toFixed(4)),
    requestedZoom: record?.requested ?? null,
    changed: !!record?.owned && !same(current, record.baseline),
    manualOverride,
  });

  // Check ownership both before and after persisting a planned browser write.
  // Saving first makes the original available if the extension panel closes.
  async function write(target, record, next, action, adoptOrigin = false) {
    const before = record.expected;
    if (!same(await inspect(target), before)) throw new Error("Chrome zoom changed outside AccessMate.");
    record.pendingBefore = before;
    record.expected = next;
    await save(target, record);
    if (!same(await inspect(target), before)) throw new Error("Chrome zoom changed outside AccessMate.");
    await check(target);
    await action();
    const actual = await inspect(target);
    // Returning to per-origin scope can legitimately adopt a newer origin zoom
    // chosen in another tab. Never set a factor after restoring that scope.
    if (!(adoptOrigin && actual.mode === next.mode && actual.scope === "per-origin") && !same(actual, next)) {
      throw new Error("Chrome could not apply the requested zoom.");
    }
    record.expected = actual;
    record.pendingBefore = null;
    await save(target, record);
    return actual;
  }
  async function restoreSnapshot(target, record, snapshot) {
    if (record.expected.mode !== "automatic" || snapshot.mode !== "automatic") {
      throw new Error("Chrome zoom is managed by another mode.");
    }
    if (record.expected.scope !== "per-tab") {
      await write(target, record, { ...record.expected, scope: "per-tab" },
        () => tabs.setZoomSettings(target.tabId, { mode: "automatic", scope: "per-tab" }));
    }
    if (!near(record.expected.factor, snapshot.factor)) {
      await write(target, record, { ...record.expected, factor: snapshot.factor },
        () => tabs.setZoom(target.tabId, snapshot.factor));
    }
    if (snapshot.scope !== record.expected.scope) {
      await write(target, record, { ...snapshot },
        () => tabs.setZoomSettings(target.tabId, { mode: snapshot.mode, scope: snapshot.scope }), snapshot.scope === "per-origin");
    }
  }

  async function apply(target, percentage, { preserveManual, force }) {
    if (!validZoom(percentage)) throw new TypeError("Invalid page zoom preference.");
    let current = await inspect(target), record = await load(target);
    await check(target);
    // A panel may close between the write-ahead checkpoint and the Chrome API
    // call. Either known snapshot can resume; an unrelated factor is user-owned.
    if (record?.pendingBefore && (same(current, record.expected) || same(current, record.pendingBefore))) {
      record.expected = current; record.pendingBefore = null;
      await save(target, record);
    }
    const manualOverride = !!record && !same(current, record.expected);
    if (manualOverride) {
      record = { ...record, baseline: current, expected: current, owned: false, pendingBefore: null };
      await save(target, record);
    }
    // Undo, status refreshes, and unrelated preference edits must preserve zoom
    // chosen later through Chrome. Only an explicit zoom selection takes over.
    if (percentage !== null && record && !record.owned && preserveManual) {
      record.requested = percentage;
      await save(target, record);
      return result(current, record, true);
    }
    // Unrelated appearance previews must not undo a subsequent Ctrl+/Ctrl-.
    // Changing the zoom preference explicitly starts ownership again.
    if (!force && percentage !== null && record?.requested === percentage &&
      (!record.owned || (near(current.factor, percentage / 100) && current.scope === "per-tab"))) {
      return result(current, record, manualOverride || !record.owned);
    }
    if (percentage === null && !record?.owned) {
      if (record) await remove(target);
      return result(current, null, manualOverride);
    }
    if (current.mode !== "automatic") throw new Error("Chrome zoom is disabled or managed by another extension.");
    const previous = record ? structuredClone(record) : null;
    const before = current;
    record = record ?? { version: 1, documentId: target.documentId, baseline: current, expected: current, owned: true, requested: percentage };
    if (!record.owned) record.baseline = current;
    record.owned = true; record.requested = percentage;
    try {
      if (percentage === null) {
        await restoreSnapshot(target, record, record.baseline);
        current = await inspect(target);
        await remove(target);
        return result(current, null);
      }
      if (current.scope !== "per-tab") {
        current = await write(target, record, { ...current, scope: "per-tab" },
          () => tabs.setZoomSettings(target.tabId, { mode: "automatic", scope: "per-tab" }));
      }
      if (!near(current.factor, percentage / 100)) {
        current = await write(target, record, { ...current, factor: percentage / 100 },
          () => tabs.setZoom(target.tabId, percentage / 100));
      } else await save(target, record);
      return result(current, record);
    } catch (error) {
      // Best-effort rollback of this operation only; retain a recoverable record
      // if Chrome/storage fails again. Never roll back over a manual zoom change
      // or onto a newly navigated document.
      try {
        const actual = await inspect(target);
        if (same(actual, record.expected) || same(actual, before) || (record.pendingBefore && same(actual, record.pendingBefore))) {
          record.expected = actual; record.pendingBefore = null;
          await restoreSnapshot(target, record, before);
          if (previous) await save(target, previous);
          else await remove(target);
        }
      } catch { /* Retry can use the retained session; the caller shows failure. */ }
      throw error;
    }
  }

  return Object.freeze({
    apply(target, percentage, { preserveManual = false, force = false } = {}) {
      const pinned = targetOf(target);
      if (typeof preserveManual !== "boolean" || typeof force !== "boolean") throw new TypeError("Invalid zoom operation options.");
      return queue(() => apply(pinned, percentage, { preserveManual, force }));
    },
    restore(target) {
      const pinned = targetOf(target);
      return queue(() => apply(pinned, null, { preserveManual: true, force: false }));
    },
    status(target) {
      const pinned = targetOf(target);
      return queue(async () => {
        const current = await inspect(pinned), record = await load(pinned);
        await check(pinned);
        const overridden = !!record && (!record.owned || !same(current, record.expected));
        return result(current, overridden ? { ...record, owned: false } : record, overridden);
      });
    },
  });
}
