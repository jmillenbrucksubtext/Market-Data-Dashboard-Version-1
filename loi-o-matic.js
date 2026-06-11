/* LOI-O-MATIC 3000 sidebar ad - links to loi-generator.streamlit.app.

   Aesthetic: 1950s magazine appliance advertisement (Frigidaire energy).
   Cream paper, mint-and-chrome countertop machine with a big dial, a
   document going in and a crisp LOI coming out, atomic sparkles, period
   catalog copy, and a money-back-style "non-binding guarantee" seal.
   Display type is Alfa Slab One; the script accent is Pacifico. */
(function () {
  var FONTS = 'https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Pacifico&display=swap';

  var css = `
.loi-omatic-ad + .sidebar-footer { margin-top: 0; }
.loi-omatic-ad {
  margin: auto 12px 0;  /* auto top margin pins the ad stack to the sidebar bottom */
  position: relative;
  padding: 8px 8px 9px;
  text-align: center;
  user-select: none;
  cursor: pointer;
  color: #2c2418;
  background:
    radial-gradient(circle, rgba(44, 36, 24, 0.08) 1px, transparent 1.5px) 0 0 / 8px 8px,
    linear-gradient(170deg, #f7f0dd 0%, #f1e7cc 100%);
  border: 2.5px solid #1f6e63;
  outline: 1px solid #1f6e63;
  outline-offset: 2.5px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
  transition: transform 0.35s ease, box-shadow 0.35s ease;
}
.loi-omatic-ad:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.55);
}

/* while this ad is visible it pins the stack, so the Memo Chef below it
   drops its own auto top margin (else the free space splits between them) */
.loi-omatic-ad ~ .memo-chef-ad { margin-top: 5px; }

.loi-omatic-ad .om-name {
  font-family: "Alfa Slab One", "Rockwell", serif;
  white-space: nowrap;
  font-size: 14px;
  line-height: 1.05;
  color: #1f6e63;
  text-shadow: 1px 1px 0 rgba(44, 36, 24, 0.18);
}
.loi-omatic-ad .om-name sup { font-size: 7px; }
.loi-omatic-ad svg { display: block; margin: 1px auto 0; }

/* the "ding" sparkle over the fresh letter, slow */
.loi-omatic-ad .om-ding {
  transform-box: fill-box;
  transform-origin: center;
  animation: om-ding 6s ease-in-out infinite;
}
@keyframes om-ding {
  0%, 82%, 100% { opacity: 0; transform: scale(0.5) rotate(0deg); }
  90% { opacity: 1; transform: scale(1.15) rotate(20deg); }
}
/* the dial settles on a new setting now and then */
.loi-omatic-ad .om-needle {
  transform-box: fill-box;
  transform-origin: 50% 80%;
  animation: om-dial 11s ease-in-out infinite;
}
@keyframes om-dial {
  0%, 35%, 100% { transform: rotate(-25deg); }
  45%, 80% { transform: rotate(30deg); }
}

.loi-omatic-ad .om-tagline {
  font-family: Georgia, "Times New Roman", serif;
  font-style: italic;
  font-size: 9px;
  margin-top: 3px;
  color: #4a3f2c;
}

.loi-omatic-ad .om-cta {
  display: inline-block;
  margin-top: 6px;
  padding: 4px 13px 3px;
  background: #ce3a2e;
  border: 2px solid #2c2418;
  box-shadow: 2px 2px 0 #2c2418;
  font-family: "Alfa Slab One", serif;
  font-size: 8.5px;
  letter-spacing: 0.06em;
  color: #f7f0dd;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.loi-omatic-ad:hover .om-cta {
  transform: translate(1px, 1px);
  box-shadow: 1px 1px 0 #2c2418;
}

/* hide with the rest of the sidebar furniture on phones; the Memo Chef
   takes the pin back */
@media (max-width: 760px) {
  .loi-omatic-ad { display: none; }
  .loi-omatic-ad ~ .memo-chef-ad { margin-top: auto; }
}

/* applied by the fit check below when nav plus two ads would overflow the
   sidebar. A fixed max-height media query can't do this: the laptop-fit
   zoom in style.css gives the sidebar more effective room than the raw
   viewport height suggests, so we measure real overflow instead. */
.loi-omatic-ad.om-hidden { display: none; }
.loi-omatic-ad.om-hidden ~ .memo-chef-ad { margin-top: auto; }
`;

  /* The machine: chrome-topped mint cabinet on tapered legs. A messy
     draft goes in the top slot, the dial swings, three status lamps,
     and a crisp letter slides out the front with a sparkle. */
  var svg = `
<svg width="158" height="88" viewBox="0 0 200 112" aria-hidden="true">
  <defs>
    <linearGradient id="omChrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e9eef0"/>
      <stop offset="0.5" stop-color="#b7c4c9"/>
      <stop offset="1" stop-color="#dfe7ea"/>
    </linearGradient>
  </defs>
  <!-- period spot-illustration backdrop -->
  <circle cx="100" cy="58" r="50" fill="#dceee6"/>
  <!-- atomic sparkles -->
  <g fill="#ce3a2e">
    <path d="M30 24 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2 z"/>
    <path d="M170 78 l1.6 4.8 4.8 1.6 -4.8 1.6 -1.6 4.8 -1.6 -4.8 -4.8 -1.6 4.8 -1.6 z"/>
  </g>
  <g stroke="#2c2418" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <!-- messy draft going in -->
    <g transform="rotate(-14 96 16)">
      <rect x="88" y="6" width="18" height="22" fill="#fffdf5"/>
      <path d="M91 11 l12 0 M91 15 l12 0 M91 19 l8 0" stroke-width="1.2" stroke="#8a7a59"/>
    </g>
    <!-- chrome cap -->
    <rect x="58" y="24" width="84" height="11" rx="5.5" fill="url(#omChrome)"/>
    <path d="M84 24 l32 0" stroke-width="3.4" stroke="#2c2418"/>
    <!-- cabinet -->
    <rect x="54" y="35" width="92" height="56" rx="7" fill="#9fd0bd"/>
    <path d="M54 50 l92 0" stroke-width="1.6"/>
    <!-- dial -->
    <circle cx="86" cy="70" r="13" fill="#fffdf5"/>
    <path d="M86 59.5 l0 3 M96 70 l-3 0 M86 80.5 l0 -3 M76 70 l3 0" stroke-width="1.4"/>
    <path class="om-needle" d="M86 70 l0 -8" stroke="#ce3a2e" stroke-width="2.6"/>
    <circle cx="86" cy="70" r="2" fill="#2c2418" stroke="none"/>
    <!-- status lamps -->
    <circle cx="116" cy="62" r="3.2" fill="#ce3a2e"/>
    <circle cx="127" cy="62" r="3.2" fill="#e8b33c"/>
    <circle cx="138" cy="62" r="3.2" fill="#5da95d"/>
    <!-- nameplate -->
    <rect x="112" y="72" width="30" height="9" rx="2" fill="#fffdf5" stroke-width="1.4"/>
    <!-- output slot and the fresh LOI -->
    <path d="M54 84 l-10 0" stroke-width="3"/>
    <g transform="rotate(8 30 86)">
      <rect x="16" y="76" width="26" height="19" fill="#fffdf5"/>
      <text x="29" y="89" text-anchor="middle" font-family="Georgia, serif" font-size="8" font-weight="bold" fill="#1f6e63" stroke="none">LOI</text>
    </g>
    <!-- tapered mid-century legs -->
    <path d="M64 91 l-5 14 M136 91 l5 14" stroke-width="3"/>
    <path d="M56 105 l8 0 M133 105 l8 0" stroke-width="3"/>
  </g>
  <!-- ding! -->
  <path class="om-ding" d="M14 64 l2.4 7 7 2.4 -7 2.4 -2.4 7 -2.4 -7 -7 -2.4 7 -2.4 z" fill="#e8b33c" stroke="#2c2418" stroke-width="1.4"/>
</svg>`;

  var html = `
<div class="om-name">LOI-O-MATIC 3000<sup>&trade;</sup></div>
${svg}
<div class="om-tagline">"Just add acreage, purchase price, and a dream."</div>
<div class="om-cta">OPEN THE LOI GENERATOR</div>`;

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
    ad.title = 'The LOI-O-MATIC 3000 - open the LOI Generator';
    ad.addEventListener('click', function () {
      window.open('https://loi-generator.streamlit.app/', '_blank', 'noopener');
    });
    /* sits between the nav and the Memo Chef ad / footer */
    sidebar.insertBefore(ad, sidebar.querySelector('.memo-chef-ad') || sidebar.querySelector('.sidebar-footer'));
    refit();
  }

  /* Show the ad whenever it actually fits: un-hide, then yield the spot if
     the sidebar overflows. The +1 forgives sub-pixel rounding under zoom. */
  function refit() {
    var sidebar = document.querySelector('.sidebar');
    var ad = document.querySelector('.loi-omatic-ad');
    if (!sidebar || !ad) return;
    ad.classList.remove('om-hidden');
    if (sidebar.scrollHeight > sidebar.clientHeight + 1) ad.classList.add('om-hidden');
  }

  window.addEventListener('resize', refit);
  window.addEventListener('load', refit); /* re-check once fonts settle */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
