// What each key does where, for the footer (third field true) and the ? help.
export const KEYS = {
  files: [
    ["space", "stage/unstage", true], ["enter", "stage lines", true], ["a", "stage all", true], ["c", "commit", true],
    ["C", "commit in editor"], ["A", "amend last commit", true], ["d", "discard", true], ["s", "stash all", true],
    ["S", "stash staged"], ["e", "edit file"], ["- / =", "collapse / expand all"], ["enter on folder", "fold"],
    ["enter on conflict", "resolve: menu"], ["o / t / b", "conflict: keep ours / theirs / both"], ["O / T", "all conflicts: ours / theirs"],
  ],
  stage: [
    ["space", "stage/unstage selection", true], ["v", "select range", true], ["a", "select change block", true],
    ["tab", "unstaged / staged", true], ["d", "discard lines", true], ["[ ]", "prev / next change"],
    ["e", "edit file"], ["esc", "back", true],
  ],
  conflict: [
    ["o / t", "keep ours / theirs", true], ["b / B", "keep both (ours first / theirs first)", true],
    ["space", "pick line(s)", true], ["enter", "keep picked lines", true], ["v / a", "range / block"],
    ["O / T", "all conflicts in file: ours / theirs", true], ["[ ]", "prev / next conflict"], ["z", "undo", true],
    ["e", "edit file"], ["esc", "back", true],
  ],
  branches: [
    ["space", "check out", true], ["enter", "browse commits", true], ["r", "rebase onto", true], ["n", "new branch", true],
    ["R", "rename", true], ["d", "delete local", true], ["D", "delete remote", true], ["u", "set upstream"], ["[ ]", "local / remotes", true],
  ],
  commits: [
    ["enter", "files / build patch", true], ["r", "reword", true], ["R", "reword in editor"], ["d", "drop", true],
    ["e", "edit (stop here)", true], ["s / f", "squash / fixup into below", true], ["A", "amend staged into it", true],
    ["a", "author", true], ["ctrl-j / ctrl-k", "move down / up", true], ["i", "interactive rebase", true],
    ["o", "copy hash"], ["n", "new branch here"], ["space", "check out (detached)"], ["ctrl-p", "patch menu"], ["esc", "back to HEAD / reset patch"],
  ],
  cfiles: [
    ["space", "toggle in patch", true], ["enter", "pick lines / fold", true], ["a", "toggle all files", true],
    ["- / =", "collapse / expand all"], ["ctrl-p", "patch menu", true], ["esc", "back", true],
  ],
  patchlines: [
    ["space", "toggle lines in patch", true], ["v", "select range", true], ["a", "select change block", true],
    ["[ ]", "prev / next change"], ["ctrl-p", "patch menu", true], ["esc", "back", true],
  ],
  plan: [
    ["p", "pick", true], ["d", "drop / remove", true], ["e", "edit", true], ["r", "reword", true],
    ["s", "squash", true], ["f", "fixup", true], ["b", "add break", true], ["x", "add exec", true],
    ["ctrl-j / ctrl-k", "move", true], ["enter", "run", true], ["esc", "cancel", true],
  ],
  rebase: [
    ["p", "pick", true], ["d", "drop / remove", true], ["e", "edit", true], ["r", "reword", true],
    ["s / f", "squash / fixup", true], ["b", "add break", true], ["x", "add exec", true],
    ["ctrl-j / ctrl-k", "move", true], ["m", "continue / abort", true], ["esc", "abort rebase", true], ["enter", "files"], ["o", "copy hash"],
  ],
  stash: [
    ["space", "apply", true], ["o", "pop", true], ["d", "drop", true], ["n", "new branch", true],
  ],
  global: [
    ["j / k / ↓ ↑", "move"], ["g / G", "top / bottom"], ["ctrl-d / ctrl-u", "half page"],
    ["h / l / tab", "previous / next panel"], ["1-4", "go to panel"], ["J / K", "scroll the diff"],
    ["f", "fetch"], ["p", "pull"], ["P", "push"], ["m", "rebase/merge: continue, skip, abort"],
    ["ctrl-p", "patch menu"], ["R", "refresh"], ["?", "keys"], ["q", "close (pinned: back to the terminal)"], ["ctrl-b shift-g", "pin / unpin the sidebar"],
  ],
};
