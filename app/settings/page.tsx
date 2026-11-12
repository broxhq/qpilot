"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, CircleAlert, Cpu, Loader2, Palette, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { dict, type Lang } from "@/lib/i18n";

type Provider = "anthropic" | "custom";


interface Settings {
  provider: Provider;
  model: string;
  baseURL: string;
  hasKey: boolean;
  keyHint: string;
  source: "file" | "env" | "none";
  configured: boolean;
  configPath: string;
  defaultModel: string;
}

const CARD = "rounded-xl border border-border bg-card shadow-sm";
const LABEL = "text-[13px] font-medium text-foreground";
const HINT = "text-xs leading-relaxed text-subtle";
const normUrl = (u: string | undefined) => (u ?? "").trim().replace(/\/+$/, "");

export default function SettingsPage() {
  // useSearchParams needs a Suspense boundary in the app router
  return (
    <Suspense>
      <SettingsForm />
    </Suspense>
  );
}

function SettingsForm() {
  const router = useRouter();
  const welcome = useSearchParams().get("welcome") === "1";
  const [lang, setLang] = useState<Lang>("en");
  const t = dict(lang).settings;

  const [saved, setSaved] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (navigator.language?.toLowerCase().startsWith("ru")) setLang("ru");
    fetch("/api/settings").then(r => r.json()).then((s: Settings) => {
      setSaved(s);
      setProvider(s.provider);
      setBaseURL(s.baseURL);
      setModel(s.model);
    }).catch(() => {});
  }, []);

  // the saved key counts only for the provider and base URL it was saved
  // for — the server enforces the same rule (lib/config.ts reusableKey)
  const savedKeyFits = (p: Provider, url: string, s = saved) =>
    Boolean(s?.hasKey && s.provider === p && normUrl(s.baseURL) === normUrl(url));
  function switchProvider(p: Provider) {
    if (p === provider) return;
    setProvider(p);
    setApiKey("");
    setModel(p === saved?.provider ? saved.model : "");
    setBaseURL(p === saved?.provider ? saved.baseURL : "");
  }

  async function save(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey, model, baseURL }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSaved(json);
      setApiKey("");
      if (welcome) { router.push("/"); return; }
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const sameProviderKey = Boolean(saved?.hasKey && saved.provider === provider);
  const keyNote = !saved || !sameProviderKey || apiKey.trim()
    ? null
    : savedKeyFits(provider, baseURL)
      ? (saved.source === "env" ? t.keyFromEnv : t.keySaved).replace("{hint}", saved.keyHint)
      : t.keyRebind;

  return (
    <main className="mx-auto max-w-xl px-6 pt-10 pb-24">
      <Link href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8">
        <ArrowLeft className="size-3.5" />{t.back}
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight mb-6">{t.title}</h1>

      {welcome && saved && !saved.configured && (
        <div className="mb-6 flex gap-3 rounded-xl border border-ring/30 bg-ring/[0.07] px-4 py-3.5">
          <Sparkles className="size-4 shrink-0 mt-0.5 text-ring" />
          <div>
            <div className="text-sm font-medium">{t.welcome}</div>
            <div className={cn(HINT, "mt-0.5")}>{t.welcomeSub}</div>
          </div>
        </div>
      )}

      <form onSubmit={save} className={cn(CARD, "mb-6")}>
        <SectionHead icon={<Cpu className="size-4" />} title={t.model} />

        <div className="space-y-5 px-5 pb-5">
          {/* provider */}
          <div className="space-y-2">
            <div className={LABEL}>{t.provider}</div>
            <div role="radiogroup" className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface p-1">
              {(["anthropic", "custom"] as const).map(p => (
                <button key={p} type="button" role="radio" aria-checked={provider === p}
                  onClick={() => switchProvider(p)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    provider === p
                      ? "bg-background text-foreground font-medium shadow-sm ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}>
                  {p === "anthropic" ? t.anthropic : t.custom}
                </button>
              ))}
            </div>
          </div>

          {provider === "custom" && (
            <Field label={t.baseUrl} hint={t.baseUrlHintCustom}>
              <Input value={baseURL} onChange={e => setBaseURL(e.target.value)}
                placeholder="https://…/v1"
                spellCheck={false} autoComplete="off" className="font-mono text-[13px]" />
            </Field>
          )}

          {/* key */}
          <Field label={provider === "anthropic" ? t.apiKey : t.apiToken} hint={keyNote ?? undefined}>
            <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder={savedKeyFits(provider, baseURL) ? "••••••••" : provider === "anthropic" ? "sk-ant-…" : ""}
              spellCheck={false} autoComplete="off" autoFocus={welcome}
              className="font-mono text-[13px]" />
          </Field>

          {/* model: typed by hand — a provider's own list mixes in models that cannot drive the agent */}
          <Field label={t.modelLabel}
            hint={provider === "anthropic"
              ? t.modelHintAnthropic.replace("{model}", saved?.defaultModel ?? "")
              : t.modelHintCustom}>
            <Input value={model} onChange={e => setModel(e.target.value)}
              placeholder={provider === "anthropic" ? saved?.defaultModel ?? "" : "model-id"}
              spellCheck={false} autoComplete="off" className="font-mono text-[13px]" />
          </Field>

          {provider === "anthropic" && (
            <Field label={t.baseUrl} optional={t.optional} hint={t.baseUrlHintAnthropic}>
              <Input value={baseURL} onChange={e => setBaseURL(e.target.value)}
                placeholder="https://api.anthropic.com"
                spellCheck={false} autoComplete="off" className="font-mono text-[13px]" />
            </Field>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.07] px-3 py-2.5 text-xs leading-relaxed text-destructive">
              <CircleAlert className="size-3.5 shrink-0 mt-px" />
              <span className="break-words min-w-0">{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border bg-surface px-5 py-3 rounded-b-xl">
          <span className="mr-auto min-w-0 truncate text-[11px] font-mono text-faint">
            {saved && t.storedIn.replace("{path}", saved.configPath.replace(/^\/(Users|home)\/[^/]+/, "~"))}
          </span>
          {justSaved && (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="size-3.5" />{t.saved}
            </span>
          )}
          <Button type="submit" disabled={busy || !saved} className="gap-1.5 px-4">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </form>

      <section className={CARD}>
        <SectionHead icon={<Palette className="size-4" />} title={t.appearance} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5">
          <span className={LABEL}>{t.theme}</span>
          <ThemeToggle labels={t} withLabels />
        </div>
      </section>
    </main>
  );
}

function SectionHead({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-5 pt-4 pb-4 text-sm font-semibold">
      <span className="text-subtle">{icon}</span>{title}
    </div>
  );
}

function Field({ label, hint, optional, children }: {
  label: string;
  hint?: string;
  optional?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>{label}</span>
        {optional && <span className="text-[11px] text-faint">{optional}</span>}
      </span>
      {children}
      {hint && <span className={cn(HINT, "block")}>{hint}</span>}
    </label>
  );
}
