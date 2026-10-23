import { execFile, type ExecFileException } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { QPILOT_HOME } from "./config";

// Git repositories the user connected as a source of test cases. The list is
// saved to ~/.qpilot/repos.json (mode 600 — it may hold access tokens) and each
// repo is a shallow clone in ~/.qpilot/repos/<id>. The clone is read-only for
// us: syncing fetches the branch tip and resets to it, so force-pushes and
// rewritten history never leave it in a conflicted state.
//
// The system git binary is used on purpose: it already knows the user's SSH
// keys and credential helpers, so private repos often work without a token.

const HOME = QPILOT_HOME;
const LIST_PATH = join(HOME, "repos.json");
const CLONES = join(HOME, "repos");

const GIT_TIMEOUT_MS = 120_000;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;

interface StoredRepo {
  id: string;
  name: string;
  url: string;
  /** Branch to follow. Filled in after the first clone when the user left it empty. */
  branch?: string;
  /** Sub-folder with the test cases, relative to the repo root. Empty = whole repo. */
  path?: string;
  username?: string;
  token?: string;
  createdAt: number;
  syncedAt?: number;
  commit?: string;
}

/** What the UI sees — never the token. */
export interface RepoInfo {
  id: string;
  name: string;
  url: string;
  branch?: string;
  path?: string;
  hasToken: boolean;
  syncedAt?: number;
  commit?: string;
}

export interface NewRepoInput {
  url: string;
  branch?: string;
  path?: string;
  username?: string;
  token?: string;
}

const toInfo = ({ token, username: _u, createdAt: _c, ...rest }: StoredRepo): RepoInfo => ({
  ...rest,
  hasToken: Boolean(token),
});

// ── storage ──────────────────────────────────────────────────────────────────

