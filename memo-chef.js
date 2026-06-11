/* Memo Chef sidebar ad - links to memochef.streamlit.app.

   Aesthetic: late-60s comic-book back-page mail-order ad (Sea Monkeys,
   X-Ray Specs). Aged newsprint, ben-day dots, sunburst rays, hand-inked
   outlines, a pulsing starburst, hazard tape, and a clip-'n'-mail coupon.
   Display type is Bangers; fine print is Special Elite, because memos
   are typed. */
(function () {
  var FONTS = 'https://fonts.googleapis.com/css2?family=Bangers&family=Special+Elite&display=swap';

  var css = `
/* the footer also has margin-top auto; zero it so the two auto margins
   don't split the free space and strand the ad mid-sidebar */
.memo-chef-ad + .sidebar-footer { margin-top: 0; }
/* ditto the "More Subtext Tools" tab that sits between this ad and the
   footer; the LOI script's higher-specificity om-hidden rules win when
   every ad is hidden and the tab takes the auto pin back */
.memo-chef-ad ~ .nav-more-tools { margin-top: 5px; }

.memo-chef-ad {
  margin: auto 10px 14px; /* pins to the sidebar bottom when it's the only ad;
                             the LOI ad's stylesheet overrides this while
                             that ad is visible and pinning the stack itself */
  flex-shrink: 0;         /* the sidebar is a fixed-height flex column; don't let
                             it crush the card - the LOI script's fit check hides
                             whole ads instead when the space runs out */
  zoom: 0.82;             /* keep the gag, surrender the square footage */
  position: relative;
  padding: 9px 10px 8px;
  color: #221d12;
  text-align: center;
  user-select: none;
  cursor: pointer;
  transform: rotate(-1.6deg);
  /* slightly ragged page edge; drop-shadow (not box-shadow) follows the clip */
  clip-path: polygon(0.8% 0%, 31% 0.7%, 66% 0%, 99.2% 0.9%, 100% 34%, 99.1% 67%, 100% 99%, 65% 99.2%, 33% 100%, 0.9% 99.1%, 0% 64%, 0.7% 31%);
  filter: drop-shadow(4px 5px 0 rgba(15, 12, 6, 0.9));
  background:
    /* coffee-ring stain, top right */
    radial-gradient(circle at 84% 10%, transparent 14px, rgba(124, 92, 40, 0.18) 15px, rgba(124, 92, 40, 0.18) 18px, transparent 19px),
    /* halftone newsprint dots */
    radial-gradient(circle, rgba(34, 29, 18, 0.11) 1px, transparent 1.6px) 0 0 / 7px 7px,
    /* sun-yellowed paper */
    linear-gradient(160deg, #f2e7c4 0%, #ecdcb0 55%, #e2cf9a 100%);
  border: 3px solid #221d12;
}
/* cellophane tape holding the ad to the sidebar */
.memo-chef-ad::before,
.memo-chef-ad::after {
  content: "";
  position: absolute;
  top: -7px;
  width: 44px;
  height: 15px;
  background: rgba(235, 224, 170, 0.5);
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  border-right: 1px solid rgba(255, 255, 255, 0.35);
}
.memo-chef-ad::before { left: 14px; transform: rotate(-6deg); }
.memo-chef-ad::after  { right: 14px; transform: rotate(5deg); }

.memo-chef-ad .mc-advert {
  font-family: "Special Elite", "Courier New", monospace;
  font-size: 7px;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: #7a6a45;
}
.memo-chef-ad .mc-headline {
  font-family: "Bangers", "Comic Sans MS", cursive;
  font-size: 29px;
  line-height: 0.92;
  margin-top: 1px;
  color: #c0271d;
  letter-spacing: 0.05em;
  -webkit-text-stroke: 1.2px #221d12;
  text-shadow: 2.5px 2.5px 0 #f5b400;
  transform: rotate(-1.2deg);
}
.memo-chef-ad .mc-kicker {
  font-family: "Special Elite", "Courier New", monospace;
  font-size: 8px;
  letter-spacing: 0.06em;
  margin-top: 3px;
  padding: 0 4px;
  color: #44391f;
}

/* the stage: vintage sunburst rays spinning slowly behind the chef */
.memo-chef-ad .mc-stage {
  position: relative;
  margin: 5px 0 0;
  overflow: hidden;
  border: 2.5px solid #221d12;
  background: #f5b400;
}
.memo-chef-ad .mc-rays {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 360px;
  height: 360px;
  margin: -180px 0 0 -180px;
  background: repeating-conic-gradient(#f5b400 0deg 12deg, #e89c00 12deg 24deg);
  animation: mc-rays 120s linear infinite;
}
@keyframes mc-rays { to { transform: rotate(360deg); } }
/* halftone over the rays so the colour reads as printed, not digital */
.memo-chef-ad .mc-stage::after {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(circle, rgba(192, 39, 29, 0.18) 1px, transparent 1.7px) 0 0 / 6px 6px;
  pointer-events: none;
}
.memo-chef-ad .mc-stage svg { display: block; margin: 0 auto; position: relative; }

/* shivering fever chills on hover */
.memo-chef-ad:hover .mc-chef { animation: mc-shiver 0.14s linear infinite; }
@keyframes mc-shiver {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-0.8px) rotate(-0.4deg); }
  75% { transform: translateX(0.8px) rotate(0.4deg); }
}
/* fever squiggles shimmer upward */
.memo-chef-ad .mc-heat { animation: mc-heat 5s ease-in-out infinite; }
.memo-chef-ad .mc-heat-2 { animation-delay: 2.5s; }
@keyframes mc-heat {
  0%, 100% { transform: translateY(0); opacity: 0.9; }
  50% { transform: translateY(-2.5px); opacity: 0.45; }
}
/* mercury throbs with the fever */
.memo-chef-ad .mc-mercury {
  transform-box: fill-box;
  transform-origin: left center;
  animation: mc-fever 4s ease-in-out infinite;
}
@keyframes mc-fever {
  0%, 100% { transform: scaleX(0.8); }
  50% { transform: scaleX(1); }
}

/* double-outline starburst: black star wrapper, red star inset */
.memo-chef-ad .mc-burst {
  position: absolute;
  top: 56px;
  right: -10px;
  width: 74px;
  height: 74px;
  padding: 3px;
  z-index: 3;
  background: #221d12;
  clip-path: polygon(50% 0%, 59% 12%, 72% 4%, 75% 19%, 90% 16%, 87% 31%, 100% 38%, 89% 50%, 100% 62%, 87% 69%, 90% 84%, 75% 81%, 72% 96%, 59% 88%, 50% 100%, 41% 88%, 28% 96%, 25% 81%, 10% 84%, 13% 69%, 0% 62%, 11% 50%, 0% 38%, 13% 31%, 10% 16%, 25% 19%, 28% 4%, 41% 12%);
  transform: rotate(11deg);
  animation: mc-pulse 6s ease-in-out infinite;
}
@keyframes mc-pulse {
  0%, 100% { transform: rotate(11deg) scale(1); }
  50% { transform: rotate(12.5deg) scale(1.04); }
}
.memo-chef-ad .mc-burst-in {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: #c0271d;
  clip-path: inherit;
  color: #f5b400;
  font-family: "Bangers", "Comic Sans MS", cursive;
  font-size: 12px;
  line-height: 0.95;
  letter-spacing: 0.05em;
}

/* "still only 25 cents" price spot, top left */
.memo-chef-ad .mc-price {
  position: absolute;
  top: 74px;
  left: -8px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  z-index: 3;
  background: #f5b400;
  border: 2.5px solid #221d12;
  box-shadow: 2px 2px 0 rgba(15, 12, 6, 0.8);
  display: grid;
  place-items: center;
  font-family: "Bangers", "Comic Sans MS", cursive;
  font-size: 8px;
  line-height: 1;
  color: #221d12;
  transform: rotate(-12deg);
}
.memo-chef-ad .mc-price b { font-size: 14px; display: block; }

.memo-chef-ad .mc-construction {
  margin: 0 -16px 8px;
  padding: 3px 0;
  position: relative;
  z-index: 2;
  background: repeating-linear-gradient(-45deg, #f5b400 0 9px, #221d12 9px 18px);
  border-top: 2.5px solid #221d12;
  border-bottom: 2.5px solid #221d12;
  transform: rotate(1.6deg);
  box-shadow: 0 3px 0 rgba(15, 12, 6, 0.45);
}
.memo-chef-ad .mc-construction span {
  display: block;
  margin: 0 24px;
  background: #f2e7c4;
  font-family: "Bangers", "Comic Sans MS", cursive;
  font-size: 13px;
  letter-spacing: 0.22em;
  padding: 1px 0 0;
  color: #221d12;
  outline: 2px solid #221d12;
}

/* sidebar collapses to a top bar on phones and the footer hides; ditto */
@media (max-width: 760px) {
  .memo-chef-ad { display: none; }
  .memo-chef-ad ~ .nav-more-tools { margin-top: 0; } /* sidebar is a row here */
}
`;

  /* The patient: queasy green chef, half-mast eyes, worried brows, ice bag
     on the toque, neckerchief, thermometer with throbbing mercury, sweat
     drops, ben-day dot cheek shading. Hand-inked 3px outlines throughout. */
  var svg = `
<svg width="182" height="122" viewBox="9 4 182 122" aria-hidden="true">
  <defs>
    <pattern id="mcDots" width="4.5" height="4.5" patternUnits="userSpaceOnUse">
      <circle cx="2.2" cy="2.2" r="1.1" fill="#7e9c4c"/>
    </pattern>
  </defs>
  <g class="mc-chef" stroke="#221d12" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <!-- fever heat squiggles -->
    <g class="mc-heat" fill="none" stroke-width="2.2">
      <path d="M44 62 q5 -6 0 -12 q-5 -6 0 -12"/>
      <path d="M33 76 q4 -5 0 -10"/>
    </g>
    <g class="mc-heat mc-heat-2" fill="none" stroke-width="2.2">
      <path d="M156 62 q5 -6 0 -12 q-5 -6 0 -12"/>
      <path d="M167 76 q4 -5 0 -10"/>
    </g>
    <!-- toque -->
    <path d="M76 58 q-16 -2 -15 -16 q1 -12 13 -12 q2 -13 19 -13 q6 -8 16 -7 q10 1 13 9 q15 -2 17 11 q2 13 -13 17 l-1 11 q-24 6 -48 0 z" fill="#fbf5e6"/>
    <path d="M77 58 q23 6 46 0 l0 9 q-23 6 -46 0 z" fill="#fbf5e6"/>
    <path d="M83 62 l0 7 M100 65 l0 7 M117 62 l0 7" fill="none" stroke-width="2"/>
    <!-- ice bag -->
    <path d="M84 12 q16 -8 32 0 q5 7 -3 11 q-13 5 -26 0 q-8 -4 -3 -11" fill="#a8c8e8"/>
    <path d="M94 7 l12 0 l-1.5 6 l-9 0 z" fill="#5d83ad"/>
    <path d="M91 15 l18 0 M94 20 l12 0" fill="none" stroke-width="1.8"/>
    <!-- drip from the ice bag -->
    <path d="M120 24 q-3 5 0 7 q4 -2 0 -7" fill="#a8c8e8" stroke-width="1.6"/>
    <!-- face -->
    <path d="M78 67 q-3 32 22 35 q25 -3 22 -35 q-22 5 -44 0" fill="#c9dd9d"/>
    <!-- ben-day cheek shading -->
    <ellipse cx="86" cy="84" rx="6.5" ry="4.5" fill="url(#mcDots)" stroke="none"/>
    <ellipse cx="114" cy="84" rx="6.5" ry="4.5" fill="url(#mcDots)" stroke="none"/>
    <!-- worried brows -->
    <path d="M84 71 q5 -4 10 -1 M106 70 q5 -3 10 1" fill="none" stroke-width="2.4"/>
    <!-- half-mast eyes with bags -->
    <path d="M86 78 q4 4 9 0" fill="none" stroke-width="2.6"/>
    <path d="M105 78 q4 4 9 0" fill="none" stroke-width="2.6"/>
    <path d="M87 82.5 q3.5 2 7 0 M106 82.5 q3.5 2 7 0" fill="none" stroke-width="1.6"/>
    <!-- queasy mouth -->
    <path d="M90 93 q3.5 -3.5 7 0 q3.5 3.5 7 0" fill="none" stroke-width="2.6"/>
    <!-- thermometer -->
    <g transform="rotate(16 97 93)">
      <rect x="95" y="90" width="46" height="7" rx="3.5" fill="#fbf5e6" stroke-width="2.6"/>
      <path class="mc-mercury" d="M100 93.5 l33 0" stroke="#c0271d" stroke-width="2.6"/>
      <circle cx="141" cy="93.5" r="6.5" fill="#c0271d" stroke-width="2.6"/>
      <path d="M106 91.5 l0 4 M114 91.5 l0 4 M122 91.5 l0 4 M130 91.5 l0 4" stroke-width="1.4"/>
    </g>
    <!-- sweat drops -->
    <path d="M73 72 q-5 8 0 11 q6 -3 0 -11" fill="#a8c8e8" stroke-width="2"/>
    <path d="M130 64 q-4 7 0 9 q5 -2 0 -9" fill="#a8c8e8" stroke-width="1.8"/>
    <!-- neckerchief -->
    <path d="M82 101 q18 9 36 0 l-14 14 q-4 3 -8 0 z" fill="#c0271d"/>
    <circle cx="100" cy="106" r="4" fill="#c0271d" stroke-width="2.2"/>
  </g>
</svg>`;

  var html = `
<div class="mc-advert">Advertisement</div>
<div class="mc-headline">THE MEMO CHEF</div>
<div class="mc-kicker">He's cooking up something. Probably a fever.</div>
<div class="mc-stage"><div class="mc-rays"></div>${svg}</div>
<div class="mc-burst"><div class="mc-burst-in">COMING<br>SOON!</div></div>
<div class="mc-price"><div>only<b>25&cent;</b></div></div>
<div class="mc-construction"><span>UNDER CONSTRUCTION</span></div>`;

  function inject() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.querySelector('.memo-chef-ad')) return;

    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = FONTS;
    document.head.appendChild(fonts);

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var ad = document.createElement('div');
    ad.className = 'memo-chef-ad';
    ad.innerHTML = html;
    ad.title = 'The Memo Chef - coming soon';
    ad.addEventListener('click', function () {
      window.open('https://memochef.streamlit.app/', '_blank', 'noopener');
    });
    sidebar.insertBefore(ad, sidebar.querySelector('.nav-more-tools') || sidebar.querySelector('.sidebar-footer'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
