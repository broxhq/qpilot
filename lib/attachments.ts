import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Files the user attaches to a run (CSV, XLSX, images, PDFs…). They are written
// to a per-run temp dir so Playwright can hand them to a file input on the page,
// and the dir is removed when the run ends. Nothing is kept after that — the
// run only remembers the names for display.

export interface StoredFile {
  name: string;
  path: string;
  size: number;
}

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const ROOT = join(tmpdir(), "qpilot-uploads");

/**
 * Uploaded names are untrusted: keep the basename and drop path separators and
 * control characters. Letters of any script are kept as-is — mangling Cyrillic
 * (or any non-ASCII) names would make the file unrecognizable to the user and
 * to the model, which refers to it by name.
 */
function safeName(raw: string, index: number): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").trim();
  const cleaned = base
    .replace(/[^\p{L}\p{N}._\- ()[\]]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || `file-${index + 1}`;
}

/**
 * Write uploads to the run's temp dir. Rejects oversized files loudly so the
 * user sees why a file is missing instead of the agent failing mid-run.
 */
export async function saveUploads(
  runId: string,
  files: File[],
): Promise<StoredFile[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_FILES) {
    throw new Error(`Too many attachments: ${files.length} (max ${MAX_FILES})`);
  }

  const dir = join(ROOT, runId);
  await mkdir(dir, { recursive: true });

  const used = new Set<string>();
  const stored: StoredFile[] = [];

  try {
    for (const [i, file] of files.entries()) {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(
          `Attachment "${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`,
        );
      }
      // keep names unique so a ref by name is unambiguous for the agent
      let name = safeName(file.name, i);
      for (let n = 2; used.has(name); n++) {
        const dot = name.lastIndexOf(".");
        name =
          dot > 0
            ? `${name.slice(0, dot)}-${n}${name.slice(dot)}`
            : `${name}-${n}`;
      }
      used.add(name);

      const path = join(dir, name);
      await writeFile(path, Buffer.from(await file.arrayBuffer()));
      stored.push({ name, path, size: file.size });
    }
  } catch (err) {
    // the run is never created when this throws, so nothing would clean up the
    // files already written — do it here
    await cleanupUploads(runId);
    throw err;
  }

  return stored;
}

/** Best-effort removal of the run's temp dir — called when the run ends. */
export async function cleanupUploads(runId: string): Promise<void> {
  await rm(join(ROOT, runId), { recursive: true, force: true }).catch(() => {});
}
