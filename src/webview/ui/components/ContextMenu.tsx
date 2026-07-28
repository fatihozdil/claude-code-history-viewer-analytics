// src/webview/ui/components/ContextMenu.tsx
import { useState, useEffect } from "preact/hooks";
import type { CommandMessage } from "../types.js";

interface MenuState {
  visible: boolean;
  x: number;
  y: number;
  sessionId: string;
  provider: "claude" | "codex" | "agy";
  pinned: boolean;
  archived: boolean;
  possibleFork: boolean;
  forkDismissed: boolean;
  isBranch: boolean;
  ungrouped: boolean;
}

const HIDDEN: MenuState = {
  visible: false, x: 0, y: 0, sessionId: "", provider: "claude",
  pinned: false, archived: false, possibleFork: false, forkDismissed: false,
  isBranch: false, ungrouped: false,
};

// Module-level handle set by the mounted ContextMenu instance.
let _open: ((s: MenuState, post: (msg: CommandMessage) => void) => void) | null = null;

export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState>(HIDDEN);
  const [post, setPost] = useState<(msg: CommandMessage) => void>(() => () => {});

  useEffect(() => {
    _open = (s, p) => {
      setMenu(s);
      setPost(() => p);
    };
    const hide = () => setMenu((m) => ({ ...m, visible: false }));
    window.addEventListener("click", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      _open = null;
      window.removeEventListener("click", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!menu.visible) return null;

  const sid = menu.sessionId;
  const send = (msg: CommandMessage) => post(msg);

  return (
    <div class="context-menu" style={{ left: menu.x, top: menu.y }}>
      <button class="context-menu__item" onClick={() => send({ command: "openSession", sessionId: sid })}>
        Open Conversation
      </button>
      <div class="context-menu__separator" />
      {menu.provider === "claude" && (
        <button class="context-menu__item" onClick={() => send({ command: "resume.openInClaudeTab", sessionId: sid })}>
          Open in Claude Tab
        </button>
      )}
      <button class="context-menu__item" onClick={() => send({ command: "resume.run", sessionId: sid })}>
        Resume in Terminal
      </button>
      <button class="context-menu__item" onClick={() => send({ command: "resume.copy", sessionId: sid })}>
        Copy Resume Command
      </button>
      <div class="context-menu__separator" />
      {menu.archived ? (
        <button class="context-menu__item" onClick={() => send({ command: "unarchive", sessionId: sid })}>
          Unarchive
        </button>
      ) : (
        <button class="context-menu__item" onClick={() => send({ command: "archive", sessionId: sid })}>
          Archive
        </button>
      )}
      {menu.pinned ? (
        <button class="context-menu__item" onClick={() => send({ command: "unpin", sessionId: sid })}>
          Unpin
        </button>
      ) : (
        <button class="context-menu__item" onClick={() => send({ command: "pin", sessionId: sid })}>
          Pin
        </button>
      )}
      {(menu.possibleFork || menu.forkDismissed || menu.isBranch || menu.ungrouped) && (
        <div class="context-menu__separator" />
      )}
      {menu.possibleFork && (
        <button class="context-menu__item" onClick={() => send({ command: "dismissFork", sessionId: sid })}>
          Not a Fork (Ungroup)
        </button>
      )}
      {menu.forkDismissed && (
        <button class="context-menu__item" onClick={() => send({ command: "restoreFork", sessionId: sid })}>
          Regroup as Possible Fork
        </button>
      )}
      {menu.isBranch && !menu.ungrouped && (
        <button class="context-menu__item" onClick={() => send({ command: "ungroupBranch", sessionId: sid })}>
          Ungroup
        </button>
      )}
      {menu.ungrouped && (
        <button class="context-menu__item" onClick={() => send({ command: "regroupBranch", sessionId: sid })}>
          Regroup
        </button>
      )}
    </div>
  );
}

// Static show method — called from App.tsx with the card's current flags.
ContextMenu.show = (
  x: number,
  y: number,
  opts: {
    sessionId: string;
    provider: "claude" | "codex" | "agy";
    pinned: boolean;
    archived: boolean;
    possibleFork?: boolean;
    forkDismissed?: boolean;
    isBranch?: boolean;
    ungrouped?: boolean;
  },
  post: (msg: CommandMessage) => void,
) => {
  _open?.({
    visible: true, x, y,
    possibleFork: false, forkDismissed: false, isBranch: false, ungrouped: false,
    ...opts,
  }, post);
};
