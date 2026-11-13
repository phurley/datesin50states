// Photo piles: an entry with 3+ photos starts as a messy stack of prints. When it scrolls
// into view (or is clicked), the top print lifts off, straightens, takes a bow, and flies to
// its spot in the grid — then the next one, until the pile is dealt out.
(() => {
  const grids = [...document.querySelectorAll('.photos[data-pile]')];
  if (!grids.length) return;
  const reveal = (g) => { g.classList.remove('piled'); g.classList.add('dealt'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !Element.prototype.animate) {
    grids.forEach(reveal);
    return;
  }

  const PILE_H = 300; // room the pile takes before it's dealt out
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const tf = (p, lift = 0, s = 1, r = p.r) => `translate(${p.dx}px, ${p.dy - lift}px) rotate(${r}deg) scale(${p.s * s})`;

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
    const state = { grid, wrap, hint, items, poses: [], playing: false, done: false };
    stack(state);
    return state;
  }

  // Measure each print's real grid slot, then transform it onto the pile (first one on top).
  function stack(st) {
    const g = st.grid.getBoundingClientRect();
    const cx = g.left + g.width / 2;
    const cy = g.top + PILE_H / 2 - 8;
    st.items.forEach((a) => { a.style.transform = 'none'; }); // measure the real slots, not the pile
    const rects = st.items.map((a) => a.getBoundingClientRect());
    st.poses = st.items.map((a, i) => {
      const r = rects[i];
      const w = r.width || 180, h = r.height || 135;
      const old = st.poses[i];
      const p = {
        s: Math.min(250 / w, 210 / h),
        r: old ? old.r : rand(-14, 14),
        jx: old ? old.jx : rand(-14, 14),
        jy: old ? old.jy : rand(-10, 10),
      };
      p.dx = cx - (r.left + w / 2) + p.jx;
      p.dy = cy - (r.top + h / 2) + p.jy;
      a.style.zIndex = String(st.items.length - i);
      a.style.transform = tf(p);
      return p;
    });
  }

  async function play(st) {
    if (st.playing || st.done) return;
    st.playing = true;
    st.hint.style.opacity = '0';
    stack(st); // layout may have shifted (fonts, images) since the pile was built
    const n = st.items.length;
    const hold = Math.max(180, Math.min(650, 3200 / n)); // whole show stays ~3–5s
    const wrapTop = () => st.wrap.getBoundingClientRect().top;
    let landing = [];

    for (let i = 0; i < n; i++) {
      const a = st.items[i], p = st.poses[i];
      a.style.zIndex = String(1000 + i);
      // Lift: up off the pile, straighten out, grow a little — its moment in the spotlight.
      await a.animate(
        [{ transform: tf(p) }, { transform: tf(p, 46, 1.3, rand(-3, 3)), offset: 0.7 }, { transform: tf(p, 40, 1.25, 0) }],
        { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'forwards' },
      ).finished;
      await wait(hold);
      // Grow the wrapper so this print's slot is on screen before it lands there.
      const bottom = a.offsetTop + a.offsetHeight + 12;
      st.wrap.style.height = `${Math.max(parseFloat(st.wrap.style.height), bottom)}px`;
      // Fly home with a little overshoot and a spin; don't wait — the next print lifts meanwhile.
      const spin = rand(-8, 8);
      a.style.transform = '';
      const fly = a.animate(
        [{ transform: tf(p, 40, 1.25, 0) }, { transform: `translate(0,0) rotate(${spin}deg) scale(1.06)`, offset: 0.75 }, { transform: 'none' }],
        { duration: 620, easing: 'cubic-bezier(.3,.7,.2,1)' },
      );
      st.items[i].getAnimations().forEach((x) => { if (x !== fly) x.cancel(); });
      landing.push(fly.finished.then(() => { a.classList.add('landed'); a.style.zIndex = ''; }));
      await wait(Math.min(260, hold));
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

  const states = grids.map((g) => {
    try { return setup(g); } catch (e) { reveal(g); return null; }
  }).filter(Boolean);

  states.forEach((st) => {
    // Until the deal finishes, clicks start (or wait for) the show instead of opening the lightbox.
    st.wrap.addEventListener('click', (e) => {
      if (st.done) return;
      e.preventDefault();
      e.stopPropagation();
      play(st);
    }, true);
  });

  const io = new IntersectionObserver((list) => {
    list.forEach((en) => {
      if (!en.isIntersecting) return;
      const st = states.find((s) => s.wrap === en.target);
      io.unobserve(en.target);
      if (st) setTimeout(() => play(st), 350);
    });
  }, { threshold: 0.6 });
  states.forEach((st) => io.observe(st.wrap));

  // Re-square the pile if the window resizes before it's been dealt.
  addEventListener('resize', () => states.forEach((st) => { if (!st.playing && !st.done) stack(st); }));
})();
