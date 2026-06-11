/* LOI-O-GENERATOR 3000 sidebar ad - links to loi-generator.streamlit.app.

   Aesthetic: modern premium appliance advertisement (Dyson/Miele launch
   energy). Matte graphite monolith under a showroom spotlight, lime LED
   touch ring, OLED status strip, a draft feeding in up top and a crisp
   LOI gliding out below. Wordmark is Space Grotesk; copy is Manrope. */
(function () {
  var FONTS = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Manrope:wght@300;600&display=swap';

  var css = `
.loi-omatic-ad + .sidebar-footer { margin-top: 0; }
.loi-omatic-ad {
  margin: auto 12px 0;  /* auto top margin pins the ad stack to the sidebar bottom */
  flex-shrink: 0;       /* the sidebar is a fixed-height flex column; without this
                           it crushes the card instead of letting content overflow,
                           which mangles the art and blinds the fit check below */
  position: relative;
  overflow: hidden;
  padding: 12px 10px;
  text-align: center;
  user-select: none;
  cursor: pointer;
  color: #e9ebed;
  background: linear-gradient(180deg, #202327 0%, #121416 100%);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 12px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  transition: transform 0.35s ease, box-shadow 0.35s ease, border-color 0.35s ease;
}
.loi-omatic-ad:hover {
  transform: translateY(-2px);
  border-color: rgba(193, 209, 0, 0.45);
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.55);
}

/* while this ad is visible it pins the stack, so the Memo Chef below it
   drops its own auto top margin (else the free space splits between them) */
.loi-omatic-ad ~ .memo-chef-ad { margin-top: 5px; }

.loi-omatic-ad .om-name {
  font-family: "Space Grotesk", "Segoe UI", sans-serif;
  font-weight: 500;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.1;
  letter-spacing: 0.11em;
  color: #f4f6f7;
}
.loi-omatic-ad .om-name sup { font-size: 6px; color: #9aa0a6; letter-spacing: 0; }
.loi-omatic-ad .om-series { color: var(--lime, #c1d100); font-weight: 700; }
.loi-omatic-ad svg { display: block; margin: 3px auto 0; }

/* the LED touch ring idles through a slow lap */
.loi-omatic-ad .om-ring {
  transform-box: fill-box;
  transform-origin: center;
  animation: om-ring 9s linear infinite;
}
@keyframes om-ring {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* the OLED readout breathes */
.loi-omatic-ad .om-oled-txt { animation: om-oled 7s ease-in-out infinite; }
@keyframes om-oled {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* the draft settles into the intake slot */
.loi-omatic-ad .om-sheet { animation: om-sheet 8s ease-in-out infinite; }
@keyframes om-sheet {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(2px); }
}

/* fresh-off-the-line underglow on the finished letter */
.loi-omatic-ad .om-glow { animation: om-glow 6s ease-in-out infinite; }
@keyframes om-glow {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.4; }
}

.loi-omatic-ad .om-tagline {
  font-family: "Manrope", "Segoe UI", sans-serif;
  font-weight: 300;
  font-size: 9.5px;
  letter-spacing: 0.02em;
  margin-top: 5px;
  color: #b9bec3;
}

.loi-omatic-ad .om-fine {
  font-family: "Manrope", "Segoe UI", sans-serif;
  font-weight: 300;
  font-size: 7px;
  margin-top: 2px;
  color: #6f757b;
}

.loi-omatic-ad .om-cta {
  display: inline-block;
  margin-top: 8px;
  padding: 5px 16px;
  border: 1px solid rgba(193, 209, 0, 0.55);
  border-radius: 999px;
  font-family: "Manrope", "Segoe UI", sans-serif;
  font-weight: 600;
  font-size: 8.5px;
  letter-spacing: 0.14em;
  color: var(--lime, #c1d100);
  background: transparent;
  transition: background 0.25s ease, color 0.25s ease;
}
.loi-omatic-ad:hover .om-cta {
  background: var(--lime, #c1d100);
  color: #121416;
}

/* hide with the rest of the sidebar furniture on phones; the Memo Chef
   takes the pin back */
@media (max-width: 760px) {
  .loi-omatic-ad { display: none; }
  .loi-omatic-ad ~ .memo-chef-ad { margin-top: auto; }
}

/* applied by the fit check below when the ads would overflow the sidebar.
   A fixed max-height media query can't do this: the laptop-fit zoom in
   style.css gives the sidebar more effective room than the raw viewport
   height suggests, so we measure real overflow instead. The Memo Chef
   (a coming-soon teaser) yields first; this ad follows if the sidebar is
   still too tight. */
.loi-omatic-ad.om-hidden,
.memo-chef-ad.om-hidden { display: none; }
.loi-omatic-ad.om-hidden ~ .memo-chef-ad { margin-top: auto; }
/* once every ad is gone the footer takes its auto pin back; the ads'
   adjacent-sibling margin-top:0 rules still match display:none elements
   and would otherwise strand it mid-sidebar */
.loi-omatic-ad.om-hidden + .sidebar-footer,
.loi-omatic-ad.om-hidden ~ .memo-chef-ad.om-hidden + .sidebar-footer { margin-top: auto; }
`;

  /* The machine: a matte graphite monolith under a soft spotlight. A
     draft settles into the brushed intake deck, the lime LED ring idles,
     the OLED strip reads LOI READY, and the finished letter glides out
     over a faint underglow. */
  var svg = `
<svg width="158" height="88" viewBox="0 0 200 112" aria-hidden="true">
  <defs>
    <linearGradient id="omBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34383d"/>
      <stop offset="0.12" stop-color="#26292d"/>
      <stop offset="1" stop-color="#191b1e"/>
    </linearGradient>
    <linearGradient id="omSteel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3a3e43"/>
      <stop offset="0.5" stop-color="#5a5e64"/>
      <stop offset="1" stop-color="#3a3e43"/>
    </linearGradient>
    <radialGradient id="omSpot" cx="0.5" cy="0.25" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- showroom spotlight -->
  <rect x="0" y="0" width="200" height="112" fill="url(#omSpot)"/>

  <!-- floor shadow -->
  <ellipse cx="100" cy="98" rx="52" ry="6" fill="#000" opacity="0.4"/>

  <!-- messy draft settling into the intake -->
  <g class="om-sheet">
    <g transform="rotate(-4 99 10)">
      <rect x="88" y="2" width="22" height="15" rx="1.5" fill="#f5f6f7"/>
      <path d="M91 6 l16 0 M91 9 l16 0 M91 12 l10 0" stroke="#b6bbc0" stroke-width="1"/>
    </g>
  </g>

  <!-- brushed top deck with the intake slot -->
  <rect x="64" y="16" width="72" height="7" rx="3.5" fill="url(#omSteel)"/>
  <rect x="86" y="18" width="28" height="3" rx="1.5" fill="#0c0d0e"/>

  <!-- monolith body -->
  <rect x="60" y="23" width="80" height="72" rx="9" fill="url(#omBody)" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
  <path d="M64 30 q-1 30 0 58" stroke="rgba(255,255,255,0.07)" stroke-width="2" fill="none"/>

  <!-- touch dial with idling LED ring -->
  <circle cx="100" cy="48" r="15" fill="#101214" stroke="#3c4146" stroke-width="1"/>
  <circle class="om-ring" cx="100" cy="48" r="15" fill="none" stroke="#c1d100" stroke-width="2"
          stroke-linecap="round" stroke-dasharray="26 68.2"/>
  <circle cx="100" cy="48" r="2.2" fill="#c1d100"/>

  <!-- status LEDs -->
  <circle cx="130" cy="30" r="1.6" fill="#c1d100"/>
  <circle cx="130" cy="36" r="1.6" fill="#3c4146"/>

  <!-- OLED status strip -->
  <rect x="76" y="68" width="48" height="10" rx="2" fill="#0b0c0d" stroke="#2e3236" stroke-width="1"/>
  <text class="om-oled-txt" x="100" y="75.2" text-anchor="middle" font-family="Consolas, monospace"
        font-size="5.4" letter-spacing="1" fill="#c1d100">LOI READY</text>

  <!-- output slot and the finished LOI gliding out -->
  <rect x="70" y="84" width="60" height="3" rx="1.5" fill="#0c0d0e"/>
  <ellipse class="om-glow" cx="44" cy="96" rx="22" ry="4" fill="#c1d100" opacity="0.25"/>
  <g transform="rotate(-3 42 88)">
    <rect x="28" y="78" width="28" height="19" rx="1.5" fill="#fdfdfb" stroke="#caccc9" stroke-width="0.6"/>
    <text x="42" y="91" text-anchor="middle" font-family="Georgia, serif" font-size="8" font-weight="bold" fill="#16352e">LOI</text>
  </g>
</svg>`;

  var html = `
<div class="om-name">LOI-O-GENERATOR <span class="om-series">3000</span><sup>&trade;</sup></div>
${svg}
<div class="om-tagline">Engineered for non-binding commitment.</div>
<div class="om-fine">Just add acreage, purchase price, and a dream.</div>
<div class="om-cta">GENERATE AN LOI</div>`;

  function inject() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.querySelector('.loi-omatic-ad')) return;

    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = FONTS;
    document.head.appendChild(fonts);

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var ad = document.createElement('div');
    ad.className = 'loi-omatic-ad';
    ad.innerHTML = html;
    ad.title = 'The LOI-O-GENERATOR 3000 - open the LOI Generator';
    ad.addEventListener('click', function () {
      window.open('https://loi-generator.streamlit.app/', '_blank', 'noopener');
    });
    /* sits between the nav and the Memo Chef ad / footer */
    sidebar.insertBefore(ad, sidebar.querySelector('.memo-chef-ad') || sidebar.querySelector('.sidebar-footer'));
    refit();

    /* the Memo Chef injects after this script; re-run the fit check when it
       (or anything else) lands in the sidebar. Class toggles inside refit
       don't retrigger a childList observer, so this can't loop. */
    new MutationObserver(refit).observe(sidebar, { childList: true });
  }

  /* Show each ad only when everything actually fits: un-hide both, then
     yield ads until the sidebar stops overflowing - the Memo Chef first,
     this ad second. The +1 forgives sub-pixel rounding under zoom. */
  function refit() {
    var sidebar = document.querySelector('.sidebar');
    var ad = document.querySelector('.loi-omatic-ad');
    if (!sidebar || !ad) return;
    var memo = document.querySelector('.memo-chef-ad');
    function overflowing() { return sidebar.scrollHeight > sidebar.clientHeight + 1; }
    ad.classList.remove('om-hidden');
    if (memo) memo.classList.remove('om-hidden');
    if (memo && overflowing()) memo.classList.add('om-hidden');
    if (overflowing()) ad.classList.add('om-hidden');
  }

  window.addEventListener('resize', refit);
  window.addEventListener('load', refit); /* re-check once fonts settle */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
