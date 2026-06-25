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

  /* Context label for filenames and the table title band: the market name on
     market.html (#market-name), the property name on property.html
     (#prop-name), absent on index.html. */
  function contextName() {
    var el = document.getElementById("market-name") || document.getElementById("prop-name");
    var name = el ? el.textContent.trim() : "";
    return name && name !== "-" ? name : "";
  }

  function pagePrefix() {
    var name = contextName();
    return name ? slug(name) + "-" : "";
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

  /* ----- Table to PNG downloads (Competitive Set tab) ------------
     The table is redrawn onto a canvas in the dashboard's card style:
     everest title band, beige header row, the detail tables' butter
     body tint, bold footer with growth coloring. */

  function tableRows(table) {
    var rows = [];
    ["thead", "tbody", "tfoot"].forEach(function (sec) {
      var el = table.querySelector(sec);
      if (!el) return;
      el.querySelectorAll("tr").forEach(function (tr) {
        if (tr.querySelector(".empty-state")) return;
        var cells = [];
        tr.querySelectorAll("th, td").forEach(function (cell) {
          // The checkbox column is a UI control, not data
          if (cell.classList.contains("comp-select-cell") ||
              cell.classList.contains("comp-select-col")) return;
          cells.push({
            text: cell.textContent.replace(/\s+/g, " ").trim(),
            span: Math.max(1, Number(cell.getAttribute("colspan")) || 1),
            up: cell.classList.contains("growth-up"),
            down: cell.classList.contains("growth-down"),
          });
        });
        if (cells.length) rows.push({ section: sec, agg: tr.classList.contains("agg-row"), cells: cells });
      });
    });
    return rows;
  }

  function downloadTablePng(table, title) {
    var rows = tableRows(table);
    if (rows.length === 0) return;
    var S = 2;  // render at 2x for crispness
    var padX = 12 * S, rowH = 32 * S, bandH = 50 * S, margin = 20 * S;
    var fonts = {
      head: "700 " + 11 * S + "px 'Pragmatica', sans-serif",
      body: "400 " + 12 * S + "px 'Pragmatica', sans-serif",
      bodyBold: "700 " + 12 * S + "px 'Pragmatica', sans-serif",
      band: "700 " + 17 * S + "px 'Mencken Std', Georgia, serif",
      bandSub: "600 " + 10 * S + "px 'Pragmatica', sans-serif",
    };

    var meas = document.createElement("canvas").getContext("2d");
    var nCols = 0;
    rows.forEach(function (r) {
      var n = 0;
      r.cells.forEach(function (c) { n += c.span; });
      nCols = Math.max(nCols, n);
    });
    var colW = new Array(nCols).fill(44 * S);
    rows.forEach(function (r) {
      var ci = 0;
      r.cells.forEach(function (c) {
        if (c.span === 1) {
          meas.font = r.section === "thead" ? fonts.head
            : (r.section === "tfoot" || ci === 0) ? fonts.bodyBold : fonts.body;
          var w = Math.min(meas.measureText(c.text).width + padX * 2, 480 * S);
          colW[ci] = Math.max(colW[ci], w);
        }
        ci += c.span;
      });
    });
    var tableW = colW.reduce(function (a, b) { return a + b; }, 0);

    var out = document.createElement("canvas");
    out.width = tableW + margin * 2;
    out.height = bandH + rows.length * rowH + margin * 2;
    var ctx = out.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);

    // Title band - everest, white serif title, market name on the right
    ctx.fillStyle = "#16352e";
    ctx.fillRect(margin, margin, tableW, bandH);
    ctx.fillStyle = "#ffffff";
    ctx.font = fonts.band;
    ctx.fillText(title, margin + padX, margin + bandH / 2 + 6 * S);
    var market = contextName();
    if (market) {
      ctx.font = fonts.bandSub;
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      var mw = ctx.measureText(market.toUpperCase()).width;
      ctx.fillText(market.toUpperCase(), margin + tableW - padX - mw, margin + bandH / 2 + 4 * S);
    }

    var y = margin + bandH;
    rows.forEach(function (r) {
      ctx.fillStyle = r.section === "thead" ? "#ede5cf"
        : r.section === "tfoot" ? (r.agg ? "#f1ecdd" : "#ffffff")
        : "#fbf5d9";
      ctx.fillRect(margin, y, tableW, rowH);
      if (r.section === "tbody") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = S;
        ctx.beginPath();
        ctx.moveTo(margin, y + rowH);
        ctx.lineTo(margin + tableW, y + rowH);
        ctx.stroke();
      }
      if (r.section === "tfoot" && r.agg) {
        ctx.strokeStyle = "#2b2825";
        ctx.lineWidth = 1.5 * S;
        ctx.beginPath();
        ctx.moveTo(margin, y);
        ctx.lineTo(margin + tableW, y);
        ctx.stroke();
      }

      var x = margin, ci = 0;
      var baseline = y + rowH / 2 + 4.5 * S;
      r.cells.forEach(function (c) {
        var w = 0;
        for (var k = 0; k < c.span; k++) w += colW[ci + k] || 0;
        var left = ci === 0;  // first column (and colspan labels) read left
        ctx.font = r.section === "thead" ? fonts.head
          : (r.section === "tfoot" || left) ? fonts.bodyBold : fonts.body;
        ctx.fillStyle = c.up ? "#16352e" : c.down ? "#a95818"
          : (r.section === "tfoot" && !r.agg && !left) ? "#5a544f" : "#2b2825";
        var maxW = w - padX * 2;
        var tw = Math.min(ctx.measureText(c.text).width, maxW);
        ctx.fillText(c.text, left ? x + padX : x + w - padX - tw, baseline, maxW);
        x += w;
        ci += c.span;
      });
      y += rowH;
    });

    var link = document.createElement("a");
    link.download = pagePrefix() + slug(title) + "-" + todayStamp() + ".png";
    link.href = out.toDataURL("image/png");
    link.click();
  }

  function makeTableBtn(table, getTitle) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-dl-btn table-dl-btn";
    btn.title = "Download table as image";
    btn.setAttribute("aria-label", "Download table as image");
    btn.innerHTML = ICON;
    btn.addEventListener("click", function () { downloadTablePng(table, getTitle()); });
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
    // Titles are read at click time - some update with the data year.
    document.querySelectorAll(".comp-table-card").forEach(function (card) {
      var titleEl = card.querySelector(".comp-table-title");
      var table = card.querySelector("table");
      if (!titleEl || !table || titleEl.querySelector(".table-dl-btn")) return;
      titleEl.appendChild(makeTableBtn(table, function () {
        return titleEl.textContent.trim();
      }));
    });

    // Generic: any table flagged with data-dl-title gets a button in its
    // card's header (e.g. the property page's Floor Plans table). The title
    // for the export is taken from the attribute.
    document.querySelectorAll("table[data-dl-title]").forEach(function (table) {
      var card = table.closest(".card");
      var header = card ? card.querySelector(".card-header") : null;
      if (!header || header.querySelector(".table-dl-btn")) return;
      header.appendChild(makeTableBtn(table, function () {
        return table.getAttribute("data-dl-title") || "Table";
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
