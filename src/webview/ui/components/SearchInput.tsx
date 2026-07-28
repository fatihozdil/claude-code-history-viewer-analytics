// src/webview/ui/components/SearchInput.tsx
import { useState, useEffect, useRef } from "preact/hooks";

interface Props {
  query: string;
  onSearch: (query: string) => void;
  onClear: () => void;
}

export function SearchInput({ query, onSearch, onClear }: Props) {
  const [local, setLocal] = useState(query);
  // Tracks the last value we pushed to the host so we can tell an external
  // query change apart from the host merely echoing our own search back.
  const lastSent = useRef(query);

  // Adopt only *external* query changes (e.g. the host clearing the search).
  // The host echoes the query back asynchronously via searchResults; if that
  // echo arrives after the user has typed another character it would reset the
  // input and drop that character (and spaces). Skipping our own echo prevents
  // the dropped-letter race.
  useEffect(() => {
    if (query !== lastSent.current) {
      setLocal(query);
      lastSent.current = query;
    }
  }, [query]);

  // Debounce search → host
  useEffect(() => {
    const t = setTimeout(() => {
      lastSent.current = local;
      if (local) {
        onSearch(local);
      } else {
        onClear();
      }
    }, 250);
    return () => clearTimeout(t);
  }, [local]);

  return (
    <div style="position:relative;flex:2;min-width:120px;">
      <input
        class="toolbar__search"
        type="search"
        placeholder="Search conversations…"
        value={local}
        onInput={(e) => setLocal((e.target as HTMLInputElement).value)}
        style="width:100%"
      />
      {local && (
        <button
          onClick={() => { lastSent.current = ""; setLocal(""); onClear(); }}
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--vscode-foreground)",
            fontSize: 12,
          }}
          class="codicon codicon-close"
        />
      )}
    </div>
  );
}
