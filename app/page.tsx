"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Bot, FileText, ArrowRight, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const EXAMPLE = `TC-001 — Login and add item to cart
URL: https://www.saucedemo.com/
Credentials: standard_user / secret_sauce

Steps:
1. Open the home page.
   Expected: login form with Username and Password fields is visible.
2. Enter Username "standard_user" and Password "secret_sauce", click Login.
   Expected: Products page opens with 6 items.
3. Click "Add to cart" on "Sauce Labs Backpack".
   Expected: cart counter shows 1.
4. Click the cart icon.
   Expected: cart contains exactly one item — Sauce Labs Backpack at $29.99.`;

export default function Home() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result;
      if (typeof content === "string") setText(content);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCase: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "error");
      router.push(`/run/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-col items-center min-h-screen px-6 pt-20 pb-24">
      {/* logo mark */}
      <div className="flex items-center justify-center size-11 rounded-2xl border border-white/10 bg-white/5 mb-6 shadow-lg">
        <Bot className="size-5 text-foreground/80" />
      </div>

      {/* heading */}
      <h1 className="text-3xl font-semibold tracking-tight mb-2">QA Agent</h1>
      <p className="text-sm text-muted-foreground mb-10">
        Paste a test case. Watch it run.
      </p>

      {/* form */}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="w-full max-w-2xl space-y-3"
      >
        <div
          className={cn(
            "rounded-xl border transition-all duration-200",
            focused
              ? "border-white/15 shadow-[0_0_0_3px_oklch(0.5_0.1_270_/_12%)]"
              : "border-white/7",
          )}
        >
          <Textarea
            placeholder="Paste your test case here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            rows={16}
            className="min-h-[320px] font-mono text-[12.5px] leading-relaxed resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 rounded-xl p-4"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            disabled={!text.trim() || busy}
            size="lg"
            className="gap-2 font-medium"
          >
            {busy ? (
              "Running…"
            ) : (
              <>
                Run
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => setText(EXAMPLE)}
            className="text-muted-foreground hover:text-foreground"
          >
            <FileText className="size-4" />
            Example
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={onFileChange}
          />
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => fileInputRef.current?.click()}
            className="text-muted-foreground hover:text-foreground"
          >
            <Upload className="size-4" />
            Upload .md
          </Button>

          {error && (
            <span className="text-destructive text-xs ml-1">{error}</span>
          )}

          <kbd className="ml-auto hidden sm:inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-[10px] font-mono text-muted-foreground/60">
            ⌘ + ↵
          </kbd>
        </div>
      </form>
    </main>
  );
}
