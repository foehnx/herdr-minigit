// Git plumbing for minigit: running git, parsing its output, building partial
// patches and scripted interactive rebases. No UI here.
import { exec, readTextFile } from "herdr";

// Every call: no colors, no external diff, a/ b/ prefixes (patches depend on them),
// and no editor or credential prompt that would hang a call without a terminal.
const BASE = ["-c", "color.ui=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "core.quotePath=false"];
// Reads write nothing under .git (no index refresh, no lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const QUIET_ENV = { GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" };
// Env vars carry patches into `sh -c`; keep them well under the OS argument limit (UTF-8 bytes).
export const PATCH_LIMIT = 100000;
const CHUNK_BYTES = 48000;

export class GitError extends Error {
  constructor(result, args) {
    super((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
    this.result = result;
  }
}

const envArgs = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}`);

/** Safe POSIX single-quoted shell literal. */
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** UTF-8 byte length of a JS string (without relying on Web TextEncoder). */
export function utf8ByteLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Splits `text` into chunks of at most `maxBytes` UTF-8 bytes without splitting surrogate pairs. */
function utf8Chunks(text, maxBytes = CHUNK_BYTES) {
  if (!text.length) return [""];
  const chunks = [];
  let start = 0, bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let step = 1, add = 1;
    if (c < 0x80) { add = 1; }
    else if (c < 0x800) { add = 2; }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { add = 4; step = 2; }
    else { add = 3; }
    if (bytes + add > maxBytes && i > start) {
      chunks.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += add;
    if (step === 2) i++;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

/** Rejects paths that escape the base directory or contain NUL bytes. */
function assertSafeRelPath(rel) {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.split("/").includes("..")) {
    throw new Error(`Refusing unsafe relative path: ${rel}`);
  }
}

/** Atomically writes `text` to `baseDir/relPath` using UTF-8 bounded chunks, mktemp (umask 077),
 *  symlink/parent-dir escape checks, and optional mode preservation. */
async function writeFileAtomic(repo, baseDir, relPath, text, { mkdir = false, noSymlink = true, preserveMode = false } = {}) {
  assertSafeRelPath(relPath);
  if (text.includes("\0")) throw new Error("Cannot write text containing NUL bytes");
  const abs = `${baseDir}/${relPath}`;
  const opts = { cwd: repo.root, on: repo.on };
  const chunks = utf8Chunks(text);
  const checkContained =
    'base_real=$(cd -P -- "$1" 2>/dev/null && pwd -P) || { echo "Invalid base dir" >&2; exit 1; }; ' +
    'dir_real=$(cd -P -- "$(dirname -- "$2")" 2>/dev/null && pwd -P) || { echo "Invalid target dir" >&2; exit 1; }; ' +
    'case "$dir_real" in "$base_real"|"$base_real"/*) ;; *) echo "Refusing to write outside repository" >&2; exit 1 ;; esac; ' +
    (noSymlink ? '[ ! -L "$2" ] || { echo "Refusing to overwrite symlink" >&2; exit 1; }; ' : "");
  let tmp = null;
  try {
    if (mkdir) {
      const mkCmd =
        'base_real=$(cd -P -- "$1" 2>/dev/null && pwd -P) || { echo "Invalid base dir" >&2; exit 1; }; ' +
        'd=$(dirname -- "$2"); cur="$d"; while [ ! -e "$cur" ] && [ "$cur" != "/" ] && [ "$cur" != "." ]; do cur=$(dirname -- "$cur"); done; ' +
        'cur_real=$(cd -P -- "$cur" 2>/dev/null && pwd -P) || { echo "Invalid target dir" >&2; exit 1; }; ' +
        'case "$cur_real" in "$base_real"|"$base_real"/*) ;; *) echo "Refusing to create directory outside repository" >&2; exit 1 ;; esac; ' +
        'mkdir -p -- "$d"';
      const mk = await exec("sh", ["-c", mkCmd, "-", baseDir, abs], opts);
      if (mk.code !== 0) throw new GitError(mk, ["mkdir"]);
    }
    const mkTmp = await exec(
      "sh",
      ["-c", `${checkContained}umask 077; mktemp -- "$2.minigit.XXXXXX"`, "-", baseDir, abs],
      opts,
    );
    if (mkTmp.code !== 0) throw new GitError(mkTmp, ["write"]);
    tmp = mkTmp.stdout.trim();
    if (!tmp) throw new Error("Failed to create temporary file");
    for (let i = 0; i < chunks.length; i++) {
      const r = await exec(
        "env",
        [`MINIGIT_TEXT=${chunks[i]}`, "sh", "-c", `printf '%s' "$MINIGIT_TEXT" ${i === 0 ? ">" : ">>"} "$1"`, "-", tmp],
        opts,
      );
      if (r.code !== 0) throw new GitError(r, ["write"]);
    }
    const preserveCmd = preserveMode
      ? 'if [ -f "$2" ] && [ ! -L "$2" ]; then mode=$(stat -c %a -- "$2" 2>/dev/null || stat -f %Lp -- "$2" 2>/dev/null); case "$mode" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) chmod "$mode" -- "$3" ;; esac; fi; '
      : "";
    const mv = await exec(
      "sh",
      ["-c", `${checkContained}${preserveCmd}mv -f -- "$3" "$2"`, "-", baseDir, abs, tmp],
      opts,
    );
    if (mv.code !== 0) throw new GitError(mv, ["write"]);
    tmp = null;
  } catch (e) {
    if (tmp) await exec("rm", ["-f", "--", tmp], opts).catch(() => {});
    throw e;
  }
}

export class Repo {
  constructor(root, on, gitDir) { this.root = root; this.on = on; this.gitDir = gitDir; }

  // Reads: no locks. Writes: env wrapper so nothing ever waits for an editor or password.
  run(args, { read = false, env = null, timeout = 60000 } = {}) {
    const git = [...BASE, ...(read ? READ : []), ...args];
    const opts = { cwd: this.root, on: this.on, timeout };
    if (read && !env) return exec("git", git, opts);
    return exec("env", [...envArgs({ ...QUIET_ENV, ...(env ?? {}) }), "git", ...git], opts);
  }
  async ok(args, opts) {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new GitError(r, args);
    return r.stdout;
  }
  read(args, opts) { return this.ok(args, { ...opts, read: true }); }

  // Pipes `patch` into `git apply <flags>` through sh, since exec has no stdin.
  async apply(patch, flags) {
    if (patch.includes("\0")) throw new Error("Patch contains NUL bytes and cannot be applied");
    if (utf8ByteLen(patch) > PATCH_LIMIT) throw new Error("Patch too large for minigit (over 100 KB)");
    const argv = Array.isArray(flags) ? flags : String(flags).split(/\s+/).filter(Boolean);
    const r = await exec(
      "env",
      [...envArgs(QUIET_ENV), `MINIGIT_PATCH=${patch}`, "sh", "-c", 'printf "%s" "$MINIGIT_PATCH" | git apply "$@"', "-", ...argv],
      { cwd: this.root, on: this.on },
    );
    if (r.code !== 0) throw new GitError(r, ["apply"]);
  }

  // Writes text into the git dir (a file a person can find again); returns its path.
  async save(name, text) {
    await writeFileAtomic(this, this.gitDir, name, text, { mkdir: true, noSymlink: true, preserveMode: false });
    return `${this.gitDir}/${name}`;
  }

  async file(path) { return readTextFile(`${this.gitDir}/${path}`, { on: this.on }).catch(() => null); }
}

export async function openRepo(cwd, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [root, gitDir] = r.stdout.trim().split("\n");
  return new Repo(root, on, gitDir);
}

// ---------- status ----------

export async function loadStatus(repo) {
  const out = await repo.read(["status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=all"]);
  const st = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      if (key === "branch.oid") st.oid = rest[0] === "(initial)" ? null : rest[0];
      else if (key === "branch.head") st.head = rest[0] === "(detached)" ? null : rest.join(" ");
      else if (key === "branch.upstream") st.upstream = rest.join(" ");
      else if (key === "branch.ab") { st.ahead = Math.abs(+rest[0]); st.behind = Math.abs(+rest[1]); }
      continue;
    }
    const kind = line[0];
    if (kind === "?") { st.files.push({ path: line.slice(2), x: ".", y: "?", untracked: true }); continue; }
    if (kind === "!") continue;
    const f = line.split(" "), xy = f[1];
    if (kind === "1") st.files.push({ path: f.slice(8).join(" "), x: xy[0], y: xy[1] });
    else if (kind === "2") { st.files.push({ path: f.slice(9).join(" "), x: xy[0], y: xy[1] }); i++; }
    else if (kind === "u") st.files.push({ path: f.slice(10).join(" "), x: xy[0], y: xy[1], conflict: true });
  }
  for (const f of st.files) {
    f.staged = !f.untracked && !f.conflict && f.x !== ".";
    f.unstaged = f.untracked || f.conflict || f.y !== ".";
  }
  st.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return st;
}

// What's going on in .git: a rebase (and how far), a merge, a cherry-pick.
export async function loadState(repo) {
  const [mHead, aHead, merge, pick, revert] = await Promise.all([
    repo.file("rebase-merge/head-name"), repo.file("rebase-apply/head-name"),
    repo.file("MERGE_HEAD"), repo.file("CHERRY_PICK_HEAD"), repo.file("REVERT_HEAD"),
  ]);
  if (mHead !== null || aHead !== null) {
    const dir = mHead !== null ? "rebase-merge" : "rebase-apply";
    const [num, end, stopped] = await Promise.all([repo.file(`${dir}/msgnum`), repo.file(`${dir}/end`), repo.file(`${dir}/stopped-sha`)]);
    return { kind: "rebase", step: +(num ?? 0), total: +(end ?? 0), branch: (mHead ?? aHead).trim().replace(/^refs\/heads\//, ""), stopped: stopped?.trim().slice(0, 7) ?? null };
  }
  if (merge !== null) return { kind: "merge" };
  if (pick !== null) return { kind: "cherry-pick" };
  if (revert !== null) return { kind: "revert" };
  return null;
}

// ---------- refs, log, stash ----------

// Local branches always; remote ones (repos can have tens of thousands) only when asked, newest 500.
export async function loadBranches(repo, withRemotes) {
  const format = "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream)%1f%(upstream:remotename)%1f%(upstream:remoteref)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:relative)%1f%(contents:subject)";
  const [heads, remotes, remoteNamesOut] = await Promise.all([
    repo.read(["for-each-ref", "--sort=-committerdate", format, "refs/heads"]),
    withRemotes ? repo.read(["for-each-ref", "--sort=-committerdate", "--count=500", format, "refs/remotes"]) : "",
    withRemotes ? repo.read(["remote"]).catch(() => "") : "",
  ]);
  const knownRemotes = remoteNamesOut.split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
  const out = heads + remotes;
  const local = [], remote = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref, name, sha, upstream, upstreamRef, upstreamRemote, upstreamRemoteRef, track, head, date, subject] = line.split("\x1f");
    if (ref.startsWith("refs/heads/")) {
      const ahead = /ahead (\d+)/.exec(track)?.[1], behind = /behind (\d+)/.exec(track)?.[1];
      const uRemote = upstreamRemote && upstreamRemote !== "." ? upstreamRemote : null;
      const uBranch = uRemote && upstreamRemoteRef ? upstreamRemoteRef.replace(/^refs\/heads\//, "") : null;
      local.push({
        ref, name, sha,
        upstream: upstream || null,
        upstreamRef: upstreamRef || null,
        upstreamRemote: uRemote,
        upstreamBranch: uBranch,
        gone: track === "gone",
        ahead: +(ahead ?? 0),
        behind: +(behind ?? 0),
        head: head === "*",
        date, subject,
      });
    } else if (!ref.endsWith("/HEAD") && ref.startsWith("refs/remotes/")) {
      const full = ref.slice("refs/remotes/".length);
      const matched = knownRemotes.find((rn) => full.startsWith(rn + "/"));
      const rName = matched ?? full.slice(0, Math.max(0, full.indexOf("/")));
      const bName = matched ? full.slice(matched.length + 1) : full.slice(full.indexOf("/") + 1);
      remote.push({ ref, name: full, remote: rName, branch: bName, sha, date, subject });
    }
  }
  local.sort((a, b) => b.head - a.head);
  return { local, remote };
}

export async function loadLog(repo, ref, limit) {
  const target = ref && !ref.startsWith("-") ? ref : "HEAD";
  const r = await repo.run(["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ar%x1f%s%x1f%D%x1e", `-n${limit}`, target, "--"], { read: true });
  if (r.code !== 0) return []; // no commits yet
  return r.stdout.split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, parents, author, email, date, subject, refs] = rec.split("\x1f");
    return { sha, short: sha.slice(0, 7), parents: parents ? parents.split(" ") : [], author, email, date, subject, refs };
  });
}

// Commits of `ref` not on its upstream (nor on a remote `baseRef`); without an upstream, not on any remote branch.
// `limit` matches the log's: rev-list keeps log's order, so every shown commit is covered.
export async function loadUnpushed(repo, upstreamRef, ref, limit, baseRef = null) {
  const target = ref && !ref.startsWith("-") ? ref : "HEAD";
  const args = upstreamRef && !upstreamRef.startsWith("-")
    ? [target, "--not", upstreamRef, ...(baseRef && baseRef.startsWith("refs/remotes/") && baseRef !== upstreamRef ? [baseRef] : [])]
    : [target, "--not", "--remotes"];
  const r = await repo.run(["rev-list", `--max-count=${limit}`, ...args], { read: true });
  return r.code === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

// The branch work merges into: the upstream remote's HEAD (refs/remotes/origin/HEAD -> refs/remotes/origin/main),
// else refs/remotes/<remote>/main or master, else a local main or master. Returns full refname or null.
export async function findBase(repo, upstreamRemote) {
  const remote = upstreamRemote || "origin";
  const head = await repo.run(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], { read: true });
  const candidates = [
    ...(head.code === 0 && head.stdout.trim() ? [head.stdout.trim()] : []),
    `refs/remotes/${remote}/main`,
    `refs/remotes/${remote}/master`,
    "refs/heads/main",
    "refs/heads/master",
  ];
  for (const ref of candidates) {
    const r = await repo.run(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { read: true });
    if (r.code === 0) return ref;
  }
  return null;
}

// Commits of `ref` not yet in `baseRef` (same order and limit as loadUnpushed).
export async function loadUnmerged(repo, baseRef, ref, limit) {
  if (!baseRef || baseRef.startsWith("-")) return null;
  const target = ref && !ref.startsWith("-") ? ref : "HEAD";
  const r = await repo.run(["rev-list", `--max-count=${limit}`, `${baseRef}..${target}`], { read: true });
  return r.code === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

export async function loadStashes(repo) {
  const r = await repo.run(["stash", "list", "--format=%gd%x1f%cr%x1f%s"], { read: true });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => { const [ref, date, subject] = l.split("\x1f"); return { ref, date, subject }; });
}

export async function commitFiles(repo, sha) {
  const out = await repo.read(["diff-tree", "--root", "--no-commit-id", "-r", "-m", "--first-parent", "-z", "--name-status", "--no-renames", sha]);
  const p = out.split("\0"), files = [];
  for (let i = 0; i + 1 < p.length; i += 2) if (p[i]) files.push({ status: p[i], path: p[i + 1] });
  return files;
}

// The diff minigit shows and builds patches from, for one file of a commit.
export const showFile = (repo, sha, path) => repo.read(["show", "--format=", "-m", "--first-parent", "--binary", "--no-ext-diff", "--no-renames", sha, "--", path]);

// ---------- diffs ----------

function unquoteGitPath(s) {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  return s.slice(1, -1).replace(/\\([abfnrtv\\"]|[0-7]{3})/g, (_, esc) => {
    const map = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };
    if (map[esc] !== undefined) return map[esc];
    return String.fromCharCode(parseInt(esc, 8));
  });
}

function headerPath(line, prefix) {
  if (line.startsWith(`${prefix} `)) {
    const rest = line.slice(prefix.length + 1);
    if (rest === "/dev/null") return null;
    if (rest.startsWith('"') && rest.endsWith('"')) return unquoteGitPath(rest).replace(/^[ab]\//, "");
    return rest.replace(/^[ab]\//, "");
  }
  return null;
}

// One file's diff: its header lines, its hunks, and the raw text (an exact patch).
export function parseDiff(text) {
  const files = [];
  let file = null, hunk = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = {
        header: [line],
        hunks: [],
        raw: [line],
        path: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"),
        oldHeader: null,
        newHeader: null,
        modeLines: [],
      };
      files.push(file); hunk = null; continue;
    }
    if (!file) continue;
    file.raw.push(line);
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) { hunk = { header: line, oldStart: +m[1], newStart: +m[3], lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) {
      file.header.push(line);
      if (line.startsWith("--- ")) {
        file.oldHeader = line;
        const p = headerPath(line, "---");
        if (p !== null) file.path = p;
      } else if (line.startsWith("+++ ")) {
        file.newHeader = line;
        const p = headerPath(line, "+++");
        if (p !== null) file.path = p;
      } else if (/^(new file mode |deleted file mode )/.test(line)) {
        file.modeLines.push(line);
      }
      continue;
    }
    const kind = line[0];
    if (kind === "+" || kind === "-" || kind === " " || kind === "\\") hunk.lines.push({ kind, text: line });
    else if (line === "") hunk.lines.push({ kind: " ", text: " ", blank: true });
  }
  for (const f of files) {
    // A trailing "" from the final newline is not a context line.
    const last = f.hunks.at(-1)?.lines;
    while (last?.length && last.at(-1).blank) last.pop();
    while (f.raw.length && f.raw.at(-1) === "") f.raw.pop();
    f.raw = f.raw.join("\n") + "\n";
  }
  return files;
}

// Changed lines of a file, as "hunk:line" keys.
export function changedKeys(file) {
  const keys = [];
  file.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (l.kind === "+" || l.kind === "-") keys.push(`${hi}:${li}`); }));
  return keys;
}

/**
 * A patch with only the selected changed lines of `file`.
 * forward (reverse=false): applies to the diff's old side; unselected "-" lines stay as context.
 * reverse (reverse=true): its new side is the diff's new side, for `apply -R`;
 * unselected "+" lines stay as context. Null when nothing is selected.
 */
export function buildPatch(file, selected, reverse) {
  const all = changedKeys(file);
  const picked = all.filter((k) => selected.has(k));
  if (!picked.length && !(selected.has("*") && !all.length)) return null;
  if (picked.length === all.length) return file.raw;
  const p = file.path;
  const isNew = file.oldHeader === "--- /dev/null";
  const isDel = file.newHeader === "+++ /dev/null";
  const oldHdr = (!reverse && isNew)
    ? "--- /dev/null"
    : (file.oldHeader && file.oldHeader !== "--- /dev/null")
      ? file.oldHeader
      : (file.newHeader && file.newHeader.startsWith('+++ "b/'))
        ? `--- "a/${file.newHeader.slice(7)}`
        : `--- a/${p}`;
  const newHdr = (reverse && isDel)
    ? "+++ /dev/null"
    : (file.newHeader && file.newHeader !== "+++ /dev/null")
      ? file.newHeader
      : (file.oldHeader && file.oldHeader.startsWith('--- "a/'))
        ? `+++ "b/${file.oldHeader.slice(7)}`
        : `+++ b/${p}`;
  const out = [file.header[0] ?? `diff --git a/${p} b/${p}`];
  if (!reverse && isNew) out.push(...file.modeLines.filter((l) => l.startsWith("new file mode ")));
  if (reverse && isDel) out.push(...file.modeLines.filter((l) => l.startsWith("deleted file mode ")));
  out.push(oldHdr, newHdr);

  let delta = 0;
  file.hunks.forEach((h, hi) => {
    const entries = [];
    let oc = 0, nc = 0, changed = false, lastKept = null;
    h.lines.forEach((l, li) => {
      const on = selected.has(`${hi}:${li}`), body = l.text.slice(1);
      if (l.kind === " ") { lastKept = { kind: " ", text: l.text, noNl: null }; entries.push(lastKept); oc++; nc++; }
      else if (l.kind === "\\") { if (lastKept) lastKept.noNl = l.text; }
      else if (l.kind === "+") {
        if (on) { lastKept = { kind: "+", text: l.text, noNl: null }; entries.push(lastKept); nc++; changed = true; }
        else if (reverse) { lastKept = { kind: " ", text: " " + body, noNl: null }; entries.push(lastKept); oc++; nc++; }
        else lastKept = null;
      } else {
        if (on) { lastKept = { kind: "-", text: l.text, noNl: null }; entries.push(lastKept); oc++; changed = true; }
        else if (!reverse) { lastKept = { kind: " ", text: " " + body, noNl: null }; entries.push(lastKept); oc++; nc++; }
        else lastKept = null;
      }
    });
    if (!changed) return;
    const lines = [];
    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      lines.push(e.text);
      if (e.noNl) {
        let hasMoreOld = false, hasMoreNew = false;
        for (let j = idx + 1; j < entries.length; j++) {
          const k = entries[j].kind;
          if (k === "-" || k === " ") hasMoreOld = true;
          if (k === "+" || k === " ") hasMoreNew = true;
        }
        const valid = (e.kind === "-" && !hasMoreOld)
          || (e.kind === "+" && !hasMoreNew)
          || (e.kind === " " && !hasMoreOld && !hasMoreNew);
        if (valid) lines.push(e.noNl);
      }
    }
    let os, ns;
    if (reverse) { ns = h.newStart; os = h.newStart - delta; } else { os = h.oldStart; ns = h.oldStart + delta; }
    if (oc > 0 && os === 0) os = 1;
    if (nc > 0 && ns === 0) ns = 1;
    delta += nc - oc;
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`, ...lines);
  });
  return out.join("\n") + "\n";
}

// ---------- conflicts ----------

/** Writes a worktree file (here or on the repo's machine) atomically in UTF-8 bounded chunks. */
export async function writeFile(repo, path, text) {
  await writeFileAtomic(repo, repo.root, path, text, { mkdir: false, noSymlink: true, preserveMode: true });
}

/** A file with conflict markers as segments: { lines } for plain text,
 *  { conflict: true, ours, base, theirs, oursLabel, theirsLabel, len } for each conflict. */
export function parseConflicts(text) {
  const segs = [];
  let plain = [], cur = null;
  const flush = () => { if (plain.length) segs.push({ lines: plain }); plain = []; };
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "");
    if (!cur) {
      const om = /^(<{7,})(?: (.*))?$/.exec(t);
      if (om) {
        flush();
        cur = { conflict: true, len: om[1].length, ours: [], base: null, theirs: [], oursLabel: (om[2] ?? "").trim(), theirsLabel: "", raw: [line], at: "o", depth: 0, nested: false };
        continue;
      }
      plain.push(line);
      continue;
    }
    cur.raw.push(line);
    if (/^<{7,}(?: |$)/.test(t)) {
      cur.depth++;
      cur.nested = true;
      continue;
    }
    if (cur.depth > 0) {
      if (/^>{7,}(?: |$)/.test(t)) cur.depth--;
      continue;
    }
    const basePrefix = "|".repeat(cur.len);
    const sepMarker = "=".repeat(cur.len);
    const endPrefix = ">".repeat(cur.len);
    if (cur.at === "o" && t.startsWith(basePrefix) && (t.length === cur.len || t[cur.len] === " ")) {
      cur.base = []; cur.at = "b";
    } else if ((cur.at === "o" || cur.at === "b") && t === sepMarker) {
      cur.at = "t";
    } else if (cur.at === "t" && t.startsWith(endPrefix) && (t.length === cur.len || t[cur.len] === " ")) {
      cur.theirsLabel = t.slice(cur.len).trim();
      if (cur.nested) {
        plain.push(...cur.raw);
      } else {
        delete cur.raw; delete cur.at; delete cur.depth; delete cur.nested;
        segs.push(cur);
      }
      cur = null;
    } else {
      (cur.at === "o" ? cur.ours : cur.at === "b" ? cur.base : cur.theirs).push(line);
    }
  }
  if (cur) plain.push(...cur.raw); // an unterminated marker is just text
  flush();
  return segs;
}

export const joinSegs = (segs) => segs.flatMap((s) => {
  if (s.lines) return s.lines;
  const n = s.len ?? 7;
  const open = "<".repeat(n) + (s.oursLabel ? ` ${s.oursLabel}` : "");
  const base = "|".repeat(n) + " base";
  const sep = "=".repeat(n);
  const close = ">".repeat(n) + (s.theirsLabel ? ` ${s.theirsLabel}` : "");
  return [open, ...s.ours, ...(s.base ? [base, ...s.base] : []), sep, ...s.theirs, close];
}).join("\n");

/** Which conflict stages each unmerged path has: 1 base, 2 ours, 3 theirs. */
export async function unmergedStages(repo, paths) {
  const out = await repo.read(["ls-files", "-u", "-z", "--", ...paths]);
  const stages = new Map();
  for (const entry of out.split("\0")) {
    const m = /^\d+ [0-9a-f]+ (\d)\t(.*)$/.exec(entry);
    if (m) { if (!stages.has(m[2])) stages.set(m[2], new Set()); stages.get(m[2]).add(+m[1]); }
  }
  return stages;
}

// ---------- rebases ----------

const TODO_COMMIT = { p: "pick", pick: "pick", r: "reword", reword: "reword", e: "edit", edit: "edit", s: "squash", squash: "squash", f: "fixup", fixup: "fixup", d: "drop", drop: "drop" };

/** Parses git-rebase-todo text into items in file order (next-to-run first). */
export function parseRebaseTodo(text) {
  const items = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const cmd = m[1], rest = (m[2] ?? "").trim();
    if (TODO_COMMIT[cmd]) {
      const action = TODO_COMMIT[cmd];
      const fm = action === "fixup" ? /^(-[cC])\s+(.*)$/.exec(rest) : null;
      const body = fm ? fm[2].trim() : rest;
      const cm = /^([0-9a-fA-F]+)(?:\s+(.*))?$/.exec(body);
      if (cm) {
        items.push({ todo: true, kind: "commit", action, flags: fm ? fm[1] : null, sha: cm[1], short: cm[1].slice(0, 7), subject: (cm[2] ?? "").replace(/^#\s*/, "") });
        continue;
      }
    }
    if (cmd === "x" || cmd === "exec") { items.push({ todo: true, kind: "exec", action: "exec", cmd: rest }); continue; }
    if (cmd === "b" || cmd === "break") { items.push({ todo: true, kind: "break", action: "break" }); continue; }
    if (cmd === "noop") continue;
    items.push({ todo: true, kind: "other", action: cmd, rest, raw: line });
  }
  return items;
}

/** Formats todo items (in file order, next-to-run first) back to git-rebase-todo text. */
export function formatRebaseTodo(items) {
  if (!items.length) return "noop\n";
  return items.map((x) => {
    if (x.kind === "commit") return `${x.action}${x.flags ? " " + x.flags : ""} ${x.sha}${x.subject ? " " + x.subject : ""}`;
    if (x.kind === "exec") return `exec ${x.cmd}`;
    if (x.kind === "break") return "break";
    return x.raw;
  }).join("\n") + "\n";
}

/** Reads the remaining rebase todo in UI order (newest at top, next-to-run at bottom), or null. */
export async function loadRebaseTodo(repo) {
  const text = await repo.file("rebase-merge/git-rebase-todo");
  if (text === null) return null;
  const items = parseRebaseTodo(text);
  const missing = [...new Set(items.filter((x) => x.kind === "commit" && !x.subject).map((x) => x.sha))];
  if (missing.length) {
    const r = await repo.run(["log", "--no-walk=unsorted", "--format=%H%x1f%s", ...missing], { read: true });
    if (r.code === 0) {
      const pairs = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
      for (const x of items) {
        if (x.kind === "commit" && !x.subject) {
          const hit = pairs.find(([full]) => full.startsWith(x.sha));
          if (hit) x.subject = hit[1] ?? "";
        }
      }
    }
  }
  return items.reverse();
}

/** Writes the remaining rebase todo from UI order (newest at top) back to git-rebase-todo. */
export async function saveRebaseTodo(repo, uiItems) {
  await repo.save("rebase-merge/git-rebase-todo", formatRebaseTodo([...uiItems].reverse()));
}

/** Persists rebase payload files under `.git/minigit-rebase/` so they survive pause/continue. */
export async function saveRebaseFiles(repo, entries) {
  const paths = {};
  for (const [name, content] of Object.entries(entries)) {
    paths[name] = await repo.save(`minigit-rebase/${name}`, content);
  }
  return paths;
}

/** Cleans up `.git/minigit-rebase/` once a rebase finishes or aborts. */
export async function cleanRebaseFiles(repo) {
  await exec("rm", ["-rf", "--", `${repo.gitDir}/minigit-rebase`], { cwd: repo.root, on: repo.on }).catch(() => {});
}

// Writes our todo from a persisted file instead of opening an editor.
const seqEditorFor = (todoPath) => `sequence.editor=sh -c 'cp -- "$1" "$2"' - ${shQuote(todoPath)}`;

/** The commits from `oldest` up to HEAD (oldest first) and the base to rebase onto. */
export async function rebaseRange(repo, oldest) {
  const parent = await repo.run(["rev-parse", "--verify", "-q", `${oldest}^`], { read: true });
  const base = parent.code === 0 ? parent.stdout.trim() : null;
  const anc = await repo.run(["merge-base", "--is-ancestor", oldest, "HEAD"], { read: true });
  if (anc.code !== 0) throw new Error("That commit is not on the current branch");
  const out = await repo.read(["rev-list", "--reverse", "--parents", base ? `${base}..HEAD` : "HEAD"]);
  const shas = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const parts = line.split(" ");
    if (parts.length > 2) throw new Error("The range contains a merge commit; minigit only rewrites linear history");
    shas.push(parts[0]);
  }
  return { base, shas };
}

/** Runs `git rebase -i` with the given todo persisted to `.git/minigit-rebase/todo`. */
export async function rebase(repo, base, todo) {
  const todoPath = await repo.save("minigit-rebase/todo", todo.join("\n") + "\n");
  const r = await repo.run(["-c", seqEditorFor(todoPath), "rebase", "-i", "--autostash", base ?? "--root"],
    { timeout: 300000 });
  const paused = (await loadState(repo))?.kind === "rebase";
  if (r.code === 0 && !paused) await cleanRebaseFiles(repo);
  return { ...r, paused };
}

/** argv to run the same rebase in a terminal, where git opens the person's editor (reword). */
export async function rebaseArgv(repo, base, todo) {
  const todoPath = await repo.save("minigit-rebase/todo", todo.join("\n") + "\n");
  return ["git", "-c", seqEditorFor(todoPath), "rebase", "-i", "--autostash", base ?? "--root"];
}

// exec lines for the rebase todo; they read persisted files under `.git/minigit-rebase/` so they survive pause/continue.
export const X = {
  amendMsg: (path) => `exec git commit --amend --only --no-verify --allow-empty -q -F ${shQuote(path)}`,
  amendAuthor: (path) => `exec git commit --amend --only --no-verify --allow-empty --no-edit -q --author="$(cat ${shQuote(path)})"`,
  resetAuthor: () => `exec git commit --amend --only --no-verify --allow-empty --no-edit -q --reset-author`,
  // Take a patch out of the commit just picked.
  unapply: (path) => `exec git apply -R --index --recount ${shQuote(path)} && git commit --amend --no-edit --no-verify --allow-empty -q`,
  // Apply a patch onto HEAD and fold it into HEAD (3-way when the context moved).
  fold: (path) => `exec git apply --3way --recount ${shQuote(path)} && git commit --amend --no-edit --no-verify --allow-empty -q`,
  // A new commit from a patch.
  commitPatch: (patchPath, msgPath) => `exec git apply --index --recount ${shQuote(patchPath)} && git commit --no-verify --allow-empty -q -F ${shQuote(msgPath)}`,
  // Make the tree exactly that of <sha>, as a commit with its message and author, or a new message.
  restore: (sha) => `exec git read-tree -u --reset ${sha} && git commit --no-verify --allow-empty -q -C ${sha}`,
  restoreAs: (sha, msgPath) => `exec git read-tree -u --reset ${sha} && git commit --no-verify --allow-empty -q -F ${shQuote(msgPath)}`,
};
