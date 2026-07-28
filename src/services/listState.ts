import type { SortMode } from "./sessionListQuery.js";
import type { ProviderFilter } from "./providerFilter.js";

export type DisplayMode = "expanded" | "compact";

export interface ListState {
  sort: SortMode;
  /** Absolute path of the project to filter by, or null for all projects. */
  selectedProject: string | null;
  display: DisplayMode;
  showArchived: boolean;
  providerFilter: ProviderFilter;
}

export interface ListStateDefaults {
  sort: SortMode;
  display: DisplayMode;
  showArchived: boolean;
  /** Project to filter by when no preference has been saved yet, or null for all projects. */
  selectedProject: string | null;
  providerFilter: ProviderFilter;
}

interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const K = {
  sort: "claudeHistory.sort",
  selectedProject: "claudeHistory.selectedProject",
  display: "claudeHistory.display",
  showArchived: "claudeHistory.showArchived",
  providerFilter: "claudeHistory.providerFilter",
} as const;

export class ListStateStore {
  /**
   * `selectedProject` is read from `workspaceMemento` (scoped to the current window) so a
   * choice made in one workspace doesn't leak into another; the rest use `memento`
   * (global) since they're window-independent preferences.
   */
  constructor(
    private memento: MementoLike,
    private defaults: ListStateDefaults,
    private workspaceMemento: MementoLike = memento,
  ) {}

  get(): ListState {
    return {
      sort: this.memento.get<SortMode>(K.sort, this.defaults.sort),
      selectedProject: this.workspaceMemento.get<string | null>(K.selectedProject, this.defaults.selectedProject),
      display: this.memento.get<DisplayMode>(K.display, this.defaults.display),
      showArchived: this.memento.get<boolean>(K.showArchived, this.defaults.showArchived),
      providerFilter: this.memento.get<ProviderFilter>(K.providerFilter, this.defaults.providerFilter),
    };
  }

  set(patch: Partial<ListState>): void {
    if (patch.sort !== undefined) this.memento.update(K.sort, patch.sort);
    if (patch.selectedProject !== undefined) this.workspaceMemento.update(K.selectedProject, patch.selectedProject);
    if (patch.display !== undefined) this.memento.update(K.display, patch.display);
    if (patch.showArchived !== undefined) this.memento.update(K.showArchived, patch.showArchived);
    if (patch.providerFilter !== undefined) this.memento.update(K.providerFilter, patch.providerFilter);
  }
}
