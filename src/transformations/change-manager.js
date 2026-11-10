/**
 * Track extension-owned inline style properties, grouped into undo steps.
 * Website changes to those properties establish a new baseline instead of
 * being overwritten by Undo/Restore. Other inline properties are never touched.
 */
export function createChangeManager() {
  const records = new Map();
  const history = [];
  let pending = null;
  const read = (element, property) => ({
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  });
  const equal = (a, b) => a.value === b.value && a.priority === b.priority;

  function write(record, value) {
    if (value.value) record.element.style.setProperty(record.property, value.value, value.priority);
    else record.element.style.removeProperty(record.property);
    if (!record.hadStyle && record.element.style.length === 0) {
      // Flush Chrome's lazy CSSOM-to-attribute synchronization before removal.
      record.element.getAttribute("style");
      record.element.removeAttribute("style");
    }
  }

  function synchronize(record) {
    const actual = read(record.element, record.property);
    if (!equal(actual, record.expected)) {
      record.baseline = actual;
      record.expected = actual;
      record.hadStyle = record.element.hasAttribute("style");
      record.generation++;
    }
  }

  function undoOperations(operations) {
    let restored = 0;
    for (const operation of [...operations].reverse()) {
      const { record, before, after, generation } = operation;
      synchronize(record);
      if (record.generation !== generation || !equal(record.expected, after)) continue;
      write(record, before);
      record.expected = read(record.element, record.property);
      restored++;
    }
    return restored;
  }

  return Object.freeze({
    run(description, edit) {
      if (pending) throw new Error("Nested change groups are not supported.");
      pending = [];
      try {
        edit();
        if (pending.length) {
          history.push({ description, operations: pending });
          // Restore retains original baselines even when older undo steps expire.
          if (history.length > 20) history.shift();
        }
      } catch (error) {
        undoOperations(pending);
        throw error;
      } finally {
        pending = null;
      }
    },

    setStyle(element, property, value, priority = "important") {
      if (!pending) throw new Error("Style changes require an active group.");
      let properties = records.get(element);
      if (!properties) records.set(element, properties = new Map());
      let record = properties.get(property);
      if (!record) {
        const initial = read(element, property);
        record = {
          element, property, baseline: initial, expected: initial,
          hadStyle: element.hasAttribute("style"), generation: 0,
        };
        properties.set(property, record);
      }
      synchronize(record);
      const before = record.expected;
      write(record, { value, priority: value ? priority : "" });
      const after = read(element, property);
      record.expected = after;
      if (!equal(before, after)) pending.push({ record, before, after, generation: record.generation });
    },

    resetProperty(element, property) {
      const record = records.get(element)?.get(property);
      if (!record) return;
      synchronize(record);
      this.setStyle(element, property, record.baseline.value, record.baseline.priority);
    },

    withOriginalStyles(inspect) {
      const temporarilyRestored = [];
      for (const properties of records.values()) {
        for (const record of properties.values()) {
          synchronize(record);
          if (!record.element.isConnected) continue;
          temporarilyRestored.push({ record, expected: record.expected, generation: record.generation });
          write(record, record.baseline);
        }
      }
      try { return inspect(); }
      finally {
        for (const { record, expected, generation } of temporarilyRestored) {
          if (record.generation === generation && equal(read(record.element, record.property), record.baseline)) {
            write(record, expected);
          }
        }
      }
    },

    undo() {
      const group = history.pop();
      return group ? undoOperations(group.operations) : 0;
    },

    restore() {
      let restored = 0;
      for (const properties of records.values()) {
        for (const record of properties.values()) {
          synchronize(record);
          if (!equal(record.expected, record.baseline)) {
            write(record, record.baseline);
            restored++;
          }
        }
      }
      records.clear();
      history.length = 0;
      return restored;
    },

    getStatus() {
      let changedProperties = 0;
      for (const properties of records.values()) {
        for (const record of properties.values()) {
          synchronize(record);
          if (record.element.isConnected && !equal(record.expected, record.baseline)) changedProperties++;
        }
      }
      return { canUndo: history.length > 0, changedProperties };
    },
  });
}
