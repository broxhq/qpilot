"use client";

// The test case and the two ways to run it.

import { useRef } from "react";
import { ArrowRight, Eye, FileText } from "lucide-react";
import { type Dict } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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

export function CaseEditor({ text, busy, onChange, onRun, t }: {
  text: string;
  busy: boolean;
  onChange: (text: string) => void;
  /** headless = false is "Run with preview": the browser is visible. */
  onRun: (headless: boolean) => void;
  t: Dict["home"];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const empty = !text.trim();

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        onRun(true);
      }}
      className="flex-1 min-w-0 space-y-3"
    >
      <Textarea
        placeholder={t.placeholder}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            formRef.current?.requestSubmit();
          }
        }}
        rows={16}
        className="min-h-[320px] max-h-[60vh] resize-none overflow-y-auto rounded-xl border-border p-4 font-mono text-[12.5px] leading-relaxed focus-visible:border-border-strong focus-visible:ring-3 focus-visible:ring-ring/15"
      />

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={empty || busy} size="lg" className="gap-2 font-medium">
          {busy ? t.running : <><ArrowRight className="size-4" />{t.run}</>}
        </Button>
        <Button type="button" disabled={empty || busy} size="lg" variant="outline"
          onClick={() => onRun(false)} className="gap-2">
          {busy ? t.running : <><Eye className="size-4" />{t.runPreview}</>}
        </Button>
        <Button type="button" variant="ghost" size="lg"
          onClick={() => onChange(EXAMPLE)}
          className="ml-auto text-muted-foreground hover:text-foreground">
          <FileText className="size-4" />{t.example}
        </Button>
      </div>
    </form>
  );
}
