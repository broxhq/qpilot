"use client";

// The dialog the agent raises when it needs a value from the user.

import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { type PendingQuestion } from "@/lib/types";
import { type Dict } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function QuestionBody({
  runId,
  question,
  t,
}: {
  runId: string;
  question: PendingQuestion;
  t: Dict;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/run/${runId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, answer: value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base">
          <CircleAlert className="size-4 text-warning shrink-0" />
          {t.needInput}
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground leading-relaxed">{question.prompt}</p>
      <Input
        autoFocus
        type={question.secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={question.secret ? t.secretPlaceholder : t.answerPlaceholder}
        className="font-mono"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" disabled={!value || busy} className="w-full">
        {busy ? t.sending : t.submit}
      </Button>
    </form>
  );
}
