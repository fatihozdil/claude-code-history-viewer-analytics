import { test } from "node:test";
import assert from "node:assert/strict";
import { ListStateStore } from "../src/services/listState.js";

function fakeMemento(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  return {
    get<T>(k: string, d: T): T { return (k in store ? store[k] : d) as T; },
    update(k: string, v: unknown) { store[k] = v; return Promise.resolve(); },
    _store: store,
  };
}

const defaults = { sort: "newest" as const, display: "expanded" as const, showArchived: false, selectedProject: null, providerFilter: "all" as const };

test("falls back to defaults when nothing stored", () => {
  const s = new ListStateStore(fakeMemento(), defaults);
  assert.deepEqual(s.get(), { sort: "newest", selectedProject: null, display: "expanded", showArchived: false, providerFilter: "all" });
});

test("defaults selectedProject to current workspace project when configured", () => {
  const s = new ListStateStore(fakeMemento(), { ...defaults, selectedProject: "/home/me/project-a" });
  assert.equal(s.get().selectedProject, "/home/me/project-a");
});

test("round-trips selectedProject", () => {
  const m = fakeMemento();
  const s = new ListStateStore(m, defaults);
  s.set({ selectedProject: "/home/me/project-b" });
  assert.equal(m._store["claudeHistory.selectedProject"], "/home/me/project-b");
  assert.equal(s.get().selectedProject, "/home/me/project-b");
  s.set({ selectedProject: null });
  assert.equal(s.get().selectedProject, null);
});

test("reads stored values over defaults", () => {
  const s = new ListStateStore(fakeMemento({
    "claudeHistory.sort": "oldest", "claudeHistory.display": "compact",
  }), defaults);
  const st = s.get();
  assert.equal(st.sort, "oldest");
  assert.equal(st.display, "compact");
});

test("set persists individual fields", () => {
  const m = fakeMemento();
  const s = new ListStateStore(m, defaults);
  s.set({ sort: "messages", showArchived: true });
  assert.equal(m._store["claudeHistory.sort"], "messages");
  assert.equal(m._store["claudeHistory.showArchived"], true);
});

test("persists the provider filter", () => {
  const m = fakeMemento();
  const s = new ListStateStore(m, defaults);
  s.set({ providerFilter: "deepseek" });
  assert.equal(m._store["claudeHistory.providerFilter"], "deepseek");
  assert.equal(s.get().providerFilter, "deepseek");
});

test("selectedProject is read from the workspace-scoped memento, not the global one", () => {
  const globalMemento = fakeMemento({ "claudeHistory.selectedProject": "/home/me/other-window-project" });
  const workspaceMemento = fakeMemento();
  const s = new ListStateStore(globalMemento, { ...defaults, selectedProject: "/home/me/this-workspace" }, workspaceMemento);

  // No workspace-scoped value yet -> falls back to this workspace's default, ignoring the global leftover.
  assert.equal(s.get().selectedProject, "/home/me/this-workspace");

  s.set({ selectedProject: "/home/me/this-workspace" });
  assert.equal(workspaceMemento._store["claudeHistory.selectedProject"], "/home/me/this-workspace");
  assert.equal(globalMemento._store["claudeHistory.selectedProject"], "/home/me/other-window-project");
});
