import type { ProviderFilter } from "../types.js";
import { useState } from "preact/hooks";
import { ProviderLogo } from "./ProviderLogo.js";

interface Props {
  selected: ProviderFilter;
  onChange: (providerFilter: ProviderFilter) => void;
}

const OPTIONS: Array<[ProviderFilter, string]> = [
  ["all", "All Providers"],
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["agy", "AGY CLI"],
  ["deepseek", "DeepSeek"],
];
export function ProviderSelect({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = OPTIONS.find(([value]) => value === selected) ?? OPTIONS[0];
  return (
    <div class="provider-picker">
      <button class="provider-picker__trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ProviderLogo provider={selected} />{current[1]}
      </button>
      {open && <div class="provider-picker__menu" role="listbox">
        {OPTIONS.map(([value, label]) => <button class="provider-picker__option" type="button" role="option" aria-selected={value === selected} onClick={() => {
          // eslint-disable-next-line no-console
          console.log(`[perf] provider option clicked: ${value} at ${Date.now()}`);
          onChange(value);
          setOpen(false);
        }}>
          <ProviderLogo provider={value} />{label}
        </button>)}
      </div>}
    </div>
  );
}
