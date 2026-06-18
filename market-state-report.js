/* =============================================================
   Market State - print report (DATA ONLY; narrative lives in the Word export)
   URL: market-state-report.html?level=national
        market-state-report.html?market=<market_key>
   Reads market-state/_cohort.json, market-state/<key>.json, amenities/_rollup.json
   ============================================================= */
"use strict";

const C = { slate:"#2b2825", slate70:"#5a544f", slate30:"#b6b1ab", everest:"#16352e",
  birch:"#a95818", lime:"#c1d100", warn:"#c79830", beige:"#f7f1e3", beigeDeep:"#ede5cf" };
const UNIT_ORDER = ["Studio","1BR","2BR","3BR","4BR","5BR","6BR+"];
const UNIT_COLOR = { "Studio":"#b6b1ab","1BR":"#c79830","2BR":"#a95818","3BR":"#16352e","4BR":"#c1d100","5BR":"#512213","6BR+":"#837c75" };
const PARITY_ORDER = ["Parity","Non-Parity","Bath-Heavy","Unknown"];
const PARITY_COLOR = { "Parity":"#16352e","Non-Parity":"#a95818","Bath-Heavy":"#c79830","Unknown":"#d8d4ce" };
const CAT_LABELS = { access_tech:"Access tech", outdoor:"Outdoor/rooftop", convenience:"Convenience",
  coffee_fnb:"Coffee & F&B", wellness:"Wellness", entertainment:"Entertainment", mobility:"Mobility/EV",
  pet:"Pet", novel:"Novel", smart_fitness:"Smart fitness" };
const CAT_COLOR = { wellness:"#16352e", entertainment:"#a95818", access_tech:"#c79830", coffee_fnb:"#512213",
  convenience:"#5a544f", mobility:"#7a8a00", pet:"#b6843f", outdoor:"#2f6f6f", smart_fitness:"#8a4f86", novel:"#9aa0a6" };

