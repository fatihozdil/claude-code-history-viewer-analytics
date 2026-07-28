(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const fileChangesEl = document.getElementById("file-changes");
  const openInClaudeTabBtn = document.getElementById("open-in-claude-tab");
  const panelToolbarEl = document.getElementById("panel-toolbar");
  const promptBarEl = document.getElementById("prompt-bar");
  openInClaudeTabBtn.addEventListener("click", () => {
    vscode.postMessage({ command: "openInClaudeTab" });
  });
  let renderedCount = 0;
  let pendingScrollIndex = null;
  let lastRenderedRole = null;
  let highlightTerm = "";

  // Handle messages from the extension
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "clear":
        messagesEl.innerHTML = "";
        fileChangesEl.innerHTML = "";
        renderedCount = 0;
        pendingScrollIndex = null;
        pendingFindAnchor = null;
        lastRenderedRole = null;
        highlightTerm = typeof msg.highlightTerm === "string" ? msg.highlightTerm : "";
        if (findWidgetEl && findWidgetEl.style.display !== "none") closeFind();
        break;
      case "fileChanges":
        renderFileChanges(msg.files, msg.projectPath);
        break;
      case "conversationCost":
        renderConversationCost(msg.cost);
        break;
      case "messages":
        for (const m of msg.messages) {
          renderMessage(m);
        }
        renderedCount += msg.messages.length;
        if (pendingScrollIndex != null) {
          scrollToMessage(pendingScrollIndex);
        }
        break;
      case "done":
        showFooter();
        if (pendingScrollIndex != null) {
          scrollToMessage(pendingScrollIndex);
        } else {
          window.scrollTo(0, document.body.scrollHeight);
        }
        updateStickyOffsets();
        maybeAutoOpenFind();
        break;
      case "scrollTo":
        scrollToMessage(msg.index);
        break;
      case "claudeTabAvailable":
        openInClaudeTabBtn.style.display = msg.available ? "" : "none";
        break;
    }
  });

  function formatUsd(cost) {
    if (!Number.isFinite(cost)) return "";
    if (cost === 0) return "$0.00";
    if (cost < 0.0001) return "$" + cost.toFixed(6);
    if (cost < 0.01) return "$" + cost.toFixed(4);
    return "$" + cost.toFixed(2);
  }

  function renderConversationCost(cost) {
    promptBarEl.innerHTML = "";
    promptBarEl.style.display = Number.isFinite(cost) ? "" : "none";
    if (!Number.isFinite(cost)) return;
    const label = document.createElement("span");
    label.className = "conversation-cost";
    label.textContent = "Estimated cost: " + formatUsd(cost);
    label.title = "Estimated from recorded token usage and model pricing";
    promptBarEl.appendChild(label);
  }

  function renderFileChanges(files, projectPath) {
    fileChangesEl.innerHTML = "";
    if (!files || files.length === 0) return;

    // Split into project files vs other (Claude/system) files
    var projectFiles = [];
    var otherFiles = [];
    var pp = projectPath ? projectPath.replace(/\/$/, "") + "/" : null;
    for (var i = 0; i < files.length; i++) {
      if (pp && files[i].filePath.indexOf(pp) === 0) {
        projectFiles.push(files[i]);
      } else {
        otherFiles.push(files[i]);
      }
    }

    if (projectFiles.length > 0) {
      fileChangesEl.appendChild(renderCategory("Project files", projectFiles));
    }
    if (otherFiles.length > 0) {
      fileChangesEl.appendChild(renderCategory(
        projectFiles.length > 0 ? "Other files (Claude/system)" : "Files changed",
        otherFiles
      ));
    }
    fileChangesEl.querySelectorAll("details").forEach((d) => {
      d.addEventListener("toggle", updateStickyOffsets);
    });
    updateStickyOffsets();
  }

  function renderCategory(title, files) {
    // Keep the sticky header compact when a session touches a lot of files.
    // The remaining rows are still rendered (so their buttons keep working),
    // but are hidden until the user explicitly asks to see them.
    var previewLimit = 3;
    var added = 0, removed = 0;
    for (var i = 0; i < files.length; i++) {
      added += files[i].linesAdded;
      removed += files[i].linesRemoved;
    }

    var details = document.createElement("details");
    details.className = "file-changes";
    details.open = true;

    var summary = document.createElement("summary");
    var chevron = document.createElement("span");
    chevron.className = "file-changes-chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    summary.appendChild(chevron);

    var label = document.createElement("span");
    label.className = "file-changes-label";
    label.textContent = title + " (" + files.length + ")";
    summary.appendChild(label);

    if (added > 0 || removed > 0) {
      var stats = document.createElement("span");
      stats.className = "file-changes-stats";
      if (added > 0) stats.appendChild(countSpan("+" + added, "lines-added"));
      if (removed > 0) stats.appendChild(countSpan("−" + removed, "lines-removed"));
      summary.appendChild(stats);
    }

    details.appendChild(summary);

    var list = document.createElement("div");
    list.className = "file-changes-list";
    for (var i = 0; i < files.length; i++) {
      var row = renderFileChangeRow(files[i]);
      if (i >= previewLimit) row.hidden = true;
      list.appendChild(row);
    }

    if (files.length > previewLimit) {
      var moreCount = files.length - previewLimit;
      var expandRow = document.createElement("div");
      expandRow.className = "file-changes-expand-row";

      var expandButton = document.createElement("button");
      expandButton.className = "file-changes-expand";
      expandButton.type = "button";
      expandButton.textContent = "Show " + moreCount + " more file" + (moreCount === 1 ? "" : "s");
      expandButton.setAttribute("aria-expanded", "false");
      expandButton.addEventListener("click", () => {
        var expanded = expandButton.getAttribute("aria-expanded") === "true";
        var rows = list.querySelectorAll(".file-change-row");
        for (var j = previewLimit; j < rows.length; j++) rows[j].hidden = expanded;
        expandButton.setAttribute("aria-expanded", String(!expanded));
        expandButton.textContent = expanded ?
          "Show " + moreCount + " more file" + (moreCount === 1 ? "" : "s") :
          "Show less";
        updateStickyOffsets();
      });
      expandRow.appendChild(expandButton);
      list.appendChild(expandRow);
    }
    details.appendChild(list);

    return details;
  }

  function renderFileChangeRow(f) {
    const row = document.createElement("div");
    row.className = "file-change-row";

    const badge = document.createElement("span");
    badge.className = "file-change-badge";
    badge.textContent = toolIconFor(primaryOperation(f.operations));
    row.appendChild(badge);

    const pathEl = document.createElement("span");
    pathEl.className = "file-change-path";
    pathEl.title = f.filePath;
    const lastSlash = Math.max(f.filePath.lastIndexOf("/"), f.filePath.lastIndexOf("\\"));
    const dirPart = lastSlash >= 0 ? f.filePath.slice(0, lastSlash + 1) : "";
    const baseName = lastSlash >= 0 ? f.filePath.slice(lastSlash + 1) : f.filePath;
    const dirEl = document.createElement("span");
    dirEl.className = "file-change-dirname";
    dirEl.textContent = dirPart;
    pathEl.appendChild(dirEl);
    const baseEl = document.createElement("span");
    baseEl.className = "file-change-basename";
    baseEl.textContent = baseName;
    pathEl.appendChild(baseEl);
    row.appendChild(pathEl);

    if (f.linesAdded > 0 || f.linesRemoved > 0) {
      const counts = document.createElement("span");
      counts.className = "file-change-counts";
      if (f.linesAdded > 0) counts.appendChild(countSpan("+" + f.linesAdded, "lines-added"));
      if (f.linesRemoved > 0) counts.appendChild(countSpan("−" + f.linesRemoved, "lines-removed"));
      row.appendChild(counts);
    }

    const openBtn = document.createElement("button");
    openBtn.className = "file-change-btn";
    openBtn.textContent = "Open";
    openBtn.title = "Open file";
    openBtn.addEventListener("click", () => {
      vscode.postMessage({ command: "openFile", filePath: f.filePath });
    });
    row.appendChild(openBtn);

    if (f.canDiff) {
      const diffBtn = document.createElement("button");
      diffBtn.className = "file-change-btn";
      diffBtn.textContent = "Diff";
      diffBtn.title = "Open diff against pre-session content";
      diffBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "openDiff", filePath: f.filePath });
      });
      row.appendChild(diffBtn);
    }

    return row;
  }

  function countSpan(text, className) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  function primaryOperation(ops) {
    if (!ops) return "Read";
    if (ops.includes("Write")) return "Write";
    if (ops.includes("MultiEdit")) return "MultiEdit";
    if (ops.includes("Edit")) return "Edit";
    return "Read";
  }

  function renderMessage(msg) {
    const isOrphanResult = msg.parts.length > 0 && msg.parts.every((p) => p.kind === "tool_result");

    const div = document.createElement("div");
    div.className = "message " + (isOrphanResult ? "result" : msg.role);
    div.id = "msg-" + msg.index;
    div.setAttribute("data-index", msg.index);

    // Timeline rail dot — color reflects the "loudest" part in this message.
    const dot = document.createElement("span");
    dot.className = "rail-dot " + railDotClassFor(msg);
    div.appendChild(dot);

    // Header — only show when role changes (or is "user"); consecutive same-role
    // messages share one label. Orphan results always get their own neutral label.
    // Force a header if the message carries model information.
    const effectiveRole = isOrphanResult ? "result" : msg.role;
    const roleChanged = effectiveRole !== lastRenderedRole || effectiveRole === "user" || !!msg.model;

    if (roleChanged) {
      const header = document.createElement("div");
      header.className = "message-header";

      const role = document.createElement("span");
      role.className = "message-role-chip role-" + effectiveRole;
      role.textContent = effectiveRole;
      header.appendChild(role);

      if (msg.index != null) {
        const idx = document.createElement("span");
        idx.className = "message-index";
        idx.textContent = "#" + msg.index;
        header.appendChild(idx);
      }

      if (msg.model) {
        const modelSpan = document.createElement("span");
        modelSpan.className = "message-model";
        let text = msg.model;
        if (msg.cost != null) {
          text += " (" + formatUsd(msg.cost) + ")";
        }
        modelSpan.textContent = text;
        header.appendChild(modelSpan);
      }

      div.appendChild(header);
      lastRenderedRole = effectiveRole;
    }

    // Parts
    for (const part of msg.parts) {
      const el = renderPart(part);
      if (el) div.appendChild(el);
    }

    if (highlightTerm) applyHighlight(div, highlightTerm);

    messagesEl.appendChild(div);
  }

  /** Wrap every case-insensitive occurrence of `term` within rootEl's text in
   *  <mark>, so messages opened from a search hit show where the match is.
   *  Walks text nodes only (via DOM APIs, no innerHTML) so it can't introduce
   *  markup from message content. */
  function applyHighlight(rootEl, term) {
    const needle = term.toLowerCase();
    if (!needle) return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLowerCase().indexOf(needle) !== -1) {
        textNodes.push(node);
      }
    }
    for (const textNode of textNodes) {
      const value = textNode.nodeValue;
      const lower = value.toLowerCase();
      const frag = document.createDocumentFragment();
      let pos = 0;
      let idx;
      while ((idx = lower.indexOf(needle, pos)) !== -1) {
        if (idx > pos) frag.appendChild(document.createTextNode(value.slice(pos, idx)));
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = value.slice(idx, idx + needle.length);
        frag.appendChild(mark);
        pos = idx + needle.length;
      }
      if (pos < value.length) frag.appendChild(document.createTextNode(value.slice(pos)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  /** Unwrap every existing search-highlight <mark> in `rootEl`, restoring plain
   *  text and merging adjacent text nodes so a fresh highlight pass is clean. */
  function clearHighlights(rootEl) {
    const marks = rootEl.querySelectorAll("mark.search-highlight");
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
  }

  // ── In-viewer find widget ────────────────────────────────────────────────
  const findWidgetEl = document.getElementById("find-widget");
  const findInputEl = document.getElementById("find-input");
  const findCounterEl = document.getElementById("find-counter");
  const findPrevEl = document.getElementById("find-prev");
  const findNextEl = document.getElementById("find-next");
  const findCloseEl = document.getElementById("find-close");
  let findMatches = [];
  let findCurrent = -1;
  let findDebounce = null;

  /** Recompute matches for `term` across the whole conversation and rebuild the
   *  match list. `preferIndex`, if given, selects the closest match at/after it. */
  function runFind(term, preferIndex) {
    clearHighlights(messagesEl);
    findMatches = [];
    findCurrent = -1;
    if (term) {
      applyHighlight(messagesEl, term);
      findMatches = Array.prototype.slice.call(
        messagesEl.querySelectorAll("mark.search-highlight")
      );
    }
    if (findMatches.length) {
      let start = 0;
      if (preferIndex != null) {
        const anchor = document.getElementById("msg-" + preferIndex);
        if (anchor) {
          for (let i = 0; i < findMatches.length; i++) {
            if (anchor.contains(findMatches[i])) {
              start = i;
              break;
            }
          }
        }
      }
      setCurrentMatch(start, false);
    } else {
      updateFindCounter();
    }
  }

  /** Focus match `i` (with wraparound): move the "current" style and scroll it
   *  into view. `scroll` guards the initial pass where the panel already scrolled. */
  function setCurrentMatch(i, scroll) {
    if (!findMatches.length) return;
    const n = findMatches.length;
    const next = ((i % n) + n) % n;
    if (findCurrent >= 0 && findMatches[findCurrent]) {
      findMatches[findCurrent].classList.remove("search-highlight-current");
    }
    findCurrent = next;
    const el = findMatches[findCurrent];
    el.classList.add("search-highlight-current");
    if (scroll !== false) el.scrollIntoView({ behavior: "smooth", block: "center" });
    updateFindCounter();
  }

  function updateFindCounter() {
    const total = findMatches.length;
    findCounterEl.textContent = (total ? findCurrent + 1 : 0) + "/" + total;
  }

  function openFind(term) {
    findWidgetEl.style.display = "";
    findInputEl.value = term;
    runFind(term, pendingFindAnchor);
    findInputEl.focus();
    findInputEl.select();
  }

  function closeFind() {
    findWidgetEl.style.display = "none";
    clearHighlights(messagesEl);
    findMatches = [];
    findCurrent = -1;
  }

  // Track the message we scrolled to so the first current-match is the nearest one.
  let pendingFindAnchor = null;

  /** Called on "done": auto-open the widget when opened from a search hit that
   *  matches more than once in this conversation. */
  function maybeAutoOpenFind() {
    if (!highlightTerm) return;
    const count = messagesEl.querySelectorAll("mark.search-highlight").length;
    if (count > 1) openFind(highlightTerm);
  }

  findInputEl.addEventListener("input", () => {
    if (findDebounce) clearTimeout(findDebounce);
    findDebounce = setTimeout(() => runFind(findInputEl.value.trim(), null), 150);
  });
  findInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (findMatches.length) setCurrentMatch(findCurrent + (e.shiftKey ? -1 : 1), true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  });
  findPrevEl.addEventListener("click", () => setCurrentMatch(findCurrent - 1, true));
  findNextEl.addEventListener("click", () => setCurrentMatch(findCurrent + 1, true));
  findCloseEl.addEventListener("click", closeFind);

  // Cmd/Ctrl+F opens the find widget anywhere in the viewer (focusing it if
  // already open); Escape closes it even when focus is outside the input.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      if (findWidgetEl.style.display === "none") {
        openFind(findInputEl.value || highlightTerm || "");
      } else {
        findInputEl.focus();
        findInputEl.select();
      }
    } else if (e.key === "Escape" && findWidgetEl.style.display !== "none") {
      closeFind();
    }
  });

  /** Pick a rail-dot color class for a message based on its parts. */
  function railDotClassFor(msg) {
    let sawToolUse = false;
    for (const part of msg.parts) {
      if (part.kind === "tool_result" && part.isError) return "rail-dot-error";
      if (part.kind === "tool_use") sawToolUse = true;
      if (part.kind === "tool_result" && !part.isError) sawToolUse = true;
    }
    return sawToolUse ? "rail-dot-success" : "rail-dot-muted";
  }

  function renderPart(part) {
    switch (part.kind) {
      case "text":
        return renderText(part.text);
      case "tool_use":
        return renderToolUse(part);
      case "tool_result":
        return renderOrphanToolResult(part);
      default:
        return null;
    }
  }

  function renderText(text) {
    const div = document.createElement("div");
    div.className = "text-content";
    div.innerHTML = simpleMarkdown(text);
    // Apply syntax highlighting to code blocks
    highlightCodeBlocks(div);
    return div;
  }

  function renderToolUse(part) {
    const details = document.createElement("details");
    details.className = "tool-card";
    details.open = false; // collapsed by default; keeps view clean

    const summary = document.createElement("summary");

    const header = document.createElement("div");
    header.className = "tool-card-header";

    const dot = document.createElement("span");
    dot.className = "tool-card-dot";
    header.appendChild(dot);

    const name = document.createElement("span");
    name.className = "tool-card-name";
    name.textContent = part.name;
    header.appendChild(name);

    const hint = toolHintFor(part.name, part.input);
    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "tool-card-hint";
      hintEl.textContent = hint;
      header.appendChild(hintEl);
    }

    const chevron = document.createElement("span");
    chevron.className = "tool-card-chevron";
    chevron.textContent = "›";
    header.appendChild(chevron);

    summary.appendChild(header);
    details.appendChild(summary);

    if (isCommandStyleTool(part.name, part.input)) {
      details.appendChild(renderToolIo(part.input, part.result));
    } else {
      details.appendChild(renderToolBody(part.input));
      if (part.result) {
        details.appendChild(renderResultBlock(part.result, "RESULT"));
      }
    }

    return details;
  }

  /** Bash-like tools get a labeled IN/OUT body; everything else keeps a single JSON dump. */
  function isCommandStyleTool(name, input) {
    return name === "Bash" && !!input && typeof input.command === "string";
  }

  function renderToolBody(input) {
    const body = document.createElement("div");
    body.className = "tool-body";
    body.textContent = JSON.stringify(input, null, 2);
    return body;
  }

  function renderToolIo(input, result) {
    const io = document.createElement("div");
    io.className = "tool-io";

    const inLabel = document.createElement("div");
    inLabel.className = "tool-io-label";
    inLabel.textContent = "IN";
    io.appendChild(inLabel);

    const inBlock = document.createElement("div");
    inBlock.className = "tool-io-block";
    inBlock.textContent = input.command;
    io.appendChild(inBlock);

    if (result) {
      const outLabel = document.createElement("div");
      outLabel.className = "tool-io-label";
      outLabel.textContent = "OUT";
      io.appendChild(outLabel);

      const outBlock = document.createElement("div");
      outBlock.className = "tool-io-block" + (result.isError ? " error" : "");
      outBlock.id = "msg-" + result.index;
      outBlock.textContent = result.text;
      io.appendChild(outBlock);
    }

    return io;
  }

  /** Appended result section for non-command-style tools (Read, Edit, etc.). */
  function renderResultBlock(result, label) {
    const io = document.createElement("div");
    io.className = "tool-io";

    const resultLabel = document.createElement("div");
    resultLabel.className = "tool-io-label";
    resultLabel.textContent = label;
    io.appendChild(resultLabel);

    const resultBlock = document.createElement("div");
    resultBlock.className = "tool-io-block" + (result.isError ? " error" : "");
    resultBlock.id = "msg-" + result.index;
    resultBlock.textContent = result.text;
    io.appendChild(resultBlock);

    return io;
  }

  function renderOrphanToolResult(part) {
    const div = document.createElement("div");
    div.className = "tool-output" + (part.isError ? " error" : "");
    div.textContent = part.text;
    return div;
  }

  function toolIconFor(name) {
    const icons = {
      Bash: "⚡",
      Read: "📖",
      Write: "✏️",
      Edit: "🔧",
      MultiEdit: "🔧",
      WebFetch: "🌐",
      WebSearch: "🔍",
      AskUserQuestion: "❓",
      Grep: "🔎",
      Glob: "🔎",
      Task: "📋",
      LSP: "💡",
    };
    return icons[name] || "⚙️";
  }

  /** Build a short dimmed hint string for a tool-call summary line. */
  function toolHintFor(name, input) {
    if (!input) return "";
    const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

    if (typeof input.file_path === "string" && input.file_path) {
      return "· " + input.file_path;
    }
    if (name === "Bash" && typeof input.command === "string" && input.command) {
      return "· " + truncate(input.command.replace(/\s+/g, " ").trim(), 60);
    }
    if ((name === "Grep" || name === "Glob") && typeof input.pattern === "string" && input.pattern) {
      return "· " + truncate(input.pattern, 60);
    }
    return "";
  }

  /** Minimal markdown → HTML conversion (handles code fences, headings, bold, italic, inline code). */
  function simpleMarkdown(text) {
    if (!text) return "";

    let html = text;

    // Escape HTML
    html = html
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks (```language\n code \n```)
    html = html.replace(/```(\S*)\n([\s\S]*?)```/g, function (_m, lang, code) {
      // Only allow alphanumeric and hyphens for language identifier to prevent XSS.
      var safeLang = (lang || "plaintext");
      if (!/^[a-zA-Z0-9-]*$/.test(safeLang)) { safeLang = "plaintext"; }
      return '<pre><code class="language-' + safeLang + '">' + code.replace(/\n$/, "") + "</code></pre>";
    });

    // Inline code
    html = html.replace(/`([^`\n]+?)`/g, "<code>$1</code>");

    // GFM tables (header row + separator row + body rows)
    html = renderTables(html);

    // Headings
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");

    // Paragraphs: double newlines
    html = html.replace(/\n\n+/g, "</p><p>");
    html = "<p>" + html + "</p>";

    // Clean up empty wrapping
    html = html.replace(/<p>\s*<\/p>/g, "");
    html = html.replace(/<p>(\s*<[hoult][^>]*>)/g, "$1");
    html = html.replace(/(<\/[hoult][^>]*>)\s*<\/p>/g, "$1");

    return html;
  }

  /**
   * Convert GFM pipe tables to <table> markup. Runs on already-HTML-escaped
   * text (before headings/bold/italic, which then style cell contents). A table
   * is a row containing "|", immediately followed by a separator row of dashes.
   */
  function renderTables(src) {
    const lines = src.split("\n");
    const out = [];
    let i = 0;

    const isSeparator = function (line) {
      return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
    };
    const splitRow = function (line) {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map(function (c) { return c.trim(); });
    };
    const alignOf = function (spec) {
      const l = spec.startsWith(":");
      const r = spec.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    };
    const cellAttr = function (align) {
      return align ? ' style="text-align:' + align + '"' : "";
    };

    while (i < lines.length) {
      const line = lines[i];
      const next = lines[i + 1];
      if (line && line.indexOf("|") !== -1 && next && isSeparator(next)) {
        const header = splitRow(line);
        const aligns = splitRow(next).map(alignOf);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let t = '<table class="md-table"><thead><tr>';
        header.forEach(function (h, idx) {
          t += "<th" + cellAttr(aligns[idx]) + ">" + h + "</th>";
        });
        t += "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>";
          header.forEach(function (_h, idx) {
            t += "<td" + cellAttr(aligns[idx]) + ">" + (r[idx] || "") + "</td>";
          });
          t += "</tr>";
        });
        t += "</tbody></table>";
        out.push(t);
      } else {
        out.push(line);
        i++;
      }
    }
    return out.join("\n");
  }

  /** Apply syntax highlighting to <pre><code> blocks using highlight.js if available. */
  function highlightCodeBlocks(root) {
    if (typeof hljs === "undefined") return;
    const blocks = root.querySelectorAll("pre code");
    for (const block of blocks) {
      try {
        hljs.highlightElement(block);
      } catch (_) {}
    }
  }

  function scrollToMessage(index) {
    const el = document.getElementById("msg-" + index);
    if (el) {
      pendingScrollIndex = null;
      pendingFindAnchor = index;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("scroll-target");
      setTimeout(() => el.classList.remove("scroll-target"), 1500);
    } else {
      // Target not rendered yet (chunked rendering race) — retry after the
      // next "messages" batch or on "done".
      pendingScrollIndex = index;
    }
  }

  function showFooter() {
    const footer = document.createElement("div");
    footer.id = "messages-footer";
    footer.textContent = "— End of conversation —";
    messagesEl.appendChild(footer);
  }

  /** Recompute sticky `top` offsets for the file-changes and prompt-bar layers
   *  from the actual measured height of the layers above them. */
  function updateStickyOffsets() {
    const toolbarHeight = panelToolbarEl.offsetHeight;
    fileChangesEl.style.top = toolbarHeight + "px";
    promptBarEl.style.top = toolbarHeight + fileChangesEl.offsetHeight + "px";
    var fullH = toolbarHeight + fileChangesEl.offsetHeight + promptBarEl.offsetHeight;
    document.documentElement.style.setProperty("--ch-sticky-stack-height", fullH + "px");
  }

  /** Find the last real user message scrolled above the sticky stack and show
   *  its text in the prompt bar; hide the bar if none qualify yet.
   *  Uses getBoundingClientRect() (viewport-relative) rather than offsetTop,
   *  since offsetTop is relative to #messages (the nearest positioned
   *  ancestor), not the viewport — comparing it against scroll position
   *  directly would be wrong. */
  function updateCurrentPromptLabel() {
    const stackBottom = panelToolbarEl.offsetHeight + fileChangesEl.offsetHeight + promptBarEl.offsetHeight;
    const userMessages = messagesEl.querySelectorAll(".message.user");
    let current = null;
    for (const el of userMessages) {
      if (el.getBoundingClientRect().top < stackBottom) {
        current = el;
      } else {
        break;
      }
    }
    if (!current) {
      promptBarEl.style.display = "none";
      updateStickyOffsets();
      return;
    }
    const textEl = current.querySelector(".text-content");
    promptBarEl.textContent = textEl ? textEl.textContent : "";
    promptBarEl.style.display = "block";
    updateStickyOffsets();
  }

  // Sticky offsets depend only on content height, not scroll position, so
  // they're recomputed on resize/content-change (see calls below) — not on
  // every scroll event.
  window.addEventListener("scroll", updateCurrentPromptLabel);
  window.addEventListener("resize", updateStickyOffsets);
})();
