// minigit: a keyboard-first git panel in the spirit of lazygit, drawn natively.
// Follows the repo of the last focused terminal (or props.folder when given).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, ScrollHandle, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, layout, spaces, panes, focused, theme, settings, props, run, window, checking, nextCommand, watchFolder, closeOverlay, readTextFile, shared, setShared } from "herdr";
import * as G from "./git.js";
import { KEYS } from "./keys.js";

const DOCK_ID = "minigit-dock";
const PANELS = ["files", "branches", "commits", "stash"];
const TITLES = { files: "Files", branches: "Branches", commits: "Commits", stash: "Stash" };
const MAX_ROWS = 6000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const errText = (e) => String(e?.message ?? e).replace(/^Error: /, "").split("\n").filter((l) => l.trim() && !/^hint:/.test(l)).slice(0, 4).join(" · ");
const untab = (s) => s.replace(/[^\t]*\t/g, (m) => m.slice(0, -1).padEnd((m.length - 1) - (m.length - 1) % 4 + 4));
const clip = (s) => (s.length > 1500 ? s.slice(0, 1500) + " …" : s);

// ---------- where the repo is ----------

function machineOf(f) { return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null; }

function focusLocation() {
  const f = focused();
  if (!f) return null;
  const space = spaces().find((s) => s.id === f.space) ?? spaces().find((s) => s.active);
  if (f.pane) {
    const p = panes().find((p) => p.pane === f.pane);
    return p?.terminal && p.cwd ? { cwd: p.cwd, on: space?.machine ?? null } : null;
  }
  return f.terminal && f.cwd ? { cwd: f.cwd, on: machineOf(f) } : null;
}

function fallbackLocation() {
  const f = focused(), space = spaces().find((s) => s.active);
  const p = panes().find((p) => p.tab === f?.tab && p.terminal && p.cwd);
  if (p) return { cwd: p.cwd, on: space?.machine ?? null };
  return space?.folder ? { cwd: space.folder, on: space.machine ?? null } : null;
}

// ---------- rows for the main view ----------

// Text (git show, diff, log) to rows with kinds and line numbers.
function textRows(text, title) {
  const rows = title ? [{ kind: "s", text: title }] : [];
  let old = 0, nu = 0, inHunk = false;
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    if (rows.length > MAX_ROWS) { rows.push({ kind: "t", text: "… (truncated)" }); break; }
    const line = clip(untab(raw));
    if (line.startsWith("diff --git ")) { inHunk = false; rows.push({ kind: "h", text: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") }); continue; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; nu = +m[2]; inHunk = true; rows.push({ kind: "@", text: line }); continue; }
    if (inHunk && line[0] === "+") rows.push({ kind: "+", text: line.slice(1), nu: nu++ });
    else if (inHunk && line[0] === "-") rows.push({ kind: "-", text: line.slice(1), old: old++ });
    else if (inHunk && line[0] === " ") rows.push({ kind: " ", text: line.slice(1), old: old++, nu: nu++ });
    else if (inHunk && line[0] === "\\") rows.push({ kind: "m", text: line });
    else { inHunk = inHunk && line === ""; rows.push({ kind: /^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|Binary)/.test(line) ? "m" : "t", text: line }); }
  }
  return rows;
}

// One parsed file diff to selectable rows ("hunk:line" keys).
function fileRows(file) {
  const rows = [];
  if (!file.hunks.length) rows.push({ kind: "m", text: file.header.slice(1).join("  ") || "No text changes" });
  file.hunks.forEach((h, hi) => {
    rows.push({ kind: "@", text: h.header, hunk: hi });
    let old = h.oldStart, nu = h.newStart;
    h.lines.forEach((l, li) => {
      const text = clip(untab(l.text.slice(1)));
      if (l.kind === "+") rows.push({ kind: "+", text, nu: nu++, key: `${hi}:${li}`, hunk: hi });
      else if (l.kind === "-") rows.push({ kind: "-", text, old: old++, key: `${hi}:${li}`, hunk: hi });
      else if (l.kind === " ") rows.push({ kind: " ", text, old: old++, nu: nu++, hunk: hi });
      else rows.push({ kind: "m", text: l.text, hunk: hi });
    });
  });
  return numberBlocks(rows);
}

// Consecutive selectable rows form a block: what "a" selects and "[ ]" jump between.
function numberBlocks(rows) {
  let block = -1, prev = false;
  for (const r of rows) { if (r.key) { if (!prev) block++; r.block = block; } prev = !!r.key; }
  return rows;
}

// A conflicted file: plain lines, then each conflict with its two sides as selectable lines.
function conflictRows(segs) {
  const rows = [];
  let line = 1;
  segs.forEach((s, ci) => {
    if (!s.conflict) {
      const lines = ci === segs.length - 1 && s.lines.at(-1) === "" ? s.lines.slice(0, -1) : s.lines;
      for (const text of lines) { if (rows.length < MAX_ROWS) rows.push({ kind: "c", text: clip(untab(text)), nu: line }); line++; }
      return;
    }
    rows.push({ kind: "x", text: `<<<<<<< ours · ${s.oursLabel}`, conflict: ci });
    s.ours.forEach((text, i) => rows.push({ kind: "co", text: clip(untab(text)), key: `${ci}:o:${i}`, conflict: ci, hunk: ci }));
    if (s.base) { rows.push({ kind: "x", text: "||||||| base", conflict: ci }); s.base.forEach((text) => rows.push({ kind: "bs", text: clip(untab(text)), conflict: ci })); }
    rows.push({ kind: "x", text: "=======", conflict: ci });
    s.theirs.forEach((text, i) => rows.push({ kind: "ct", text: clip(untab(text)), key: `${ci}:t:${i}`, conflict: ci, hunk: ci }));
    rows.push({ kind: "x", text: `>>>>>>> theirs · ${s.theirsLabel}`, conflict: ci });
  });
  return numberBlocks(rows);
}

// Builds a flattened, single-child-compacted folder tree from objects with `.path`.
function buildFileTree(files, collapsed) {
  const root = { dir: true, children: new Map(), files: [] };
  for (const f of files ?? []) {
    const parts = f.path.split("/");
    let node = root;
    root.files.push(f);
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(parts[i])) node.children.set(parts[i], { dir: true, name: parts[i], path, children: new Map(), files: [] });
      node = node.children.get(parts[i]);
      node.files.push(f);
    }
    node.children.set(parts.at(-1) + "\0", { dir: false, name: parts.at(-1), path: f.path, file: f });
  }
  const out = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => (b.dir - a.dir) || (a.name < b.name ? -1 : 1));
    for (let k of kids) {
      let name = k.name;
      while (k.dir && k.children.size === 1) { const only = [...k.children.values()][0]; if (!only.dir) break; k = only; name += "/" + k.name; }
      out.push({ ...k, name, depth });
      if (k.dir && !collapsed.has(k.path)) walk(k, depth + 1);
      if (out.length > 3000) return;
    }
  };
  walk(root, 0);
  return out;
}

