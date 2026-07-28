(function () {
  "use strict";

  var vscode = acquireVsCodeApi();
  var providerIcons = window.__providerIcons || {};

  // ---- State ----
  var allDaily = [];
  var showAllDays = false;
  var sortCol = "date";
  var sortDir = "desc";

  // ---- Formatting ----
  function formatTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }

  function formatCost(n) {
    return "$" + n.toFixed(2);
  }

  function formatTime(ms) {
    if (ms <= 0) return "any moment";
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) return h + "h " + (m % 60) + "m";
    if (m > 0) return m + "m " + (s % 60) + "s";
    return s + "s";
  }

  function formatDuration(ms) {
    if (ms <= 0) return "soon";
    var m = Math.floor(ms / 60000);
    var h = Math.floor(m / 60);
    var d = Math.floor(h / 24);
    if (d > 0) return d + "d " + (h % 24) + "h";
    if (h > 0) return h + "h " + (m % 60) + "m";
    return m + "m";
  }

  // Accepts epoch seconds, epoch ms, or an ISO string; returns epoch ms or null.
  function parseResetMs(reset) {
    if (typeof reset === "number" && isFinite(reset)) return reset > 1e12 ? reset : reset * 1000;
    if (typeof reset === "string" && reset) {
      var t = Date.parse(reset);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  // "resets in 2h 5m" for a future duration in ms; "" when unknown/past.
  function resetFromMs(ms) {
    return typeof ms === "number" && ms > 0 ? "resets in " + formatDuration(ms) : "";
  }

  // "resets in 2d 3h" for a reset timestamp (seconds/ms/ISO); "" when unknown/past.
  function resetFromStamp(reset) {
    var ms = parseResetMs(reset);
    return ms !== null && ms > Date.now() ? "resets in " + formatDuration(ms - Date.now()) : "";
  }

  // Label a Codex window from its `window_minutes` (300 → "5-hour limit").
  function codexWindowLabel(minutes, fallback) {
    if (typeof minutes !== "number" || minutes <= 0) return fallback;
    if (minutes % 10080 === 0) { var w = minutes / 10080; return w === 1 ? "Weekly limit" : (w + "-week limit"); }
    if (minutes % 1440 === 0) { var d = minutes / 1440; return d === 7 ? "Weekly limit" : (d + "-day limit"); }
    if (minutes % 60 === 0) return (minutes / 60) + "-hour limit";
    return minutes + "-minute limit";
  }

  function relativeAge(ms) {
    var diff = Date.now() - ms;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) return h + "h ago";
    if (m > 0) return m + "m ago";
    return "just now";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- Shared chart tooltip ----
  function showTooltip(html, x, y) {
    var tip = document.getElementById("chart-tooltip");
    if (!tip) return;
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    var pad = 14;
    var left = x + pad;
    var top = y + pad;
    var rect = tip.getBoundingClientRect();
    if (left + rect.width > window.innerWidth) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight) top = y - rect.height - pad;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = Math.max(0, top) + "px";
    tip.classList.add("visible");
  }

  function hideTooltip() {
    var tip = document.getElementById("chart-tooltip");
    if (tip) tip.classList.remove("visible");
  }

  // ---- Jump from heatmap to the matching daily-table row ----
  function jumpToDate(date) {
    var idx = allDaily.findIndex(function (d) { return d.date === date; });
    if (idx === -1) return;
    if (!showAllDays) {
      showAllDays = true;
      var btn = document.getElementById("show-all-btn");
      if (btn) btn.textContent = "Show fewer";
    }
    renderDailyTable();
    var row = document.querySelector('#daily-body tr[data-date="' + date + '"]');
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("row-flash");
      setTimeout(function () { row.classList.remove("row-flash"); }, 1200);
    }
  }

  // ---- Message handling ----
  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "data":
        renderAll(msg.payload);
        // A cached snapshot is followed by a background refresh. Keep that
        // refresh silent: the existing dashboard remains fully interactive.
        setRefreshing(false, msg.updatedAt);
        break;
      case "loading":
        document.getElementById("loading").classList.remove("hidden");
        break;
      case "error":
        showError(msg.message);
        setRefreshing(false);
        break;
    }
  });

  // ---- Refresh button ----
  function setRefreshing(isRefreshing, updatedAt) {
    var btn = document.getElementById("refresh-btn");
    if (!btn) return;
    btn.disabled = isRefreshing;
    btn.textContent = isRefreshing ? "⟳ Refreshing…" : "⟳ Refresh";
    var stamp = document.getElementById("last-updated");
    if (stamp && updatedAt) stamp.textContent = "Last updated: " + new Date(updatedAt).toLocaleTimeString();
  }

  var refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      setRefreshing(true);
      vscode.postMessage({ command: "refresh" });
    });
  }

  function showError(msg) {
    var banner = document.getElementById("error-banner");
    banner.textContent = msg;
    banner.classList.remove("hidden");
    document.getElementById("loading").classList.add("hidden");
  }

  // ---- Main render ----
  var dailySortState = { col: "date", dir: "desc" };

  function renderAll(data) {
    // Repaints now also happen unattended (background refresh), so the user's
    // scroll position and daily-table state must survive them. showAllDays and
    // dailySortState keep their current values — they are initialised to the
    // first-render defaults at load, so opening the panel is unaffected.
    var scrollTop = window.scrollY;

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("content").classList.remove("hidden");

    renderMetricCards(data);
    renderProviderUsage(data);
    allDaily = data.daily;
    renderDailyTable();
    renderHeatmap(allDaily);
    renderHoursChart(data.sessionsByHour || []);
    renderWeekdayChart(data.sessionsByWeekday || []);
    renderAverageCards(data.avgMessagesPerSession, data.avgTokensPerMessage);
    renderProjectsTable(data.byProject);
    renderBreakdownTable("providers", data.byProvider || [], "provider");
    renderModels(data.byModel || []);
    renderFilesTable(data.topFiles);

    if (scrollTop > 0) window.scrollTo(0, scrollTop);

    // Hook up "show all" button
    var btn = document.getElementById("show-all-btn");
    var newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    // cloneNode copies whatever label is currently in the DOM, so set it from
    // state explicitly — otherwise it can drift out of sync with showAllDays.
    newBtn.textContent = showAllDays ? "Show fewer" : "Show all";
    newBtn.addEventListener("click", function () {
      showAllDays = !showAllDays;
      newBtn.textContent = showAllDays ? "Show fewer" : "Show all";
      renderDailyTable();
    });

    // Hook up sort headers
    var headers = document.querySelectorAll("#daily-table th.sortable");
    Array.prototype.forEach.call(headers, function (th) {
      var newTh = th.cloneNode(true);
      th.parentNode.replaceChild(newTh, th);
      newTh.addEventListener("click", function () {
        var col = newTh.getAttribute("data-col");
        if (dailySortState.col === col) {
          dailySortState.dir = dailySortState.dir === "asc" ? "desc" : "asc";
        } else {
          dailySortState.col = col;
          dailySortState.dir = "desc";
        }
        renderDailyTable();
      });
    });
  }

  function renderBreakdownTable(kind, rows, labelKey) {
    var body = document.getElementById(kind + "-body");
    if (!body) return;
    body.innerHTML = rows.length ? rows.map(function (row) {
      var value = String(row[labelKey]);
      var icon = kind === "providers" ? providerMark(value) + ' ' : '';
      var label = kind === "providers"
        ? '<span class="provider-cell">' + icon + '<span>' + escapeHtml(providerLabel(value)) + '</span></span>'
        : escapeHtml(value);
      return '<tr><td>' + label + '</td><td>' + row.sessions + '</td><td>' + formatTokens(row.tokens) + '</td><td>' + formatCost(row.cost) + '</td></tr>';
    }).join("") : '<tr><td colspan="4" class="empty-state">No usage data yet.</td></tr>';
  }

  function providerLabel(provider) {
    return { claude: "Claude", codex: "Codex", agy: "Antigravity", deepseek: "DeepSeek" }[provider] || provider;
  }

  function providerMark(provider) {
    var safe = String(provider || "unknown").toLowerCase();
    var marks = { claude: "C", codex: "◎", agy: "A", deepseek: "D" };
    var icon = providerIcons[safe] || marks[safe] || "•";
    return '<span class="provider-logo provider-logo--' + escapeHtml(safe) + '" aria-hidden="true">' + icon + '</span>';
  }

  function providerForModel(model) {
    var value = String(model || "").toLowerCase();
    if (value.indexOf("deepseek") !== -1) return "deepseek";
    if (value.indexOf("gpt") !== -1 || value.indexOf("o1") !== -1 || value.indexOf("o3") !== -1) return "codex";
    if (value.indexOf("gemini") !== -1) return "agy";
    return "claude";
  }

  function usageBar(label, remaining, detail, resetText, provider) {
    var pct = Math.max(0, Math.min(100, Math.round(remaining)));
    var detailLine = resetText ? detail + ' · ' + resetText : detail;
    return '<div class="usage-limit">' +
      '<div class="usage-limit__top"><span>' + escapeHtml(label) + '</span><strong>' + pct + '% remaining</strong></div>' +
      '<div class="usage-limit__track"><span class="usage-limit__fill usage-limit__fill--' + escapeHtml(provider) + '" style="width:' + pct + '%"></span></div>' +
      '<div class="usage-limit__detail">' + escapeHtml(detailLine) + '</div>' +
    '</div>';
  }

  // Antigravity exposes a per-model quota; the CLI presents these bucketed by
  // model family ("Gemini models", "Claude & GPT models"). Mirror that
  // categorization so the card stays compact instead of listing every variant.
  function agyGroupName(label) {
    var l = String(label).toLowerCase();
    if (l.indexOf("gemini") !== -1) return "Gemini models";
    if (l.indexOf("claude") !== -1 || l.indexOf("gpt") !== -1 || l.indexOf("openai") !== -1) return "Claude & GPT models";
    return "Other models";
  }

  // "Gemini 3.5 Flash (Medium)" → "Gemini 3.5 Flash": drop the tier qualifier so
  // group membership lists read like the CLI's ("Gemini Flash, Gemini Pro").
  function agyModelBase(label) {
    return String(label).replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  function groupAgyLimits(limits) {
    var order = [];
    var groups = {};
    limits.forEach(function (limit) {
      var name = agyGroupName(limit.label);
      if (!groups[name]) { groups[name] = { name: name, members: [], limits: [] }; order.push(name); }
      var base = agyModelBase(limit.label);
      if (groups[name].members.indexOf(base) === -1) groups[name].members.push(base);
      groups[name].limits.push(limit);
    });
    // Most-constrained group first, matching the rest of the dashboard.
    return order.map(function (name) { return groups[name]; }).sort(function (a, b) {
      return minRemaining(a.limits) - minRemaining(b.limits);
    });
  }

  function minRemaining(limits) {
    return limits.reduce(function (min, l) { return Math.min(min, l.remainingPct); }, 100);
  }

  // Render a group from RetrieveUserQuotaSummary: header + member models + one
  // bar per bucket (Weekly Limit, Five Hour Limit).
  function renderAgyBucketGroup(group, detail) {
    var bars = (group.buckets || []).map(function (bucket) {
      return usageBar(bucket.label, bucket.remainingPct, detail, resetFromStamp(bucket.resetsAt), "agy");
    }).join("");
    return '<div class="usage-group">' +
      '<div class="usage-group__head">' + escapeHtml(group.name) + '</div>' +
      (group.models ? '<div class="usage-group__members">Models: ' + escapeHtml(group.models) + '</div>' : '') +
      bars +
    '</div>';
  }

  function renderAgyGroup(group, detail) {
    // The group's headline is its most-constrained model window.
    var tightest = group.limits.reduce(function (worst, l) {
      return l.remainingPct < worst.remainingPct ? l : worst;
    }, group.limits[0]);
    return '<div class="usage-group">' +
      '<div class="usage-group__head">' + escapeHtml(group.name) + '</div>' +
      '<div class="usage-group__members">Models: ' + escapeHtml(group.members.join(", ")) + '</div>' +
      usageBar("Plan limit", tightest.remainingPct, detail, resetFromStamp(tightest.resetsAt), "agy") +
    '</div>';
  }

  function renderProviderUsage(data) {
    var section = document.getElementById("provider-usage-cards");
    if (!section) return;
    var rows = data.byProvider || [];
    var snapshots = data.providerUsage || {};
    var cards = rows.map(function (row) {
      var provider = String(row.provider || "unknown").toLowerCase();
      var content = '<div class="provider-usage-card__history">' +
        '<span>' + row.sessions + ' sessions</span><span>' + formatTokens(row.tokens) + ' tokens</span><span>' + formatCost(row.cost) + ' est.</span>' +
      '</div>';
      if (provider === "claude" && data.quota) {
        var claudeDetail = data.quota.source === "live" ? "Live Claude limit" : "Local estimate";
        content = usageBar("5-hour plan", data.quota.fiveHour.remainingPct, claudeDetail, resetFromMs(data.quota.fiveHour.resetsIn), provider) +
          usageBar("7-day plan", data.quota.weekly.remainingPct, claudeDetail, resetFromMs(data.quota.weekly.resetsIn), provider) + content;
      } else if (provider === "codex" && snapshots.codex) {
        var codex = snapshots.codex;
        var bars = usageBar(codexWindowLabel(codex.primaryWindowMinutes, "Primary window"), codex.primaryRemainingPct, "Live Codex limit", resetFromStamp(codex.primaryResetsAt), provider);
        // Only show the secondary window when Codex has actually reported it.
        if (typeof codex.secondaryRemainingPct === "number") {
          bars += usageBar(codexWindowLabel(codex.secondaryWindowMinutes, "Secondary window"), codex.secondaryRemainingPct, "Live Codex limit", resetFromStamp(codex.secondaryResetsAt), provider);
        }
        content = bars + content;
      } else if (provider === "agy" && snapshots.agy) {
        var agyDetail = snapshots.agy.source === "cache" ? "Last known Antigravity limit" : "Live Antigravity limit";
        if (snapshots.agy.groups && snapshots.agy.groups.length) {
          // Authoritative grouped weekly / 5-hour buckets, as the CLI shows them.
          content = snapshots.agy.groups.map(function (group) { return renderAgyBucketGroup(group, agyDetail); }).join("") + content;
        } else {
          // Fallback: derive family groups from a flat per-model limit list.
          var limits = snapshots.agy.limits && snapshots.agy.limits.length ? snapshots.agy.limits : [{ label: "Plan limit", remainingPct: snapshots.agy.remainingPct, resetsAt: snapshots.agy.resetsAt }];
          content = groupAgyLimits(limits).map(function (group) { return renderAgyGroup(group, agyDetail); }).join("") + content;
        }
      } else {
        content = '<div class="usage-unavailable">Local history</div>' + content;
      }
      return '<article class="provider-usage-card provider-usage-card--' + escapeHtml(provider) + '">' +
        '<div class="provider-usage-card__heading">' + providerMark(provider) + '<div><h3>' + escapeHtml(providerLabel(provider)) + '</h3><p>' + (provider === "deepseek" ? "Estimated API use" : "Usage overview") + '</p></div></div>' + content +
      '</article>';
    });
    section.innerHTML = cards.length ? cards.join("") : '<div class="empty-state">No provider usage has been indexed yet.</div>';
  }

  function renderModels(rows) {
    var body = document.getElementById("models-body");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<div class="empty-state">No model usage has been indexed yet.</div>';
      return;
    }
    var maxTokens = Math.max.apply(null, rows.map(function (row) { return row.tokens || 0; }).concat([1]));
    body.innerHTML = rows.map(function (row) {
      var provider = providerForModel(row.model);
      var width = Math.max(3, Math.round(((row.tokens || 0) / maxTokens) * 100));
      return '<article class="model-row">' +
        '<div class="model-row__name">' + providerMark(provider) + '<div><strong>' + escapeHtml(row.model) + '</strong><span>' + escapeHtml(providerLabel(provider)) + ' · ' + row.sessions + ' session' + (row.sessions === 1 ? "" : "s") + '</span></div></div>' +
        '<div class="model-row__usage"><div class="model-row__track"><span class="model-row__fill model-row__fill--' + provider + '" style="width:' + width + '%"></span></div></div>' +
        '<div class="model-row__metrics"><strong>' + formatTokens(row.tokens) + '</strong><span>' + formatCost(row.cost) + ' est.</span></div>' +
      '</article>';
    }).join("");
  }

  // ---- Metric cards ----
  function renderMetricCards(data) {
    var section = document.getElementById("metric-cards");
    var scope = data.provider ? providerLabel(data.provider) : "All providers";
    section.innerHTML =
      '<div class="card">' +
        '<div class="card-number">' + data.totals.sessions + '</div>' +
        '<div class="card-label">Sessions</div>' +
        '<div class="card-today">' + data.today.sessions + ' today</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-number">' + data.totals.messages + '</div>' +
        '<div class="card-label">Messages</div>' +
        '<div class="card-today">—</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-number">' + formatTokens(data.totals.totalTokens) + '</div>' +
        '<div class="card-label">' + escapeHtml(scope) + ' tokens</div>' +
        '<div class="card-today">' + formatTokens(data.today.tokens) + ' today</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-number">' + formatCost(data.totals.totalCost) + '</div>' +
        '<div class="card-label">Est. ' + escapeHtml(scope) + ' cost</div>' +
        '<div class="card-today">' + formatCost(data.today.cost) + ' today</div>' +
      '</div>';
  }

  // ---- Quota cards ----
  function renderQuotaCards(quota) {
    var section = document.getElementById("quota-cards");
    if (!quota) {
      section.innerHTML = '<div class="card"><div class="card-label">Quota data unavailable</div></div>';
      return;
    }
    // Plan badge + data-source indicator in the section heading
    var heading = document.getElementById("quota-heading");
    if (heading) {
      var isLive = quota.source === "live";
      var isCached = isLive && typeof quota.cachedAtMs === "number";
      var srcClass, srcText, srcTitle;
      if (isCached) {
        srcClass = "source-cached";
        srcText = "cached " + relativeAge(quota.cachedAtMs);
        srcTitle = "Real usage from claude.ai, cached at " + new Date(quota.cachedAtMs).toLocaleTimeString() +
          " (live endpoint was rate-limited). Press Refresh to retry.";
      } else if (isLive) {
        srcClass = "source-live";
        srcText = "live";
        srcTitle = "Real usage from claude.ai";
      } else {
        srcClass = "source-est";
        srcText = "estimate";
        srcTitle = "Estimated from local sessions (claude.ai usage unavailable)";
      }
      heading.innerHTML = 'Claude Plan Limit ' +
        '<span class="source-badge ' + srcClass + '" title="' + escapeHtml(srcTitle) + '">' +
          escapeHtml(srcText) + '</span>';
    }
    section.innerHTML =
      buildQuotaCard("Claude 5-Hour", quota.fiveHour, quota.source) +
      buildQuotaCard("Claude 7-Day", quota.weekly, quota.source);
  }

  function quotaLevel(remainingPct) {
    if (remainingPct <= 10) return "danger";
    if (remainingPct <= 30) return "warn";
    return "ok";
  }

  function buildQuotaCard(label, win, source) {
    var remPct = typeof win.remainingPct === "number"
      ? win.remainingPct
      : Math.max(0, Math.min(100, 100 - win.pct));
    var level = quotaLevel(remPct);
    // In live mode there is no local token budget; show the used% instead.
    var detail = source === "live"
      ? (win.pct + "% used")
      : (formatTokens(win.used) + " / " + formatTokens(win.budget) + " used");
    return (
      '<div class="card quota-card">' +
        '<div class="card-label">' + label + '</div>' +
        '<div class="quota-headline ' + level + '">' + remPct + '% <span class="quota-headline-sub">remaining</span></div>' +
        '<div class="quota-bar-container">' +
          '<div class="quota-bar ' + level + '" style="width:' + remPct + '%"></div>' +
        '</div>' +
        '<div class="quota-stats">' +
          '<span class="quota-reset">Resets in ' + formatTime(win.resetsIn) + '</span>' +
          '<span class="quota-used">' + detail + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  // ---- Daily table ----
  function renderDailyTable() {
    // Sort
    var sorted = allDaily.slice();
    sorted.sort(function (a, b) {
      var va = a[dailySortState.col];
      var vb = b[dailySortState.col];
      if (typeof va === "string") {
        var cmp = va.localeCompare(vb);
        return dailySortState.dir === "asc" ? cmp : -cmp;
      }
      return dailySortState.dir === "asc" ? va - vb : vb - va;
    });

    // Slice
    var rows = showAllDays ? sorted : sorted.slice(0, 30);

    var tbody = document.getElementById("daily-body");
    tbody.innerHTML = "";
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No daily data yet.</td></tr>';
    } else {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var tr = document.createElement("tr");
        tr.setAttribute("data-date", r.date);
        tr.innerHTML =
          '<td>' + escapeHtml(r.date) + '</td>' +
          '<td>' + r.sessions + '</td>' +
          '<td>' + r.messages + '</td>' +
          '<td>' + formatTokens(r.tokens) + '</td>' +
          '<td>' + formatCost(r.cost) + '</td>';
        tbody.appendChild(tr);
      }
    }

    // Update sort arrows
    var headers = document.querySelectorAll("#daily-table th.sortable");
    Array.prototype.forEach.call(headers, function (th) {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.getAttribute("data-col") === dailySortState.col) {
        th.classList.add(dailySortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });

    // Update count
    document.getElementById("daily-count").textContent = "Showing " + rows.length + " of " + allDaily.length + " days";
  }

  // ---- Heatmap ----
  function renderHeatmap(daily) {
    var container = document.getElementById("heatmap");
    container.innerHTML = "";

    // Build a map: dateStr -> session count
    var dayMap = {};
    for (var i = 0; i < daily.length; i++) {
      dayMap[daily[i].date] = daily[i].sessions;
    }

    // Generate last 84 days
    var cells = [];
    var now = new Date();
    for (var j = 83; j >= 0; j--) {
      var d = new Date(now);
      d.setDate(d.getDate() - j);
      var y = d.getFullYear();
      var mo = String(d.getMonth() + 1).padStart(2, "0");
      var dd = String(d.getDate()).padStart(2, "0");
      var dateStr = y + "-" + mo + "-" + dd;
      var count = dayMap[dateStr] || 0;
      cells.push({ date: dateStr, count: count });
    }

    // Find max count for opacity scaling
    var maxCount = 1;
    for (var k = 0; k < cells.length; k++) {
      if (cells[k].count > maxCount) maxCount = cells[k].count;
    }

    // Render each cell, scaling an actual color toward the "ok" accent green
    // by intensity. Modulating opacity on the empty (near-page-background)
    // color is invisible since there's no hue to fade into — color the cell
    // directly instead.
    for (var l = 0; l < cells.length; l++) {
      var cell = cells[l];
      var el = document.createElement("div");
      el.className = "heatmap-cell";
      var intensity = maxCount > 0 ? cell.count / maxCount : 0;
      if (cell.count > 0) {
        var alpha = 0.25 + intensity * 0.75;
        el.style.background = "rgba(76, 175, 80, " + alpha.toFixed(2) + ")";
      }
      (function (cellData) {
        el.addEventListener("mouseenter", function (e) {
          showTooltip(
            '<strong>' + escapeHtml(cellData.date) + '</strong><br>' +
              cellData.count + ' session' + (cellData.count !== 1 ? "s" : ""),
            e.clientX, e.clientY
          );
        });
        el.addEventListener("mousemove", function (e) {
          showTooltip(
            '<strong>' + escapeHtml(cellData.date) + '</strong><br>' +
              cellData.count + ' session' + (cellData.count !== 1 ? "s" : ""),
            e.clientX, e.clientY
          );
        });
        el.addEventListener("mouseleave", hideTooltip);
        el.addEventListener("click", function () {
          if (cellData.count > 0) jumpToDate(cellData.date);
        });
      })(cell);
      container.appendChild(el);
    }
  }

  // ---- Projects table ----
  function renderProjectsTable(projects) {
    var tbody = document.getElementById("projects-body");
    tbody.innerHTML = "";
    if (!projects || projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No projects yet.</td></tr>';
      return;
    }
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td>' + escapeHtml(p.name || "(unnamed)") + '</td>' +
        '<td>' + p.sessions + '</td>' +
        '<td>' + formatTokens(p.tokens) + '</td>' +
        '<td>' + formatCost(p.cost) + '</td>';
      tbody.appendChild(tr);
    }
  }

  // ---- Top files table ----
  function renderFilesTable(files) {
    var tbody = document.getElementById("files-body");
    tbody.innerHTML = "";
    if (!files || files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No file changes tracked yet.</td></tr>';
      return;
    }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var tr = document.createElement("tr");
      tr.className = "clickable-row";
      tr.title = f.path;
      tr.innerHTML =
        '<td>' + escapeHtml(truncatePath(f.path, 60)) + '</td>' +
        '<td>' + f.sessions + '</td>' +
        '<td>' + f.changes + '</td>';
      (function (path) {
        tr.addEventListener("click", function () {
          vscode.postMessage({ command: "openFile", filePath: path });
        });
      })(f.path);
      tbody.appendChild(tr);
    }
  }

  function truncatePath(p, max) {
    if (p.length <= max) return p;
    return "..." + p.slice(-(max - 3));
  }

  // ---- Average cards ----
  function renderAverageCards(avgMessages, avgTokens) {
    var msgEl = document.getElementById("avg-messages-card");
    var tokEl = document.getElementById("avg-tokens-card");
    if (msgEl) msgEl.textContent = (avgMessages || 0).toFixed(1);
    if (tokEl) tokEl.textContent = Math.round(avgTokens || 0).toLocaleString();
  }

  // ---- Nice scale helper ----
  function niceCeil(max) {
    if (max <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(max)));
    var n = max / pow;
    var nice;
    if (n <= 1) nice = 1;
    else if (n <= 2) nice = 2;
    else if (n <= 5) nice = 5;
    else nice = 10;
    return nice * pow;
  }

  // ---- Active Hours bar chart (SVG) ----
  function renderHoursChart(hours) {
    var container = document.getElementById("hours-chart");
    if (!container) return;
    container.innerHTML = "";

    var width = 560, height = 220;
    var padLeft = 36, padBottom = 26, padTop = 10, padRight = 8;
    var plotW = width - padLeft - padRight;
    var plotH = height - padTop - padBottom;

    var max = 0;
    for (var i = 0; i < hours.length; i++) {
      if (hours[i] > max) max = hours[i];
    }
    var scaleMax = niceCeil(max);
    var steps = 5;

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart-svg" preserveAspectRatio="xMinYMin meet">';

    // Gridlines + y-axis labels
    for (var s = 0; s <= steps; s++) {
      var val = Math.round((scaleMax / steps) * s);
      var y = padTop + plotH - (s / steps) * plotH;
      svg += '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (padLeft + plotW) + '" y2="' + y + '" class="chart-grid" />';
      svg += '<text x="' + (padLeft - 8) + '" y="' + (y + 4) + '" class="chart-axis-label" text-anchor="end">' + val + '</text>';
    }

    // Bars
    var n = hours.length;
    var barSlot = plotW / n;
    var barWidth = barSlot * 0.6;
    for (var h = 0; h < n; h++) {
      var v = hours[h];
      var barH = scaleMax > 0 ? (v / scaleMax) * plotH : 0;
      var x = padLeft + h * barSlot + (barSlot - barWidth) / 2;
      var y2 = padTop + plotH - barH;
      if (v > 0) {
        svg += '<rect x="' + x + '" y="' + y2 + '" width="' + barWidth + '" height="' + barH + '" class="chart-bar" data-hour="' + h + '" data-value="' + v + '"></rect>';
      }
      if (h % 2 === 0) {
        var lx = padLeft + h * barSlot + barSlot / 2;
        svg += '<text x="' + lx + '" y="' + (height - 6) + '" class="chart-axis-label chart-axis-label-x" text-anchor="middle" transform="rotate(-35 ' + lx + ' ' + (height - 6) + ')">' + String(h).padStart(2, "0") + 'h</text>';
      }
    }

    svg += '</svg>';
    container.innerHTML =
      '<div class="chart-legend"><span class="chart-legend-swatch chart-legend-swatch-bar"></span>Sessions</div>' + svg;

    var bars = container.querySelectorAll(".chart-bar");
    Array.prototype.forEach.call(bars, function (bar) {
      var hr = bar.getAttribute("data-hour");
      var val = bar.getAttribute("data-value");
      var label = '<strong>' + String(hr).padStart(2, "0") + ':00</strong><br>' +
        val + ' session' + (val !== "1" ? "s" : "");
      bar.addEventListener("mouseenter", function (e) {
        bar.classList.add("bar-active");
        showTooltip(label, e.clientX, e.clientY);
      });
      bar.addEventListener("mousemove", function (e) {
        showTooltip(label, e.clientX, e.clientY);
      });
      bar.addEventListener("mouseleave", function () {
        bar.classList.remove("bar-active");
        hideTooltip();
      });
    });
  }

  // ---- Weekly Distribution radar chart (SVG) ----
  function renderWeekdayChart(weekday) {
    var container = document.getElementById("weekday-chart");
    if (!container) return;
    container.innerHTML = "";

    var labels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var size = 320;
    var cx = size / 2, cy = size / 2;
    var radius = size / 2 - 56;
    var n = labels.length;

    var max = 0;
    for (var i = 0; i < weekday.length; i++) {
      if (weekday[i] > max) max = weekday[i];
    }
    var scaleMax = niceCeil(max);
    var rings = 4;

    function pointFor(i, value) {
      var angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      var r = scaleMax > 0 ? (value / scaleMax) * radius : 0;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    }

    var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" class="chart-svg" preserveAspectRatio="xMidYMid meet">';

    // Concentric grid rings (polygons)
    for (var ring = 1; ring <= rings; ring++) {
      var ringR = (ring / rings) * radius;
      var pts = [];
      for (var j = 0; j < n; j++) {
        var angle2 = (Math.PI * 2 * j) / n - Math.PI / 2;
        pts.push((cx + ringR * Math.cos(angle2)) + "," + (cy + ringR * Math.sin(angle2)));
      }
      svg += '<polygon points="' + pts.join(" ") + '" class="chart-radar-ring" />';
      var ringVal = Math.round((scaleMax / rings) * ring);
      svg += '<text x="' + (cx + 4) + '" y="' + (cy - ringR + 4) + '" class="chart-axis-label">' + ringVal + '</text>';
    }

    // Spokes + axis labels
    for (var k = 0; k < n; k++) {
      var angle3 = (Math.PI * 2 * k) / n - Math.PI / 2;
      var ex = cx + radius * Math.cos(angle3);
      var ey = cy + radius * Math.sin(angle3);
      svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + ex + '" y2="' + ey + '" class="chart-radar-spoke" data-spoke="' + k + '" />';

      var lx = cx + (radius + 22) * Math.cos(angle3);
      var ly = cy + (radius + 22) * Math.sin(angle3);
      svg += '<text x="' + lx + '" y="' + ly + '" class="chart-radar-axis-label" text-anchor="middle">' + labels[k] + '</text>';
    }

    // Data polygon
    var dataPts = [];
    for (var m = 0; m < n; m++) {
      var p = pointFor(m, weekday[m] || 0);
      dataPts.push(p.x + "," + p.y);
    }
    svg += '<polygon points="' + dataPts.join(" ") + '" class="chart-radar-data" />';
    for (var d = 0; d < n; d++) {
      var p2 = pointFor(d, weekday[d] || 0);
      svg += '<circle cx="' + p2.x + '" cy="' + p2.y + '" r="3.5" class="chart-radar-point" data-index="' + d + '" />';
    }

    svg += '</svg>';
    container.innerHTML =
      '<div class="chart-legend"><span class="chart-legend-swatch chart-legend-swatch-dot"></span>Session Count</div>' + svg;

    var points = container.querySelectorAll(".chart-radar-point");
    Array.prototype.forEach.call(points, function (pt) {
      var idx = Number(pt.getAttribute("data-index"));
      var label = labels[idx];
      var val = weekday[idx] || 0;
      var html = '<strong>' + label + '</strong><br>' + val + ' session' + (val !== 1 ? "s" : "");
      var spoke = container.querySelector('.chart-radar-spoke[data-spoke="' + idx + '"]');
      pt.addEventListener("mouseenter", function (e) {
        pt.classList.add("point-active");
        if (spoke) spoke.classList.add("spoke-active");
        showTooltip(html, e.clientX, e.clientY);
      });
      pt.addEventListener("mousemove", function (e) {
        showTooltip(html, e.clientX, e.clientY);
      });
      pt.addEventListener("mouseleave", function () {
        pt.classList.remove("point-active");
        if (spoke) spoke.classList.remove("spoke-active");
        hideTooltip();
      });
    });
  }

  // Tell the extension the message listener is attached and it is safe to send
  // data. Without this handshake the initial postMessage races the script load
  // and the panel renders empty until a manual refresh.
  vscode.postMessage({ command: "ready" });

})();
