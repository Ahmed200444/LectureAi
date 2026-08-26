const STORAGE_KEY = "lectureai.workspace.v1";

const defaultState = {
  title: "",
  notes: "",
  updatedAt: null,
};

export function loadWorkspace(storage = globalThis.localStorage) {
  if (!storage) return { ...defaultState };

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultState };
    const parsed = JSON.parse(raw);
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { ...defaultState };
  }
}

export function saveWorkspace(workspace, storage = globalThis.localStorage) {
  if (!storage) return null;

  const value = {
    title: String(workspace?.title || ""),
    notes: String(workspace?.notes || ""),
    updatedAt: new Date().toISOString(),
  };

  storage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

export function clearWorkspace(storage = globalThis.localStorage) {
  storage?.removeItem(STORAGE_KEY);
}
