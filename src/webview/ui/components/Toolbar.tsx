// src/webview/ui/components/Toolbar.tsx
import type { SortMode, ProjectInfo, ProviderFilter } from "../types.js";
import { ProjectSelect } from "./ProjectSelect.js";
import { SearchInput } from "./SearchInput.js";
import { SortSelect } from "./SortSelect.js";
import { CompactToggle } from "./CompactToggle.js";
import { ArchiveToggle } from "./ArchiveToggle.js";
import { ProviderSelect } from "./ProviderSelect.js";

interface ToolbarProps {
  projects: ProjectInfo[];
  selectedProject: string | null;
  sort: SortMode;
  compact: boolean;
  showArchived: boolean;
  providerFilter: ProviderFilter;
  searchQuery: string;
  onProjectChange: (path: string | null) => void;
  onSearch: (query: string) => void;
  onClearSearch: () => void;
  onSortChange: (sort: SortMode) => void;
  onToggleCompact: () => void;
  onToggleArchived: () => void;
  onProviderChange: (providerFilter: ProviderFilter) => void;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div class="toolbar">
      <div class="toolbar__row">
        <ProjectSelect
          projects={props.projects}
          selected={props.selectedProject}
          onChange={props.onProjectChange}
        />
        <ProviderSelect selected={props.providerFilter} onChange={props.onProviderChange} />
        <SearchInput
          query={props.searchQuery}
          onSearch={props.onSearch}
          onClear={props.onClearSearch}
        />
      </div>
      <div class="toolbar__row">
        <SortSelect value={props.sort} onChange={props.onSortChange} />
        <CompactToggle active={props.compact} onClick={props.onToggleCompact} />
        <ArchiveToggle active={props.showArchived} onClick={props.onToggleArchived} />
      </div>
    </div>
  );
}