export default class Minigit extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.cfg = { list_row_height: 16, preview_line_height: 1.4 };
    this.panel = "files";
    this.cursor = { files: 0, branches: 0, commits: 0, stash: 0, cfiles: 0, plan: 0, remote: 0 };
    this.scroll = {};
    for (const k of [...PANELS, "remote", "cfiles", "plan"]) this.scroll[k] = ScrollHandle.new();
    this.mainScroll = VirtualListScrollHandle.new();
    this.collapsed = new Set();
    this.status = null; this.tree = []; this.branches = { local: [], remote: [] }; this.branchTab = "local";
    this.commits = []; this.unpushed = null; this.unmerged = null; this.base = null; this.stashes = []; this.state = null; this.rebaseTodo = null; this.logLimit = 300;
    this.browse = null; this.cfiles = null; this.plan = null; this.patch = null;
    this.mode = null; this.lineCursor = 0; this.anchor = null; this.hunkMode = false;
    this.main = { key: null, rows: [], title: "" }; this.mainToken = 0; this.mainTop = 0;
    this.refreshToken = 0; this.cfilesToken = 0; this.modalToken = 0; this.closed = false;
    this.modal = null; this.flash = null; this.busy = null; this.size = null;
    this.pinned = props()?.folder ? { cwd: props().folder, on: props().machine ?? null } : null;
    this.dock = !!props()?.dock;
    this.ph = {}; this.drag = null; this.lay = this.loadLayout();
    if (checking()) return;
    // Optional mods/minigit/settings.json; a missing file keeps the defaults above.
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/minigit/settings.json`).catch(() => null);
      if (!text) return;
      try {
        const c = JSON.parse(text);
        if (Number.isFinite(c.list_row_height)) this.cfg.list_row_height = Math.max(12, Math.min(40, c.list_row_height));
        if (Number.isFinite(c.preview_line_height)) this.cfg.preview_line_height = Math.max(1, Math.min(3, c.preview_line_height));
        cx.notify();
      } catch (e) { console.log(`minigit settings.json: ${e}`); }
    });
    if (props()?.overlay) setShared("minigit.window", props().overlay);
    if (!this.dock) {
      this.handle.focus();
      cx.timer.after(120, () => this.handle.focus()); // as a window, the element exists only after the first frame
    }
    this.follow(cx, this.pinned ?? focusLocation() ?? fallbackLocation());
    cx.timer.every(400, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (; ;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "refresh") this.refresh(cx);
        else if (c.startsWith("key:")) this.press(c.slice(4), cx);
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    this.repo = null;
    this.watch?.cancel();
    this.releaseModal();
    if (props()?.overlay && shared("minigit.window") === props().overlay) setShared("minigit.window", null);
  }

  // ---------- repo, refresh, watching ----------

  follow(cx, loc) {
    if (!loc || this.closed) return;
    const key = JSON.stringify(loc);
    if (key === this.locKey) return;
    this.locKey = key;
    cx.spawn(async (cx) => {
      const repo = await G.openRepo(loc.cwd, loc.on);
      if (this.closed || this.locKey !== key) return;
      if (this.busy || this.modal) { this.locKey = null; return; }
      if (!repo) { if (!this.repo) { this.error = `Not a git repository: ${loc.cwd}`; cx.notify(); } return; }
      if (this.repo && this.repo.root === repo.root && this.repo.on === repo.on) return;
      this.repo = repo; this.error = null; this.errorFull = null;
      this.status = null; this.tree = []; this.commits = []; this.stashes = []; this.branches = { local: [], remote: [] }; this.state = null; this.rebaseTodo = null;
      this.browse = null; this.cfiles = null; this.plan = null; this.patch = null; this.mode = null; this.main = { key: null, rows: [], title: "" };
      this.logLimit = 300; this.collapsed.clear(); this.mainToken++; this.cfilesToken++; this.modalToken++;
      this.startWatch(cx);
      this.refresh(cx, true);
      cx.notify();
    });
  }

  startWatch(cx) {
    this.watch?.cancel(); this.watch = null;
    const repo = this.repo;
    if (!repo || repo.on) return; // remote: polled
    cx.spawn(async (cx) => {
      while (!this.closed && this.repo === repo) {
        try { this.watch = watchFolder(repo.root); const paths = await this.watch; if (paths.length) this.dirty = true; }
        catch { return; }
      }
    });
  }

  tick(cx) {
    if (this.closed) return;
    const now = Date.now();
    if (this.flash && now > this.flash.until) { this.flash = null; cx.notify(); }
    if (this.modal?.focusAt && now > this.modal.focusAt) { this.modal.focusAt = 0; this.modal.state?.focus(); }
    const w = window();
    if (w && !w.visible) return;
    if (!this.pinned && !this.modal && !this.busy) this.follow(cx, focusLocation());
    // File changes refresh whenever the window shows; the timed poll only while it's active.
    const poll = w?.active !== false && now - (this.loadedAt ?? 0) > (this.repo?.on ? 4000 : 10000);
    if (this.repo && !this.loading && !this.busy && (this.dirty || poll)) {
      this.dirty = false; this.refresh(cx);
    }
  }

  refresh(cx, force = false) {
    const repo = this.repo;
    if (!repo || this.closed) return;
    if (this.loading && !force) { this.again = true; return; }
    const token = ++this.refreshToken;
    const browse = this.browse, branchTab = this.branchTab, logLimit = this.logLimit;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [status, branches, stashes, state] = await Promise.all([
          G.loadStatus(repo),
          G.loadBranches(repo, branchTab === "remote"),
          G.loadStashes(repo),
          G.loadState(repo),
        ]);
        const headBranch = branches.local.find((b) => b.head);
        // A browsed local branch is compared with its own upstream; a remote one has none (all pushed).
        const upstreamRef = browse
          ? (branches.local.find((b) => b.ref === browse.ref)?.upstreamRef ?? null)
          : (headBranch?.upstreamRef ?? null);
        const base = await G.findBase(repo, headBranch?.upstreamRemote ?? null);
        const [commits, unpushed, unmerged, rebaseTodo] = await Promise.all([
          G.loadLog(repo, browse?.ref ?? null, logLimit),
          G.loadUnpushed(repo, upstreamRef, browse?.ref ?? null, logLimit),
          G.loadUnmerged(repo, base, browse?.ref ?? null, logLimit),
          state?.kind === "rebase" && !browse ? G.loadRebaseTodo(repo) : null,
        ]);
        if (this.closed || repo !== this.repo || token !== this.refreshToken) return;
        const keep = this.selectedIds();
        Object.assign(this, { status, branches, stashes, state, rebaseTodo, commits, unpushed, unmerged, base, error: null, errorFull: null });
        this.buildTree();
        this.restoreSelection(keep);
        this.updateMain(cx, true);
        if (this.browse !== browse || this.branchTab !== branchTab || this.logLimit !== logLimit) this.again = true;
      } catch (e) {
        if (!this.closed && repo === this.repo && token === this.refreshToken) {
          this.error = errText(e); this.errorFull = String(e?.message ?? e);
          console.log("minigit refresh failed:", this.errorFull);
        }
      } finally {
        if (token === this.refreshToken) {
          this.loading = false; this.loadedAt = Date.now(); cx.notify();
          if (this.again && !this.closed) { this.again = false; this.refresh(cx); }
        }
      }
    });
  }

  selectedIds() {
    const cur = this.commitsList()[this.cursor.commits];
    return {
      files: this.tree[this.cursor.files]?.path,
      branches: this.branchList()[this.cursor.branches]?.name,
      commits: cur ? (cur.todo ? { todo: true, sha: cur.sha, idx: this.cursor.commits } : { todo: false, sha: cur.sha }) : undefined,
    };
  }

  restoreSelection(keep) {
    const at = (list, f, id, k) => { const i = id === undefined ? -1 : list.findIndex(f); this.cursor[k] = i >= 0 ? i : Math.max(0, Math.min(this.cursor[k], list.length - 1)); };
    at(this.tree, (n) => n.path === keep.files, keep.files, "files");
    at(this.branchList(), (b) => b.name === keep.branches, keep.branches, "branches");
    const clist = this.commitsList();
    if (keep.commits === undefined) {
      this.cursor.commits = Math.max(0, Math.min(this.cursor.commits, clist.length - 1));
    } else if (keep.commits.todo) {
      const todo = this.activeTodo();
      const i = keep.commits.sha ? todo.findIndex((x) => x.sha === keep.commits.sha) : -1;
      this.cursor.commits = i >= 0 ? i : Math.max(0, Math.min(keep.commits.idx, clist.length - 1));
    } else {
      const i = clist.findIndex((c) => !c.todo && c.sha === keep.commits.sha);
      this.cursor.commits = i >= 0 ? i : Math.max(0, Math.min(this.cursor.commits, clist.length - 1));
    }
    this.cursor.stash = Math.max(0, Math.min(this.cursor.stash, this.stashes.length - 1));
  }

  buildTree() {
    this.tree = buildFileTree(this.status?.files, this.collapsed);
  }

  rebuildCfilesTree() {
    const c = this.cfiles;
    if (!c) return;
    const curPath = c.tree?.[this.cursor.cfiles]?.path;
    c.tree = buildFileTree(c.files, c.collapsed);
    const idx = curPath ? c.tree.findIndex((n) => n.path === curPath) : -1;
    this.cursor.cfiles = idx >= 0 ? idx : Math.max(0, Math.min(this.cursor.cfiles, c.tree.length - 1));
  }

  openCommitFiles(sha, short, subject, cx) {
    const repo = this.repo, token = ++this.cfilesToken;
    cx.spawn(async (cx) => {
      try {
        const files = await G.commitFiles(repo, sha);
        if (this.closed || repo !== this.repo || token !== this.cfilesToken) return;
        const collapsed = new Set();
        this.cfiles = { sha, short, subject, files, collapsed, tree: buildFileTree(files, collapsed) };
        this.cursor.cfiles = 0;
        this.updateMain(cx);
      } catch (e) { this.say(errText(e), "error"); }
      cx.notify();
    });
  }

  branchList() { return this.branchTab === "local" ? this.branches.local : this.branches.remote; }
  activeTodo() { return !this.browse && this.state?.kind === "rebase" && this.rebaseTodo ? this.rebaseTodo : []; }
  commitsList() { const todo = this.activeTodo(); return todo.length ? [...todo, ...this.commits] : this.commits; }
  listOf(name) {
    if (name === "files") return this.tree;
    if (name === "branches") return this.branchList();
    if (name === "commits") return this.plan ? this.plan.items : this.cfiles ? this.cfiles.tree : this.commitsList();
    return this.stashes;
  }
  cursorKey(name) { return name === "commits" ? (this.plan ? "plan" : this.cfiles ? "cfiles" : "commits") : name; }
  sel(name = this.panel) { return this.listOf(name)[this.cursor[this.cursorKey(name)]]; }

  // ---------- the main view ----------

  mainSpec() {
    const repo = this.repo;
    if (!repo) return null;
    if (this.mode) {
      const m = this.mode;
      return { key: `mode:${m.kind}:${m.sha ?? ""}:${m.side ?? ""}:${m.path}`, load: async () => this.loadModeFile(repo, m) };
    }
    const s = this.sel();
    if (!s) return { key: `empty:${this.panel}`, load: async () => ({ rows: [], title: "" }) };
    if (this.panel === "files") {
      return {
        key: `file:${s.path}:${s.dir}`, load: async () => {
          if (!s.dir && s.file.untracked) {
            const r = await repo.run(["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", s.path], { read: true });
            return { rows: textRows(r.stdout || "Untracked file"), title: `${s.path} · untracked` };
          }
          const [u, st] = await Promise.all([repo.read(["diff", "--no-ext-diff", "--", s.path]), repo.read(["diff", "--cached", "--no-ext-diff", "--", s.path])]);
          const untracked = s.dir ? s.files.filter((f) => f.untracked).map((f) => f.path) : [];
          let rows = [];
          if (u) rows = rows.concat(textRows(u, st ? "Unstaged" : null));
          if (st) rows = rows.concat(textRows(st, u ? "Staged" : null));
          if (untracked.length) rows = rows.concat([{ kind: "s", text: "Untracked" }, ...untracked.slice(0, 500).map((p) => ({ kind: "+", text: p }))]);
          if (!rows.length) rows = [{ kind: "t", text: s.file?.conflict ? "Conflicted file" : "No changes" }];
          return { rows, title: s.path + (s.dir ? "/" : "") };
        }
      };
    }
    if (this.panel === "branches") {
      return {
        key: `branch:${s.ref}:${s.sha}`, load: async () => ({
          rows: textRows(await repo.read(["log", "--graph", "--format=%h %s  (%an, %ar)%d", "-n150", s.ref, "--"])), title: `Log · ${s.name}`
        })
      };
    }
    if (this.panel === "commits") {
      if (this.cfiles) {
        const cf = this.cfiles;
        return {
          key: `cfile:${cf.sha}:${s.path}:${s.dir}`,
          load: async () => ({
            rows: textRows(await G.showFile(repo, cf.sha, s.path)),
            title: `${cf.short} · ${s.path}${s.dir ? "/" : ""}`,
          }),
        };
      }
      if (s.kind === "break") return { key: "todo:break", load: async () => ({ rows: [{ kind: "t", text: "break — rebase pauses here so you can inspect or amend before continuing (m → continue)" }], title: "Break" }) };
      if (s.kind === "exec" || (!s.sha && s.cmd !== undefined)) return { key: `todo:exec:${s.cmd}`, load: async () => ({ rows: [{ kind: "t", text: `exec ${s.cmd}` }], title: "Exec" }) };
      if (s.kind === "other") return { key: `todo:other:${s.raw}`, load: async () => ({ rows: [{ kind: "t", text: s.raw }], title: s.action }) };
      if (!s.sha) return { key: "empty:commits", load: async () => ({ rows: [], title: "" }) };
      return {
        key: `commit:${s.sha}`, load: async () => ({
          rows: textRows(await repo.read(["show", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B", "--no-ext-diff", s.sha])), title: `Commit ${s.short ?? s.sha.slice(0, 7)}`
        })
      };
    }
    return { key: `stash:${s.ref}`, load: async () => ({ rows: textRows(await repo.read(["stash", "show", "--stat", "-p", "--no-ext-diff", s.ref])), title: s.ref }) };
  }

  updateMain(cx, force = false) {
    const repo = this.repo, spec = this.mainSpec();
    if (!spec) return;
    if (!force && spec.key === this.main.key) return;
    const same = spec.key === this.main.key, token = ++this.mainToken;
    this.main.key = spec.key;
    if (!same) { this.mainTop = 0; this.mainScroll.scroll_to_item(0); }
    cx.spawn(async (cx) => {
      try {
        const r = await spec.load();
        if (this.closed || repo !== this.repo || token !== this.mainToken) return;
        this.main = { key: spec.key, rows: r.rows, title: r.title };
        if (this.mode) this.afterModeLoad();
      } catch (e) {
        if (!this.closed && repo === this.repo && token === this.mainToken) this.main = { key: spec.key, rows: [{ kind: "t", text: errText(e) }], title: "Error" };
      }
      cx.notify();
    });
  }

  scrollMain(by) {
    const n = this.main.rows.length;
    this.mainTop = Math.max(0, Math.min(n - 1, this.mainTop + by));
    this.mainScroll.scroll_to_item(this.mainTop, "top");
  }

  // ---------- line mode: staging lines, building patches ----------

  async loadModeFile(repo, m) {
    if (!m || !repo) return { rows: [], title: "" };
    if (m.kind === "conflict") {
      const text = await readTextFile(`${repo.root}/${m.path}`, { on: repo.on });
      if (text === null) return { rows: [{ kind: "t", text: "Can't read this file (missing, binary or over 1 MB): use the file menu (enter in Files)" }], title: m.path };
      m.text = text; m.segs = G.parseConflicts(text);
      const n = m.segs.filter((s) => s.conflict).length;
      return { rows: conflictRows(m.segs), title: `${m.path} · ${n} conflict${n === 1 ? "" : "s"}` };
    }
    let text;
    if (m.kind === "stage") text = await repo.read(["diff", ...(m.side === "staged" ? ["--cached"] : []), "--no-ext-diff", "--", m.path]);
    else text = await G.showFile(repo, m.sha, m.path);
    const parsed = G.parseDiff(text);
    if (parsed.length > 1) {
      m.file = null;
      return { rows: [{ kind: "t", text: "Typechanged file (e.g. file ↔ symlink): stage or toggle the whole file from the list" }], title: m.path };
    }
    m.file = parsed[0] ?? null;
    if (!m.file) return { rows: [{ kind: "t", text: m.kind === "stage" ? `No ${m.side} changes` : "No changes" }], title: m.path };
    m.keys = G.changedKeys(m.file);
    const title = m.kind === "stage" ? `${m.side === "staged" ? "Staged" : "Unstaged"} · ${m.path}` : `Patch · ${m.path} @ ${m.sha.slice(0, 7)}`;
    return { rows: fileRows(m.file), title };
  }

  afterModeLoad() {
    const rows = this.main.rows;
    if (!rows.some((r) => r.key)) { this.anchor = null; return; }
    if (!rows[this.lineCursor]?.key) {
      let i = Math.min(this.lineCursor, rows.length - 1);
      while (i < rows.length && !rows[i]?.key) i++;
      if (i >= rows.length) { i = Math.min(this.lineCursor, rows.length - 1); while (i > 0 && !rows[i].key) i--; }
      this.lineCursor = i;
    }
    if (this.anchor !== null && !rows[this.anchor]?.key) this.anchor = null;
    this.mainScroll.scroll_to_item(this.lineCursor);
  }

  enterMode(mode, cx) {
    this.mode = mode; this.lineCursor = 0; this.anchor = null; this.hunkMode = false;
    this.updateMain(cx, true);
  }

  exitMode(cx) { this.mode = null; this.anchor = null; this.hunkMode = false; this.updateMain(cx, true); }

  selectedRows() {
    const rows = this.main.rows, out = new Set(), c = this.lineCursor;
    if (!rows[c]?.key) return out;
    if (this.hunkMode) { rows.forEach((r, i) => { if (r.key && r.block === rows[c].block) out.add(i); }); return out; }
    const a = this.anchor ?? c;
    for (let i = Math.min(a, c); i <= Math.max(a, c); i++) if (rows[i]?.key) out.add(i);
    return out;
  }
  selectedKeys() { return new Set([...this.selectedRows()].map((i) => this.main.rows[i].key)); }

  moveLine(dir) {
    const rows = this.main.rows;
    if (this.hunkMode) {
      const b = rows[this.lineCursor]?.block;
      let i = this.lineCursor;
      while (i >= 0 && i < rows.length && (!rows[i].key || rows[i].block === b)) i += dir;
      if (i < 0 || i >= rows.length) return;
      if (dir < 0) { const b2 = rows[i].block; while (i > 0 && rows[i - 1].key && rows[i - 1].block === b2) i--; }
      this.lineCursor = i;
    } else {
      let i = this.lineCursor + dir;
      while (i >= 0 && i < rows.length && !rows[i].key) i += dir;
      if (i >= 0 && i < rows.length) this.lineCursor = i;
    }
    this.mainScroll.scroll_to_item(this.lineCursor);
  }

  stageLines(cx, discard = false) {
    const m = this.mode;
    if (!m?.file) return;
    const keys = this.selectedKeys();
    if (!keys.size) return;
    const repo = this.repo, staged = m.side === "staged";
    if (discard && staged) return this.say("Discard works on unstaged lines; unstage them first", "warning");
    const go = (cx) => this.act(cx, discard ? "Discarding" : staged ? "Unstaging" : "Staging", async () => {
      if (discard) await repo.apply(G.buildPatch(m.file, keys, true), ["-R", "--recount"]);
      else if (!staged) {
        const p = G.buildPatch(m.file, keys, false);
        if (p === m.file.raw) await repo.ok(["add", "--", m.path]); else await repo.apply(p, ["--cached", "--recount"]);
      } else {
        const p = G.buildPatch(m.file, keys, true);
        if (p === m.file.raw) await this.unstage(repo, [m.path]); else await repo.apply(p, ["--cached", "-R", "--recount"]);
      }
      if (repo === this.repo) this.anchor = null;
    }, async () => {
      if (repo !== this.repo || this.mode !== m) return;
      // Nothing left on this side: show the other one, or go back to the list.
      const other = staged ? "unstaged" : "staged";
      const left = await repo.read(["diff", ...(staged ? ["--cached"] : []), "--name-only", "--", m.path]).catch(() => "x");
      if (repo !== this.repo || this.mode !== m || left.trim()) return;
      const there = await repo.read(["diff", ...(other === "staged" ? ["--cached"] : []), "--name-only", "--", m.path]).catch(() => "");
      if (repo !== this.repo || this.mode !== m) return;
      if (there.trim() && !discard) { m.side = other; this.lineCursor = 0; } else this.mode = null;
    });
    if (discard) this.confirm("Discard selected lines?", `${keys.size} line(s) in ${m.path} will be lost.`, go);
    else go(cx);
  }

  patchEntry(sha, path) { return this.patch?.sha === sha ? this.patch.files.get(path) : null; }
  patchMark(sha, path) { const e = this.patchEntry(sha, path); return !e ? "" : e.all ? "●" : "◐"; }
  patchNodeMark(sha, n) {
    if (!n.dir) return this.patchMark(sha, n.path);
    if (!n.files.length) return "";
    if (n.files.every((f) => this.patchEntry(sha, f.path)?.all)) return "●";
    if (n.files.some((f) => this.patchEntry(sha, f.path))) return "◐";
    return "";
  }

  // Whether a row's key is in the patch (line mode on a commit).
  inPatch(key) {
    const m = this.mode;
    if (m?.kind === "conflict") return !!key && m.picks.has(key);
    if (m?.kind !== "patch" || !key) return false;
    const e = this.patchEntry(m.sha, m.path);
    return !!e && (e.all || e.keys.has(key));
  }

  ensurePatchFor(sha, then) {
    if (this.patch && this.patch.sha !== sha && this.patch.files.size) {
      return this.confirm("Start a new patch?", `The current patch is built from ${this.patch.short}. Building from another commit discards it.`, () => { this.patch = null; then(); });
    }
    then();
  }

  newPatch(sha) {
    const c = this.cfiles;
    if (!this.patch || this.patch.sha !== sha) this.patch = { sha, short: sha.slice(0, 7), subject: c?.subject ?? "", files: new Map() };
    return this.patch;
  }

  toggleLinesInPatch() {
    const m = this.mode, keys = this.selectedKeys();
    if (!keys.size) return;
    this.ensurePatchFor(m.sha, () => {
      const p = this.newPatch(m.sha);
      let e = p.files.get(m.path);
      if (e?.all) e = { keys: new Set(m.keys.length ? m.keys : ["*"]) };
      e = e ?? { keys: new Set() };
      const allIn = [...keys].every((k) => e.keys.has(k));
      for (const k of keys) allIn ? e.keys.delete(k) : e.keys.add(k);
      if (!e.keys.size) p.files.delete(m.path);
      else if (m.keys.every((k) => e.keys.has(k))) p.files.set(m.path, { all: true });
      else p.files.set(m.path, e);
      if (!p.files.size) this.patch = null;
      this.anchor = null;
    });
  }

  toggleFilesInPatch(files) {
    if (!files.length) return;
    const sha = this.cfiles.sha;
    const allIn = files.every((f) => this.patchEntry(sha, f.path)?.all);
    this.ensurePatchFor(sha, () => {
      const p = this.newPatch(sha);
      for (const f of files) allIn ? p.files.delete(f.path) : p.files.set(f.path, { all: true });
      if (!p.files.size) this.patch = null;
    });
  }

  async buildCustomPatch(repo, P) {
    let fwd = "", rev = "";
    for (const [path, e] of P.files) {
      const raw = await G.showFile(repo, P.sha, path);
      const parsed = G.parseDiff(raw);
      if (!parsed.length) continue;
      if (e.all) {
        const chunk = parsed.map((f) => f.raw).join("");
        fwd += chunk;
        rev += chunk;
        continue;
      }
      for (const file of parsed) {
        fwd += G.buildPatch(file, e.keys, false) ?? "";
        rev += G.buildPatch(file, e.keys, true) ?? "";
      }
    }
    if (!fwd) throw new Error("The patch is empty");
    return { fwd, rev };
  }

  patchMenu() {
    const P = this.patch;
    if (!P?.files.size) return this.say("No patch yet: open a commit (enter), then space on files or lines", "warning");
    const target = !this.cfiles && !this.plan && this.panel === "commits" ? this.sel("commits") : null;
    const items = [
      { key: "d", label: `Remove patch from ${P.short}`, run: (cx) => this.patchOp(cx, "remove") },
      { key: "n", label: `Move patch into a new commit after ${P.short}`, run: () => this.patchMsg("after") },
      { key: "b", label: `Move patch into a new commit before ${P.short}`, run: () => this.patchMsg("before") },
      { key: "i", label: "Move patch out into the index", run: (cx) => this.patchOp(cx, "index") },
      { key: "s", label: "Move patch out into a stash", run: (cx) => this.patchOp(cx, "stash") },
    ];
    if (target && !target.todo && target.sha && target.sha !== P.sha) items.push({ key: "m", label: `Move patch into selected commit ${target.short}`, run: (cx) => this.patchOp(cx, "move", target.sha) });
    items.push({ key: "r", label: "Reset patch", run: () => { this.patch = null; } });
    this.menu(`Patch · ${P.files.size} file(s) from ${P.short}`, items);
  }

  patchMsg(op) {
    this.prompt(op === "after" ? "New commit after" : "New commit before", this.patch.subject, (msg, cx) => {
      if (!msg.trim()) return this.say("A commit needs a message", "warning");
      this.patchOp(cx, op, null, msg.trim());
    }, true);
  }

  patchOp(cx, op, target = null, msg = "") {
    const repo = this.repo, P = this.patch, C = P.sha;
    if (!this.canRewrite()) return;
    this.act(cx, "Applying patch", async () => {
      if ((op === "index" || op === "stash") && (await repo.read(["status", "--porcelain", "--untracked-files=no"])).trim())
        throw new Error("Commit or stash your changes first: the patch goes into the index");
      const { fwd, rev } = await this.buildCustomPatch(repo, P);
      if ((op === "index" || op === "stash") && G.utf8ByteLen(rev) > G.PATCH_LIMIT)
        throw new Error("Patch too large for minigit (over 100 KB)");
      let oldest = C, tOlder = false;
      if (op === "move") {
        const older = await repo.run(["merge-base", "--is-ancestor", target, C], { read: true });
        tOlder = older.code === 0;
        if (tOlder) oldest = target;
      }
      const { base, shas } = await G.rebaseRange(repo, oldest);
      if (!shas.includes(C) || (op === "move" && !shas.includes(target))) throw new Error("History changed; refresh and try again");
      if (op === "before" && shas[0] === C && !base) throw new Error("Can't put a commit before the root commit");
      const paths = await G.saveRebaseFiles(repo, { "pfwd.patch": fwd, "prev.patch": rev, msg });
      const todo = [];
      for (const sha of shas) {
        if (sha === C) {
          if (op === "before") todo.push(G.X.commitPatch(paths["pfwd.patch"], paths.msg), G.X.restore(C));
          else if (op === "move" && tOlder) todo.push(G.X.restore(C));
          else todo.push(`pick ${C}`, G.X.unapply(paths["prev.patch"]));
          if (op === "after") todo.push(G.X.restoreAs(C, paths.msg));
        } else if (op === "move" && sha === target) {
          todo.push(...(tOlder ? [`pick ${sha}`, G.X.fold(paths["pfwd.patch"])] : [G.X.restore(sha)]));
        } else todo.push(`pick ${sha}`);
      }
      const r = await G.rebase(repo, base, todo);
      if (r.code !== 0) {
        if (repo === this.repo) this.patch = null;
        if (op === "index" || op === "stash") {
          const saved = await repo.save("minigit-lost.patch", rev).catch(() => null);
          const out = this.rebaseOutcome(r);
          if (saved && out?.text) return { text: `${out.text} · extracted patch saved to ${saved}`, level: out.level };
          return out;
        }
        return this.rebaseOutcome(r);
      }
      if (repo === this.repo) { this.patch = null; this.cfiles = null; this.mode = null; }
      if (op === "index" || op === "stash") {
        try { await repo.apply(rev, ["--3way", "--recount"]); }
        catch (e) {
          const saved = await repo.save("minigit-lost.patch", rev).catch(() => "(not saved)");
          throw new Error(`Patch removed from the commit but it didn't apply to the index; saved to ${saved}: ${errText(e)}`);
        }
        if (op === "stash") await repo.ok(["stash", "push", "-m", `minigit: patch from ${P.short}`]);
      }
      return { text: { remove: "Patch removed from commit", after: "Patch moved into a new commit", before: "Patch moved into a new commit", index: "Patch moved into the index", stash: "Patch stashed", move: "Patch moved" }[op], level: "success" };
    });
  }

  // ---------- actions ----------

  say(text, level = "info") {
    this.flash = { text, level, until: Date.now() + (level === "error" ? 12000 : 6000) };
  }

  // Runs a git action with a busy label, then refreshes. `fn` may return a message.
  act(cx, label, fn, after = null) {
    if (this.busy) return this.say(`Busy: ${this.busy}`, "warning");
    const repo = this.repo;
    if (!repo) return;
    this.busy = label;
    cx.spawn(async (cx) => {
      try {
        const out = await fn(cx, repo);
        if (typeof out === "string") this.say(out, "success");
        else if (out?.text) this.say(out.text, out.level);
        if (after) await after(cx, repo);
      } catch (e) { this.say(errText(e), "error"); }
      finally {
        this.busy = null;
        if (repo === this.repo && this.mode) this.main.key = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  git(cx, label, args, opts) { this.act(cx, label, async (_cx, repo) => { await repo.ok(args, opts); }); }

  async unstage(repo, paths) {
    const head = await repo.run(["rev-parse", "--verify", "-q", "HEAD"], { read: true });
    if (head.code === 0) await repo.ok(["reset", "-q", "HEAD", "--", ...paths]);
    else await repo.ok(["rm", "-r", "-q", "--cached", "--", ...paths]);
  }

  rebaseOutcome(r, paused = r.paused) {
    const out = (r.stderr + "\n" + r.stdout);
    if (r.code === 0) return paused || /Stopped at|stopped at/.test(out) ? { text: "Rebase stopped: make your changes, then m → continue", level: "warning" } : { text: "History rewritten", level: "success" };
    if (/CONFLICT|could not apply|conflict/i.test(out)) return { text: "Rebase stopped on conflicts: resolve, stage (space), then m → continue", level: "warning" };
    if (/execution failed:/i.test(out)) return { text: "Rebase stopped on failed exec: fix and m → continue", level: "warning" };
    throw new Error(out.trim());
  }

  canRewrite() {
    if (this.browse) { this.say("Go back to the current branch (esc) to rewrite history", "warning"); return false; }
    if (this.state) { this.say(`A ${this.state.kind} is in progress: m to continue or abort`, "warning"); return false; }
    return true;
  }

  // A rebase from `oldest` to HEAD; build(shas, base, paths) gives the todo.
  history(cx, label, oldest, build, files = {}) {
    if (!this.canRewrite()) return;
    this.act(cx, label, async (_cx, repo) => {
      const { base, shas } = await G.rebaseRange(repo, oldest);
      const paths = Object.keys(files).length ? await G.saveRebaseFiles(repo, files) : {};
      const todo = build(shas, base, paths);
      return this.rebaseOutcome(await G.rebase(repo, base, todo));
    });
  }

  canOpenTerminalFor(repo) {
    const activeMachine = spaces().find((s) => s.active)?.machine ?? null;
    if ((repo.on ?? null) !== activeMachine) {
      this.say(`Can't open a terminal for repo on ${repo.on ?? "local"} from this space`, "warning");
      return false;
    }
    return true;
  }

  openTerminal(repo, argv) {
    if (!this.canOpenTerminalFor(repo)) return false;
    const place = focused()?.pane ? "down" : "tab";
    run("terminal.open", { argv, folder: repo.root, place });
    return true;
  }

  async editorArgv(repo, path) {
    const ed = (await repo.read(["var", "GIT_EDITOR"]).catch(() => "vi")).trim() || "vi";
    const abs = path.startsWith("/") ? path : `${repo.root}/${path}`;
    return ["sh", "-c", `${ed} "$1"`, "minigit-edit", abs];
  }

  // ---------- modals ----------

  releaseModal() {
    this.modalToken++;
    this.modal?.state?.release();
    this.modal = null;
  }

  closeModal() {
    this.releaseModal();
    this.handle.focus();
  }

  prompt(title, value, onSubmit, multiline = false, extra = {}) {
    this.releaseModal();
    const state = multiline ? TextareaState.new({ value, rows: 8 }) : InputState.new({ value });
    if (multiline) state.set_soft_wrap(true);
    const modal = { kind: multiline ? "text" : "prompt", title, state, onSubmit, focusAt: Date.now() + 50, ...extra };
    const submit = (cx) => { if (this.modal !== modal) return; const v = state.value(); this.closeModal(); onSubmit(v, cx); };
    modal.submit = submit;
    if (!multiline) state.on("submit", (_e, cx) => { submit(cx); cx.notify(); });
    this.modal = modal;
    state.focus();
  }

  confirm(title, body, onYes) { this.releaseModal(); this.modal = { kind: "confirm", title, body, onYes }; this.handle.focus(); }
  menu(title, items) { this.releaseModal(); this.modal = { kind: "menu", title, items, cursor: 0 }; this.handle.focus(); }

  modalKey(k, cx) {
    const m = this.modal;
    if (k === "escape" || (m.kind === "help" && (k === "q" || k === "?"))) { this.closeModal(); return true; }
    if (m.kind === "prompt") return false;
    if (m.kind === "text") {
      if (k === "ctrl-enter" || k === "cmd-enter" || k === "ctrl-s" || k === "cmd-s") { m.submit(cx); return true; }
      if (k === "ctrl-o" && m.editor) { const v = m.state?.value?.() ?? ""; this.closeModal(); m.editor(v, cx); return true; }
      return false;
    }
    if (m.kind === "confirm") {
      if (k === "enter" || k === "y") { this.closeModal(); m.onYes(cx); }
      else if (k === "n" || k === "q") this.closeModal();
      return true;
    }
    if (m.kind === "menu") {
      if (k === "j" || k === "down") m.cursor = Math.min(m.items.length - 1, m.cursor + 1);
      else if (k === "k" || k === "up") m.cursor = Math.max(0, m.cursor - 1);
      else {
        const item = k === "enter" ? m.items[m.cursor] : m.items.find((i) => i.key === k);
        if (item) { this.closeModal(); item.run(cx); }
      }
      return true;
    }
    if (m.kind === "help") {
      const maxTop = Math.max(0, (m.rows ?? 0) - 1);
      if (k === "j" || k === "down") { m.top = Math.min(maxTop, (m.top ?? 0) + 3); this.helpScroll?.scroll_to_item(m.top); }
      if (k === "k" || k === "up") { m.top = Math.max(0, (m.top ?? 0) - 3); this.helpScroll?.scroll_to_item(m.top); }
      return true;
    }
    return true;
  }

  // ---------- keys ----------

  keyName(e) {
    const m = e.modifiers;
    if (m.control || m.platform || m.alt) return e.keystroke;
    if (e.key_char === " " || e.key === "space") return "space";
    if (e.key_char && e.key_char.length === 1 && e.key !== "enter" && e.key !== "tab" && e.key !== "escape") return e.key_char;
    return e.keystroke;
  }

  // q: close the window this runs in, or its pane.
  closeSelf() {
    if (this.dock) return run("pane.go", { direction: "left" }); // pinned: stay, give the keyboard back
    const overlay = props()?.overlay;
    if (overlay) return closeOverlay(overlay);
    const mine = panes().find((p) => p.mod === "minigit" && p.focused);
    if (mine) run("pane.close", { pane: mine.pane });
  }

  // Pinning needs a block with id "minigit-dock" in the shown layout (see RECIPE.md).
  canPin() {
    const has = (n) => !!n && typeof n === "object" && (n.id === DOCK_ID
      || (Array.isArray(n.children) && n.children.some(has))
      || (Array.isArray(n.floating) && n.floating.some(has))
      || has(n.root));
    try { return has(layout()); } catch { return false; }
  }

  pin() {
    run("layout.show", { id: DOCK_ID });
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }
  unpin() { run("layout.hide", { id: DOCK_ID }); }

  context() {
    if (this.modal) return "modal";
    if (this.mode) return { stage: "stage", patch: "patchlines", conflict: "conflict" }[this.mode.kind];
    if (this.panel === "commits") return this.plan ? "plan" : this.cfiles ? "cfiles" : this.sel("commits")?.todo ? "rebase" : "commits";
    return this.panel;
  }

  onKey(e, cx) {
    const k = this.keyName(e);
    if (this.modal) { if (this.modalKey(k, cx)) { cx.stop_propagation(); cx.notify(); } return; }
    if (!this.repo) return;
    const handled = this.contextKey(k, cx) || this.globalKey(k, cx);
    if (handled !== false) { cx.stop_propagation(); this.updateMain(cx); cx.notify(); }
  }

  // A key by name ("j", "space", "ctrl-p"): from keys.json as "minigit.key:<name>", or scripts.
  press(k, cx) {
    // With the window open, channel keys are for it, not for the dock.
    if (this.dock && shared("minigit.window")) return;
    if (this.modal) this.modalKey(k, cx);
    else if (this.repo && (this.contextKey(k, cx) || this.globalKey(k, cx)) !== false) this.updateMain(cx);
    cx.notify();
  }

  move(by, cx) {
    const name = this.panel, list = this.listOf(name), key = this.cursorKey(name);
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, this.cursor[key] + by));
    if (name === "commits" && !this.cfiles && !this.plan && next === list.length - 1 && this.commits.length >= this.logLimit) { this.logLimit += 300; this.refresh(cx); }
    this.cursor[key] = next;
    this.scrollTo();
  }

  scrollTo() {
    const name = this.panel, key = this.cursorKey(name);
    const handle = this.scroll[name === "branches" && this.branchTab === "remote" ? "remote" : key];
    const todoLen = key === "commits" ? this.activeTodo().length : 0;
    const offset = key === "cfiles" ? 1 : todoLen && this.cursor.commits >= todoLen ? 1 : 0;
    handle?.scroll_to_item(this.cursor[key] + offset);
  }

  setPanel(p) {
    this.panel = p;
    this.scrollTo();
  }

  globalKey(k, cx) {
    switch (k) {
      case "j": case "down": this.move(1, cx); break;
      case "k": case "up": this.move(-1, cx); break;
      case "g": case "home": this.move(-1e9, cx); break;
      case "G": case "end": this.move(1e9, cx); break;
      case "ctrl-d": case "pagedown": this.move(10, cx); break;
      case "ctrl-u": case "pageup": this.move(-10, cx); break;
      case "tab": case "l": case "right": this.setPanel(PANELS[(PANELS.indexOf(this.panel) + 1) % 4]); break;
      case "shift-tab": case "h": case "left": this.setPanel(PANELS[(PANELS.indexOf(this.panel) + 3) % 4]); break;
      case "1": case "2": case "3": case "4": this.setPanel(PANELS[+k - 1]); break;
      case "J": case "ctrl-e": this.scrollMain(5); break;
      case "K": case "ctrl-y": this.scrollMain(-5); break;
      case "R": this.refresh(cx, true); this.say("Refreshed"); break;
      case "q": this.closeSelf(); break;
      case "?": this.openHelp(); break;
      case "f": this.git(cx, "Fetching", ["fetch", "--all", "--prune"], { timeout: 300000 }); break;
      case "p": this.git(cx, "Pulling", ["pull", "--no-edit"], { timeout: 300000 }); break;
      case "P": this.push(cx); break;
      case "m": this.stateMenu(); break;
      case "ctrl-p": this.patchMenu(); break;
      case "escape":
        if (this.browse) { this.browse = null; this.cursor.commits = 0; this.refresh(cx, true); break; }
        return false;
      default: return false;
    }
    return true;
  }

  contextKey(k, cx) {
    switch (this.context()) {
      case "stage": return this.stageKey(k, cx);
      case "patchlines": return this.patchLinesKey(k, cx);
      case "conflict": return this.conflictKey(k, cx);
      case "plan": return this.planKey(k, cx);
      case "cfiles": return this.cfilesKey(k, cx);
      case "rebase": return this.rebaseTodoKey(k, cx);
      case "files": return this.filesKey(k, cx);
      case "branches": return this.branchesKey(k, cx);
      case "commits": return this.commitsKey(k, cx);
      case "stash": return this.stashKey(k, cx);
    }
    return false;
  }

  lineNav(k) {
    switch (k) {
      case "j": case "down": this.moveLine(1); return true;
      case "k": case "up": this.moveLine(-1); return true;
      case "ctrl-d": case "pagedown": for (let i = 0; i < 15; i++) this.moveLine(1); return true;
      case "ctrl-u": case "pageup": for (let i = 0; i < 15; i++) this.moveLine(-1); return true;
      case "g": case "home": { const i = this.main.rows.findIndex((r) => r.key); if (i >= 0) this.lineCursor = i; this.mainScroll.scroll_to_item(0); return true; }
      case "G": case "end": { const i = this.main.rows.findLastIndex((r) => r.key); if (i >= 0) this.lineCursor = i; this.mainScroll.scroll_to_item(this.lineCursor); return true; }
      case "v": this.anchor = this.anchor === null ? this.lineCursor : null; this.hunkMode = false; return true;
      case "a": this.hunkMode = !this.hunkMode; this.anchor = null; return true;
      case "]": case "}": { const h = this.hunkMode; this.hunkMode = true; this.moveLine(1); this.hunkMode = h; return true; }
      case "[": case "{": { const h = this.hunkMode; this.hunkMode = true; this.moveLine(-1); this.hunkMode = h; return true; }
    }
    return false;
  }

  stageKey(k, cx) {
    if (this.lineNav(k)) return true;
    switch (k) {
      case "space": case "enter": this.stageLines(cx); return true;
      case "d": this.stageLines(cx, true); return true;
      case "tab": this.mode.side = this.mode.side === "staged" ? "unstaged" : "staged"; this.lineCursor = 0; this.anchor = null; this.updateMain(cx, true); return true;
      case "escape": if (this.anchor !== null || this.hunkMode) { this.anchor = null; this.hunkMode = false; } else this.exitMode(cx); return true;
      case "e": this.editFile(this.mode.path, cx); return true;
    }
    return ["l", "h", "right", "left", "shift-tab", "1", "2", "3", "4"].includes(k);
  }

  patchLinesKey(k, cx) {
    if (this.lineNav(k)) return true;
    switch (k) {
      case "space": case "enter": this.toggleLinesInPatch(); return true;
      case "escape": if (this.anchor !== null || this.hunkMode) { this.anchor = null; this.hunkMode = false; } else this.exitMode(cx); return true;
    }
    return ["l", "h", "right", "left", "tab", "shift-tab", "1", "2", "3", "4"].includes(k);
  }

  // ---------- files ----------

  filesKey(k, cx) {
    const n = this.sel("files"), repo = this.repo;
    switch (k) {
      case "o": case "t": case "b": {
        const files = (n ? (n.dir ? n.files : [n.file]) : []).filter((f) => f.conflict);
        if (!files.length) return k === "b" ? false : true;
        const paths = files.map((f) => f.path), what = k === "o" ? "ours" : k === "t" ? "theirs" : "both";
        const go = (cx) => k === "b" ? this.keepBoth(cx, paths) : this.keepSide(cx, paths, what);
        const title = paths.length > 1 ? `Keep ${what} in ${paths.length} files?` : `Keep ${what} in ${paths[0]}?`;
        const body = paths.length > 1 ? paths.slice(0, 8).join(", ") : this.sideHelp();
        this.confirm(title, body, go);
        return true;
      }
      case "O": case "T": {
        const paths = (this.status?.files ?? []).filter((f) => f.conflict).map((f) => f.path);
        if (!paths.length) return this.say("No conflicts", "info"), true;
        const what = k === "O" ? "ours" : "theirs";
        this.confirm(`Keep ${what} in all ${paths.length} conflicted file(s)?`, this.sideHelp(), (cx) => this.keepSide(cx, paths, what));
        return true;
      }
      case "space": {
        if (!n) return true;
        const files = n.dir ? n.files : [n.file];
        if (files.some((f) => f.conflict)) {
          const conflictPaths = files.filter((f) => f.conflict).map((f) => f.path);
          const stage = (cx) => this.act(cx, "Marking resolved", async () => { await repo.ok(["add", "--", ...conflictPaths]); });
          const token = ++this.modalToken;
          cx.spawn(async (cx) => {
            try {
              const marked = [];
              for (const p of conflictPaths) {
                const text = await readTextFile(`${repo.root}/${p}`, { on: repo.on }).catch(() => null);
                if (text && G.parseConflicts(text).some((s) => s.conflict)) marked.push(p);
              }
              if (this.closed || repo !== this.repo || token !== this.modalToken) return;
              if (marked.length) this.confirm("Still has conflict markers", `${marked.join(", ")}: stage anyway?`, stage);
              else stage(cx);
            } catch (e) { this.say(errText(e), "error"); }
            cx.notify();
          });
          return true;
        }
        if (files.some((f) => f.unstaged)) this.git(cx, "Staging", ["add", "-A", "--", n.path]);
        else this.act(cx, "Unstaging", (_cx, r) => this.unstage(r, [n.path]));
        return true;
      }
      case "enter": {
        if (!n) return true;
        if (n.dir) { this.collapsed.has(n.path) ? this.collapsed.delete(n.path) : this.collapsed.add(n.path); this.buildTree(); return true; }
        if (n.file.conflict) return this.conflictMenu(n.file, cx), true;
        const side = n.file.unstaged ? "unstaged" : "staged";
        if (n.file.untracked) this.act(cx, "Preparing", async () => { await repo.ok(["add", "-N", "--", n.path]); }, async (cx) => { if (repo === this.repo) this.enterMode({ kind: "stage", path: n.path, side }, cx); });
        else this.enterMode({ kind: "stage", path: n.path, side }, cx);
        return true;
      }
      case "a": {
        const files = this.status?.files ?? [];
        if (files.some((f) => f.unstaged)) {
          const conflicts = files.filter((f) => f.conflict).map((f) => f.path);
          if (conflicts.length) {
            const stageAll = (cx) => this.act(cx, "Staging all", async () => { await repo.ok(["add", "-A"]); });
            const token = ++this.modalToken;
            cx.spawn(async (cx) => {
              try {
                const marked = [];
                for (const p of conflicts) {
                  const text = await readTextFile(`${repo.root}/${p}`, { on: repo.on }).catch(() => null);
                  if (text && G.parseConflicts(text).some((s) => s.conflict)) marked.push(p);
                }
                if (this.closed || repo !== this.repo || token !== this.modalToken) return;
                if (marked.length) this.confirm("Still has conflict markers", `${marked.slice(0, 8).join(", ")}: stage all anyway?`, stageAll);
                else stageAll(cx);
              } catch (e) { this.say(errText(e), "error"); }
              cx.notify();
            });
          } else {
            this.git(cx, "Staging all", ["add", "-A"]);
          }
        } else {
          this.act(cx, "Unstaging all", (_cx, r) => this.unstage(r, ["."]));
        }
        return true;
      }
      case "d": {
        if (!n) return true;
        const files = n.dir ? n.files : [n.file];
        this.confirm(`Discard all changes in ${n.path}${n.dir ? "/" : ""}?`, "Staged and unstaged changes are lost, untracked files are deleted.", (cx) => this.act(cx, "Discarding", async () => {
          const tracked = files.filter((f) => !f.untracked).map((f) => f.path), fresh = files.filter((f) => f.untracked).map((f) => f.path);
          const head = (await repo.run(["rev-parse", "--verify", "-q", "HEAD"], { read: true })).code === 0;
          const inHead = head && tracked.length ? (await repo.read(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...tracked])).split("\0").filter(Boolean) : [];
          const added = tracked.filter((p) => !inHead.includes(p));
          if (inHead.length) await repo.ok(["checkout", "HEAD", "--", ...inHead]);
          if (added.length) { await repo.ok(["rm", "-q", "-f", "--cached", "--", ...added]); fresh.push(...added); }
          if (fresh.length) await repo.ok(["clean", "-f", "-q", "--", ...fresh]);
        }));
        return true;
      }
      case "c": this.commitDialog(); return true;
      case "C": this.openTerminal(repo, ["git", "commit"]); return true;
      case "A": {
        const head = this.commits[0];
        if (!head || this.browse) return this.say("No commit to amend", "warning"), true;
        this.confirm("Amend last commit?", `Staged changes go into "${head.subject}".`, (cx) => this.git(cx, "Amending", ["commit", "--amend", "--no-edit"], { timeout: 120000 }));
        return true;
      }
      case "s": this.prompt("Stash all changes", "", (msg, cx) => this.git(cx, "Stashing", ["stash", "push", "-u", ...(msg.trim() ? ["-m", msg.trim()] : [])])); return true;
      case "S": this.prompt("Stash staged changes", "", (msg, cx) => this.git(cx, "Stashing", ["stash", "push", "--staged", ...(msg.trim() ? ["-m", msg.trim()] : [])])); return true;
      case "e": if (n && !n.dir) this.editFile(n.path, cx); return true;
      case "-": case "=": {
        const dirs = this.tree.filter((t) => t.dir).map((t) => t.path);
        if (k === "-") for (const p of dirs) this.collapsed.add(p); else this.collapsed.clear();
        this.buildTree(); return true;
      }
    }
    return false;
  }

  // ---------- conflicts ----------

  sideHelp() {
    return this.state?.kind === "rebase"
      ? "In a rebase, ours is the branch you're rebasing onto and theirs is your commit being replayed."
      : "Ours is your current branch (HEAD), theirs is what's coming in.";
  }

  // enter on a conflicted file: every way to resolve it.
  conflictMenu(file, cx) {
    const repo = this.repo, path = file.path, token = ++this.modalToken;
    cx.spawn(async (cx) => {
      try {
        const st = (await G.unmergedStages(repo, [path])).get(path) ?? new Set();
        const ours = st.has(2), theirs = st.has(3);
        const text = ours && theirs ? await readTextFile(`${repo.root}/${path}`, { on: repo.on }).catch(() => null) : null;
        if (this.closed || repo !== this.repo || token !== this.modalToken) return;
        const markers = !!text && G.parseConflicts(text).some((s) => s.conflict);
        const kind = ours && theirs ? (st.has(1) ? "both modified" : "both added") : ours ? (st.has(1) ? "they deleted it, you changed it" : "added by us") : theirs ? (st.has(1) ? "we deleted it, they changed it" : "added by them") : "both deleted";
        const items = [];
        if (markers) items.push({ key: "r", label: "Resolve conflict by conflict, or line by line…", run: (cx) => this.enterMode({ kind: "conflict", path, picks: new Set(), undo: [] }, cx) });
        items.push({ key: "o", label: ours ? "Keep ours (the whole file)" : "Keep ours: the file is deleted", run: (cx) => this.keepSide(cx, [path], "ours") });
        items.push({ key: "t", label: theirs ? "Keep theirs (the whole file)" : "Keep theirs: the file is deleted", run: (cx) => this.keepSide(cx, [path], "theirs") });
        if (markers) items.push({ key: "b", label: "Keep both (every conflict: ours, then theirs)", run: (cx) => this.keepBoth(cx, [path]) });
        if (ours !== theirs) items.push({ key: "d", label: "Delete the file", run: (cx) => this.git(cx, "Deleting", ["rm", "-q", "-f", "--", path]) });
        if (text !== null || !(ours && theirs)) items.push({ key: "e", label: "Open in editor", run: (cx) => this.editFile(path, cx) });
        items.push({ key: "a", label: "Mark resolved as it is now (stage)", run: (cx) => this.git(cx, "Marking resolved", ["add", "-A", "--", path]) });
        this.menu(`${path} · ${kind}`, items);
        this.modal.note = this.sideHelp();
      } catch (e) { this.say(errText(e), "error"); }
      cx.notify();
    });
  }

  // A whole side per file; where that side deleted the file, delete it.
  keepSide(cx, paths, side) {
    this.act(cx, `Keeping ${side}`, async (_cx, repo) => {
      const stages = await G.unmergedStages(repo, paths), want = side === "ours" ? 2 : 3;
      const keep = paths.filter((p) => stages.get(p)?.has(want)), gone = paths.filter((p) => !stages.get(p)?.has(want));
      if (keep.length) { await repo.ok(["checkout", `--${side}`, "--", ...keep]); await repo.ok(["add", "--", ...keep]); }
      if (gone.length) await repo.ok(["rm", "-q", "-f", "--", ...gone]);
      if (repo === this.repo && this.mode?.kind === "conflict" && paths.includes(this.mode.path)) this.mode = null;
      return `Kept ${side} in ${paths.length} file(s)${gone.length ? `, ${gone.length} deleted` : ""}`;
    });
  }

  keepBoth(cx, paths) {
    this.act(cx, "Keeping both", async (_cx, repo) => {
      const skipped = [];
      for (const path of paths) {
        const text = await readTextFile(`${repo.root}/${path}`, { on: repo.on }).catch(() => null);
        const segs = text === null ? [] : G.parseConflicts(text);
        if (!segs.some((s) => s.conflict)) { skipped.push(path); continue; }
        await G.writeFile(repo, path, G.joinSegs(segs.map((s) => s.conflict ? { lines: [...s.ours, ...s.theirs] } : s)));
        await repo.ok(["add", "--", path]);
      }
      if (repo === this.repo && this.mode?.kind === "conflict" && paths.includes(this.mode.path)) this.mode = null;
      if (skipped.length) return { text: `No conflict markers in ${skipped.join(", ")}: pick ours or theirs there`, level: "warning" };
      return "Kept both sides";
    });
  }

  // Replaces conflicts with chosen lines (fn returns the lines, or null to leave one), writes the file,
  // and stages it once no conflict is left.
  resolve(cx, fn) {
    const m = this.mode;
    if (!m?.segs) return;
    let n = 0;
    const segs = m.segs.map((s, ci) => { if (!s.conflict) return s; const lines = fn(s, ci); if (!lines) return s; n++; return { lines }; });
    if (!n) return;
    const text = G.joinSegs(segs), before = m.text;
    this.act(cx, "Resolving", async (_cx, repo) => {
      await G.writeFile(repo, m.path, text);
      m.undo.push(before); m.text = text; m.segs = G.parseConflicts(text); m.picks.clear();
      if (repo === this.repo) this.anchor = null;
      if (!m.segs.some((s) => s.conflict)) {
        await repo.ok(["add", "--", m.path]);
        if (repo === this.repo && this.mode === m) this.mode = null;
        return `${m.path}: all conflicts resolved and staged`;
      }
      if (repo === this.repo && this.mode === m) {
        const left = m.segs.filter((s) => s.conflict).length;
        this.main = { key: this.main.key, rows: conflictRows(m.segs), title: `${m.path} · ${left} conflict${left === 1 ? "" : "s"}` };
        this.afterModeLoad();
      }
      return `${n} conflict(s) resolved · z to undo`;
    });
  }

  conflictKey(k, cx) {
    const m = this.mode, row = this.main.rows[this.lineCursor], ci = row?.conflict;
    if (this.lineNav(k)) return true;
    const side = { o: (s) => s.ours, t: (s) => s.theirs, b: (s) => [...s.ours, ...s.theirs], B: (s) => [...s.theirs, ...s.ours] };
    switch (k) {
      case "o": case "t": case "b": case "B":
        if (ci === undefined) return this.say("Move onto a conflict first", "warning"), true;
        this.resolve(cx, (s, i) => i === ci ? side[k](s) : null);
        return true;
      case "O": case "T":
        this.resolve(cx, (s) => side[k.toLowerCase()](s));
        return true;
      case "space": {
        const keys = this.selectedKeys();
        const allIn = [...keys].every((key) => m.picks.has(key));
        for (const key of keys) allIn ? m.picks.delete(key) : m.picks.add(key);
        this.anchor = null;
        return true;
      }
      case "enter": {
        if (ci === undefined || !m?.segs) return true;
        const seg = m.segs[ci], picked = (s, list) => list.filter((_, i) => m.picks.has(`${ci}:${s}:${i}`));
        if (![...m.picks].some((key) => key.startsWith(`${ci}:`))) return this.say("Pick lines with space first (or o / t / b for a whole side)", "warning"), true;
        this.resolve(cx, (s, i) => i === ci ? [...picked("o", seg.ours), ...picked("t", seg.theirs)] : null);
        return true;
      }
      case "z": {
        if (this.busy) return this.say(`Busy: ${this.busy}`, "warning"), true;
        const prev = m.undo.at(-1);
        if (prev === undefined) return this.say("Nothing to undo", "info"), true;
        this.act(cx, "Undoing", async (_cx, repo) => {
          await G.writeFile(repo, m.path, prev);
          m.undo.pop();
          m.text = prev;
          m.segs = G.parseConflicts(prev);
          m.picks.clear();
          if (repo === this.repo && this.mode === m) {
            const left = m.segs.filter((s) => s.conflict).length;
            this.main = { key: this.main.key, rows: conflictRows(m.segs), title: `${m.path} · ${left} conflict${left === 1 ? "" : "s"}` };
            this.afterModeLoad();
          }
        });
        return true;
      }
      case "e": this.editFile(m.path, cx); return true;
      case "escape": if (this.anchor !== null || this.hunkMode) { this.anchor = null; this.hunkMode = false; } else this.exitMode(cx); return true;
    }
    return ["l", "h", "right", "left", "tab", "shift-tab", "1", "2", "3", "4"].includes(k);
  }

  editFile(path, cx) {
    const repo = this.repo;
    if (!repo || !this.canOpenTerminalFor(repo)) return;
    cx.spawn(async (cx) => {
      try {
        const argv = await this.editorArgv(repo, path);
        if (this.closed || repo !== this.repo) return;
        this.openTerminal(repo, argv);
      } catch (e) { this.say(errText(e), "error"); }
      cx.notify();
    });
  }

  commitDialog() {
    const repo = this.repo;
    if ((this.status?.files ?? []).some((f) => f.conflict)) return this.say("Resolve conflicts before committing", "warning");
    const staged = (this.status?.files ?? []).some((f) => f.staged);
    const open = () => this.prompt("Commit", "", (msg, cx) => {
      if (!msg.trim()) return this.say("Empty message: nothing committed", "warning");
      this.git(cx, "Committing", ["commit", "-m", msg.trim()], { timeout: 120000 });
    }, true, { submitLabel: "Commit", editor: (msg) => this.openTerminal(repo, ["git", "commit", ...(msg.trim() ? ["-e", "-m", msg.trim()] : [])]) });
    if (staged) return open();
    if (!(this.status?.files ?? []).length) return this.say("Nothing to commit", "warning");
    this.confirm("Nothing staged", "Stage all changes and commit?", (cx) => this.act(cx, "Staging all", async (_cx, r) => { await r.ok(["add", "-A"]); }, async (_cx, r) => { if (r === this.repo) open(); }));
  }

  // ---------- branches ----------

  validBranchName(name) {
    const n = name.trim();
    if (!n) return null;
    if (n.startsWith("-")) { this.say("Branch names cannot start with '-'", "warning"); return null; }
    return n;
  }

  branchesKey(k, cx) {
    const b = this.sel("branches"), local = this.branchTab === "local";
    const checkoutLocal = (cx, name) => this.git(cx, `Checking out ${name}`, name.startsWith("-") ? ["switch", "--", name] : ["checkout", name]);
    switch (k) {
      case "[": case "]": this.branchTab = local ? "remote" : "local"; this.cursor.branches = 0; this.refresh(cx, true); return true;
      case "space": {
        if (!b) return true;
        if (local) { if (!b.head) checkoutLocal(cx, b.name); return true; }
        const mine = this.branches.local.find((l) => l.name === b.branch);
        if (mine) checkoutLocal(cx, b.branch);
        else this.git(cx, `Checking out ${b.branch}`, ["checkout", "--track", b.ref]);
        return true;
      }
      case "enter":
        if (!b) return true;
        this.browse = b.head ? null : { name: b.name, ref: b.ref }; this.cfiles = null; this.plan = null; this.cursor.commits = 0; this.panel = "commits"; this.refresh(cx, true);
        return true;
      case "n": {
        const fromLabel = b?.name ?? "HEAD", fromRef = b?.ref ?? "HEAD";
        this.prompt(`New branch from ${fromLabel}`, local || !b ? "" : b.branch, (name, cx) => {
          const n = this.validBranchName(name);
          if (n) this.git(cx, "Creating branch", ["checkout", "-b", n, fromRef]);
        });
        return true;
      }
      case "r":
        if (!b || !local) return this.say("Rename works on local branches", "warning"), true;
        this.prompt(`Rename ${b.name}`, b.name, (name, cx) => {
          const n = this.validBranchName(name);
          if (n && n !== b.name) this.git(cx, "Renaming", ["branch", "-m", "--", b.name, n]);
        });
        return true;
      case "d":
        if (!b) return true;
        if (!local) return this.deleteRemote(b.remote, b.branch), true;
        if (b.head) return this.say("Can't delete the checked-out branch", "warning"), true;
        this.confirm(`Delete local branch ${b.name}?`, b.upstream ? `Its upstream ${b.upstream} stays.` : "It has no upstream.", (cx) => this.act(cx, "Deleting", async (_cx, repo) => {
          const r = await repo.run(["branch", "-d", "--", b.name]);
          if (r.code === 0) return "Branch deleted";
          if (/not fully merged/.test(r.stderr)) { if (!this.closed && repo === this.repo) this.confirm(`${b.name} is not fully merged`, "Delete it anyway? Its unmerged commits are lost.", (cx) => this.git(cx, "Deleting", ["branch", "-D", "--", b.name])); return; }
          throw new G.GitError(r, ["branch"]);
        }));
        return true;
      case "D": {
        if (!b) return true;
        if (!local) return this.deleteRemote(b.remote, b.branch), true;
        if (!b.upstream) return this.say(`${b.name} has no upstream`, "warning"), true;
        if (!b.upstreamRemote || !b.upstreamBranch) return this.say(`${b.name} tracks local branch ${b.upstream}, not a remote`, "warning"), true;
        this.deleteRemote(b.upstreamRemote, b.upstreamBranch);
        return true;
      }
      case "u":
        if (!b || !local) return true;
        this.prompt(`Upstream for ${b.name}`, b.upstream ?? `origin/${b.name}`, (up, cx) => {
          const u = up.trim();
          if (u) this.git(cx, "Setting upstream", ["branch", `--set-upstream-to=${u}`, "--", b.name]);
        });
        return true;
    }
    return false;
  }

  deleteRemote(remote, branch) {
    this.confirm(`Delete remote branch ${remote}/${branch}?`, "It's removed from the remote for everyone.", (cx) => this.git(cx, "Deleting remote branch", ["push", "--delete", "--", remote, `refs/heads/${branch}`], { timeout: 300000 }));
  }

  push(cx) {
    const st = this.status;
    if (!st?.head) return this.say("Not on a branch", "warning");
    this.act(cx, "Pushing", async (_cx, repo) => {
      let args = ["push"];
      if (!st.upstream) {
        const remotes = (await repo.read(["remote"])).split("\n").filter(Boolean);
        if (!remotes.length) throw new Error("No remote to push to");
        const remote = remotes.includes("origin") ? "origin" : remotes[0];
        args = ["push", "-u", "--", remote, `refs/heads/${st.head}`];
      }
      const r = await repo.run(args, { timeout: 300000 });
      if (r.code === 0) return "Pushed";
      if (/rejected|non-fast-forward|fetch first|stale info/.test(r.stderr)) {
        const forceArgs = ["push", "--force-with-lease", ...args.slice(1)];
        if (!this.closed && repo === this.repo) this.confirm("Push rejected", "The remote has commits you don't. Force push with lease (overwrites them)?", (cx) => this.git(cx, "Force pushing", forceArgs, { timeout: 300000 }));
        return;
      }
      throw new G.GitError(r, args);
    });
  }

  // ---------- commits ----------

  commitsKey(k, cx) {
    const c = this.sel("commits"), repo = this.repo, i = this.cursor.commits;
    if (!c) return false;
    const todoLen = this.activeTodo().length, ci = i - todoLen;
    const isHead = ci === 0 && !this.browse;
    const isPushed = (sha) => !!this.unpushed && !this.unpushed.has(sha);
    switch (k) {
      case "b":
        if (isHead && this.state?.kind === "rebase" && this.rebaseTodo !== null) {
          const next = [...this.rebaseTodo, { todo: true, kind: "break", action: "break" }];
          this.saveTodo(cx, next, todoLen);
          return true;
        }
        return false;
      case "x":
        if (isHead && this.state?.kind === "rebase" && this.rebaseTodo !== null) {
          this.prompt("Exec after HEAD (a shell command)", "", (cmd, cx) => {
            if (!cmd.trim()) return;
            if (!this.rebaseTodo || this.state?.kind !== "rebase") return this.say("No rebase in progress", "warning");
            const next = [...this.rebaseTodo, { todo: true, kind: "exec", action: "exec", cmd: cmd.trim().replace(/\n/g, " ") }];
            this.saveTodo(cx, next, this.rebaseTodo.length);
          });
          return true;
        }
        return false;
      case "enter":
        this.openCommitFiles(c.sha, c.short, c.subject, cx);
        return true;
      case "r": {
        if (!this.canRewrite()) return true;
        const token = ++this.modalToken;
        cx.spawn(async (cx) => {
          try {
            const body = (await repo.read(["log", "-1", "--format=%B", c.sha])).replace(/\n+$/, "");
            if (this.closed || repo !== this.repo || token !== this.modalToken) return;
            this.prompt(`Reword ${c.short}`, body, (msg, cx) => {
              if (!msg.trim()) return this.say("Empty message: not changed", "warning");
              if (isHead) this.git(cx, "Rewording", ["commit", "--amend", "--only", "--allow-empty", "-m", msg.trim()]);
              else this.history(cx, "Rewording", c.sha, (shas, _base, paths) => shas.flatMap((s) => s === c.sha ? [`pick ${s}`, G.X.amendMsg(paths.msg)] : [`pick ${s}`]), { msg: msg.trim() });
            }, true, { submitLabel: "Reword" });
          } catch (e) { this.say(errText(e), "error"); }
          cx.notify();
        });
        return true;
      }
      case "R":
        if (!this.canRewrite()) return true;
        if (isHead) this.openTerminal(repo, ["git", "commit", "--amend", "--only"]);
        else if (this.canOpenTerminalFor(repo)) cx.spawn(async (cx) => {
          try {
            const { base, shas } = await G.rebaseRange(repo, c.sha);
            const argv = await G.rebaseArgv(repo, base, shas.map((s) => `${s === c.sha ? "reword" : "pick"} ${s}`));
            if (this.closed || repo !== this.repo) return;
            this.openTerminal(repo, argv);
          } catch (e) { this.say(errText(e), "error"); }
          cx.notify();
        });
        return true;
      case "d":
        if (!this.canRewrite()) return true;
        this.confirm(`Drop commit ${c.short}?`, `"${c.subject}" is removed from history.`, (cx) =>
          this.history(cx, "Dropping", c.sha, (shas) => shas.map((s) => `${s === c.sha ? "drop" : "pick"} ${s}`)));
        return true;
      case "e":
        if (!this.canRewrite()) return true;
        if (isHead) return this.say("That's HEAD: change files and amend (A in Files)", "info"), true;
        this.history(cx, "Starting rebase", c.sha, (shas) => shas.map((s) => `${s === c.sha ? "edit" : "pick"} ${s}`));
        return true;
      case "s": case "f": {
        if (!this.canRewrite()) return true;
        const below = this.commits[ci + 1];
        if (!below) return this.say("No commit below to squash into", "warning"), true;
        const action = k === "s" ? "squash" : "fixup";
        const go = (cx) => this.history(cx, action === "squash" ? "Squashing" : "Fixing up", below.sha, (shas) => shas.map((s) => `${s === c.sha ? action : "pick"} ${s}`));
        if (isPushed(below.sha) || isPushed(c.sha)) {
          this.confirm(`${action === "squash" ? "Squash" : "Fixup"} pushed commit ${c.short}?`, "This rewrites already-pushed history and will require a force push.", go);
        } else go(cx);
        return true;
      }
      case "A":
        if (!this.canRewrite()) return true;
        if (!(this.status?.files ?? []).some((f) => f.staged)) return this.say("Nothing staged to amend with", "warning"), true;
        this.confirm(`Amend ${c.short} with staged changes?`, `"${c.subject}"`, (cx) => {
          if (isHead) return this.git(cx, "Amending", ["commit", "--amend", "--no-edit"], { timeout: 120000 });
          this.act(cx, "Amending", async (_cx, repo) => {
            await G.rebaseRange(repo, c.sha);
            await repo.ok(["commit", "--no-verify", `--fixup=${c.sha}`]);
            const fix = (await repo.read(["rev-parse", "HEAD"])).trim();
            const { base, shas } = await G.rebaseRange(repo, c.sha);
            const todo = shas.filter((s) => s !== fix).flatMap((s) => s === c.sha ? [`pick ${s}`, `fixup ${fix}`] : [`pick ${s}`]);
            return this.rebaseOutcome(await G.rebase(repo, base, todo));
          });
        });
        return true;
      case "a":
        if (!this.canRewrite()) return true;
        this.menu(`Author of ${c.short} · ${c.author} <${c.email}>`, [
          {
            key: "r", label: "Reset author to you", run: (cx) => isHead ? this.git(cx, "Resetting author", ["commit", "--amend", "--only", "--allow-empty", "--no-edit", "--reset-author"])
              : this.history(cx, "Resetting author", c.sha, (shas) => shas.flatMap((s) => s === c.sha ? [`pick ${s}`, G.X.resetAuthor()] : [`pick ${s}`]))
          },
          {
            key: "s", label: "Set author…", run: () => this.prompt("Author (Name <email>)", `${c.author} <${c.email}>`, (who, cx) => {
              if (!/^.+<.+@?.*>$/.test(who.trim())) return this.say("Use the form: Name <email>", "warning");
              if (isHead) this.git(cx, "Setting author", ["commit", "--amend", "--only", "--allow-empty", "--no-edit", `--author=${who.trim()}`]);
              else this.history(cx, "Setting author", c.sha, (shas, _base, paths) => shas.flatMap((s) => s === c.sha ? [`pick ${s}`, G.X.amendAuthor(paths.author)] : [`pick ${s}`]), { author: who.trim() });
            })
          },
        ]);
        return true;
      case "ctrl-j": case "ctrl-k": {
        if (!this.canRewrite()) return true;
        const down = k === "ctrl-j", other = down ? this.commits[ci + 1] : this.commits[ci - 1];
        if (!other) return true;
        const [older, newer] = down ? [other, c] : [c, other];
        const nextCursor = i + (down ? 1 : -1);
        const go = (cx) => this.act(cx, "Moving commit", async (_cx, repo) => {
          const { base, shas } = await G.rebaseRange(repo, older.sha);
          const t = shas.map((s) => `pick ${s}`);
          [t[0], t[1]] = [t[1], t[0]];
          const r = await G.rebase(repo, base, t);
          if (r.code === 0 && repo === this.repo) this.cursor.commits = nextCursor;
          return this.rebaseOutcome(r);
        });
        if (isPushed(older.sha) || isPushed(newer.sha)) {
          this.confirm(`Move pushed commit ${c.short}?`, "This rewrites already-pushed history and will require a force push.", go);
        } else go(cx);
        return true;
      }
      case "i":
        if (!this.canRewrite()) return true;
        this.plan = { items: this.commits.slice(0, ci + 1).map((x) => ({ sha: x.sha, short: x.short, subject: x.subject, action: "pick" })) };
        this.cursor.plan = ci;
        return true;
      case "o":
        cx.write_to_clipboard(c.sha);
        this.say(`Copied ${c.short}`);
        return true;
      case "n":
        this.prompt(`New branch at ${c.short}`, "", (name, cx) => {
          const n = this.validBranchName(name);
          if (n) this.git(cx, "Creating branch", ["checkout", "-b", n, c.sha]);
        });
        return true;
      case "space":
        this.confirm(`Check out ${c.short}?`, "HEAD becomes detached at this commit.", (cx) => this.git(cx, "Checking out", ["checkout", c.sha]));
        return true;
      case "escape":
        if (this.patch) { this.confirm("Reset the patch?", `${this.patch.files.size} file(s) from ${this.patch.short}`, () => { this.patch = null; }); return true; }
        if (!this.browse && this.state?.kind === "rebase") { this.confirmAbortRebase(); return true; }
        return false;
    }
    return false;
  }

  cfilesKey(k, cx) {
    const n = this.sel("commits"), c = this.cfiles;
    switch (k) {
      case "escape": this.cfiles = null; return true;
      case "space": if (n) this.toggleFilesInPatch(n.dir ? n.files : [n.file]); return true;
      case "a": this.toggleFilesInPatch(c.files); return true;
      case "enter":
        if (!n) return true;
        if (n.dir) { c.collapsed.has(n.path) ? c.collapsed.delete(n.path) : c.collapsed.add(n.path); this.rebuildCfilesTree(); return true; }
        this.enterMode({ kind: "patch", sha: c.sha, path: n.path }, cx);
        return true;
      case "-": case "=": {
        const dirs = c.tree.filter((t) => t.dir).map((t) => t.path);
        if (k === "-") for (const p of dirs) c.collapsed.add(p); else c.collapsed.clear();
        this.rebuildCfilesTree();
        return true;
      }
    }
    return false;
  }

  confirmAbortRebase() {
    this.confirm("Abort the rebase?", "Everything goes back to how it was before it started.", (cx) => this.act(cx, "Aborting", async (_cx, repo) => {
      await repo.ok(["rebase", "--abort"]);
      await G.cleanRebaseFiles(repo);
    }));
  }

  saveTodo(cx, items, nextCursor = null, msg = null) {
    if (this.busy) return this.say(`Busy: ${this.busy}`, "warning");
    this.act(cx, "Updating rebase plan", async (_cx, repo) => {
      await G.saveRebaseTodo(repo, items);
      if (repo === this.repo) {
        this.rebaseTodo = items;
        if (nextCursor !== null) { this.cursor.commits = nextCursor; this.scrollTo(); }
      }
      return msg;
    });
  }

  rebaseTodoKey(k, cx) {
    const todo = this.activeTodo(), i = this.cursor.commits, item = todo[i], repo = this.repo;
    if (!item) return false;
    const setAction = (a) => {
      if (item.kind !== "commit") return;
      this.saveTodo(cx, todo.map((x, idx) => idx === i ? { ...x, action: a, flags: null } : x));
    };
    const editExec = () => this.prompt("Edit exec command", item.cmd ?? "", (cmd, cx) => {
      if (!cmd.trim()) return;
      this.saveTodo(cx, todo.map((x, idx) => idx === i ? { ...x, cmd: cmd.trim().replace(/\n/g, " ") } : x));
    });
    switch (k) {
      case "p": setAction("pick"); return true;
      case "d":
        if (item.kind === "commit") setAction("drop");
        else {
          const next = todo.filter((_, idx) => idx !== i);
          const nextCursor = Math.max(0, Math.min(i, next.length + this.commits.length - 1));
          this.saveTodo(cx, next, nextCursor);
        }
        return true;
      case "e": if (item.kind === "exec") editExec(); else setAction("edit"); return true;
      case "r": if (item.kind === "exec") editExec(); else setAction("reword"); return true;
      case "s": setAction("squash"); return true;
      case "f": setAction("fixup"); return true;
      case "b": {
        const next = [...todo];
        next.splice(i, 0, { todo: true, kind: "break", action: "break" });
        this.saveTodo(cx, next);
        return true;
      }
      case "x":
        this.prompt("Exec after this item (a shell command)", "", (cmd, cx) => {
          if (!cmd.trim()) return;
          const next = [...todo];
          next.splice(i, 0, { todo: true, kind: "exec", action: "exec", cmd: cmd.trim().replace(/\n/g, " ") });
          this.saveTodo(cx, next);
        });
        return true;
      case "ctrl-j": case "ctrl-k": {
        const j = i + (k === "ctrl-j" ? 1 : -1);
        if (j < 0 || j >= todo.length) return true;
        const next = [...todo];
        [next[i], next[j]] = [next[j], next[i]];
        this.saveTodo(cx, next, j);
        return true;
      }
      case "enter":
        if (item.kind !== "commit") return true;
        this.openCommitFiles(item.sha, item.short, item.subject, cx);
        return true;
      case "o":
        if (item.kind !== "commit") return true;
        cx.write_to_clipboard(item.sha);
        this.say(`Copied ${item.short}`);
        return true;
      case "escape":
        this.confirmAbortRebase();
        return true;
    }
    return false;
  }

  planKey(k, cx) {
    const P = this.plan, i = this.cursor.plan, item = P.items[i], repo = this.repo;
    const set = (a) => { if (item?.sha) { item.action = a; if (a !== "reword") delete item.msg; } };
    const editExec = () => this.prompt("Edit exec command", item.cmd ?? "", (cmd) => { if (cmd.trim()) item.cmd = cmd.trim().replace(/\n/g, " "); });
    switch (k) {
      case "p": set("pick"); return true;
      case "d": if (item && !item.sha) { P.items.splice(i, 1); this.cursor.plan = Math.max(0, Math.min(i, P.items.length - 1)); } else set("drop"); return true;
      case "e": if (item && !item.sha && item.kind !== "break") editExec(); else set("edit"); return true;
      case "s": set("squash"); return true;
      case "f": set("fixup"); return true;
      case "r": {
        if (!item) return true;
        if (!item.sha) { if (item.kind !== "break") editExec(); return true; }
        const token = ++this.modalToken;
        cx.spawn(async (cx) => {
          try {
            const body = item.msg ?? (await repo.read(["log", "-1", "--format=%B", item.sha])).replace(/\n+$/, "");
            if (this.closed || repo !== this.repo || this.plan !== P || token !== this.modalToken) return;
            this.prompt(`Reword ${item.short}`, body, (msg) => { if (msg.trim()) { item.action = "reword"; item.msg = msg.trim(); } }, true, { submitLabel: "Set message" });
          } catch (e) { this.say(errText(e), "error"); }
          cx.notify();
        });
        return true;
      }
      case "b":
        P.items.splice(i, 0, { kind: "break", action: "break" });
        return true;
      case "x":
        this.prompt("Exec after this commit (a shell command)", "", (cmd) => { if (cmd.trim()) { P.items.splice(i, 0, { kind: "exec", action: "exec", cmd: cmd.trim().replace(/\n/g, " ") }); } });
        return true;
      case "ctrl-j": case "ctrl-k": {
        const j = i + (k === "ctrl-j" ? 1 : -1);
        if (j < 0 || j >= P.items.length) return true;
        [P.items[i], P.items[j]] = [P.items[j], P.items[i]];
        this.cursor.plan = j; this.scrollTo();
        return true;
      }
      case "escape": this.plan = null; return true;
      case "enter": this.runPlan(); return true;
    }
    return false;
  }

  runPlan() {
    const items = [...this.plan.items].reverse(); // oldest first
    const commits = items.filter((x) => x.sha);
    let seen = false;
    for (const x of commits) {
      if ((x.action === "squash" || x.action === "fixup") && !seen) return this.say(`Can't ${x.action} ${x.short}: no earlier commit to fold into`, "warning");
      if (x.action !== "drop") seen = true;
    }
    const files = {};
    items.forEach((x, n) => { if (x.sha && x.action === "reword") files[`msg-${n}`] = x.msg; });
    const summary = commits.filter((x) => x.action !== "pick").map((x) => `${x.action} ${x.short}`).join(", ") || "reorder only";
    const execs = items.filter((x) => !x.sha && x.kind !== "break").length;
    const breaks = items.filter((x) => x.kind === "break").length;
    const extras = [execs ? `${execs} exec` : "", breaks ? `${breaks} break` : ""].filter(Boolean).join(", ");
    this.confirm(`Rebase ${commits.length} commit(s)?`, summary + (extras ? ` · ${extras}` : ""), (cx) => {
      const expected = new Set(commits.map((x) => x.sha));
      this.plan = null;
      this.history(cx, "Rebasing", this.oldestOf(expected), (shas, _base, paths) => {
        if (shas.length !== expected.size || !shas.every((s) => expected.has(s))) throw new Error("History changed since you planned this; plan again");
        return items.flatMap((x, n) => {
          if (x.kind === "break") return ["break"];
          if (!x.sha) return [`exec ${x.cmd}`];
          if (x.action === "reword") return [`pick ${x.sha}`, G.X.amendMsg(paths[`msg-${n}`])];
          return [`${x.action} ${x.sha}`];
        });
      }, files);
    });
  }

  oldestOf(set) { let o = null; for (const c of this.commits) if (set.has(c.sha)) o = c.sha; return o; }

  // ---------- stash, state ----------

  stashKey(k, cx) {
    const s = this.sel("stash");
    if (!s) return false;
    switch (k) {
      case "space": this.git(cx, "Applying stash", ["stash", "apply", s.ref]); return true;
      case "o": this.git(cx, "Popping stash", ["stash", "pop", s.ref]); return true;
      case "d": this.confirm(`Drop ${s.ref}?`, s.subject, (cx) => this.git(cx, "Dropping stash", ["stash", "drop", s.ref])); return true;
      case "n": this.prompt(`New branch from ${s.ref}`, "", (name, cx) => {
        const n = this.validBranchName(name);
        if (n) this.git(cx, "Creating branch", ["stash", "branch", n, s.ref]);
      }); return true;
    }
    return false;
  }

  stateMenu() {
    const st = this.state, repo = this.repo;
    if (!st) return this.say("No rebase, merge or cherry-pick in progress");
    const cmd = st.kind === "rebase" ? "rebase" : st.kind;
    const needsEditor = () => {
      if (st.kind !== "rebase" || !this.rebaseTodo) return false;
      for (let idx = this.rebaseTodo.length - 1; idx >= 0; idx--) {
        const x = this.rebaseTodo[idx];
        if (x.action === "reword") return true;
        if (x.action === "edit" || x.action === "break") return false;
      }
      return false;
    };
    const items = [
      {
        key: "c", label: needsEditor() ? "Continue (opens editor for reword)" : "Continue", run: (cx) => {
          if (needsEditor()) return this.openTerminal(repo, ["git", "rebase", "--continue"]);
          this.act(cx, "Continuing", async (_cx, r0) => {
            const r = await r0.run([cmd, "--continue"], { timeout: 300000 });
            if (st.kind === "rebase") {
              const paused = (await G.loadState(r0))?.kind === "rebase";
              if (r.code === 0 && !paused) await G.cleanRebaseFiles(r0);
              return this.rebaseOutcome(r, paused);
            }
            return r.code === 0 ? "Done" : (() => { throw new G.GitError(r, [cmd]); })();
          });
        }
      },
      {
        key: "a", label: "Abort", run: () => this.confirm(`Abort the ${st.kind}?`, "Everything goes back to how it was before it started.", (cx) => this.act(cx, "Aborting", async (_cx, r0) => {
          await r0.ok([cmd, "--abort"]);
          if (st.kind === "rebase") await G.cleanRebaseFiles(r0);
        }))
      },
    ];
    if (st.kind === "rebase") items.splice(1, 0, { key: "C", label: "Continue in terminal", run: () => this.openTerminal(repo, ["git", "rebase", "--continue"]) });
    if (st.kind !== "merge") {
      items.splice(items.length - 1, 0, {
        key: "s", label: "Skip this commit", run: () => this.confirm(`Skip this commit in ${st.kind}?`, "The current commit's changes will be discarded.", (cx) => this.act(cx, "Skipping", async (_cx, r0) => {
          const r = await r0.run([cmd, "--skip"], { timeout: 300000 });
          let paused = false;
          if (st.kind === "rebase") {
            paused = (await G.loadState(r0))?.kind === "rebase";
            if (r.code === 0 && !paused) await G.cleanRebaseFiles(r0);
          }
          return this.rebaseOutcome(r, paused);
        }))
      });
    }
    this.menu(st.kind === "rebase" ? `Rebasing ${st.branch} · ${st.step}/${st.total}` : `${st.kind} in progress`, items);
  }

  openHelp() {
    this.releaseModal();
    const ctx = this.context();
    this.helpScroll = this.helpScroll ?? ScrollHandle.new();
    this.helpScroll.scroll_to_item(0);
    const sections = [[ctx, KEYS[ctx] ?? []], ["global", KEYS.global]];
    this.modal = { kind: "help", title: "Keys", sections, top: 0, rows: sections.reduce((n, s) => n + s[1].length + 1, 0) };
  }

  // ---------- render ----------

  render(cx) {
    if (!this.pinned && !this.repo && !checking() && !this.locKey) this.follow(cx, focusLocation() ?? fallbackLocation());
    const t = theme();
    this.monoFont = settings().font_family || settings().font || cx.theme().typography.mono;
    const wide = (this.size?.width ?? 1000) >= 720;
    const body = !this.repo
      ? div().flex_1().p(20).text_color(t.dim).child(this.error ?? (checking() ? "minigit" : "Looking for a git repository…"))
      : (wide ? h_flex() : v_flex()).flex_1().min_h(0).p(6)
        .child(this.column(t, wide))
        .child(wide
          ? this.splitter("col", "mg-split-main", (e) => { const w0 = this.leftWidth(); return (pos) => { this.lay.leftW = w0 + pos.x - e.position.x; }; }, () => { delete this.lay.leftW; })
          : this.splitter("row", "mg-split-main", (e) => { const h0 = this.colH ?? PANELS.reduce((n, q) => n + (this.ph[q] ?? 60), 18); return (pos) => { this.lay.listH = h0 + pos.y - e.position.y; }; }, () => { delete this.lay.listH; }))
        .child(this.mainBox(t, wide));
    const keep = (e) => e.on_mouse_down("left", (_e, cx) => { if (props()?.overlay) cx.stop_propagation(); });
    return v_flex().id("minigit").size_full().relative().bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_window_mouse_move((e, cx) => {
        if (!this.drag) return;
        if (e.pressed_button !== "left") { this.endDrag(); cx.notify(); return; }
        this.drag.move(e.position); cx.notify();
      })
      .on_window_mouse_up("left", (_e, cx) => { if (this.drag) { this.endDrag(); cx.notify(); } })
      .on_mouse_down("left", (_e, _cx) => { if (!this.modal) this.handle.focus(); })
      .child(this.header(t))
      .child(keep(div().id("mg-body").flex_1().min_h(0).flex().flex_col().child(body)))
      .child(keep(this.footer(t)))
      .when(!!this.modal, (e) => e.child(this.modalLayer(t)));
  }

  header(t) {
    const st = this.status, repo = this.repo;
    const name = repo ? repo.root.split("/").pop() : "minigit";
    const branch = st ? (st.head ?? `detached @ ${st.oid?.slice(0, 7) ?? "?"}`) : "";
    const s = this.state;
    return h_flex().h(30).flex_none().px(10).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().font_semibold().child(name))
      .when(!!repo?.on, (e) => e.child(div().text_color(t.dim).child(`on ${repo.on}`)))
      .when(!!branch, (e) => e.child(h_flex().gap(6).items_center().child(div().text_color(t.accent).child(branch))
        .when(!!st.upstream, (e) => e.child(div().text_color(t.dim).text_size(11).child(st.upstream)))
        .when(st.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${st.ahead}`)))
        .when(st.behind > 0, (e) => e.child(div().text_color(t.ansi1).child(`↓${st.behind}`)))))
      .when(!!this.browse, (e) => e.child(div().px(6).rounded(4).bg(t.raised).text_size(11).child(`browsing ${this.browse.name} · esc`)))
      .when(!!s, (e) => e.child(div().px(6).rounded(4).bg(t.blocked).text_color(t.background).text_size(11).font_semibold()
        .child(s.kind === "rebase" ? `REBASING ${s.step}/${s.total}${s.stopped ? ` · at ${s.stopped}` : ""} · m` : `${s.kind.toUpperCase()} · m`)))
      .child(div().flex_1())
      .when(this.dock || (!!props()?.overlay && this.canPin()), (e) => e.child(h_flex().id("mg-pin").h(20).px(8).items_center().rounded(5).text_size(11).cursor_pointer()
        .bg(t.raised).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.dock ? this.unpin() : this.pin(); cx.notify(); })
        .child(this.dock ? "Unpin" : "Pin to sidebar")))
      .when(!!this.patch, (e) => e.child(div().px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.ansi5).child(`patch: ${this.patch.files.size} file(s) from ${this.patch.short} · ctrl-p`)))
      .when(!!this.busy || this.loading, (e) => e.child(h_flex().gap(5).items_center().text_color(t.dim).text_size(11)
        .child(div().frames(SPINNER, 80)).when(!!this.busy, (e) => e.child(this.busy))));
  }

  footer(t) {
    const f = this.flash, ctx = this.context();
    const hints = (KEYS[ctx] ?? []).filter((x) => x[2]).map((x) => `${x[0]} ${x[1]}`).join("  ·  ");
    const color = !f ? t.dim : f.level === "error" ? t.ansi1 : f.level === "warning" ? t.blocked : f.level === "success" ? t.ansi2 : t.muted;
    return h_flex().h(24).flex_none().px(10).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(f ? f.text : (this.error ?? hints)))
      .child(div().flex_none().text_color(t.dim).child("? keys"));
  }

  // ---------- resizing ----------

  layoutKey() { return `layout:${this.dock ? "dock" : props()?.overlay ? "window" : "pane"}`; }
  loadLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.layoutKey()) ?? "{}");
      if (!raw || typeof raw !== "object") return {};
      const out = {};
      if (Number.isFinite(raw.leftW) && raw.leftW > 0) out.leftW = raw.leftW;
      if (Number.isFinite(raw.listH) && raw.listH > 0) out.listH = raw.listH;
      if (raw.weights && typeof raw.weights === "object") {
        const w = {};
        for (const q of PANELS) if (Number.isFinite(raw.weights[q]) && raw.weights[q] > 0) w[q] = raw.weights[q];
        if (Object.keys(w).length === PANELS.length) out.weights = w;
      }
      return out;
    } catch { return {}; }
  }
  saveLayout() { try { localStorage.setItem(this.layoutKey(), JSON.stringify(this.lay)); } catch { } }
  endDrag() { this.drag = null; this.saveLayout(); }

  leftWidth() {
    const W = this.size?.width ?? 1000;
    return Math.max(200, Math.min(W - 320, this.lay.leftW ?? Math.max(260, Math.min(520, W * 0.38))));
  }

  // A drag handle: start(e) returns move(pos); a double-click resets.
  splitter(dir, id, start, reset) {
    const t = theme(), vertical = dir === "col", active = this.drag?.id === id;
    return div().id(id).flex_none().flex().items_center().justify_center().rounded(3)
      .when(vertical, (e) => e.w(6).h_full().cursor_col_resize()).when(!vertical, (e) => e.h(6).w_full().cursor_row_resize())
      .hover((s) => s.bg(t.hover))
      .child(div().rounded(1).bg(active ? t.accent : t.border).when(vertical, (e) => e.w(2).h(28)).when(!vertical, (e) => e.h(2).w(28)))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) { reset(); this.drag = null; this.saveLayout(); cx.notify(); return; }
        this.drag = { id, move: start(e) }; cx.notify();
      });
  }

  // The four boxes with a handle between each pair.
  column(t, wide) {
    const H = this.size?.height ?? 800;
    const kids = [];
    PANELS.forEach((p, i) => {
      if (i) kids.push(this.splitter("row", `mg-split-${i}`, (e) => {
        const hs = PANELS.map((q) => this.ph[q] ?? 100), y0 = e.position.y, a = hs[i - 1], b = hs[i], min = 34;
        return (pos) => {
          if (a + b <= 2 * min) return;
          const na = Math.max(min, Math.min(a + b - min, a + pos.y - y0)), w = [...hs];
          w[i - 1] = na; w[i] = a + b - na;
          this.lay.weights = Object.fromEntries(PANELS.map((q, k) => [q, w[k]]));
        };
      }, () => { delete this.lay.weights; }));
      kids.push(this.panelBox(p, i, t));
    });
    return v_flex().id("mg-col").min_h(0)
      .on_size_change((size) => { this.colH = size.height; })
      .when(wide, (e) => e.w(this.leftWidth()).h_full().flex_none())
      .when(!wide && this.lay.listH !== undefined, (e) => e.w_full().flex_none().h(Math.max(140, Math.min(H - 200, this.lay.listH))))
      .when(!wide && this.lay.listH === undefined, (e) => e.w_full().flex_basis(0).flex_grow(1))
      .children(kids);
  }

  panelBox(name, n, t) {
    const active = this.panel === name && !this.mode;
    let title = `${n + 1} ${TITLES[name]}`, extra = "";
    if (name === "files") { const c = (this.status?.files ?? []).filter((f) => f.conflict).length; extra = `${this.status?.files.length ?? 0}${c ? ` · ${c} conflicted · enter to resolve` : ""}`; }
    if (name === "branches") extra = this.branchTab === "local" ? "local · [ ] remotes" : `remotes${this.branches.remote.length >= 500 ? " (newest 500)" : ""} · [ ] local`;
    if (name === "commits") {
      const todo = this.activeTodo();
      extra = this.plan ? "rebase plan · enter run · esc cancel"
        : this.cfiles ? `${this.cfiles.short} files`
          : this.browse ? this.browse.name
            : this.state?.kind === "rebase" ? `rebasing · ${todo.length} todo · m continue`
              : String(this.commits.length);
    }
    if (name === "stash") extra = String(this.stashes.length);
    const listId = name === "branches" && this.branchTab === "remote" ? "remote" : this.cursorKey(name);
    const rows = this.rows(name, t);
    const weights = this.lay.weights;
    return v_flex().id(`panel-${name}`).flex_basis(0).flex_grow(weights ? weights[name] ?? 1 : this.panel === name ? 3 : 1).min_h(weights ? 34 : this.panel === name ? 100 : 46).rounded(6).border_1()
      .on_size_change((size) => { this.ph[name] = size.height; })
      .border_color(active ? t.accent : this.panel === name ? t.input : t.border).bg(t.surface).overflow_hidden()
      .cursor_pointer().on_mouse_down("left", (_e, cx) => { this.panel = name; if (this.mode) this.exitMode(cx); this.updateMain(cx); cx.notify(); })
      .child(h_flex().h(22).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(active ? t.accent : t.foreground).child(title))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(extra)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`list-${listId}`).absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll[listId]).py(2).children(rows))
        .child(Scrollbar.vertical(`list-${listId}`).absolute().inset_0()));
  }

  row(id, selected, active, t, onClick) {
    return h_flex().id(id).h(this.cfg.list_row_height).flex_none().px(8).gap(6).items_center().whitespace_nowrap()
      .when(selected, (e) => e.bg(active ? t.selected : t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { onClick(e, cx); this.handle.focus(); this.updateMain(cx); cx.notify(); });
  }

  rows(name, t) {
    const active = this.panel === name && !this.mode, empty = (text) => [div().px(10).py(4).text_color(t.dim).child(text)];
    const pick = (key, i, e, cx, enter) => { this.panel = name; this.cursor[key] = i; if (this.mode) this.exitMode(cx); if (e.click_count === 2 && enter) enter(cx); };
    if (name === "files") {
      if (!this.tree.length) return empty(this.status ? "Working tree clean" : "");
      return this.tree.map((n, i) => {
        const files = n.dir ? n.files : [n.file];
        const allStaged = files.every((f) => f.staged && !f.unstaged), some = files.some((f) => f.staged);
        const nameColor = files.some((f) => f.conflict) ? t.ansi1 : allStaged ? t.ansi2 : some ? t.blocked : t.foreground;
        const x = n.dir ? "" : n.file.untracked ? " " : n.file.x === "." ? " " : n.file.x;
        const y = n.dir ? "" : n.file.untracked ? "?" : n.file.y === "." ? " " : n.file.y;
        return this.row(`f-${n.path}`, this.cursor.files === i, active, t, (e, cx) => pick("files", i, e, cx, (cx) => this.filesKey("enter", cx)))
          .child(div().w(n.depth * 12).flex_none())
          .child(div().w(22).flex_none().font_family(this.mono()).text_size(11.5).child(h_flex()
            .child(div().text_color(t.ansi2).child(x)).child(div().text_color(t.ansi1).child(y))
            .when(n.dir, (e) => e.child(div().text_color(t.dim).child(this.collapsed.has(n.path) ? "▸" : "▾")))))
          .child(div().flex_1().min_w(0).truncate().text_color(nameColor).child(n.name + (n.dir ? "/" : "")));
      });
    }
    if (name === "branches") {
      const list = this.branchList();
      if (!list.length) return empty(this.branchTab === "local" ? "No branches" : "No remote branches · f to fetch");
      return list.map((b, i) => this.row(`b-${b.ref}`, this.cursor.branches === i, active, t, (e, cx) => pick("branches", i, e, cx, (cx) => this.branchesKey("enter", cx)))
        .child(div().w(10).flex_none().text_color(t.accent).child(b.head ? "*" : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(b.head ? t.accent : t.foreground).child(b.name))
        .when(this.branchTab === "local", (e) => e.child(div().flex_none().text_size(11).text_color(b.gone ? t.ansi1 : b.ahead || b.behind ? t.blocked : t.ansi2)
          .child(b.gone ? "gone" : !b.upstream ? "" : b.ahead || b.behind ? `${b.ahead ? "↑" + b.ahead : ""}${b.behind ? "↓" + b.behind : ""}` : "✓")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(b.date.replace(/ ago$/, ""))));
    }
    if (name === "commits") {
      const todoRow = (id, x, selected, onClick) => {
        const act = x.action ?? (x.kind === "break" ? "break" : "exec");
        const actLabel = x.flags ? `${act} ${x.flags}` : act;
        const label = x.sha ? (x.msg?.split("\n")[0] ?? x.subject) : x.kind === "break" ? "pause rebase here" : x.kind === "other" ? x.rest : x.cmd;
        return this.row(id, selected, active, t, onClick)
          .child(div().w(54).flex_none().font_family(this.mono()).text_size(11.5).text_color(this.actionColor(act, t)).child(actLabel))
          .when(!!x.sha, (e) => e.child(div().flex_none().font_family(this.mono()).text_size(11.5).text_color(t.dim).child(x.short)))
          .child(div().flex_1().min_w(0).truncate()
            .text_color(act === "drop" || x.kind === "break" ? t.dim : t.foreground)
            .when(act === "drop", (e) => e.line_through())
            .child(label));
      };
      if (this.plan) return this.plan.items.map((x, i) => todoRow(`p-${i}-${x.sha ?? x.action ?? x.cmd}`, x, this.cursor.plan === i, (e, cx) => pick("plan", i, e, cx)));
      if (this.cfiles) {
        const c = this.cfiles;
        return [
          this.row("cf-back", false, active, t, (_e, cx) => { this.cfiles = null; }).child(div().text_color(t.dim).truncate().child(`‹ ${c.short} ${c.subject}`)),
          ...(c.tree.length
            ? c.tree.map((n, i) => this.row(`cf-${n.dir ? "d" : "f"}-${n.path}`, this.cursor.cfiles === i, active, t, (e, cx) => pick("cfiles", i, e, cx, (cx) => this.cfilesKey("enter", cx)))
              .child(div().w(12).flex_none().text_color(t.ansi5).child(this.patchNodeMark(c.sha, n)))
              .child(div().w(n.depth * 12).flex_none())
              .child(n.dir
                ? div().w(14).flex_none().font_family(this.mono()).text_size(11.5).text_color(t.dim).child(c.collapsed.has(n.path) ? "▸" : "▾")
                : div().w(14).flex_none().font_family(this.mono()).text_size(11.5).text_color(n.file.status === "A" ? t.ansi2 : n.file.status === "D" ? t.ansi1 : t.blocked).child(n.file.status))
              .child(div().flex_1().min_w(0).truncate().child(n.name + (n.dir ? "/" : ""))))
            : empty("No file changes")),
        ];
      }
      const todo = this.activeTodo();
      if (!todo.length && !this.commits.length) return empty("No commits yet");
      const out = todo.map((x, i) => todoRow(`rt-${i}-${x.sha ?? x.action}`, x, this.cursor.commits === i, (e, cx) => pick("commits", i, e, cx, x.sha ? (cx) => this.rebaseTodoKey("enter", cx) : null)));
      if (todo.length) {
        out.push(h_flex().id("rt-sep").h(this.cfg.list_row_height).flex_none().px(8).gap(6).items_center().bg(t.raised)
          .child(div().text_size(10.5).font_semibold().text_color(t.blocked).child("─── rebasing · HEAD below ───")));
      }
      this.commits.forEach((c, j) => {
        const i = todo.length + j;
        // red: not pushed · green: pushed and in the base branch (merged) · yellow: pushed, not merged.
        const pushed = this.unpushed ? !this.unpushed.has(c.sha) : null;
        const merged = this.unmerged ? !this.unmerged.has(c.sha) : null;
        const shaColor = pushed === false ? t.ansi1 : pushed && merged ? t.ansi2 : pushed ? t.ansi3 : t.dim;
        out.push(this.row(`c-${c.sha}`, this.cursor.commits === i, active, t, (e, cx) => pick("commits", i, e, cx, (cx) => this.commitsKey("enter", cx)))
          .child(div().flex_none().font_family(this.mono()).text_size(11.5).text_color(shaColor).child(c.short))
          .when(this.patch?.sha === c.sha, (e) => e.child(div().text_color(t.ansi5).child("●")))
          .when(!!c.refs, (e) => e.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.accent).child(c.refs.replace(/HEAD -> /, ""))))
          .child(div().flex_1().min_w(0).truncate().child(c.subject))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(c.author.split(/\s+/).map((w) => w[0]).join("").slice(0, 2))));
      });
      return out;
    }
    if (!this.stashes.length) return empty("No stashes");
    return this.stashes.map((s, i) => this.row(`s-${s.ref}`, this.cursor.stash === i, active, t, (e, cx) => pick("stash", i, e, cx))
      .child(div().flex_none().text_color(t.dim).text_size(11).child(s.ref.replace(/^stash@\{(\d+)\}$/, "$1")))
      .child(div().flex_1().min_w(0).truncate().child(s.subject))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(s.date.replace(/ ago$/, ""))));
  }

  actionColor(a, t) {
    return { pick: t.dim, drop: t.ansi1, edit: t.blocked, reword: t.ansi4, squash: t.ansi5, fixup: t.ansi5, exec: t.ansi6, break: t.ansi3 }[a] ?? t.foreground;
  }

  mono() { return this.monoFont; }

  mainBox(t, wide) {
    const size = Math.max(10, Math.min(16, (settings().font_size ?? 13) - 1)), h = Math.ceil(size * this.cfg.preview_line_height);
    const rows = this.error && this.errorFull && !this.mode ? textRows(this.errorFull, "Error") : this.main.rows, sel = this.mode ? this.selectedRows() : new Set(), cur = this.mode ? this.lineCursor : -1;
    const m = this.mode;
    const title = m?.kind === "stage" ? h_flex().gap(6).child(div().text_color(m.side === "unstaged" ? t.accent : t.dim).child("Unstaged")).child(div().text_color(t.dim).child("·"))
      .child(div().text_color(m.side === "staged" ? t.accent : t.dim).child("Staged")).child(div().text_color(t.dim).truncate().child(`  ${m.path}${this.hunkMode ? "  · hunk" : this.anchor !== null ? "  · range" : ""}`))
      : m?.kind === "conflict" ? h_flex().gap(8).child(div().text_color(t.foreground).truncate().child(this.main.title))
        .child(div().text_color(t.ansi4).child("■ ours")).child(div().text_color(t.ansi5).child("■ theirs"))
        .when(this.state?.kind === "rebase", (e) => e.child(div().text_color(t.dim).truncate().child("rebase: ours = the branch you're rebasing onto, theirs = your commit")))
        : div().truncate().text_color(t.muted).child(this.main.title + (this.hunkMode ? "  · hunk" : this.anchor !== null ? "  · range" : ""));
    const numW = Math.ceil(size * 0.62 * 4) + 4;
    return v_flex().id("main").when(wide, (e) => e.flex_1().h_full()).when(!wide, (e) => e.w_full().flex_basis(0).flex_grow(1)).min_w(0).min_h(0).rounded(6).border_1()
      .border_color(this.mode ? t.accent : t.border).bg(t.background).overflow_hidden()
      .child(h_flex().h(22).flex_none().px(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(11.5).child(title))
      .child(div().flex_1().min_h(0).relative().font_family(this.mono()).text_size(size)
        .child(v_virtual_list("main-rows", rows.length, h, (i) => String(i), (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(this.mainRow(rows[i], i, t, h, numW, sel.has(i), i === cur));
          return out;
        }).size_full().track_scroll(this.mainScroll).on_item_click((key, cx) => {
          const i = +key;
          if (this.mode && rows[i]?.key) { this.lineCursor = i; cx.notify(); }
          else if (!this.mode && this.panel === "files" && rows[i]?.kind !== "s") { this.filesKey("enter", cx); cx.notify(); }
        }))
        .child(Scrollbar.vertical("main-rows").absolute().inset_0()));
  }

  mainRow(r, i, t, h, numW, selected, cursor) {
    let bg = null, fg = t.foreground;
    if (r.kind === "+") { bg = t.ansi2 + "1c"; fg = t.foreground; }
    else if (r.kind === "-") { bg = t.ansi1 + "1c"; }
    else if (r.kind === "@") fg = t.ansi6;
    else if (r.kind === "h") fg = t.accent;
    else if (r.kind === "m") fg = t.dim;
    else if (r.kind === "s") { fg = t.foreground; bg = t.raised; }
    else if (r.kind === "x") { fg = t.dim; bg = t.raised; }
    else if (r.kind === "co") bg = t.ansi4 + "22";
    else if (r.kind === "ct") bg = t.ansi5 + "22";
    else if (r.kind === "bs") fg = t.dim;
    if (selected) bg = t.selection;
    const mark = this.inPatch(r.key);
    const numbers = r.old !== undefined || r.nu !== undefined;
    return h_flex().h(h).w_full().flex_none().whitespace_nowrap().when(!!bg, (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(cursor, (e) => e.bg(t.accent)).when(!cursor && mark, (e) => e.bg(t.ansi5)))
      .when(numbers || ["+", "-", " ", "co", "ct", "bs", "x"].includes(r.kind), (e) => e
        .child(div().w(numW).flex_none().text_right().text_color(mark ? t.ansi2 : t.dim).child(mark ? "✓" : r.old !== undefined ? String(r.old) : ""))
        .child(div().w(numW).flex_none().text_right().text_color(t.dim).child(r.nu !== undefined ? String(r.nu) : ""))
        .child(div().w(18).flex_none().text_center().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : r.kind === "co" ? t.ansi4 : r.kind === "ct" ? t.ansi5 : t.dim).child({ "+": "+", "-": "-", co: "‹", ct: "›" }[r.kind] ?? "")))
      .child(div().flex_1().min_w(0).pl(numbers ? 0 : 6).truncate().text_color(fg).when(r.kind === "h" || r.kind === "s", (e) => e.font_semibold()).child(r.text || " "));
  }

  modalLayer(t) {
    const m = this.modal;
    const box = v_flex().id("mg-modal").w(m.kind === "text" ? 620 : 480).max_w(this.size ? this.size.width - 32 : 600).max_h(this.size ? this.size.height - 40 : 600)
      .p(16).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().child(div().flex_1().text_size(14).font_semibold().truncate().child(m.title)).child(div().text_size(11).text_color(t.dim).child("esc")));
    const button = (id, label, primary, onClick) => h_flex().id(id).h(28).px(12).items_center().rounded(7).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(primary ? t.solid : t.input)
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
    let content;
    if (m.kind === "prompt") {
      content = [Input.new(m.state).h(34).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13),
      h_flex().justify_end().gap(8).child(button("mg-cancel", "Cancel", false, () => this.closeModal())).child(button("mg-ok", "OK", true, (cx) => m.submit(cx)))];
    } else if (m.kind === "text") {
      content = [div().h(200).rounded(8).border_1().border_color(t.accent).bg(t.background).p(8).font_family(this.mono()).text_size(13).child(Textarea.new(m.state).size_full()),
      h_flex().gap(8).items_center().child(div().flex_1().text_size(11).text_color(t.dim).child(`ctrl-enter ${(m.submitLabel ?? "save").toLowerCase()}${m.editor ? " · ctrl-o open in editor" : ""} · first line is the summary`))
        .when(!!m.editor, (e) => e.child(button("mg-editor", "Open in editor", false, (cx) => { const v = m.state.value(); this.closeModal(); m.editor(v, cx); })))
        .child(button("mg-cancel", "Cancel", false, () => this.closeModal())).child(button("mg-ok", m.submitLabel ?? "Save", true, (cx) => m.submit(cx)))];
    } else if (m.kind === "confirm") {
      content = [div().text_color(t.muted).child(m.body ?? ""),
      h_flex().justify_end().gap(8).child(button("mg-cancel", "Cancel", false, () => this.closeModal())).child(button("mg-ok", "Confirm", true, (cx) => { this.closeModal(); m.onYes(cx); }))];
    } else if (m.kind === "menu") {
      content = [...(m.note ? [div().text_size(11.5).text_color(t.dim).child(m.note)] : []), v_flex().gap(2).children(m.items.map((it, i) => h_flex().id(`mg-item-${i}`).h(26).px(8).gap(10).items_center().rounded(6).cursor_pointer()
        .when(i === m.cursor, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.closeModal(); it.run(cx); cx.notify(); })
        .child(div().w(14).font_family(this.mono()).text_color(t.accent).child(it.key)).child(div().flex_1().truncate().child(it.label))))];
    } else {
      content = [v_flex().id("mg-help").max_h(420).overflow_y_scroll().track_scroll(this.helpScroll).gap(1).children(m.sections.flatMap(([name, keys]) => [
        div().pt(6).pb(2).text_size(11).text_color(t.dim).child(name === "global" ? "Everywhere" : `Here (${name})`),
        ...keys.map(([key, label]) => h_flex().gap(12).child(div().w(110).flex_none().font_family(this.mono()).text_size(11.5).text_color(t.accent).child(key)).child(div().flex_1().child(label))),
      ]))];
    }
    return div().id("mg-backdrop").absolute().inset_0().bg("#00000066").flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); })
      .child(box.children(content));
  }
}
