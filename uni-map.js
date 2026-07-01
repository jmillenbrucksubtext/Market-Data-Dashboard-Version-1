/* =============================================================
   Campus Map Generator - University Information tab of market.html.
   Sibling of comp-map.js: a static deck-style canvas (basemap tiles +
   campus boundary) with the best-known campus POIs as draggable name
   call-outs and Greek life / nightlife venue clusters as shaded
   district outlines. Downloadable as a print-crisp PNG.

   Loads after market.js and reads its data layer: fetchCampusPois(),
   pickTopPois(), buildPoiZones(), setUniMapStatus(), MARKET.
   market.js calls window.UniMap.show(school) when the University tab
   opens or the selected school changes.
   ============================================================= */
(function () {
  "use strict";

  var W = 2800, H = 2000;
  // PowerPoint export: a true 16:9 frame (13.333x7.5in slide at ~240 DPI),
  // full-bleed border-to-border. The map is re-rendered at these dimensions
  // off-screen so the auto-layout, title card and legend refit the wider
  // frame rather than being cropped.
  var PPTX_W = 3200, PPTX_H = 1800;
  var exportCanvas = null;  // when set, draw()/refresh() target this instead of the on-screen canvas
  // Branded slide frame drawn ONLY on the PowerPoint export: an everest header
  // band (title + SubHouse wordmark) and footer band (source + attribution),
  // so the downloaded 16:9 PNG reads as a finished slide, not a bare map.
  var FRAME = { header: 156, footer: 84, accent: 8 };
  var TILE = 256;
  var FIT_PAD_X = 420, FIT_PAD_Y = 300;
  var EDGE = 24;
  var CANDIDATES_PER_CAT = 15;   // picker depth per call-out category

  function mapCanvas() { return exportCanvas || document.getElementById("uni-map-canvas"); }

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

  /* callout cats get named boxes; icon cats get themed location badges
     (no names) - a Greek temple for Greek life, a martini glass for
     nightlife, a bed for residence halls. Venues whose badges would
     overlap merge into one badge with a count chip. */
  var CATS = [
    { key: "academic",  label: "Academic buildings",    color: "#16352e", mode: "callout", cap: 8 },
    { key: "landmark",  label: "Monuments + landmarks", color: "#a95818", mode: "callout", cap: 5 },
    { key: "athletics", label: "Athletics",             color: "#8c1d18", mode: "callout", cap: 5 },
    { key: "residence", label: "Residence halls",       color: "#38618c", mode: "icon", glyph: "bed" },
    { key: "greek",     label: "Greek life",            color: "#6d4aa0", mode: "icon", glyph: "temple" },
    { key: "nightlife", label: "Nightlife",             color: "#c79830", mode: "icon", glyph: "martini" },
  ];
  function catOf(key) { return CATS.find(function (c) { return c.key === key; }); }

  var state = {
    school: null,
    candidates: new Map(),  // cat key -> ranked candidate pois (each with .id)
    selected: new Set(),    // poi ids currently shown as call-outs
    venues: new Map(),      // icon cat key -> venue pois
    hiddenCats: new Set(),
    basemap: "satellite",
    zoomDelta: 0,
    center: null,
    panDrag: null,
    view: null,
    base: null,
    baseSig: null,
    boundary: undefined,
    placements: new Map(),  // poi id -> {x, y, w, h, auto}
    drag: null,
    renderToken: 0,
    loadToken: 0,
  };

  function poiId(p) { return p.cat + "|" + p.name + "|" + p.lat.toFixed(5); }

  /* visible call-out pois, with px/box stamped by refresh() */
  function activeCallouts() {
    var out = [];
    CATS.forEach(function (cat) {
      if (cat.mode !== "callout" || state.hiddenCats.has(cat.key)) return;
      (state.candidates.get(cat.key) || []).forEach(function (p) {
        if (state.selected.has(p.id)) out.push(p);
      });
    });
    return out;
  }

  function activeVenueCats() {
    var out = [];
    CATS.forEach(function (cat) {
      if (cat.mode !== "icon" || state.hiddenCats.has(cat.key)) return;
      var venues = state.venues.get(cat.key) || [];
      if (venues.length) out.push({ cat: cat, venues: venues });
    });
    return out;
  }

  /* ----- Web Mercator (same math as comp-map.js) ----------------- */

  function worldX(lng, z) { return ((lng + 180) / 360) * TILE * Math.pow(2, z); }
  function worldY(lat, z) {
    var s = Math.sin((lat * Math.PI) / 180);
    s = Math.min(Math.max(s, -0.9999), 0.9999);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
  }
  function unprojectLng(x, z) { return (x / (TILE * Math.pow(2, z))) * 360 - 180; }
  function unprojectLat(y, z) {
    var n = Math.PI - (2 * Math.PI * y) / (TILE * Math.pow(2, z));
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
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
    var maxZ = TILE_SOURCES[state.basemap].maxZoom;
    z = Math.min(Math.max(z + state.zoomDelta, 3), maxZ);
    var cx, cy;
    if (state.center) {
      cx = worldX(state.center.lng, z);
      cy = worldY(state.center.lat, z);
    } else {
      cx = (worldX(lngW, z) + worldX(lngE, z)) / 2;
      cy = (worldY(latN, z) + worldY(latS, z)) / 2;
    }
    return { z: z, originX: cx - W / 2, originY: cy - H / 2 };
  }

  function project(lat, lng) {
    return {
      x: worldX(lng, state.view.z) - state.view.originX,
      y: worldY(lat, state.view.z) - state.view.originY,
    };
  }

  /* ----- Base layer: tiles + campus boundary --------------------- */

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
        ctx.fillStyle = "rgba(211, 47, 47, 0.12)";
        ctx.fill();
        ctx.strokeStyle = "#d32f2f";
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }
      state.base = canvas;
    });
  }

  /* ----- Call-out boxes ------------------------------------------ */

  var FONTS = {
    name: "700 28px 'Pragmatica', sans-serif",
    cat: "600 18px 'Pragmatica', sans-serif",
  };
  var BOX_PAD = 18;

  function measureCallout(ctx, p) {
    ctx.font = FONTS.name;
    var w = ctx.measureText(p.name).width;
    return { w: Math.min(Math.max(w + BOX_PAD * 2, 160), 560), h: BOX_PAD * 2 + 30 };
  }

  /* ----- Auto-placement (comp-map algorithm on poi ids) ----------- */

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
    var w = ctx.measureText(state.school ? state.school.university_name : "").width + 56;
    return { x: EDGE, y: H - EDGE - 130, w: w, h: 130 };
  }

  function segmentsCross(a, b, c, d) {
    function ccw(p, q, r) { return (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x); }
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function segCrossesRect(a, b, r) {
    if (rectCoversPoint(r, a.x, a.y, 0) || rectCoversPoint(r, b.x, b.y, 0)) return true;
    var tl = { x: r.x, y: r.y }, tr = { x: r.x + r.w, y: r.y };
    var bl = { x: r.x, y: r.y + r.h }, br = { x: r.x + r.w, y: r.y + r.h };
    return segmentsCross(a, b, tl, tr) || segmentsCross(a, b, tr, br) ||
           segmentsCross(a, b, br, bl) || segmentsCross(a, b, bl, tl);
  }

  function clampRect(r) {
    r.x = Math.min(Math.max(r.x, EDGE), W - EDGE - r.w);
    r.y = Math.min(Math.max(r.y, EDGE), H - EDGE - r.h);
  }

  function rectEdgePoint(r, px, py) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var dx = px - cx, dy = py - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var tx = dx !== 0 ? (r.w / 2) / Math.abs(dx) : Infinity;
    var ty = dy !== 0 ? (r.h / 2) / Math.abs(dy) : Infinity;
    var t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function autoLayout(ctx, items) {
    var radii = [110, 170, 250, 350, 480];
    var angleOffsets = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
    // On the export the title card is gone (its title moves into the header
    // band), so the header + footer bands are the callout obstacles instead.
    var placed;
    if (exportCanvas) {
      placed = [
        { x: 0, y: 0, w: W, h: FRAME.header + FRAME.accent + 12 },
        { x: 0, y: H - FRAME.footer - FRAME.accent - 12, w: W, h: FRAME.footer + FRAME.accent + 12 },
      ];
    } else {
      placed = [titleCardRect(ctx)];
    }
    var lr = legendRect(ctx);
    if (lr) placed.push(lr);
    var leaders = [];
    var keepDragged = [];

    items.forEach(function (p) {
      var prev = state.placements.get(p.id);
      if (prev && !prev.auto) {
        prev.w = p.box.w; prev.h = p.box.h;
        clampRect(prev);
        placed.push(prev);
        leaders.push([rectEdgePoint(prev, p.px.x, p.px.y), p.px]);
        keepDragged.push(p.id);
      }
    });

    var next = new Map();
    keepDragged.forEach(function (id) { next.set(id, state.placements.get(id)); });

    var cx0 = 0, cy0 = 0;
    items.forEach(function (p) { cx0 += p.px.x; cy0 += p.px.y; });
    cx0 /= items.length; cy0 /= items.length;

    items.slice().sort(function (a, b) { return a.px.y - b.px.y; }).forEach(function (p) {
      if (next.has(p.id)) return;
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
          var bad = placed.some(function (other) { return rectsOverlap(cand, other, 12); })
                 || items.some(function (q) { return rectCoversPoint(cand, q.px.x, q.px.y, 20); });
          if (bad) continue;
          var seg = [rectEdgePoint(cand, p.px.x, p.px.y), p.px];
          var crossings = leaders.reduce(function (n, other) {
            return n + (segmentsCross(seg[0], seg[1], other[0], other[1]) ? 1 : 0)
                     + (segCrossesRect(other[0], other[1], cand) ? 1 : 0);
          }, 0);
          var threading = placed.reduce(function (n, other) {
            return n + (segCrossesRect(seg[0], seg[1], other) ? 1 : 0);
          }, 0);
          var score = (crossings + threading) * 1e6 + r * 2 + Math.abs(angleOffsets[ai]) * 1.5;
          if (score < bestScore) { bestScore = score; best = cand; }
        }
        if (best && bestScore < 1e6) break;
      }
      var rect = best;
      if (!rect) {
        var bestCell = null, bestDist = Infinity;
        for (var gy = EDGE; gy + p.box.h <= H - EDGE; gy += 60) {
          for (var gx = EDGE; gx + p.box.w <= W - EDGE; gx += 60) {
            var cell = { x: gx, y: gy, w: p.box.w, h: p.box.h };
            var blocked = placed.some(function (other) { return rectsOverlap(cell, other, 12); })
                       || items.some(function (q) { return rectCoversPoint(cell, q.px.x, q.px.y, 18); });
            if (blocked) continue;
            var ddx = gx + p.box.w / 2 - p.px.x, ddy = gy + p.box.h / 2 - p.px.y;
            var dist = ddx * ddx + ddy * ddy;
            if (dist < bestDist) { bestDist = dist; bestCell = cell; }
          }
        }
        rect = bestCell || { x: Math.min(Math.max(p.px.x + 36, EDGE), W - EDGE - p.box.w),
                             y: Math.min(Math.max(p.px.y + 36, EDGE), H - EDGE - p.box.h),
                             w: p.box.w, h: p.box.h };
      }
      rect.auto = true;
      placed.push(rect);
      leaders.push([rectEdgePoint(rect, p.px.x, p.px.y), p.px]);
      next.set(p.id, rect);
    });

    state.placements = next;
  }

  /* ----- Drawing -------------------------------------------------- */

  /* ----- venue icon badges (Greek life / nightlife / res halls) --- */

  var BADGE_R = 21;         // badge circle radius
  var BADGE_MERGE_PX = 46;  // badges closer than this merge into one

  function drawGlyph(ctx, glyph, x, y, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    if (glyph === "temple") {
      // pediment
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(12, -5);
      ctx.lineTo(-12, -5);
      ctx.closePath();
      ctx.fill();
      // columns
      ctx.lineWidth = 3;
      [-8, 0, 8].forEach(function (cx) {
        ctx.beginPath();
        ctx.moveTo(cx, -2);
        ctx.lineTo(cx, 8);
        ctx.stroke();
      });
      // base
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(-11, 11);
      ctx.lineTo(11, 11);
      ctx.stroke();
    } else if (glyph === "martini") {
      // bowl
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(10, -10);
      ctx.lineTo(0, 1);
      ctx.closePath();
      ctx.fill();
      // stem + foot
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 1);
      ctx.lineTo(0, 9);
      ctx.stroke();
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(-7, 11);
      ctx.lineTo(7, 11);
      ctx.stroke();
      // garnish
      ctx.beginPath();
      ctx.arc(6, -13, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (glyph === "bed") {
      // headboard
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(-11, -9);
      ctx.lineTo(-11, 8);
      ctx.stroke();
      // mattress
      ctx.beginPath();
      ctx.moveTo(-11, 2);
      ctx.lineTo(8, 2);
      ctx.quadraticCurveTo(11, 2, 11, 5);
      ctx.lineTo(11, 8);
      ctx.lineTo(-11, 8);
      ctx.closePath();
      ctx.fill();
      // pillow
      ctx.beginPath();
      ctx.arc(-6, -1, 3.5, 0, Math.PI * 2);
      ctx.fill();
      // foot leg
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(11, 8);
      ctx.lineTo(11, 11);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBadge(ctx, x, y, cat, count) {
    ctx.save();
    ctx.shadowColor = "rgba(43, 40, 37, 0.35)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.arc(x, y, BADGE_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, BADGE_R, 0, Math.PI * 2);
    ctx.strokeStyle = cat.color;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    drawGlyph(ctx, cat.glyph, x, y, cat.color);
    if (count > 1) {
      var chipR = 12;
      var cx = x + BADGE_R - 4, cy = y - BADGE_R + 4;
      ctx.beginPath();
      ctx.arc(cx, cy, chipR, 0, Math.PI * 2);
      ctx.fillStyle = cat.color;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 16px 'Pragmatica', sans-serif";
      var t = count > 99 ? "99+" : String(count);
      ctx.fillText(t, cx - ctx.measureText(t).width / 2, cy + 6);
    }
  }

  function drawVenueIcons(ctx) {
    activeVenueCats().forEach(function (vc) {
      // merge venues whose badges would overlap; the badge sits at the
      // mean position of its merged venues so a strip reads as one spot
      var groups = [];
      vc.venues.forEach(function (v) {
        var p = project(v.lat, v.lng);
        if (p.x < -BADGE_R || p.x > W + BADGE_R || p.y < -BADGE_R || p.y > H + BADGE_R) return;
        var hit = groups.find(function (g) {
          return Math.hypot(g.x / g.n - p.x, g.y / g.n - p.y) < BADGE_MERGE_PX;
        });
        if (hit) { hit.x += p.x; hit.y += p.y; hit.n += 1; }
        else groups.push({ x: p.x, y: p.y, n: 1 });
      });
      groups.forEach(function (g) {
        drawBadge(ctx, g.x / g.n, g.y / g.n, vc.cat, g.n);
      });
    });
  }

  function drawCallout(ctx, p, rect) {
    var color = catOf(p.cat).color;
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
    ctx.fillStyle = "#2b2825";
    ctx.font = FONTS.name;
    ctx.fillText(p.name, rect.x + BOX_PAD, rect.y + rect.h / 2 + 10, rect.w - BOX_PAD * 2);
  }

  function legendEntries() {
    var entries = [];
    CATS.forEach(function (cat) {
      if (state.hiddenCats.has(cat.key)) return;
      if (cat.mode === "callout") {
        var n = (state.candidates.get(cat.key) || []).filter(function (p) {
          return state.selected.has(p.id);
        }).length;
        if (n) entries.push({ type: "dot", color: cat.color, label: cat.label });
      } else if ((state.venues.get(cat.key) || []).length) {
        entries.push({ type: "badge", color: cat.color, glyph: cat.glyph, cat: cat, label: cat.label });
      }
    });
    if (state.boundary) entries.push({ type: "line", color: "#d32f2f", label: "Campus boundary" });
    return entries;
  }

  var LEGEND_ROW = 38, LEGEND_PAD = 22, LEGEND_ICON = 48, LEGEND_TITLE = 34;

  function legendRect(ctx) {
    var entries = legendEntries();
    if (!entries.length) return null;
    ctx.font = "400 22px 'Pragmatica', sans-serif";
    var w = 0;
    entries.forEach(function (e) { w = Math.max(w, ctx.measureText(e.label).width); });
    w = Math.max(w + LEGEND_ICON + LEGEND_PAD * 2, 260);
    var h = LEGEND_PAD * 2 + LEGEND_TITLE + entries.length * LEGEND_ROW;
    // On the export, lift the legend clear of the footer band.
    var bottomGap = EDGE + 34 + (exportCanvas ? FRAME.footer + FRAME.accent : 0);
    return { x: W - EDGE - w, y: H - bottomGap - h, w: w, h: h };
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
      var iy = y + LEGEND_ROW / 2 - 4;
      var ix = r.x + LEGEND_PAD + 16;
      if (e.type === "dot") {
        ctx.beginPath();
        ctx.arc(ix, iy, 11, 0, Math.PI * 2);
        ctx.fillStyle = e.color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (e.type === "badge") {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ix, iy, 14, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.translate(ix, iy);
        ctx.scale(0.62, 0.62);
        drawGlyph(ctx, e.glyph, 0, 0, e.color);
        ctx.restore();
      } else {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ix - 14, iy);
        ctx.lineTo(ix + 14, iy);
        ctx.stroke();
      }
      ctx.fillStyle = "#2b2825";
      ctx.font = "400 22px 'Pragmatica', sans-serif";
      ctx.fillText(e.label, r.x + LEGEND_PAD + LEGEND_ICON, iy + 8);
      y += LEGEND_ROW;
    });
  }

  function drawTitleCard(ctx) {
    if (!state.school) return;
    var title = state.school.university_name;
    var date = MARKET.data_as_of ? new Date(MARKET.data_as_of) : new Date();
    var sub = "Campus Map · " +
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
    var text = TILE_SOURCES[state.basemap].attribution + " · POIs © OpenStreetMap";
    ctx.font = "400 18px 'Pragmatica', sans-serif";
    var w = ctx.measureText(text).width + 20;
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(W - w, H - 32, w, 32);
    ctx.fillStyle = "#5a544f";
    ctx.fillText(text, W - w + 10, H - 10);
  }

  /* Branded slide frame - export only. An everest header band carries the
     campus title (left) and the SubHouse wordmark (right); an everest footer
     band carries the source line and the required tile/POI attribution. A lime
     hairline separates each band from the map. Replaces the in-map title card
     on the export. */
  function drawSlideFrame(ctx) {
    var EV = "#16352e", LIME = "#c1d100", BEIGE = "#f7f1e3";
    var date = MARKET.data_as_of ? new Date(MARKET.data_as_of) : new Date();
    var stamp = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    // Header band + lime accent.
    ctx.fillStyle = EV;
    ctx.fillRect(0, 0, W, FRAME.header);
    ctx.fillStyle = LIME;
    ctx.fillRect(0, FRAME.header, W, FRAME.accent);

    ctx.textBaseline = "middle";
    // SubHouse wordmark (right), measured first so the title can avoid it.
    ctx.textAlign = "right";
    var rx = W - EDGE - 24;
    ctx.font = "700 20px 'Pragmatica', sans-serif";
    ctx.fillStyle = LIME;
    ctx.fillText("MARKET ANALYSIS", rx, FRAME.header / 2 - 30);
    ctx.font = "700 46px 'Mencken Std', Georgia, serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("SubHouse", rx, FRAME.header / 2 + 20);
    var wmW = ctx.measureText("SubHouse").width;
    ctx.fillStyle = LIME;
    ctx.fillRect(rx - wmW, FRAME.header / 2 + 44, wmW, 4);

    // Title (left), clamped so it never runs into the wordmark block.
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 52px 'Mencken Std', Georgia, serif";
    var title = (state.school ? state.school.university_name : "") + " - Campus Map";
    ctx.fillText(title, EDGE + 24, FRAME.header / 2, W - EDGE * 2 - wmW - 120);

    // Footer band + lime accent.
    var fy = H - FRAME.footer;
    ctx.fillStyle = LIME;
    ctx.fillRect(0, fy - FRAME.accent, W, FRAME.accent);
    ctx.fillStyle = EV;
    ctx.fillRect(0, fy, W, FRAME.footer);
    ctx.textAlign = "left";
    ctx.font = "600 24px 'Pragmatica', sans-serif";
    ctx.fillStyle = BEIGE;
    ctx.fillText("Source: SubHouse Market Analysis  ·  " + stamp, EDGE + 24, fy + FRAME.footer / 2);
    ctx.textAlign = "right";
    ctx.font = "400 18px 'Pragmatica', sans-serif";
    ctx.fillStyle = "rgba(247, 241, 227, 0.7)";
    ctx.fillText(TILE_SOURCES[state.basemap].attribution + " · POIs © OpenStreetMap", W - EDGE - 24, fy + FRAME.footer / 2);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  function draw() {
    var canvas = mapCanvas();
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");

    if (!state.school) {
      ctx.fillStyle = "#f7f1e3";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#837c75";
      ctx.font = "400 36px 'Pragmatica', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No campus on file for this market.", W / 2, H / 2);
      ctx.textAlign = "left";
      return;
    }
    if (!state.base) return;  // tiles still loading; draw() re-runs when done

    var pd = state.panDrag;
    if (pd) {
      ctx.fillStyle = "#f7f1e3";
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(pd.dx, pd.dy);
    }

    ctx.drawImage(state.base, 0, 0);
    drawVenueIcons(ctx);

    var items = activeCallouts();

    // leader lines + dots under the boxes; white casing for legibility
    items.forEach(function (p) {
      var rect = state.placements.get(p.id);
      if (!rect) return;
      var color = catOf(p.cat).color;
      var from = rectEdgePoint(rect, p.px.x, p.px.y);
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(p.px.x, p.px.y);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4.5;
      ctx.stroke();
    });
    items.forEach(function (p) {
      var color = catOf(p.cat).color;
      ctx.beginPath();
      ctx.arc(p.px.x, p.px.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.stroke();
    });
    items.forEach(function (p) {
      var rect = state.placements.get(p.id);
      if (rect) drawCallout(ctx, p, rect);
    });

    if (pd) ctx.restore();

    // On the export, the branded frame carries the title + attribution; on the
    // interactive canvas, keep the in-map title card and corner attribution.
    if (exportCanvas) {
      drawSlideFrame(ctx);
      drawLegend(ctx);
    } else {
      drawTitleCard(ctx);
      drawLegend(ctx);
      drawAttribution(ctx);
    }
  }

  /* ----- Refresh pipeline ----------------------------------------- */

  function refresh() {
    var canvas = mapCanvas();
    if (!canvas || !state.school) { draw(); return; }

    var items = activeCallouts();
    var latLngs = [[state.school.lat, state.school.lng]];
    items.forEach(function (p) { latLngs.push([p.lat, p.lng]); });
    var venueCount = 0;
    activeVenueCats().forEach(function (vc) {
      venueCount += vc.venues.length;
      vc.venues.forEach(function (v) { latLngs.push([v.lat, v.lng]); });
    });

    setUniMapStatus(
      items.length + " call-outs · " + venueCount + " venue icon" + (venueCount === 1 ? "" : "s") +
      " · drag a callout to reposition · drag the map to pan",
    );

    return fetchBoundary().then(function (gj) {
      if (gj) boundaryRings(gj).forEach(function (ring) {
        ring.forEach(function (c) { latLngs.push([c[1], c[0]]); });
      });

      state.view = computeView(latLngs);
      items.forEach(function (p) { p.px = project(p.lat, p.lng); });

      var ctx = canvas.getContext("2d");
      items.forEach(function (p) { p.box = measureCallout(ctx, p); });
      autoLayout(ctx, items);

      var sig = state.basemap + "|" + state.view.z + "|" +
        Math.round(state.view.originX) + "|" + Math.round(state.view.originY);
      if (sig !== state.baseSig) {
        state.base = null;
        state.baseSig = sig;
        var token = ++state.renderToken;
        draw();
        return buildBase().then(function () {
          if (token === state.renderToken) draw();
        });
      }
      draw();
    });
  }

  /* ----- School load / selection UI -------------------------------- */

  function show(school) {
    state.school = school;
    state.candidates = new Map();
    state.selected = new Set();
    state.venues = new Map();
    state.placements = new Map();
    state.center = null;
    state.zoomDelta = 0;
    state.baseSig = null;

    if (!school) { renderToggles(); renderPicker(); draw(); return; }

    setUniMapStatus("Loading campus points of interest ...");
    var token = ++state.loadToken;
    fetchCampusPois(school).then(function (pois) {
      if (token !== state.loadToken) return;  // user switched schools mid-fetch
      var byCat = {};
      pois.forEach(function (p) {
        // Dorms ride in the assets as academic (sub building=dormitory);
        // split them into their own Residence-halls icon category.
        var cat = p.cat === "academic" && p.sub === "dormitory" ? "residence" : p.cat;
        (byCat[cat] = byCat[cat] || []).push(p);
      });

      CATS.forEach(function (cat) {
        if (cat.mode === "callout") {
          var ranked = pickTopPois(byCat[cat.key] || [], CANDIDATES_PER_CAT, school);
          ranked.forEach(function (p) { p.id = poiId(p); });
          state.candidates.set(cat.key, ranked);
          ranked.slice(0, cat.cap).forEach(function (p) { state.selected.add(p.id); });
        } else {
          state.venues.set(cat.key, byCat[cat.key] || []);
        }
      });

      renderToggles();
      renderPicker();
      refresh();
    }).catch(function (err) {
      if (token !== state.loadToken) return;
      setUniMapStatus("Couldn't load campus POIs (" + (err.message || err) + "). Re-open the tab to retry.");
    });
  }

  function renderToggles() {
    var wrap = document.getElementById("uni-map-toggles");
    if (!wrap) return;
    if (!state.school) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = CATS.map(function (cat) {
      var count;
      if (cat.mode === "callout") {
        count = (state.candidates.get(cat.key) || []).filter(function (p) {
          return state.selected.has(p.id);
        }).length;
      } else {
        count = (state.venues.get(cat.key) || []).length;
      }
      return '<label class="uni-poi-toggle">' +
        '<input type="checkbox" data-cat="' + cat.key + '"' + (state.hiddenCats.has(cat.key) ? "" : " checked") + ">" +
        '<span class="uni-poi-dot" style="background:' + cat.color + '"></span>' +
        cat.label + ' <span class="uni-poi-count">' + count + "</span></label>";
    }).join("");
    wrap.querySelectorAll("input[data-cat]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) state.hiddenCats.delete(cb.dataset.cat);
        else state.hiddenCats.add(cb.dataset.cat);
        refresh();
      });
    });
  }

  /* Checkbox list of every candidate call-out, grouped by category, so
     individual call-outs can be removed or added beyond the defaults. */
  function renderPicker() {
    var panel = document.getElementById("uni-picker-panel");
    if (!panel) return;
    if (!state.school) { panel.innerHTML = ""; return; }
    panel.innerHTML = CATS.filter(function (c) { return c.mode === "callout"; }).map(function (cat) {
      var rows = (state.candidates.get(cat.key) || []).map(function (p) {
        return '<label class="uni-picker-item">' +
          '<input type="checkbox" data-poi="' + escapeHtml(p.id) + '"' +
          (state.selected.has(p.id) ? " checked" : "") + ">" +
          '<span>' + escapeHtml(p.name) + "</span></label>";
      }).join("");
      return '<div class="uni-picker-group">' +
        '<div class="uni-picker-group-title" style="--cat-color:' + cat.color + '">' + cat.label + "</div>" +
        (rows || '<div class="uni-picker-empty">None found near campus</div>') +
        "</div>";
    }).join("");
    panel.querySelectorAll("input[data-poi]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) state.selected.add(cb.dataset.poi);
        else {
          state.selected.delete(cb.dataset.poi);
          state.placements.delete(cb.dataset.poi);
        }
        renderToggles();
        refresh();
      });
    });
  }

  /* ----- Dragging (same scheme as comp-map.js) --------------------- */

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
      var ids = activeCallouts().map(function (p) { return p.id; }).reverse();
      for (var i = 0; i < ids.length; i++) {
        var rect = state.placements.get(ids[i]);
        if (rect && rectCoversPoint(rect, pt.x, pt.y, 0)) {
          state.drag = { id: ids[i], dx: pt.x - rect.x, dy: pt.y - rect.y };
          canvas.classList.add("dragging");
          canvas.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      if (!state.base || !state.school) return;
      state.panDrag = { sx: pt.x, sy: pt.y, dx: 0, dy: 0 };
      canvas.classList.add("dragging");
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (state.panDrag) {
        var pp = canvasPoint(canvas, e);
        state.panDrag.dx = pp.x - state.panDrag.sx;
        state.panDrag.dy = pp.y - state.panDrag.sy;
        draw();
        return;
      }
      if (!state.drag) return;
      var pt = canvasPoint(canvas, e);
      var rect = state.placements.get(state.drag.id);
      if (!rect) return;
      rect.x = pt.x - state.drag.dx;
      rect.y = pt.y - state.drag.dy;
      rect.auto = false;
      clampRect(rect);
      draw();
    });
    function endDrag(e) {
      if (state.panDrag) {
        var pd = state.panDrag;
        state.panDrag = null;
        canvas.classList.remove("dragging");
        if (e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        if (pd.dx || pd.dy) {
          var z = state.view.z;
          state.center = {
            lat: unprojectLat(state.view.originY + H / 2 - pd.dy, z),
            lng: unprojectLng(state.view.originX + W / 2 - pd.dx, z),
          };
          state.placements.forEach(function (r) {
            r.x += pd.dx; r.y += pd.dy;
            clampRect(r);
          });
          refresh();
        } else {
          draw();
        }
        return;
      }
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

  /* ----- Download + controls --------------------------------------- */

  function slug(text) {
    return String(text || "campus").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function download() {
    var canvas = mapCanvas();
    if (!canvas || !state.school) return;
    var d = new Date();
    var stamp = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    var link = document.createElement("a");
    link.download = slug(state.school.university_name) + "-campus-map-" + stamp + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  /* PowerPoint export: re-render the current campus into a 16:9 frame
     off-screen (so the live view is never disturbed), download it, then
     restore the on-screen view exactly as it was - no tile re-fetch. */
  function exportPptx(btn) {
    if (!document.getElementById("uni-map-canvas") || !state.school) return;
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Building 16:9..."; }

    var saved = {
      W: W, H: H, base: state.base, baseSig: state.baseSig,
      view: state.view, placements: state.placements,
    };

    exportCanvas = document.createElement("canvas");
    W = PPTX_W; H = PPTX_H;
    state.base = null; state.baseSig = null;
    state.placements = new Map();  // clean auto-layout for the new aspect ratio

    Promise.resolve(refresh()).then(function () {
      var d = new Date();
      var stamp = d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");
      var link = document.createElement("a");
      link.download = slug(state.school.university_name) + "-campus-map-16x9-" + stamp + ".png";
      link.href = exportCanvas.toDataURL("image/png");
      link.click();
    }).catch(function () {}).then(function () {
      exportCanvas = null;
      W = saved.W; H = saved.H;
      state.placements = saved.placements;
      if (saved.base) {
        // Reuse the cached basemap: restore the view and reproject call-outs
        // for the original frame, then redraw - no flicker, no re-fetch.
        state.base = saved.base; state.baseSig = saved.baseSig; state.view = saved.view;
        activeCallouts().forEach(function (p) { p.px = project(p.lat, p.lng); });
        draw();
      } else {
        state.baseSig = null;
        refresh();
      }
      if (btn) { btn.disabled = false; btn.textContent = label; }
    });
  }

  function init() {
    var canvas = mapCanvas();
    if (!canvas) return;
    bindDrag(canvas);

    var basemapSel = document.getElementById("uni-map-basemap");
    if (basemapSel) {
      basemapSel.addEventListener("change", function () {
        state.basemap = basemapSel.value;
        state.baseSig = null;
        refresh();
      });
    }
    var chooseBtn = document.getElementById("uni-map-choose");
    var panel = document.getElementById("uni-picker-panel");
    if (chooseBtn && panel) {
      chooseBtn.addEventListener("click", function () {
        panel.hidden = !panel.hidden;
        chooseBtn.classList.toggle("active", !panel.hidden);
      });
    }
    var resetBtn = document.getElementById("uni-map-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        state.placements = new Map();
        refresh();
      });
    }
    function nudgeZoom(d) {
      var next = Math.min(4, Math.max(-4, state.zoomDelta + d));
      if (next === state.zoomDelta) return;
      state.zoomDelta = next;
      refresh();
    }
    var zoomIn = document.getElementById("uni-map-zoom-in");
    var zoomOut = document.getElementById("uni-map-zoom-out");
    var zoomHome = document.getElementById("uni-map-zoom-home");
    if (zoomIn) zoomIn.addEventListener("click", function () { nudgeZoom(1); });
    if (zoomOut) zoomOut.addEventListener("click", function () { nudgeZoom(-1); });
    if (zoomHome) {
      zoomHome.addEventListener("click", function () {
        if (state.zoomDelta === 0 && !state.center) return;
        state.zoomDelta = 0;
        state.center = null;
        refresh();
      });
    }
    var dlBtn = document.getElementById("uni-map-download");
    if (dlBtn) dlBtn.addEventListener("click", download);
    var pptxBtn = document.getElementById("uni-map-download-pptx");
    if (pptxBtn) pptxBtn.addEventListener("click", function () { exportPptx(pptxBtn); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.UniMap = { show: show };
})();
