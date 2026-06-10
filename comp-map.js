/* =============================================================
   Comp Map Generator — Comps tab of market.html.
   Renders the comps selected in the Comp-set Properties table onto a
   static map canvas styled like the deck "Comps & Pipeline" maps:
   basemap tiles + campus boundary + phase-shaped markers + white
   callout boxes with leader lines. Callouts auto-place around their
   marker and can be dragged to fine-tune before downloading the PNG.

   Loads after market.js and reads its top-level state (PROPERTIES,
   MARKET, compSelection, phaseStyle). market.js calls
   window.CompMap.refresh() whenever the comp selection changes.
   ============================================================= */
(function () {
  "use strict";

  /* Backing canvas is 2× the on-screen size; tiles are fetched at the
     zoom that fits these dimensions so the export is print-crisp. */
  var W = 2800, H = 2000;
  var TILE = 256;
  var FIT_PAD_X = 420, FIT_PAD_Y = 300;  // room for callouts around the marker cloud
  var EDGE = 24;                          // min gap between a callout and the canvas edge

  var TILE_SOURCES = {
    terrain: {
      label: "Terrain",
      url: function (z, x, y) {
        return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/" + z + "/" + y + "/" + x;
      },
      attribution: "Tiles © Esri",
      maxZoom: 19,
    },
    street: {
      label: "Street",
      url: function (z, x, y) {
        var s = "abc"[(x + y) % 3];
        return "https://" + s + ".tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png";
      },
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    },
    light: {
      label: "Light",
      url: function (z, x, y) {
        var s = "abcd"[(x + y) % 4];
        return "https://" + s + ".basemaps.cartocdn.com/rastertiles/voyager/" + z + "/" + x + "/" + y + ".png";
      },
      attribution: "© OSM · © CARTO",
      maxZoom: 19,
    },
    satellite: {
      label: "Satellite",
      url: function (z, x, y) {
        return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/" + z + "/" + y + "/" + x;
      },
      attribution: "Tiles © Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
    },
  };

  var state = {
    basemap: "satellite",
    rings: true,           // 0.5/1/2-mile rings around the anchor campus
    compact: false,        // true = callouts show name + address only
    view: null,            // { z, originX, originY }
    base: null,            // offscreen canvas: tiles + boundary
    baseSig: null,
    props: [],             // selected comps with coords, with px positions
    placements: new Map(), // property_key -> {x, y, w, h, auto}
    boundary: undefined,   // geojson (null = fetched, missing)
    drag: null,
    renderToken: 0,
  };

  function anchorCampus() {
    if (typeof CAMPUSES === "undefined") return null;
    return CAMPUSES.find(function (c) {
      return c.university_name === MARKET.anchor_university && c.campus_lat != null;
    }) || CAMPUSES.find(function (c) { return c.campus_lat != null; }) || null;
  }

  /* ----- Web Mercator ------------------------------------------ */

  function worldX(lng, z) { return ((lng + 180) / 360) * TILE * Math.pow(2, z); }
  function worldY(lat, z) {
    var s = Math.sin((lat * Math.PI) / 180);
    s = Math.min(Math.max(s, -0.9999), 0.9999);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
  }

  function computeView(latLngs) {
    var latN = -90, latS = 90, lngW = 180, lngE = -180;
    latLngs.forEach(function (ll) {
      latN = Math.max(latN, ll[0]); latS = Math.min(latS, ll[0]);
      lngE = Math.max(lngE, ll[1]); lngW = Math.min(lngW, ll[1]);
    });
    var fitW = W - FIT_PAD_X * 2, fitH = H - FIT_PAD_Y * 2;
    var z = 17;
    while (z > 3) {
      var spanX = worldX(lngE, z) - worldX(lngW, z);
      var spanY = worldY(latS, z) - worldY(latN, z);
      if (spanX <= fitW && spanY <= fitH) break;
      z--;
    }
    var cx = (worldX(lngW, z) + worldX(lngE, z)) / 2;
    var cy = (worldY(latN, z) + worldY(latS, z)) / 2;
    return { z: z, originX: cx - W / 2, originY: cy - H / 2 };
  }

  function project(lat, lng) {
    return {
      x: worldX(lng, state.view.z) - state.view.originX,
      y: worldY(lat, state.view.z) - state.view.originY,
    };
  }

  /* ----- Base layer: tiles + campus boundary -------------------- */

  function loadTile(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  function fetchBoundary() {
    if (state.boundary !== undefined) return Promise.resolve(state.boundary);
    return fetch("assets/campus-boundaries/" + MARKET.market_key + ".geojson", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (gj) { state.boundary = gj; return gj; });
  }

  function boundaryRings(gj) {
    var rings = [];
    function fromGeometry(geom) {
      if (!geom) return;
      if (geom.type === "Polygon") geom.coordinates.forEach(function (r) { rings.push(r); });
      else if (geom.type === "MultiPolygon") geom.coordinates.forEach(function (poly) { poly.forEach(function (r) { rings.push(r); }); });
      else if (geom.type === "GeometryCollection") (geom.geometries || []).forEach(fromGeometry);
    }
    if (gj.type === "FeatureCollection") (gj.features || []).forEach(function (f) { fromGeometry(f.geometry); });
    else if (gj.type === "Feature") fromGeometry(gj.geometry);
    else fromGeometry(gj);
    return rings;
  }

  function buildBase() {
    var src = TILE_SOURCES[state.basemap];
    var z = state.view.z, ox = state.view.originX, oy = state.view.originY;
    var maxIndex = Math.pow(2, z) - 1;
    var txMin = Math.floor(ox / TILE), txMax = Math.floor((ox + W) / TILE);
    var tyMin = Math.max(0, Math.floor(oy / TILE)), tyMax = Math.min(maxIndex, Math.floor((oy + H) / TILE));

    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e8e4da";
    ctx.fillRect(0, 0, W, H);

    var jobs = [];
    for (var tx = txMin; tx <= txMax; tx++) {
      for (var ty = tyMin; ty <= tyMax; ty++) {
        (function (tx, ty) {
          jobs.push(loadTile(src.url(z, tx, ty)).then(function (img) {
            if (img) ctx.drawImage(img, tx * TILE - ox, ty * TILE - oy);
          }));
        })(tx, ty);
      }
    }

    return Promise.all(jobs).then(fetchBoundary).then(function (gj) {
      if (gj) {
        ctx.save();
        ctx.beginPath();
        boundaryRings(gj).forEach(function (ring) {
          ring.forEach(function (coord, i) {
            var p = project(coord[1], coord[0]);
            if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          });
          ctx.closePath();
        });
        ctx.fillStyle = "rgba(211, 47, 47, 0.16)";
        ctx.fill();
        ctx.strokeStyle = "#d32f2f";
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }
      state.base = canvas;
    });
  }

  /* ----- Callout content + measurement -------------------------- */

  var FONTS = {
    title: "700 30px 'Pragmatica', sans-serif",
    sub: "400 22px 'Pragmatica', sans-serif",
    label: "700 23px 'Pragmatica', sans-serif",
    value: "400 23px 'Pragmatica', sans-serif",
  };
  var LINE_H = 34, TITLE_H = 40, SUB_H = 30, BOX_PAD = 22;

  function fmtInt(v) { return v == null ? "—" : Math.round(v).toLocaleString("en-US"); }

  function calloutContent(p) {
    // Compact mode for crowded markets: name + address only
    if (state.compact) {
      return { title: p.property_name || "(unnamed)", sub: p.street1 || "", lines: [] };
    }
    var phase = (p.phase || "").toLowerCase();
    var pipeline = phase === "under construction" || phase === "planned";
    var lines = [
      { label: "Status", value: phaseStyle(p.phase).label },
      { label: "Beds", value: fmtInt(p.beds) },
      { label: pipeline ? "Expected Delivery" : "Year Built", value: p.yearBuilt || "—" },
    ];
    if (!pipeline && p.avg_rent > 0) lines.push({ label: "Avg Rent / Bed", value: "$" + fmtInt(p.avg_rent) });
    if (p.milesToClosestCampus != null) {
      lines.push({ label: "To Campus", value: p.milesToClosestCampus.toFixed(1) + " mi" });
    }
    return { title: p.property_name || "(unnamed)", sub: p.street1 || "", lines: lines };
  }

  function measureCallout(ctx, content) {
    var w = 0;
    ctx.font = FONTS.title;
    w = Math.max(w, ctx.measureText(content.title).width);
    if (content.sub) {
      ctx.font = FONTS.sub;
      w = Math.max(w, ctx.measureText(content.sub).width);
    }
    content.lines.forEach(function (ln) {
      ctx.font = FONTS.label;
      var lw = ctx.measureText(ln.label + ":  ").width;
      ctx.font = FONTS.value;
      w = Math.max(w, lw + ctx.measureText(String(ln.value)).width);
    });
    var width = Math.min(Math.max(w + BOX_PAD * 2, 320), 640);
    var height = BOX_PAD * 2 + TITLE_H + (content.sub ? SUB_H : 0) + content.lines.length * LINE_H;
    return { w: width, h: height };
  }

  /* ----- Auto-placement ------------------------------------------ */

  function rectsOverlap(a, b, margin) {
    return !(a.x + a.w + margin < b.x || b.x + b.w + margin < a.x ||
             a.y + a.h + margin < b.y || b.y + b.h + margin < a.y);
  }

  function rectCoversPoint(r, px, py, margin) {
    return px > r.x - margin && px < r.x + r.w + margin &&
           py > r.y - margin && py < r.y + r.h + margin;
  }

  function titleCardRect(ctx) {
    ctx.font = "700 44px 'Mencken Std', Georgia, serif";
    var w = ctx.measureText(MARKET.anchor_university || "").width + 56;
    return { x: EDGE, y: H - EDGE - 130, w: w, h: 130 };
  }

  function segmentsCross(a, b, c, d) {
    function ccw(p, q, r) { return (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x); }
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  /* Does the segment a→b pass through rect r? (Leaders render under the
     boxes, so a leader threading beneath another callout disappears.) */
  function segCrossesRect(a, b, r) {
    if (rectCoversPoint(r, a.x, a.y, 0) || rectCoversPoint(r, b.x, b.y, 0)) return true;
    var tl = { x: r.x, y: r.y }, tr = { x: r.x + r.w, y: r.y };
    var bl = { x: r.x, y: r.y + r.h }, br = { x: r.x + r.w, y: r.y + r.h };
    return segmentsCross(a, b, tl, tr) || segmentsCross(a, b, tr, br) ||
           segmentsCross(a, b, br, bl) || segmentsCross(a, b, bl, tl);
  }

  function autoLayout(ctx) {
    var radii = [130, 200, 290, 400, 540];
    var angleOffsets = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
    // The title card (bottom-left) and key (bottom-right) are obstacles
    // callouts must avoid
    var placed = [titleCardRect(ctx)];
    var lr = legendRect(ctx);
    if (lr) placed.push(lr);
    var leaders = [];  // committed leader segments, for crossing checks
    var keepDragged = [];

    state.props.forEach(function (p) {
      var prev = state.placements.get(p.property_key);
      if (prev && !prev.auto) {
        prev.w = p.box.w; prev.h = p.box.h;
        clampRect(prev);
        placed.push(prev);
        leaders.push([rectEdgePoint(prev, p.px.x, p.px.y), p.px]);
        keepDragged.push(p.property_key);
      }
    });

    var next = new Map();
    keepDragged.forEach(function (pk) { next.set(pk, state.placements.get(pk)); });

    // Centroid of the marker cloud: each callout prefers the direction
    // radiating outward from it, so boxes fan out and leaders don't cross.
    var cx0 = 0, cy0 = 0;
    state.props.forEach(function (p) { cx0 += p.px.x; cy0 += p.px.y; });
    cx0 /= state.props.length; cy0 /= state.props.length;

    state.props.slice().sort(function (a, b) { return a.px.y - b.px.y; }).forEach(function (p) {
      if (next.has(p.property_key)) return;
      var radial = Math.atan2(p.px.y - cy0, p.px.x - cx0);
      if (p.px.x === cx0 && p.px.y === cy0) radial = -Math.PI / 2;

      var best = null, bestScore = Infinity;
      for (var ri = 0; ri < radii.length; ri++) {
        for (var ai = 0; ai < angleOffsets.length; ai++) {
          var ang = radial + (angleOffsets[ai] * Math.PI) / 180;
          var r = radii[ri];
          var ccx = p.px.x + Math.cos(ang) * (r + p.box.w / 2);
          var ccy = p.px.y + Math.sin(ang) * (r + p.box.h / 2);
          var cand = { x: ccx - p.box.w / 2, y: ccy - p.box.h / 2, w: p.box.w, h: p.box.h };
          if (cand.x < EDGE || cand.y < EDGE || cand.x + cand.w > W - EDGE || cand.y + cand.h > H - EDGE) continue;
          var bad = placed.some(function (other) { return rectsOverlap(cand, other, 14); })
                 || state.props.some(function (q) { return rectCoversPoint(cand, q.px.x, q.px.y, 24); });
          if (bad) continue;
          // Score: leader crossings and leaders threading under other
          // boxes are heavily penalized, then prefer close-by,
          // near-radial spots so boxes hug their markers.
          var seg = [rectEdgePoint(cand, p.px.x, p.px.y), p.px];
          var crossings = leaders.reduce(function (n, other) {
            // line-line crossing, or this box landing on an earlier leader
            return n + (segmentsCross(seg[0], seg[1], other[0], other[1]) ? 1 : 0)
                     + (segCrossesRect(other[0], other[1], cand) ? 1 : 0);
          }, 0);
          var threading = placed.reduce(function (n, other) {
            return n + (segCrossesRect(seg[0], seg[1], other) ? 1 : 0);
          }, 0);
          var score = (crossings + threading) * 1e6 + r * 2 + Math.abs(angleOffsets[ai]) * 1.5;
          if (score < bestScore) { bestScore = score; best = cand; }
        }
        // A clean nearby spot beats exhaustive search at larger radii
        if (best && bestScore < 1e6) break;
      }
      var rect = best;
      if (!rect) {
        // No collision-free spot near the marker: grid-scan the whole
        // canvas and take the free cell closest to the marker.
        var bestCell = null, bestDist = Infinity;
        for (var gy = EDGE; gy + p.box.h <= H - EDGE; gy += 60) {
          for (var gx = EDGE; gx + p.box.w <= W - EDGE; gx += 60) {
            var cell = { x: gx, y: gy, w: p.box.w, h: p.box.h };
            var blocked = placed.some(function (other) { return rectsOverlap(cell, other, 14); })
                       || state.props.some(function (q) { return rectCoversPoint(cell, q.px.x, q.px.y, 20); });
            if (blocked) continue;
            var ddx = gx + p.box.w / 2 - p.px.x, ddy = gy + p.box.h / 2 - p.px.y;
            var dist = ddx * ddx + ddy * ddy;
            if (dist < bestDist) { bestDist = dist; bestCell = cell; }
          }
        }
        // Truly nowhere left — accept overlap near the marker.
        rect = bestCell || { x: Math.min(Math.max(p.px.x + 40, EDGE), W - EDGE - p.box.w),
                             y: Math.min(Math.max(p.px.y + 40, EDGE), H - EDGE - p.box.h),
                             w: p.box.w, h: p.box.h };
      }
      rect.auto = true;
      placed.push(rect);
      leaders.push([rectEdgePoint(rect, p.px.x, p.px.y), p.px]);
      next.set(p.property_key, rect);
    });

    state.placements = next;
  }

  function clampRect(r) {
    r.x = Math.min(Math.max(r.x, EDGE), W - EDGE - r.w);
    r.y = Math.min(Math.max(r.y, EDGE), H - EDGE - r.h);
  }

  /* ----- Drawing ------------------------------------------------- */

  function drawShape(ctx, shape, x, y, size, color) {
    var h = size / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    switch (shape) {
      case "diamond":
        ctx.moveTo(0, -h); ctx.lineTo(h, 0); ctx.lineTo(0, h); ctx.lineTo(-h, 0);
        break;
      case "square":
        ctx.rect(-h * 0.72, -h * 0.72, h * 1.44, h * 1.44);
        break;
      case "triangle":
        ctx.moveTo(0, -h); ctx.lineTo(h * 0.9, h * 0.75); ctx.lineTo(-h * 0.9, h * 0.75);
        break;
      case "pentagon":
        for (var i = 0; i < 5; i++) {
          var a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
          if (i === 0) ctx.moveTo(Math.cos(a) * h, Math.sin(a) * h);
          else ctx.lineTo(Math.cos(a) * h, Math.sin(a) * h);
        }
        break;
      default:
        ctx.arc(0, 0, h * 0.8, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  /* Point where the segment from the rect center to (px, py) crosses the
     rect border — the leader line starts there. */
  function rectEdgePoint(r, px, py) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var dx = px - cx, dy = py - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var tx = dx !== 0 ? (r.w / 2) / Math.abs(dx) : Infinity;
    var ty = dy !== 0 ? (r.h / 2) / Math.abs(dy) : Infinity;
    var t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function drawCallout(ctx, p, rect) {
    var color = phaseStyle(p.phase).color;
    var content = calloutContent(p);

    ctx.save();
    ctx.shadowColor = "rgba(43, 40, 37, 0.25)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    var x = rect.x + BOX_PAD;
    var y = rect.y + BOX_PAD + 26;  // title baseline
    ctx.fillStyle = color;
    ctx.font = FONTS.title;
    ctx.fillText(content.title, x, y, rect.w - BOX_PAD * 2);
    if (content.sub) {
      y += SUB_H;
      ctx.fillStyle = "#837c75";
      ctx.font = FONTS.sub;
      ctx.fillText(content.sub, x, y, rect.w - BOX_PAD * 2);
    }
    y += 12;
    content.lines.forEach(function (ln) {
      y += LINE_H;
      ctx.font = FONTS.label;
      ctx.fillStyle = "#2b2825";
      var label = ln.label + ":  ";
      ctx.fillText(label, x, y);
      var lw = ctx.measureText(label).width;
      ctx.font = FONTS.value;
      ctx.fillStyle = "#5a544f";
      ctx.fillText(String(ln.value), x + lw, y);
    });
  }

  /* 0.5/1/2-mile rings centered on the anchor campus. Each ring has its
     own color and a light translucent infill; fills draw largest-first so
     the bands stack and deepen toward campus, like the deck maps. */
  var RING_STYLES = [
    { mi: 0.5, color: "#16352e" },   // everest
    { mi: 1,   color: "#a95818" },   // birch
    { mi: 2,   color: "#c79830" },   // gold
  ];

  function drawRings(ctx) {
    var campus = anchorCampus();
    if (!campus) return;
    var c = project(campus.campus_lat, campus.campus_lng);
    var mpp = (156543.03392 * Math.cos((campus.campus_lat * Math.PI) / 180)) /
      Math.pow(2, state.view.z);
    var px = function (mi) { return (mi * 1609.344) / mpp; };

    RING_STYLES.slice().reverse().forEach(function (rs) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, px(rs.mi), 0, Math.PI * 2);
      ctx.fillStyle = rs.color;
      ctx.globalAlpha = 0.07;
      ctx.fill();
      ctx.restore();
    });

    RING_STYLES.forEach(function (rs) {
      var r = px(rs.mi);
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = rs.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.restore();
      var ly = c.y - r;  // label chip at the top of the ring, if in frame
      if (ly > 40 && ly < H - 40) {
        var text = rs.mi + " MI";
        ctx.font = "700 20px 'Pragmatica', sans-serif";
        var tw = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.fillRect(c.x - tw / 2 - 8, ly - 14, tw + 16, 28);
        ctx.fillStyle = rs.color;
        ctx.fillText(text, c.x - tw / 2, ly + 7);
      }
    });
  }

  /* Map key, bottom-right: phase shapes present in the selection, the
     campus boundary, and the distance rings. */
  var LEGEND_ROW = 38, LEGEND_PAD = 22, LEGEND_ICON = 48, LEGEND_TITLE = 34;
  var PHASE_ORDER = ["stable", "lease up", "under construction", "planned"];

  function legendEntries() {
    var entries = [];
    var present = new Set(state.props.map(function (p) { return (p.phase || "").toLowerCase(); }));
    PHASE_ORDER.forEach(function (ph) {
      if (!present.has(ph)) return;
      present.delete(ph);
      var s = phaseStyle(ph);
      entries.push({ type: "shape", shape: s.shape, color: s.color, label: s.label });
    });
    if (present.size > 0) {
      entries.push({ type: "shape", shape: "circle", color: "#b6b1ab", label: "Other phase" });
    }
    if (state.boundary) entries.push({ type: "line", color: "#d32f2f", label: "Campus boundary" });
    if (state.rings && anchorCampus()) {
      RING_STYLES.forEach(function (rs) {
        entries.push({
          type: "ring", color: rs.color,
          label: rs.mi + (rs.mi === 1 ? " mile" : " miles") + " from campus",
        });
      });
    }
    return entries;
  }

  function legendRect(ctx) {
    var entries = legendEntries();
    if (!entries.length) return null;
    ctx.font = "400 22px 'Pragmatica', sans-serif";
    var w = 0;
    entries.forEach(function (e) { w = Math.max(w, ctx.measureText(e.label).width); });
    w = Math.max(w + LEGEND_ICON + LEGEND_PAD * 2, 260);
    var h = LEGEND_PAD * 2 + LEGEND_TITLE + entries.length * LEGEND_ROW;
    return { x: W - EDGE - w, y: H - EDGE - h - 34, w: w, h: h };
  }

  function drawLegend(ctx) {
    var entries = legendEntries();
    var r = legendRect(ctx);
    if (!r) return;
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#16352e";
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#2b2825";
    ctx.font = "700 20px 'Pragmatica', sans-serif";
    ctx.fillText("KEY", r.x + LEGEND_PAD, r.y + LEGEND_PAD + 12);
    var y = r.y + LEGEND_PAD + LEGEND_TITLE;
    entries.forEach(function (e) {
      var iy = y + LEGEND_ROW / 2 - 4;          // icon center
      var ix = r.x + LEGEND_PAD + 16;
      if (e.type === "shape") {
        drawShape(ctx, e.shape, ix, iy, 26, e.color);
      } else if (e.type === "line") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ix - 14, iy);
        ctx.lineTo(ix + 14, iy);
        ctx.stroke();
      } else if (e.type === "ring") {
        ctx.beginPath();
        ctx.arc(ix, iy, 11, 0, Math.PI * 2);
        ctx.save();
        ctx.fillStyle = e.color;
        ctx.globalAlpha = 0.15;
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = "#2b2825";
      ctx.font = "400 22px 'Pragmatica', sans-serif";
      ctx.fillText(e.label, r.x + LEGEND_PAD + LEGEND_ICON, iy + 8);
      y += LEGEND_ROW;
    });
  }

  function drawTitleCard(ctx) {
    var title = MARKET.anchor_university || "";
    var date = MARKET.data_as_of ? new Date(MARKET.data_as_of) : new Date();
    var sub = "Competitive Set · " +
      date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    var r = titleCardRect(ctx);
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#16352e";
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#16352e";
    ctx.font = "700 44px 'Mencken Std', Georgia, serif";
    ctx.fillText(title, r.x + 28, r.y + 58);
    ctx.font = "600 22px 'Pragmatica', sans-serif";
    ctx.fillStyle = "#5a544f";
    ctx.fillText(sub.toUpperCase(), r.x + 28, r.y + 98);
  }

  function drawAttribution(ctx) {
    var text = TILE_SOURCES[state.basemap].attribution;
    ctx.font = "400 18px 'Pragmatica', sans-serif";
    var w = ctx.measureText(text).width + 20;
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(W - w, H - 32, w, 32);
    ctx.fillStyle = "#5a544f";
    ctx.fillText(text, W - w + 10, H - 10);
  }

  function draw() {
    var canvas = document.getElementById("comp-map-canvas");
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");

    if (state.props.length === 0) {
      ctx.fillStyle = "#f7f1e3";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#837c75";
      ctx.font = "400 36px 'Pragmatica', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No comps selected — tick a checkbox in the table above.", W / 2, H / 2);
      ctx.textAlign = "left";
      return;
    }
    if (!state.base) return;  // tiles still loading; draw() re-runs when done

    ctx.drawImage(state.base, 0, 0);

    if (state.rings) drawRings(ctx);

    // Leader lines under everything else. Each gets a white casing under
    // the colored stroke so it stays legible on satellite imagery.
    state.props.forEach(function (p) {
      var rect = state.placements.get(p.property_key);
      if (!rect) return;
      var color = phaseStyle(p.phase).color;
      var from = rectEdgePoint(rect, p.px.x, p.px.y);
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(p.px.x, p.px.y);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.stroke();
      // Open ring around the marker, like the deck maps — white casing too
      ctx.beginPath();
      ctx.arc(p.px.x, p.px.y, 21, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4.5;
      ctx.stroke();
    });

    state.props.forEach(function (p) {
      drawShape(ctx, phaseStyle(p.phase).shape, p.px.x, p.px.y, 30, phaseStyle(p.phase).color);
    });

    state.props.forEach(function (p) {
      var rect = state.placements.get(p.property_key);
      if (rect) drawCallout(ctx, p, rect);
    });

    drawTitleCard(ctx);
    drawLegend(ctx);
    drawAttribution(ctx);
  }

  /* ----- Refresh pipeline ---------------------------------------- */

  function refresh() {
    var canvas = document.getElementById("comp-map-canvas");
    if (!canvas || typeof PROPERTIES === "undefined" || !MARKET) return;

    var selected = PROPERTIES.filter(function (p) {
      return compSelection.has(p.property_key) &&
             p.latitude != null && p.longitude != null;
    });
    var skipped = PROPERTIES.filter(function (p) {
      return compSelection.has(p.property_key) &&
             (p.latitude == null || p.longitude == null);
    }).length;

    var summary = document.getElementById("comp-map-summary");
    if (summary) {
      summary.textContent = selected.length === 0
        ? "No comps selected. Tick checkboxes in the table above to populate the map."
        : selected.length + " comp" + (selected.length === 1 ? "" : "s") + " mapped" +
          (skipped ? " · " + skipped + " missing coordinates" : "") +
          " · drag a callout to reposition it";
    }

    state.props = selected;
    if (selected.length === 0) { state.base = null; draw(); return; }

    var latLngs = selected.map(function (p) { return [p.latitude, p.longitude]; });
    // Include boundary extent in the fit so the campus is always in frame
    var afterBoundary = fetchBoundary().then(function (gj) {
      if (gj) boundaryRings(gj).forEach(function (ring) {
        ring.forEach(function (c) { latLngs.push([c[1], c[0]]); });
      });

      // With rings on, keep at least the 1-mile ring in frame
      if (state.rings) {
        var campus = anchorCampus();
        if (campus) {
          var dLat = 1 / 69.05;
          var dLng = 1 / (69.17 * Math.cos((campus.campus_lat * Math.PI) / 180));
          latLngs.push([campus.campus_lat + dLat, campus.campus_lng + dLng]);
          latLngs.push([campus.campus_lat - dLat, campus.campus_lng - dLng]);
        }
      }

      state.view = computeView(latLngs);
      selected.forEach(function (p) { p.px = project(p.latitude, p.longitude); });

      var ctx = canvas.getContext("2d");
      selected.forEach(function (p) { p.box = measureCallout(ctx, calloutContent(p)); });
      autoLayout(ctx);

      var sig = state.basemap + "|" + state.view.z + "|" +
        Math.round(state.view.originX) + "|" + Math.round(state.view.originY);
      if (sig !== state.baseSig) {
        state.base = null;
        state.baseSig = sig;
        var token = ++state.renderToken;
        draw();  // empty-frame placeholder while tiles load
        return buildBase().then(function () {
          if (token === state.renderToken) draw();
        });
      }
      draw();
    });
    return afterBoundary;
  }

  /* ----- Dragging ------------------------------------------------ */

  function canvasPoint(canvas, evt) {
    var r = canvas.getBoundingClientRect();
    return {
      x: ((evt.clientX - r.left) / r.width) * W,
      y: ((evt.clientY - r.top) / r.height) * H,
    };
  }

  function bindDrag(canvas) {
    canvas.addEventListener("pointerdown", function (e) {
      var pt = canvasPoint(canvas, e);
      // Hit-test in reverse draw order so the topmost box wins
      var keys = state.props.map(function (p) { return p.property_key; }).reverse();
      for (var i = 0; i < keys.length; i++) {
        var rect = state.placements.get(keys[i]);
        if (rect && rectCoversPoint(rect, pt.x, pt.y, 0)) {
          state.drag = { pk: keys[i], dx: pt.x - rect.x, dy: pt.y - rect.y };
          canvas.classList.add("dragging");
          canvas.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!state.drag) return;
      var pt = canvasPoint(canvas, e);
      var rect = state.placements.get(state.drag.pk);
      if (!rect) return;
      rect.x = pt.x - state.drag.dx;
      rect.y = pt.y - state.drag.dy;
      rect.auto = false;
      clampRect(rect);
      draw();
    });
    function endDrag(e) {
      if (!state.drag) return;
      state.drag = null;
      canvas.classList.remove("dragging");
      if (e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  /* ----- Download + controls ------------------------------------- */

  function slug(text) {
    return String(text || "market").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function download() {
    var canvas = document.getElementById("comp-map-canvas");
    if (!canvas || state.props.length === 0) return;
    var d = new Date();
    var stamp = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    var link = document.createElement("a");
    link.download = slug(MARKET.anchor_university) + "-comp-map-" + stamp + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  function init() {
    var canvas = document.getElementById("comp-map-canvas");
    if (!canvas) return;
    bindDrag(canvas);

    var basemapSel = document.getElementById("comp-map-basemap");
    if (basemapSel) {
      basemapSel.addEventListener("change", function () {
        state.basemap = basemapSel.value;
        state.baseSig = null;
        refresh();
      });
    }
    var statsCb = document.getElementById("comp-map-stats");
    if (statsCb) {
      statsCb.addEventListener("change", function () {
        state.compact = !statsCb.checked;
        refresh();
      });
    }
    var ringsCb = document.getElementById("comp-map-rings");
    if (ringsCb) {
      ringsCb.addEventListener("change", function () {
        state.rings = ringsCb.checked;
        state.baseSig = null;  // ring extent affects the fit → new view
        refresh();
      });
    }
    var resetBtn = document.getElementById("comp-map-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        state.placements = new Map();
        refresh();
      });
    }
    var dlBtn = document.getElementById("comp-map-download");
    if (dlBtn) dlBtn.addEventListener("click", download);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CompMap = { refresh: refresh };
})();
