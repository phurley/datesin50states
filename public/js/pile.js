// Photo piles: an entry with 3+ photos starts as a messy stack of prints. When it scrolls
// into view (or is clicked), the top print lifts, straightens, takes a bow, and glides to
// its spot in the grid — then the next one, until the pile is dealt out. Only one pile on
// the page deals at a time; the others wait their turn (and wait to be on screen).
(() => {
  const grids = [...document.querySelectorAll('.photos[data-pile]')];
  if (!grids.length) return;
  const reveal = (g) => { g.classList.remove('piled'); g.classList.add('dealt'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !Element.prototype.animate) {
    grids.forEach(reveal);
    return;
  }

  // The pile lives inside a PILE_H-tall box and every pose — resting, lifted, mid-flight —
  // stays inside it (or below it, in the grid), so nothing drifts up over the entry's text.
  const PILE_H = 340;
  const PILE_W = 240, PILE_MAX_H = 200; // resting size of a print on the pile
  const BOW = 1.22; // how much a print grows when it's lifted
  const LIFT_MS = 700, FLY_MS = 1100, NEXT_MS = 450, BETWEEN_PILES_MS = 600;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const tf = (p, s = 1, r = p.r) => `translate(${p.dx}px, ${p.dy}px) rotate(${r}deg) scale(${p.s * s})`;

  function setup(grid) {
    const wrap = document.createElement('div');
    wrap.className = 'pile-wrap';
    grid.before(wrap);
    wrap.append(grid);
    wrap.style.height = `${PILE_H}px`;
    const hint = document.createElement('div');
    hint.className = 'pile-hint';
    hint.textContent = 'Tap to deal out the photos';
    wrap.append(hint);

    const items = [...grid.querySelectorAll('.ph')];
    items.forEach((a) => { const img = a.querySelector('img'); if (img) img.loading = 'eager'; });
    grid.classList.add('piled');
    const st = { grid, wrap, hint, items, poses: [], playing: false, done: false, visible: false, wanted: false };
    stack(st);
    return st;
  }

  // Measure each print's real grid slot, then transform it onto the pile (first one on top).
  function stack(st) {
    st.items.forEach((a) => { a.style.transform = 'none'; }); // measure the real slots, not the pile
    const g = st.grid.getBoundingClientRect();
    const rects = st.items.map((a) => a.getBoundingClientRect());
    const cx = g.left + g.width / 2;
    const cy = g.top + PILE_H / 2 - 10;
    const maxW = Math.min(PILE_W, (g.width * 0.78) / BOW); // narrow screens: the bow still fits
    st.poses = st.items.map((a, i) => {
      const r = rects[i];
      const w = r.width || 180, h = r.height || 135;
      const old = st.poses[i];
      const p = {
        s: Math.min(maxW / w, PILE_MAX_H / h),
        r: old ? old.r : rand(-12, 12),
        jx: old ? old.jx : rand(-12, 12),
        jy: old ? old.jy : rand(-8, 8),
      };
      p.dx = cx - (r.left + w / 2) + p.jx;
      p.dy = cy - (r.top + h / 2) + p.jy;
      a.style.zIndex = String(st.items.length - i);
      a.style.transform = tf(p);
      return p;
    });
  }

  async function play(st) {
    st.playing = true;
    st.hint.style.opacity = '0';
    stack(st); // layout may have shifted (fonts, images) since the pile was built
    const n = st.items.length;
    const hold = Math.max(500, Math.min(1300, 7000 / n)); // each print's moment in the spotlight
    const landing = [];

    for (let i = 0; i < n; i++) {
      const a = st.items[i], p = st.poses[i];
      a.style.zIndex = String(1000 + i);
      // Lift: straighten out and grow in place — its moment in the spotlight.
      const lift = a.animate(
        [{ transform: tf(p) }, { transform: tf(p, BOW + 0.04, rand(-2, 2)), offset: 0.7 }, { transform: tf(p, BOW, 0) }],
        { duration: LIFT_MS, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' },
      );
      await lift.finished;
      await wait(hold);
      // Grow the wrapper so this print's slot is there before it lands.
      const bottom = a.offsetTop + a.offsetHeight + 12;
      st.wrap.style.height = `${Math.max(parseFloat(st.wrap.style.height), bottom)}px`;
      // Glide home with a little overshoot; the next print lifts while this one is in the air.
      a.style.transform = '';
      // The overshoot settles from just below the slot so even top-row prints never poke up.
      const spin = rand(-2.5, 2.5);
      const fly = a.animate(
        [{ transform: tf(p, BOW, 0) }, { transform: `translate(0, 14px) rotate(${spin}deg) scale(1.02)`, offset: 0.78 }, { transform: 'none' }],
        { duration: FLY_MS, easing: 'cubic-bezier(.35,.6,.25,1)' },
      );
      lift.cancel();
      landing.push(fly.finished.then(() => { a.classList.add('landed'); a.style.zIndex = ''; }));
      await wait(NEXT_MS);
    }
    await Promise.all(landing);
    st.wrap.style.height = `${st.grid.offsetHeight}px`;
    await wait(500);
    // Hand back a plain grid.
    st.wrap.style.height = '';
    st.hint.remove();
    st.items.forEach((a) => { a.classList.remove('landed'); a.style.transform = ''; a.style.zIndex = ''; });
    reveal(st.grid);
    st.playing = false;
    st.done = true;
  }

  const piles = grids.map((g) => {
    try { return setup(g); } catch (e) { reveal(g); return null; }
  }).filter(Boolean);

  // One pile at a time: deal the next pile that's been asked for (seen or tapped) and is on screen.
  let busy = false;
  async function pump() {
    if (busy) return;
    const next = piles.find((s) => s.wanted && s.visible && !s.done);
    if (!next) return;
    busy = true;
    await wait(BETWEEN_PILES_MS);
    if (next.visible) await play(next);
    busy = false;
    pump();
  }

  piles.forEach((st) => {
    // Until the deal finishes, clicks ask for the show instead of opening the lightbox.
    st.wrap.addEventListener('click', (e) => {
      if (st.done) return;
      e.preventDefault();
      e.stopPropagation();
      st.wanted = true;
      st.visible = true;
      pump();
    }, true);
  });

  const io = new IntersectionObserver((list) => {
    list.forEach((en) => {
      const st = piles.find((s) => s.wrap === en.target);
      if (!st) return;
      st.visible = en.isIntersecting;
      if (st.visible) st.wanted = true;
      if (st.done) io.unobserve(en.target);
    });
    pump();
  }, { threshold: 0.6 });
  piles.forEach((st) => io.observe(st.wrap));

  // Re-square the piles if the window resizes before they're dealt.
  addEventListener('resize', () => piles.forEach((st) => { if (!st.playing && !st.done) stack(st); }));
})();