const fInt = (v) => v==null?"-":Math.round(v).toLocaleString("en-US");
const fUsd = (v) => v==null?"-":"$"+Math.round(v).toLocaleString("en-US");
const fUsd2 = (v) => v==null?"-":"$"+Number(v).toFixed(2);
const fPct = (v,d=0) => v==null?"-":(v*100).toFixed(d)+"%";
const fSigned = (v,d=1) => v==null?"-":(v>=0?"+":"")+(v*100).toFixed(d)+"%";
const esc = (t) => String(t??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

if (window.ChartDataLabels) Chart.register(window.ChartDataLabels);
Chart.defaults.font.family = "Pragmatica, sans-serif";
Chart.defaults.font.size = 8;
Chart.defaults.color = C.slate70;
Chart.defaults.plugins.datalabels = { display:false };

function base(extra) {
  return Object.assign({ responsive:true, maintainAspectRatio:false, animation:false, devicePixelRatio:2,
    plugins:{ legend:{display:false}, tooltip:{enabled:false}, datalabels:{display:false} } }, extra);
}
const clean = (fmt) => ({ grid:{display:false}, border:{display:false}, ticks:{callback:fmt, font:{size:8,weight:"600"}} });

function bar(id, labels, data, colors, fmt) {
  new Chart(document.getElementById(id), { type:"bar",
    data:{labels, datasets:[{data, backgroundColor:colors, borderRadius:3, maxBarThickness:46}]},
    options:base({ plugins:{legend:{display:false}, tooltip:{enabled:false},
      datalabels:{display:true, anchor:"end", align:"end", color:C.slate70, font:{size:7.5,weight:"700"}, formatter:fmt}},
      scales:{ x:{grid:{display:false},border:{display:false},ticks:{font:{size:8}}}, y:clean(fmt) }, layout:{padding:{top:14}} }) });
}
function grouped(id, labels, datasets, fmt) {
  new Chart(document.getElementById(id), { type:"bar",
    data:{labels, datasets:datasets.map(d=>({...d, borderRadius:2, maxBarThickness:26}))},
    options:base({ plugins:{legend:{display:true, position:"bottom", labels:{boxWidth:9, font:{size:8}, usePointStyle:true}},
      tooltip:{enabled:false}, datalabels:{display:false}},
      scales:{ x:{grid:{display:false},border:{display:false},ticks:{font:{size:8}}}, y:clean(fmt) } }) });
}
function stacked100(id, labels, series) {
  new Chart(document.getElementById(id), { type:"bar",
    data:{labels, datasets:series.map(s=>({label:s.label, data:s.data, backgroundColor:s.color, maxBarThickness:54}))},
    options:base({ plugins:{legend:{display:true, position:"bottom", labels:{boxWidth:9, font:{size:7.5}, usePointStyle:true}},
      tooltip:{enabled:false}, datalabels:{display:false}},
      scales:{ x:{stacked:true, grid:{display:false}, border:{display:false}, ticks:{font:{size:8}}},
        y:{stacked:true, max:1, grid:{display:false}, border:{display:false}, ticks:{callback:(v)=>v*100+"%", font:{size:8}}} } }) });
}
function line(id, labels, datasets, fmt) {
  new Chart(document.getElementById(id), { type:"line",
    data:{labels, datasets:datasets.map(d=>({...d, borderWidth:2, pointRadius:1.5, tension:.25, spanGaps:true}))},
    options:base({ plugins:{legend:{display:datasets.length>1, position:"bottom", labels:{boxWidth:9, font:{size:7.5}, usePointStyle:true}},
      tooltip:{enabled:false}, datalabels:{display:false}},
      scales:{ x:{grid:{display:false},border:{display:false},ticks:{font:{size:8}}}, y:clean(fmt) } }) });
}
function barH(id, labels, data, colors, fmt) {
  new Chart(document.getElementById(id), { type:"bar",
    data:{labels, datasets:[{data, backgroundColor:colors, borderRadius:3}]},
    options:base({ indexAxis:"y", plugins:{legend:{display:false}, tooltip:{enabled:false},
      datalabels:{display:true, anchor:"end", align:"end", color:C.slate70, font:{size:7.5,weight:"700"}, formatter:fmt}},
      scales:{ x:{grid:{display:false},border:{display:false},ticks:{display:false}}, y:{grid:{display:false},border:{display:false},ticks:{font:{size:8,weight:"600"}}} },
      layout:{padding:{right:30}} }) });
}

const lastOf = (s, k="year") => { const a=(s||[]).filter(r=>r[k]!=null).slice().sort((x,y)=>x[k]-y[k]); return a.length?a[a.length-1]:null; };
function mixSeries(vints, kind, order, colors) {
  return order.filter(cat=>vints.some(v=>(v[kind]||[]).some(p=>p.cat===cat))).map(cat=>({
    label:cat, color:colors[cat],
    data:vints.map(v=>{ const tot=(v[kind]||[]).reduce((s,p)=>s+(p.beds||0),0); const n=(v[kind]||[]).find(p=>p.cat===cat); return tot?((n?n.beds:0)/tot):0; }),
  }));
}

const KPI = (l,v,s)=>`<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s||""}</div></div>`;

let DATA, ROLLUP;

async function load() {
  const j = async (u) => { const r = await fetch(u,{cache:"no-cache"}); if(!r.ok) throw new Error(u+" "+r.status); return r.json(); };
  const p = new URLSearchParams(location.search);
  DATA = await j("market-state/_cohort.json");
  try { ROLLUP = await j("amenities/_rollup.json"); } catch { ROLLUP = null; }
  const mk = p.get("market");
  if (mk) { const s = await j(`market-state/${mk}.json`); renderMarket(s); }
  else { renderNational(); }
  document.getElementById("loading").style.display = "none";
}

function head(eyebrow, title, sub) {
  return `<div class="rep-head"><div><div class="rep-eyebrow">${esc(eyebrow)}</div>
    <div class="rep-title">${esc(title)}</div><div class="rep-sub">${esc(sub)}</div></div>
    <div class="rep-meta">Subtext Living<br>New-supply cohort 2023-2026<br>Data as of ${esc(DATA.as_of)}</div></div>`;
}
function foot(n,total,label){ return `<div class="foot"><span>Subtext Living - Market State - ${esc(label)}</span><span>Page ${n} of ${total}</span></div>`; }

/* ---------------- shared sections (return HTML; charts drawn after) -------- */
function perfHtml(idp) {
  return `<div class="sec">Market Performance by Year (June anchor)</div>
    <div class="charts2">
      <div class="chart-card"><h4>Avg Rent / Bed - New Supply vs Whole Market</h4><div class="chart-box"><canvas id="${idp}-rent"></canvas></div></div>
      <div class="chart-card"><h4>Occupancy (new supply)</h4><div class="chart-box"><canvas id="${idp}-occ"></canvas></div></div>
    </div>
    <div class="charts2" style="margin-top:8px">
      <div class="chart-card"><h4>Prelease (new supply)</h4><div class="chart-box"><canvas id="${idp}-pre"></canvas></div></div>
      <div class="chart-card"><h4>Rent Growth YoY (new supply)</h4><div class="chart-box"><canvas id="${idp}-yoy"></canvas></div></div>
    </div>`;
}
function drawPerf(idp, newSeries, bench) {
  const s = (newSeries||[]).filter(r=>r.rate_bed!=null).slice().sort((a,b)=>a.year-b.year);
  const labels = s.map(r=>r.year);
  const bm = {}; (bench||[]).forEach(b=>bm[b.year]=b);
  grouped(`${idp}-rent`, labels, [
    {label:"New supply", data:s.map(r=>r.rate_bed), backgroundColor:C.everest},
    {label:"Whole market", data:labels.map(y=>bm[y]?bm[y].rate_bed:null), backgroundColor:C.slate30},
  ], fUsd);
  bar(`${idp}-occ`, labels, s.map(r=>r.occ), labels.map(()=>C.birch), (v)=>fPct(v,0));
  bar(`${idp}-pre`, labels, s.map(r=>r.prelease), labels.map(()=>C.warn), (v)=>fPct(v,0));
  const yoy = s.map((r,i)=> i>0 && s[i-1].rate_bed ? r.rate_bed/s[i-1].rate_bed-1 : null);
  bar(`${idp}-yoy`, labels, yoy, yoy.map(v=> v==null?C.slate30 : v>=0?C.everest:C.birch), (v)=>fSigned(v));
}
function compHtml(idp) {
  return `<div class="sec">Composition by Delivery Vintage</div>
    <div class="charts2">
      <div class="chart-card"><h4>Unit-Type Mix (share of beds)</h4><div class="chart-box chart-box-tall"><canvas id="${idp}-mix"></canvas></div></div>
      <div class="chart-card"><h4>Parity Mix (share of beds)</h4><div class="chart-box chart-box-tall"><canvas id="${idp}-par"></canvas></div></div>
    </div>
    <div class="chart-card" style="margin-top:8px"><h4>Avg Floor-Plan Size (SF/Bed) by Vintage</h4><div class="chart-box"><canvas id="${idp}-sf"></canvas></div></div>
    <div class="chart-card" style="margin-top:8px"><h4>Avg Rent / Bed by Layout (BRxBA, latest snapshot)</h4><div class="chart-box chart-box-xl"><canvas id="${idp}-lay"></canvas></div></div>`;
}
function drawComp(idp, vints, layouts) {
  const labels = vints.map(v=>v.vintage);
  stacked100(`${idp}-mix`, labels, mixSeries(vints,"unit_types",UNIT_ORDER,UNIT_COLOR));
  stacked100(`${idp}-par`, labels, mixSeries(vints,"parity",PARITY_ORDER,PARITY_COLOR));
  bar(`${idp}-sf`, labels, vints.map(v=>v.latest.sf_per_bed), labels.map(()=>C.everest), (v)=>fInt(v));
  const lay = (layouts||[]).slice().sort((a,b)=>{
    const pa=String(a.cat).split("x"), pb=String(b.cat).split("x");
    return (parseInt(pa[0])||99)-(parseInt(pb[0])||99) || (parseFloat(pa[1])||99)-(parseFloat(pb[1])||99);
  });
  barH(`${idp}-lay`, lay.map(l=>l.cat), lay.map(l=>l.rate_bed),
    lay.map(l=>{ const p=String(l.cat).split("x"); const br=+p[0], ba=parseFloat(p[1]); return (l.cat==="Studio"||ba===br)?C.everest:(ba<br?C.birch:C.warn); }), fUsd);
}

/* ---------------- NATIONAL ---------------- */
function renderNational() {
  const c = DATA.cohorts.all;
  const nj = lastOf(c.market_june), wm = lastOf(c.market_overall);
  const prem = (nj&&wm&&wm.rate_bed)? nj.rate_bed/wm.rate_bed-1 : null;
  const vints = c.by_vintage;
  const layouts = aggLayouts(vints);

  let html = `<div class="sheet">
    ${head("Subtext Living · State of the Student Housing Market", "New-Supply Cohort - National", `${c.n_buildings} buildings · ${c.n_schools} markets · delivered 2023-2026, >100 beds, <=1 mi`)}
    <div class="sec">Cohort Snapshot</div>
    <div class="kpis">
      ${KPI("Markets", fInt(c.n_schools), "S30 + Pursuit")}
      ${KPI("New Buildings", fInt(c.n_buildings), "delivered 2023-26")}
      ${KPI("Avg Rent / Bed", fUsd(nj?nj.rate_bed:null), prem!=null?`${fSigned(prem)} vs market`:"stabilized")}
      ${KPI("Occupancy", fPct(nj?nj.occ:null), "operating")}
      ${KPI("Prelease", fPct(nj?nj.prelease:null), "upcoming term")}
    </div>
    ${perfHtml("nat")}
    ${foot(1,3,"National")}
  </div>
  <div class="sheet">
    ${compHtml("nat")}
    ${foot(2,3,"National")}
  </div>
  <div class="sheet">
    ${amenHtml("nat")}
    <div class="sec">New Supply by Market</div>
    ${marketsTable(DATA.markets)}
    ${foot(3,3,"National")}
  </div>`;
  document.getElementById("root").innerHTML = html;
  drawPerf("nat", c.market_june, c.market_overall);
  drawComp("nat", vints, layouts);
  drawAmen("nat");
}

function aggLayouts(vints) {
  const map = {};
  (vints||[]).forEach(v => (v.layouts||[]).forEach(l => {
    const m = map[l.cat] || (map[l.cat]={cat:l.cat,_rn:0,_rd:0,beds:0});
    m._rn += (l._rn||0); m._rd += (l._rd||0); m.beds += (l.beds||0);
  }));
  return Object.values(map).map(m => ({cat:m.cat, beds:m.beds, rate_bed:m._rd?m._rn/m._rd:null}));
}
function marketsTable(markets) {
  const rows = (markets||[]).map(m=>{ const L=m.latest||{};
    return `<tr><td>${esc(m.market_name)}</td><td>${fInt(m.n_buildings)}</td><td>${fInt(L.beds)}</td><td>${fUsd(L.rate_bed)}</td><td>${fUsd2(L.rate_sf)}</td><td>${fPct(L.occ)}</td><td>${fPct(L.prelease)}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Market</th><th>Bldgs</th><th>Beds</th><th>Rent/Bed</th><th>Rent/SF</th><th>Occ</th><th>Prelease</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------------- AMENITIES ---------------- */
function amenHtml(idp) {
  if (!ROLLUP) return `<div class="sec">Competitor Amenities &amp; Fees</div><div class="narr">No amenity data.</div>`;
  const f=ROLLUP.fees, bb=ROLLUP.billbacks;
  const billers = Object.entries(bb.billers||{}).map(([k,v])=>`${esc(k)} (${v})`).join(", ");
  return `<div class="sec">Competitor Amenities &amp; Fees (official-site scrape, ${ROLLUP.n_scraped} buildings)</div>
    <div class="kpis">
      ${KPI("Avg Emerging", ROLLUP.avg_emerging_per_building, "per building")}
      ${KPI("Application", f.application.median!=null?fUsd(f.application.median):"-", `median (n=${f.application.n})`)}
      ${KPI("Admin", f.admin.median!=null?fUsd(f.admin.median):"-", `median (n=${f.admin.n})`)}
      ${KPI("Parking Fee", f.parking_pct+"%", "of buildings")}
      ${KPI("Utility RUBS", bb.rubs_pct+"%", "pass-through")}
    </div>
    <div class="charts2" style="margin-top:8px">
      <div class="chart-card"><h4>Emerging Amenity Prevalence by Category</h4><div class="chart-box chart-box-tall"><canvas id="${idp}-acat"></canvas></div></div>
      <div class="chart-card"><h4>Most Common Emerging Amenities</h4><div class="chart-box chart-box-tall"><canvas id="${idp}-atop"></canvas></div></div>
    </div>
    <div class="chart-card" style="margin-top:8px"><h4>Emerging Category Adoption by Vintage (% of buildings)</h4><div class="chart-box"><canvas id="${idp}-avin"></canvas></div></div>
    <div class="narr" style="font-size:8.5px">Utility billers: ${billers||"n/a"}. Trash bundled in rent at ${bb.trash_included_pct}% of buildings.</div>`;
}
function drawAmen(idp) {
  if (!ROLLUP) return;
  const cats = Object.entries(ROLLUP.category_prevalence||{}).filter(([c])=>c!=="standard");
  barH(`${idp}-acat`, cats.map(([c])=>CAT_LABELS[c]||c), cats.map(([,n])=>n), cats.map(()=>C.everest), (v)=>v);
  const top = (ROLLUP.top_emerging||[]).slice(0,12);
  barH(`${idp}-atop`, top.map(t=>t.name), top.map(t=>t.count), top.map(()=>C.birch), (v)=>v);
  const nbv=ROLLUP.n_by_vintage||{}, bvc=ROLLUP.by_vintage_category||{}, years=Object.keys(nbv).sort();
  const cc = Object.keys(ROLLUP.category_prevalence||{}).filter(c=>c!=="standard");
  line(`${idp}-avin`, years, cc.map(c=>({label:CAT_LABELS[c]||c, borderColor:CAT_COLOR[c]||C.slate70,
    data:years.map(v=> nbv[v]?((bvc[v]||{})[c]||0)/nbv[v]:null)})), (v)=>fPct(v,0));
}

/* ---------------- MARKET ---------------- */
function feesTable(buildings) {
  if (!buildings || !buildings.length) return `<div class="narr">No fee data for this market.</div>`;
  const cell = (v) => (v == null || String(v).trim() === "") ? "-" : esc(String(v));
  const cols = [
    { h: "Building", w: 17, always: true, get: (b) => b.name },
    { h: "Vint", w: 6, always: true, get: (b) => b.vintage },
    { h: "App", w: 11, get: (b) => (b.fees || {}).application },
    { h: "Admin", w: 13, get: (b) => (b.fees || {}).admin },
    { h: "Parking", w: 20, get: (b) => (b.fees || {}).parking },
    { h: "Pet", w: 20, get: (b) => (b.fees || {}).pet },
    { h: "Biller", w: 13, get: (b) => (b.billbacks || {}).utilities_biller },
  ];
  // drop any fee column that is empty for every building in this market
  const keep = cols.filter((c) => c.always || buildings.some((b) => { const v = c.get(b); return v != null && String(v).trim() !== ""; }));
  if (keep.length <= 2) return `<div class="narr">No published fees or bill-backs for this market.</div>`;
  const totW = keep.reduce((s, c) => s + c.w, 0);
  const colgroup = keep.map((c) => `<col style="width:${(c.w / totW * 100).toFixed(1)}%">`).join("");
  const thead = keep.map((c) => `<th>${c.h}</th>`).join("");
  const rows = buildings.map((b) => `<tr>${keep.map((c) => `<td>${cell(c.get(b))}</td>`).join("")}</tr>`).join("");
  return `<table class="feetbl"><colgroup>${colgroup}</colgroup><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`;
}
function amenityBlocks(buildings) {
  return buildings.map((b) => {
    const em = (b.emerging || []).map((e) => esc(e.name)).join("  ·  ") || "none listed on site";
    return `<div class="amen-block"><div class="amen-name">${esc(b.name)} <span class="amen-vint">delivered ${b.vintage || ""}</span></div><div class="amen-list">${em}</div></div>`;
  }).join("");
}

function renderMarket(s) {
  const nj = lastOf(s.school_june), wm = lastOf(s.market_overall);
  const prem = (nj && wm && wm.rate_bed) ? nj.rate_bed / wm.rate_bed - 1 : null;
  const vints = s.by_vintage, layouts = s.school_layouts;
  const mk = String(s.market_key);
  const amen = (ROLLUP && ROLLUP.per_market && ROLLUP.per_market[mk]) ? ROLLUP.per_market[mk].buildings : [];
  const tag = `${s.is_subtext30 ? "Subtext-30" : ""}${(s.is_subtext30 && s.is_pursuit) ? " + " : ""}${s.is_pursuit ? "Pursuit" : ""}`;

  const bodies = [];
  bodies.push(`${head("Subtext Living · State of the Student Housing Market", s.market_name, `${s.n_buildings} new buildings · delivered 2023-2026 · ${tag}`)}
    <div class="sec">Market Snapshot</div>
    <div class="kpis">
      ${KPI("New Buildings", fInt(s.n_buildings), "delivered 2023-26")}
      ${KPI("Open Beds", fInt(nj ? nj.beds : null), "latest")}
      ${KPI("Avg Rent / Bed", fUsd(nj ? nj.rate_bed : null), prem != null ? `${fSigned(prem)} vs market` : "stabilized")}
      ${KPI("Occupancy", fPct(nj ? nj.occ : null), "operating")}
      ${KPI("Prelease", fPct(nj ? nj.prelease : null), "upcoming term")}
    </div>
    ${perfHtml("mkt")}`);
  bodies.push(compHtml("mkt"));
  bodies.push(`<div class="sec">Fees &amp; Bill-Backs by Building</div>${feesTable(amen)}`);
  const per = 7;
  for (let i = 0; i < amen.length; i += per) {
    const chunk = amen.slice(i, i + per);
    const cont = amen.length > per ? ` (${i + 1}–${Math.min(i + per, amen.length)} of ${amen.length})` : "";
    bodies.push(`<div class="sec">Emerging Amenities by Building${cont}</div>${amenityBlocks(chunk)}`);
  }
  const total = bodies.length;
  document.getElementById("root").innerHTML =
    bodies.map((b, i) => `<div class="sheet">${b}${foot(i + 1, total, esc(s.market_name))}</div>`).join("");
  drawPerf("mkt", s.school_june, s.market_overall);
  drawComp("mkt", vints, layouts);
}

load().catch(e => { document.getElementById("loading").textContent = "Couldn't build report: " + e; });