async function loadList(): Promise<StoredRepo[]> {
  try {
    const data = JSON.parse(await readFile(LIST_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveList(repos: StoredRepo[]): Promise<void> {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${LIST_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(repos, null, 2), { mode: 0o600 });
  await rename(tmp, LIST_PATH);
}

// One operation per repo at a time (a sync racing a delete, two syncs…), and
// list read-modify-write cycles never interleave.
const locks = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => {});
  return next;
}

async function updateStored(id: string, patch: Partial<StoredRepo>): Promise<StoredRepo> {
  return serialize("list", async () => {
    const repos = await loadList();
    const i = repos.findIndex((r) => r.id === id);
    if (i < 0) throw new Error("Repository not found");
    repos[i] = { ...repos[i], ...patch };
    await saveList(repos);
    return repos[i];
  });
}

// ── input validation ─────────────────────────────────────────────────────────

const SCP_LIKE = /^[\w.-]+@[\w.-]+:[^\s]+$/; // git@github.com:owner/repo.git

/**
 * Accept only real remote transports. Anything else (ext::, file paths,
 * strings starting with "-") could make git run commands or read local files.
 * Credentials pasted into an https URL are moved out of it, so they are never
 * written into .git/config or shown in the UI.
 */
function parseUrl(raw: string): { url: string; username?: string; token?: string } {
  const url = raw.trim();
  if (SCP_LIKE.test(url) && !url.startsWith("-")) return { url };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Enter a repository URL like https://github.com/owner/repo.git or git@github.com:owner/repo.git");
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) {
    throw new Error("Only https://, ssh:// and git@host:path repository URLs are supported");
  }
  if ((u.protocol === "https:" || u.protocol === "http:") && u.password) {
    const username = decodeURIComponent(u.username);
    const token = decodeURIComponent(u.password);
    u.username = "";
    u.password = "";
    return { url: u.toString(), username, token };
  }
  return { url: u.toString() };
}

/** Sub-folder inside the repo: relative, no "..", forward slashes. */
function cleanPath(raw: string | undefined): string | undefined {
  const p = (raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p) return undefined;
  if (p.split("/").some((seg) => seg === ".." || seg === "")) {
    throw new Error("Folder must be a path inside the repository, e.g. tests/cases");
  }
  return p;
}

function cleanBranch(raw: string | undefined): string | undefined {
  const b = (raw ?? "").trim();
  if (!b) return undefined;
  if (b.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{/.test(b)) throw new Error("Invalid branch name");
  return b;
}

function repoName(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return tail.replace(/\.git$/, "") || url;
}

// ── git ──────────────────────────────────────────────────────────────────────

/**
 * Runs git non-interactively: no password prompts (a missing credential fails
 * fast instead of hanging the request), a new SSH host key is accepted once,
 * symlinks are checked out as plain files, and the token — if any — goes in
 * as an HTTP header via GIT_CONFIG_* env (https only), so it never appears in
 * argv, on disk, or in .git/config.
 */
function git(args: string[], repo: StoredRepo | null, cwd?: string): Promise<string> {
  const config: Array<[string, string]> = [
    ["protocol.ext.allow", "never"],
    // check symlinks out as plain files, so a repo can't point outside its clone
    ["core.symlinks", "false"],
  ];
  if (repo?.token && /^https:/.test(repo.url)) {
    const origin = new URL(repo.url).origin;
    const basic = Buffer.from(`${repo.username || "git"}:${repo.token}`).toString("base64");
    config.push([`http.${origin}/.extraHeader`, `Authorization: Basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });

  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolvePromise(stdout.trim());
        reject(new Error(gitErrorMessage(err, stderr, Boolean(repo?.token))));
      },
    );
  });
}

function gitErrorMessage(err: ExecFileException, stderr: string, withToken: boolean): string {
  if (err.code === "ENOENT") {
    return "git is not installed. On macOS run `xcode-select --install`, then try again.";
  }
  if (/xcrun: error|no developer tools/i.test(stderr)) {
    return "git needs the Xcode Command Line Tools. Run `xcode-select --install`, then try again.";
  }
  if (err.killed) return "git timed out — check the URL and your network/VPN.";
  const text = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Cloning into") && !l.startsWith("hint:"))
    .join(" ");
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(text)) {
    if (withToken) {
      return "The access token was rejected — check that it is valid, not expired, and has read access to this repository. Some hosts (e.g. Bitbucket) also need the username.";
    }
    return `Access denied. For a private repository use an SSH URL (if your SSH key is set up) or an HTTPS URL with an access token. (${text})`;
  }
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(text)) {
    return `SSH access denied — your SSH key is not set up for this host, or not loaded. Try an HTTPS URL with an access token. (${text})`;
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(text)) {
    return `Branch not found in the repository. (${text})`;
  }
  return text || err.message;
}

// Ids are generated here (6 random bytes, hex). Anything else — "..%2F..",
// a path — must never reach join() and rm(): treat it as an unknown repo.
const ID_RE = /^[0-9a-f]{12}$/;

function cloneDir(id: string): string {
  if (!ID_RE.test(id)) throw Object.assign(new Error("Repository not found"), { status: 404 });
  return join(CLONES, id);
}

/**
 * Symlink-resolved path of `p`, or null if it doesn't exist or resolves to
 * somewhere outside the repo's clone. Checking the lexical path isn't enough:
 * a folder or file in the repo can be a symlink to anywhere on disk.
 */
async function realInsideClone(id: string, p: string): Promise<string | null> {
  const root = await realpath(cloneDir(id)).catch(() => null);
  const real = await realpath(p).catch(() => null);
  if (!root || !real) return null;
  return real === root || real.startsWith(root + sep) ? real : null;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Fresh shallow clone into a temp dir, then swapped in — never a half clone. */
async function cloneInto(repo: StoredRepo): Promise<{ branch: string; commit: string }> {
  await mkdir(CLONES, { recursive: true, mode: 0o700 });
  const dir = cloneDir(repo.id);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
  if (repo.branch) args.push("--branch", repo.branch);
  try {
    await git([...args, "--", repo.url, tmp], repo);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  const branch = repo.branch || (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo, dir));
  const commit = await git(["rev-parse", "--short", "HEAD"], repo, dir);
  return { branch, commit };
}

async function pull(repo: StoredRepo): Promise<{ branch: string; commit: string }> {
  const dir = cloneDir(repo.id);
  if (!repo.branch || !(await exists(join(dir, ".git")))) return cloneInto(repo);
  await git(["fetch", "--depth", "1", "--no-tags", "origin", repo.branch], repo, dir);
  await git(["reset", "--hard", "--quiet", "FETCH_HEAD"], repo, dir);
  const commit = await git(["rev-parse", "--short", "HEAD"], repo, dir);
  return { branch: repo.branch, commit };
}

// ── files ────────────────────────────────────────────────────────────────────

function baseDir(repo: StoredRepo): string {
  return repo.path ? join(cloneDir(repo.id), ...repo.path.split("/")) : cloneDir(repo.id);
}

async function listMarkdown(repo: StoredRepo): Promise<string[]> {
  const base = baseDir(repo);
  if (!(await exists(base))) {
    throw new Error(`Folder "${repo.path}" does not exist on branch ${repo.branch ?? "(default)"}`);
  }
  const realBase = await realInsideClone(repo.id, base);
  if (!realBase) throw new Error(`Folder "${repo.path}" points outside the repository`);
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // Dirent types come from lstat: symlinks are neither directories nor
      // files here, so the walk never follows them
      if (e.isDirectory()) await walk(join(dir, e.name), childRel);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(childRel);
    }
  }
  await walk(realBase, "");
  return out;
}

/** File list, or the reason it's empty (e.g. the folder is missing on this branch). */
async function filesOrError(repo: StoredRepo): Promise<{ repo: RepoInfo; files: string[]; error?: string }> {
  try {
    return { repo: toInfo(repo), files: await listMarkdown(repo) };
  } catch (err) {
    return { repo: toInfo(repo), files: [], error: (err as Error).message };
  }
}

// ── public API (used by app/api/repos/*) ─────────────────────────────────────

export async function listRepos(): Promise<RepoInfo[]> {
  return (await loadList()).map(toInfo);
}

async function getStored(id: string): Promise<StoredRepo> {
  const repo = ID_RE.test(id) ? (await loadList()).find((r) => r.id === id) : undefined;
  if (!repo) throw Object.assign(new Error("Repository not found"), { status: 404 });
  return repo;
}

/** Clones the repo and saves it. Nothing is saved if the clone fails. */
export async function addRepo(input: NewRepoInput): Promise<{ repo: RepoInfo; files: string[] }> {
  const parsed = parseUrl(input.url ?? "");
  const repo: StoredRepo = {
    id: crypto.randomBytes(6).toString("hex"),
    name: repoName(parsed.url),
    url: parsed.url,
    branch: cleanBranch(input.branch),
    path: cleanPath(input.path),
    username: input.username?.trim() || parsed.username || undefined,
    token: input.token?.trim() || parsed.token || undefined,
    createdAt: Date.now(),
  };
  if (repo.token && !repo.url.startsWith("https://")) {
    throw new Error(
      repo.url.startsWith("http://")
        ? "An access token can't be sent over plain http:// — use an https:// URL."
        : "An access token is only used with https:// URLs; SSH URLs use your SSH key.",
    );
  }

  return serialize(repo.id, async () => {
    const { branch, commit } = await cloneInto(repo);
    repo.branch = branch;
    repo.commit = commit;
    repo.syncedAt = Date.now();
    let files: string[];
    try {
      files = await listMarkdown(repo);
    } catch (err) {
      await rm(cloneDir(repo.id), { recursive: true, force: true });
      throw err;
    }
    await serialize("list", async () => {
      const repos = await loadList();
      repos.push(repo);
      await saveList(repos);
    });
    return { repo: toInfo(repo), files };
  });
}

export async function removeRepo(id: string): Promise<void> {
  await serialize(id, async () => {
    await getStored(id); // unknown id (or a path in disguise) → 404, nothing deleted
    await serialize("list", async () => {
      await saveList((await loadList()).filter((r) => r.id !== id));
    });
    await rm(cloneDir(id), { recursive: true, force: true });
  });
}

/** Pulls the latest commit of the branch and returns the fresh file list. */
export async function syncRepo(id: string): Promise<{ repo: RepoInfo; files: string[]; error?: string }> {
  return serialize(id, async () => {
    const repo = await getStored(id);
    const { branch, commit } = await pull(repo);
    return filesOrError(await updateStored(id, { branch, commit, syncedAt: Date.now() }));
  });
}

/** Branches on the remote, with the default one (what HEAD points to). */
export async function listBranches(
  id: string,
): Promise<{ branches: string[]; defaultBranch?: string; current?: string }> {
  const repo = await getStored(id);
  const out = await git(["ls-remote", "--symref", "--", repo.url, "HEAD", "refs/heads/*"], repo);
  let defaultBranch: string | undefined;
  const branches: string[] = [];
  for (const line of out.split("\n")) {
    const symref = line.match(/^ref: refs\/heads\/(.+)\tHEAD$/);
    if (symref) { defaultBranch = symref[1]; continue; }
    const head = line.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/);
    if (head) branches.push(head[1]);
  }
  branches.sort((a, b) =>
    a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b));
  return { branches, defaultBranch, current: repo.branch };
}

/**
 * Switch the repo to another branch: fetch its tip into the shallow clone
 * (an explicit refspec works despite --single-branch) and reset to it. The
 * branch is saved, so the repo stays on it. If the test cases folder doesn't
 * exist on that branch, the switch still happens and `error` says why the
 * list is empty — switching back is one click away.
 */
export async function switchBranch(
  id: string,
  rawBranch: string,
): Promise<{ repo: RepoInfo; files: string[]; error?: string }> {
  const branch = cleanBranch(rawBranch);
  if (!branch) throw Object.assign(new Error("branch is required"), { status: 400 });
  return serialize(id, async () => {
    const repo = await getStored(id);
    const dir = cloneDir(id);
    let commit: string;
    if (await exists(join(dir, ".git"))) {
      await git(["fetch", "--depth", "1", "--no-tags", "origin", branch], repo, dir);
      await git(["reset", "--hard", "--quiet", "FETCH_HEAD"], repo, dir);
      commit = await git(["rev-parse", "--short", "HEAD"], repo, dir);
    } else {
      ({ commit } = await cloneInto({ ...repo, branch }));
    }
    return filesOrError(await updateStored(id, { branch, commit, syncedAt: Date.now() }));
  });
}

/** File list from the local clone, without touching the network. */
export async function repoFiles(id: string): Promise<{ repo: RepoInfo; files: string[]; error?: string }> {
  return serialize(id, async () => {
    const repo = await getStored(id);
    if (!(await exists(join(cloneDir(id), ".git")))) {
      // clone dir was removed by hand — get it back
      const { branch, commit } = await cloneInto(repo);
      return filesOrError(await updateStored(id, { branch, commit, syncedAt: Date.now() }));
    }
    return filesOrError(repo);
  });
}

/** Contents of one .md file; `rel` is a path from the list, checked to stay inside the folder. */
export async function readRepoFile(id: string, rel: string): Promise<string> {
  const repo = await getStored(id);
  const base = resolve(baseDir(repo));
  const full = resolve(base, rel);
  if (!full.startsWith(base + sep) || !/\.md$/i.test(full)) {
    throw Object.assign(new Error("Invalid file path"), { status: 400 });
  }
  const real = await realInsideClone(repo.id, full);
  if (!real) {
    const missing = !(await exists(full));
    throw Object.assign(
      new Error(missing ? "File not found — pull the latest changes" : "Invalid file path"),
      { status: missing ? 404 : 400 },
    );
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error("File not found — pull the latest changes"), { status: 404 });
  if (info.size > MAX_FILE_BYTES) throw Object.assign(new Error("File is larger than 1 MB"), { status: 413 });
  return readFile(real, "utf-8");
}
