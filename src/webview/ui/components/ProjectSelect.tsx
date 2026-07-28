// src/webview/ui/components/ProjectSelect.tsx
import type { ProjectInfo } from "../types.js";

interface Props {
  projects: ProjectInfo[];
  selected: string | null;
  onChange: (path: string | null) => void;
}

export function ProjectSelect({ projects, selected, onChange }: Props) {
  return (
    <select
      class="toolbar__project"
      value={selected ?? ""}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value || null)}
    >
      <option value="">All Projects</option>
      {projects.map((p) => (
        <option key={p.path} value={p.path}>{p.name}</option>
      ))}
    </select>
  );
}
