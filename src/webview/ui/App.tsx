// src/webview/ui/App.tsx
import { useReducer, useEffect, useState } from "preact/hooks";
import type { AppState, HostMessage, CommandMessage, SubagentMeta } from "./types.js";
import { Header } from "./components/Header.js";
import { Toolbar } from "./components/Toolbar.js";
import { SessionList } from "./components/SessionList.js";
import { SummaryBar } from "./components/SummaryBar.js";
import { EmptyState } from "./components/EmptyState.js";
import { ContextMenu } from "./components/ContextMenu.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: CommandMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vsCodeApi = acquireVsCodeApi();

type Action =
  | { type: "HOST_STATE"; payload: HostMessage & { type: "state" } }
  | { type: "HOST_SEARCH_RESULTS"; payload: HostMessage & { type: "searchResults" } }
  | { type: "HOST_SEARCH_CLEARED" }
  | { type: "HOST_LOADING"; payload: boolean }
  | { type: "SET_SEARCH_QUERY"; query: string };

const initialState: AppState = {
  sessions: [],
  projects: [],
  selectedProject: null,
  sort: "newest",
  compact: false,
  showArchived: false,
  providerFilter: "all",
  searchQuery: "",
  searchActive: false,
  loading: false,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "HOST_STATE": {
      const p = action.payload;
      // This message can arrive from an unrelated background refresh (fs
      // watcher, poll timer) while a search is active. Don't clobber the
      // search box or its results out from under the user (see issue #4) —
      // only the unfiltered session list and view settings should update.
      if (state.searchActive) {
        return {
          ...state,
          projects: p.projects,
          sort: p.sort,
          compact: p.compact,
          showArchived: p.showArchived,
          selectedProject: p.selectedProject,
          providerFilter: p.providerFilter,
          loading: false,
        };
      }
      return {
        ...state,
        sessions: p.sessions,
        projects: p.projects,
        sort: p.sort,
        compact: p.compact,
        showArchived: p.showArchived,
        selectedProject: p.selectedProject,
        providerFilter: p.providerFilter,
        searchActive: false,
        searchQuery: "",
        loading: false,
      };
    }
    case "HOST_SEARCH_RESULTS": {
      const p = action.payload;
      return {
        ...state,
        sessions: p.sessions,
        searchActive: true,
        searchQuery: p.query,
        loading: false,
      };
    }
    case "HOST_SEARCH_CLEARED":
      return { ...state, searchActive: false, searchQuery: "", loading: false };
    case "HOST_LOADING":
      return { ...state, loading: action.payload };
    case "SET_SEARCH_QUERY":
      return { ...state, searchQuery: action.query };
    default:
      return state;
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [subagentCache, setSubagentCache] = useState<Map<string, SubagentMeta[] | "loading">>(new Map());

  useEffect(() => {
    const handler = (ev: MessageEvent<HostMessage>) => {
      const msg = ev.data;
      switch (msg.type) {
        case "state":
          // eslint-disable-next-line no-console
          console.log(`[perf] webview received state at ${Date.now()}, ${msg.sessions.length} sessions`);
          dispatch({ type: "HOST_STATE", payload: msg });
          break;
        case "searchResults":
          dispatch({ type: "HOST_SEARCH_RESULTS", payload: msg });
          break;
        case "searchCleared":
          dispatch({ type: "HOST_SEARCH_CLEARED" });
          break;
        case "loading":
          dispatch({ type: "HOST_LOADING", payload: msg.loading });
          break;
        case "subagentsLoaded":
          setSubagentCache((prev) => {
            const next = new Map(prev);
            next.set(msg.sessionId, msg.subagents);
            return next;
          });
          break;
      }
    };
    window.addEventListener("message", handler);
    vsCodeApi.postMessage({ command: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const post = (msg: CommandMessage) => vsCodeApi.postMessage(msg);

  const handleGetSubagents = (sessionId: string) => {
    setSubagentCache((prev) => {
      const next = new Map(prev);
      next.set(sessionId, "loading");
      return next;
    });
    post({ command: "getSubagents", sessionId });
  };

  const handleCollapseSubagents = (sessionId: string) => {
    setSubagentCache((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

  return (
    <>
      <Header onRefresh={() => post({ command: "refresh" })} onSettings={() => post({ command: "openSettings" })} />
      <Toolbar
        projects={state.projects}
        selectedProject={state.selectedProject}
        sort={state.sort}
        compact={state.compact}
        showArchived={state.showArchived}
        providerFilter={state.providerFilter}
        searchQuery={state.searchQuery}
        onProjectChange={(projectPath) => post({ command: "setProject", projectPath })}
        onSearch={(query) => post({ command: "search", query })}
        onClearSearch={() => post({ command: "clearSearch" })}
        onSortChange={(sort) => post({ command: "setSort", sort })}
        onToggleCompact={() => post({ command: "toggleCompact" })}
        onToggleArchived={() => post({ command: "toggleArchived" })}
        onProviderChange={(providerFilter) => post({ command: "setProvider", providerFilter })}
        onSettings={() => post({ command: "openSettings" })}
      />
      {state.loading && <div class="loading-bar" />}
      {state.sessions.length > 0 && <SummaryBar sessions={state.sessions} />}
      {state.sessions.length > 0 ? (
        <SessionList
          sessions={state.sessions}
          compact={state.compact}
          searchActive={state.searchActive}
          subagentCache={subagentCache}
          onOpen={(card) =>
            post(
              card.matchOrdinal !== undefined
                ? {
                    command: "openSession",
                    sessionId: card.sessionId,
                    msgOrdinal: card.matchOrdinal,
                    highlightTerm: state.searchQuery,
                  }
                : { command: "openSession", sessionId: card.sessionId },
            )
          }
          onOpenSubagent={(filePath, title) => post({ command: "openSubagent", filePath, title })}
          onGetSubagents={handleGetSubagents}
          onCollapseSubagents={handleCollapseSubagents}
          onArchive={(id) => post({ command: "archive", sessionId: id })}
          onUnarchive={(id) => post({ command: "unarchive", sessionId: id })}
          onPin={(id) => post({ command: "pin", sessionId: id })}
          onUnpin={(id) => post({ command: "unpin", sessionId: id })}
          onRename={(id, title) => post({ command: "rename", sessionId: id, title })}
          onContextMenu={(card, x, y) => {
            const effectiveParentId = card.parentSessionId ?? card.possibleParentId;
            const presentIds = new Set(state.sessions.map((c) => c.sessionId));
            ContextMenu.show(
              x,
              y,
              {
                sessionId: card.sessionId,
                provider: card.provider,
                pinned: card.pinned,
                archived: card.archived,
                possibleFork: card.parentSessionId === null && card.possibleParentId !== null,
                forkDismissed: card.forkDismissed === true,
                isBranch: effectiveParentId !== null && presentIds.has(effectiveParentId),
                ungrouped: card.ungrouped === true,
              },
              post,
            );
          }}
        />
      ) : (
        <EmptyState
          searchActive={state.searchActive}
          filtered={state.selectedProject != null || state.showArchived || state.providerFilter !== "all"}
        />
      )}
      <ContextMenu />
    </>
  );
}
