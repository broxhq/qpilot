"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useDismiss } from "@/lib/hooks";
import { type Dict } from "@/lib/i18n";
import type { ModelOption } from "@/lib/provider";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * Model picker over the live list from the provider, with a filter. Typing
 * an id that isn't listed offers to use it as-is — for gateways that hide
 * models from /models, or a model released after the list was loaded.
 */
export function ModelSelect({ t, value, models, loading, defaultModel, onChange }: {
  t: Dict["settings"];
  value: string;
  models: ModelOption[] | null;
  loading: boolean;
  defaultModel?: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  useEffect(() => { if (open) setQuery(""); }, [open]);

  const current = models?.find(m => m.id === value);
  const q = query.trim().toLowerCase();
  const shown = (models ?? []).filter(m =>
    !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  const typed = query.trim();
  const offerTyped = typed && !(models ?? []).some(m => m.id === typed);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border border-input bg-transparent px-3 py-2 text-left transition-colors",
          "hover:border-border-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
          open && "border-border-strong",
        )}>
        <span className="min-w-0 flex-1">
          {value ? (
            <>
              <span className="block truncate text-sm text-foreground">{current?.name ?? value}</span>
              {current && current.name !== current.id && (
                <span className="block truncate font-mono text-[11px] text-subtle">{current.id}</span>
              )}
            </>
          ) : (
            <span className="text-sm text-subtle">{t.chooseModel}</span>
          )}
        </span>
        {loading
          ? <Loader2 className="size-4 shrink-0 animate-spin text-subtle" />
          : <ChevronDown className="size-4 shrink-0 text-subtle" />}
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="border-b border-border p-2">
            <Input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder={t.modelSearch} spellCheck={false}
              onKeyDown={e => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (shown.length === 1 || (shown[0] && !offerTyped)) pick(shown[0].id);
                else if (offerTyped) pick(typed);
              }}
              className="h-8 font-mono text-[12.5px]" />
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {loading && !models && (
              <li className="flex items-center gap-2 px-3 py-2.5 text-xs text-subtle">
                <Loader2 className="size-3.5 animate-spin" />{t.modelsLoading}
              </li>
            )}
            {shown.map(m => (
              <li key={m.id}>
                <button type="button" onClick={() => pick(m.id)}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-hover transition-colors">
                  <Check className={cn("size-3.5 shrink-0 mt-0.5", m.id === value ? "text-foreground" : "opacity-0")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm text-foreground">{m.name}</span>
                      {m.id === defaultModel && (
                        <span className="shrink-0 rounded border border-border px-1.5 text-[10px] text-subtle">{t.defaultTag}</span>
                      )}
                    </span>
                    {m.name !== m.id && <span className="block truncate font-mono text-[11px] text-subtle">{m.id}</span>}
                  </span>
                  {m.created && (
                    <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-faint">{m.created.slice(0, 10)}</span>
                  )}
                </button>
              </li>
            ))}
            {models && shown.length === 0 && !offerTyped && (
              <li className="px-3 py-2.5 text-xs text-subtle">{t.noModels}</li>
            )}
            {offerTyped && (
              <li>
                <button type="button" onClick={() => pick(typed)}
                  className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors">
                  <span className="size-3.5 shrink-0" />
                  <span className="truncate">{t.useTyped.replace("{id}", typed)}</span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
