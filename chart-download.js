/* Per-chart PNG download. Adds a download icon to the title bar of every
   .perf-chart bubble (index + market pages) and exports the canvas as a
   standalone image styled like the on-screen card: white background, serif
   title, legend swatches, hairline rule. Charts render asynchronously after
   the data fetch, so the click handler resolves the Chart instance at
   click-time rather than at attach-time. */
(function () {
  "use strict";

  var ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M2.5 12.5h11"/></svg>';

  function slug(text) {
    return String(text || "chart")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  /* market.html shows the market name in #market-name; on index.html this
     is absent and the prefix is omitted. */
  function pagePrefix() {
    var el = document.getElementById("market-name");
    var name = el ? el.textContent.trim() : "";
    return name && name !== "—" ? slug(name) + "-" : "";
  }

  function legendItems(figcaption) {
    var items = [];
    figcaption.querySelectorAll(".perf-legend-item").forEach(function (item) {
      var swatch = item.querySelector(".swatch");
      items.push({
        color: swatch ? getComputedStyle(swatch).backgroundColor : "#837c75",
        label: item.textContent.trim(),
      });
    });
    return items;
  }

  function exportChart(figure) {
    var canvas = figure.querySelector(".perf-chart-wrap canvas");
    if (!canvas || !canvas.width) return;
    var chart = window.Chart && window.Chart.getChart(canvas);
    if (!chart) return;

    var caption = figure.querySelector(".perf-title");
    var title = caption ? (caption.querySelector(".perf-title-text") || caption).textContent.trim() : "";
    var subEl = caption ? caption.querySelector(".perf-title-sub") : null;
    var sub = subEl ? subEl.textContent.trim() : "";
    var legend = caption ? legendItems(caption) : [];

    var scale = canvas.clientWidth ? canvas.width / canvas.clientWidth : 2;
    var pad = Math.round(20 * scale);
    var bandH = Math.round(34 * scale);
    var gap = Math.round(12 * scale);

    var out = document.createElement("canvas");
    out.width = canvas.width + pad * 2;
    out.height = canvas.height + bandH + gap + pad * 2;
    var ctx = out.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);

    var baseline = pad + Math.round(18 * scale);
    ctx.fillStyle = "#2b2825";
    ctx.font = "700 " + Math.round(16 * scale) + "px 'Mencken Std', Georgia, 'Times New Roman', serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, pad, baseline);

    /* Right side of the band mirrors the card: legend swatches if present,
       otherwise the sub-text. */
    var rightX = out.width - pad;
    if (legend.length) {
      ctx.font = "600 " + Math.round(10 * scale) + "px 'Pragmatica', sans-serif";
      for (var i = legend.length - 1; i >= 0; i--) {
        var it = legend[i];
        var labelW = ctx.measureText(it.label.toUpperCase()).width;
        rightX -= labelW;
        ctx.fillStyle = "#5a544f";
        ctx.fillText(it.label.toUpperCase(), rightX, baseline);
        var sw = Math.round(10 * scale);
        rightX -= sw + Math.round(5 * scale);
        ctx.fillStyle = it.color;
        ctx.fillRect(rightX, baseline - sw + Math.round(1 * scale), sw, sw);
        rightX -= Math.round(12 * scale);
      }
    } else if (sub) {
      ctx.font = "500 " + Math.round(11 * scale) + "px 'Pragmatica', sans-serif";
      ctx.fillStyle = "#837c75";
      ctx.fillText(sub, rightX - ctx.measureText(sub).width, baseline);
    }

    ctx.strokeStyle = "#ede5cf";
    ctx.lineWidth = Math.max(1, Math.round(scale));
    ctx.beginPath();
    ctx.moveTo(pad, pad + bandH);
    ctx.lineTo(out.width - pad, pad + bandH);
    ctx.stroke();

    ctx.drawImage(canvas, pad, pad + bandH + gap);

    var link = document.createElement("a");
    link.download = pagePrefix() + slug(title) + "-" + todayStamp() + ".png";
    link.href = out.toDataURL("image/png");
    link.click();
  }

  /* ----- Table → CSV downloads (Competitive Set tab) ------------- */

  function tableToCsv(table) {
    var lines = [];
    table.querySelectorAll("tr").forEach(function (tr) {
      if (tr.querySelector(".empty-state")) return;
      var cells = [];
      tr.querySelectorAll("th, td").forEach(function (cell) {
        // The checkbox column is a UI control, not data
        if (cell.classList.contains("comp-select-cell") ||
            cell.classList.contains("comp-select-col")) return;
        var text = cell.textContent.replace(/\s+/g, " ").trim();
        cells.push('"' + text.replace(/"/g, '""') + '"');
      });
      if (cells.length) lines.push(cells.join(","));
    });
    return "\uFEFF" + lines.join("\r\n");  // BOM so Excel reads UTF-8
  }

  function downloadCsv(table, title) {
    var blob = new Blob([tableToCsv(table)], { type: "text/csv;charset=utf-8" });
    var link = document.createElement("a");
    link.download = pagePrefix() + slug(title) + "-" + todayStamp() + ".csv";
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 5000);
  }

  function makeTableBtn(table, getTitle) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-dl-btn table-dl-btn";
    btn.title = "Download table as CSV";
    btn.setAttribute("aria-label", "Download table as CSV");
    btn.innerHTML = ICON;
    btn.addEventListener("click", function () { downloadCsv(table, getTitle()); });
    return btn;
  }

  function attachTables() {
    // Comp-set Properties: button joins the Select all / Clear actions
    var actions = document.querySelector(".comps-table-actions");
    var propsTable = document.getElementById("properties-comps");
    if (actions && propsTable && !actions.querySelector(".table-dl-btn")) {
      actions.appendChild(makeTableBtn(propsTable, function () { return "Comp-set Properties"; }));
    }
    // The four detail tables: button in each card's green title band.
    // Titles are read at click time — some update with the data year.
    document.querySelectorAll(".comp-table-card").forEach(function (card) {
      var titleEl = card.querySelector(".comp-table-title");
      var table = card.querySelector("table");
      if (!titleEl || !table || titleEl.querySelector(".table-dl-btn")) return;
      titleEl.appendChild(makeTableBtn(table, function () {
        return titleEl.textContent.trim();
      }));
    });
  }

  function attach() {
    document.querySelectorAll("figure.perf-chart").forEach(function (figure) {
      var caption = figure.querySelector(".perf-title");
      var canvas = figure.querySelector(".perf-chart-wrap canvas");
      if (!caption || !canvas || caption.querySelector(".chart-dl-btn")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chart-dl-btn";
      btn.title = "Download chart as PNG";
      btn.setAttribute("aria-label", "Download chart as PNG");
      btn.innerHTML = ICON;
      btn.addEventListener("click", function () { exportChart(figure); });
      caption.appendChild(btn);
    });
    attachTables();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
