"use client";

// One line of a step's log: what the agent did, in the run's language.

import { type RunEvent } from "@/lib/types";
import { dict, type Dict } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function isVisibleLog(e: RunEvent): boolean {
  if (
    e.kind === "action" &&
    (e.toolName === "report_step" || e.toolName === "finish" || e.toolName === "set_plan")
  )
    return false;
  if (e.kind === "observation") {
    const t = e.text ?? "";
    return t.startsWith("Error:") || t.startsWith("[debug]");
  }
  return true;
}

function describeAction(name?: string, input?: unknown, t: Dict = dict("en")): string {
  const p = (input ?? {}) as Record<string, unknown>;
  const a = t.action;
  switch (name) {
    case "navigate": return `${a.opening} ${p.url ?? ""}`;
    case "snapshot": return p.near ? `${a.readingBlock} "${p.near}"` : a.readingPage;
    case "click":    return p.name ? `${a.clicking} "${p.name}"` : a.clickingElement;
    case "fill":     return p.name ? `${a.filling} "${p.name}" → "${p.value ?? ""}"` : `${a.filling} "${p.value ?? ""}"`;
    case "select":   return p.name ? `${a.selecting} "${p.value ?? ""}" — "${p.name}"` : `${a.selecting} "${p.value ?? ""}"`;
    case "hover":    return p.name ? `${a.hovering} "${p.name}"` : a.hoveringElement;
    case "scroll_to": return `${a.scrollingTo} ${p.text ? `"${p.text}"` : p.ref ?? ""}`;
    case "scroll": {
      const dirs = [
        Number(p.y) ? `${Number(p.y) > 0 ? a.down : a.up} ${Math.abs(Number(p.y))}px` : "",
        Number(p.x) ? `${Number(p.x) > 0 ? a.right : a.left} ${Math.abs(Number(p.x))}px` : "",
      ].filter(Boolean).join(", ");
      const target = p.ref ? ` ${a.inside} ${p.ref}` : "";
      return `${a.scrolling} ${dirs || "0px"}${target}`;
    }
    case "press":    return `${a.pressing} ${p.key ?? ""}`;
    case "upload_file": return `${a.uploading} "${p.file ?? ""}"${p.name ? ` ${a.to} "${p.name}"` : ""}`;
    case "dismiss":  return a.closingOverlay;
    case "wait":     return `${a.waiting} ${p.ms ?? ""} ms`;
    case "ask_user": return a.askingUser;
    case "wait_for": return `${p.gone ? a.waitingGone : a.waitingFor} "${p.text ?? ""}"`;
    case "switch_tab": return `${a.switchingTab} ${p.index ?? ""}`;
    case "handle_dialog": return `${a.nextDialog} ${p.action === "dismiss" ? a.dialogDismiss : a.dialogAccept}`;
    case "mock_request": {
      const how = p.abort
        ? a.mockAbort
        : p.patch !== undefined
          ? a.mockPatch
          : p.status !== undefined || p.body !== undefined
            ? String(p.status ?? 200)
            : "";
      const delay = p.delay_ms ? `${a.mockDelay} ${p.delay_ms} ms` : "";
      const target = `${p.method ? `${p.method} ` : ""}${p.url ?? ""}`;
      return `${a.mocking} ${target} → ${[how, delay].filter(Boolean).join(", ")}`;
    }
    case "clear_mocks": return a.clearingMocks;
    case "set_offline": return p.offline === false ? a.goingOnline : a.goingOffline;
    case "get_requests": {
      const find = p.find ?? p.url;
      return find ? `${a.readingRequests} "${find}"` : a.readingRequests;
    }
    case "note": return `${a.noting} ${p.text ?? ""}`;
    case "get_console": return a.readingConsole;
    default:         return name ?? "action";
  }
}

function renderLog(e: RunEvent, t: Dict): { icon: string; text: string; cls: string } {
  switch (e.kind) {
    case "action":
      return { icon: "→", text: describeAction(e.toolName, e.toolInput, t), cls: "text-foreground/75" };
    case "step": {
      const s = e.step?.status ?? "";
      const cls = s === "pass" ? "text-success" : s === "fail" ? "text-destructive" : "text-warning";
      const icon = s === "pass" ? "✓" : s === "fail" ? "✗" : "!";
      return { icon, text: `${t.stepLabel} ${e.step?.num} — ${(t.stepStatus[s] ?? s).toUpperCase()}`, cls };
    }
    case "observation": {
      const t = e.text ?? "";
      if (t.startsWith("Error:")) return { icon: "✗", text: t, cls: "text-destructive" };
      return { icon: "·", text: t, cls: "text-subtle" };
    }
    case "info": {
      const i = e.info;
      const text = !i
        ? (e.text ?? "")
        : i.type === "dialog"
          ? `${t.infoDialog} (${i.dialog}): «${i.message}» — ${i.accepted ? t.infoAccepted : t.infoDismissed}`
          : `${i.type === "newTab" ? t.infoNewTab : t.infoTabClosed}: ${i.url}`;
      return { icon: "•", text, cls: "text-warning/90" };
    }
    case "question":
      return { icon: "?", text: `${t.asking}: ${e.question?.prompt ?? ""}`, cls: "text-warning" };
    case "answer":
      return { icon: "✎", text: t.userAnswered, cls: "text-foreground/75" };
    case "thought":
      return { icon: "›", text: e.text ?? "", cls: "text-subtle italic" };
    case "done":
      return { icon: "■", text: `${t.runFinished} — ${t.status[e.status ?? ""]?.label ?? e.status ?? ""}`, cls: "text-foreground/75" };
    case "error":
      return { icon: "✗", text: e.text ?? "", cls: "text-destructive" };
    default:
      return { icon: "·", text: "", cls: "text-faint" };
  }
}

export function LogLine({ event, t }: { event: RunEvent; t: Dict }) {
  const { icon, text, cls } = renderLog(event, t);
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="flex gap-2.5 text-[11.5px] leading-relaxed items-baseline font-mono">
      <span className="shrink-0 tabular-nums text-faint text-[10px]">
        {time}
      </span>
      <span className={cn("shrink-0 w-3.5 text-center", cls)}>{icon}</span>
      <span className={cn("min-w-0 break-words", cls)}>{text}</span>
    </div>
  );
}
