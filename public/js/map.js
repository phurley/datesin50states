// Map hover tooltip; authors get the editor dialog instead of navigation.
(() => {
  const svg = document.querySelector('.usa');
  const tip = document.querySelector('.map-tip');
  if (!svg || !tip) return;
  const card = svg.closest('.map-card');
  const authed = svg.dataset.canEdit === '1'; // this map's own authors

  function show(el, evt) {
    if (el.classList.contains('tour-future')) return hide(); // don't spoil the tour
    const n = Number(el.dataset.n);
    tip.innerHTML = '';
    tip.append(el.dataset.name);
    const small = document.createElement('small');
    small.textContent = n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : (authed ? 'Click to write the first entry' : 'Not yet!');
    tip.append(small);
    const r = card.getBoundingClientRect();
    let x, y;
    if (evt && 'clientX' in evt) { x = evt.clientX - r.left; y = evt.clientY - r.top; }
    else { const b = el.getBoundingClientRect(); x = b.left + b.width / 2 - r.left; y = b.top - r.top; }
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
  }
  const hide = () => { tip.hidden = true; };

  svg.querySelectorAll('.st').forEach((el) => {
    el.addEventListener('mousemove', (e) => show(el, e));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', () => show(el));
    el.addEventListener('blur', hide);
    if (authed) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        hide();
        window.D50Editor?.openState(el.dataset.code, el.dataset.name);
      });
    }
  });
})();

// Postcard slideshows: slow crossfade, staggered so cards don't change in lockstep.
(() => {
  const shows = [...document.querySelectorAll('.pc-img.slideshow')];
  if (!shows.length) return;
  const slow = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const INTERVAL = slow ? 9000 : 5500;
  shows.forEach((box, i) => {
    const imgs = [...box.querySelectorAll('img')];
    let idx = 0;
    setTimeout(() => setInterval(() => {
      if (document.hidden) return;
      imgs[idx].classList.remove('on');
      idx = (idx + 1) % imgs.length;
      imgs[idx].classList.add('on');
    }, INTERVAL), i * 1400);
  });
})();

// Map tour: ▶ replays the trip in date order and loops. States start blank and are
// revealed as the timeline reaches them; the current one is bright, earlier ones faded.
// A dotted line draws itself from stop to stop (placed by photo GPS when we have it).
// The map gently follows the trip (never closer than 60% of the whole map); click it, or
// pinch in on a phone, for the whole map, and again to follow. Runs of dates in one state go faster.
// ‹ › step, clicking the date pauses/resumes, × or Esc ends the tour.
(() => {
  const svg = document.querySelector('.usa');
  const play = document.querySelector('.tour-play');
  const ctl = document.querySelector('.tour-ctl');
  const data = document.getElementById('tour-data');
  if (!svg || !play || !ctl || !data) return;
  const stops = JSON.parse(data.textContent).filter((s) => svg.querySelector(`.st[data-code="${s.state}"]`));
  if (!stops.length) { play.hidden = true; return; }

  const W = 975, H = 610, FULL = [0, 0, W, H];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ZOOM_MS = still ? 0 : 2200;
  const STEP_MS = still ? 6000 : 5800;
  const QUICK_STEP_MS = still ? 6000 : 2800; // the next date is in the same state
  const MIN_VIEW = 0.6; // never zoom closer than this fraction of the whole map
  const dateBtn = ctl.querySelector('.tour-date');
  const legend = document.querySelector('.map-legend');
  const visited = [...svg.querySelectorAll('.st.visited')];
  let idx = 0, running = false, touring = false, follow = false, timer = null, frame = null, vb = FULL.slice();

  const fmt = (d) => d
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : 'Undated';
  const setVB = (v) => { vb = v; svg.setAttribute('viewBox', v.map((n) => n.toFixed(2)).join(' ')); };
  const ease = (k) => (1 - Math.cos(Math.PI * k)) / 2; // gentle in-out; chains smoothly when retargeted mid-move

  function zoomTo(target, ms, done) {
    cancelAnimationFrame(frame);
    if (!ms || document.visibilityState === 'hidden') { setVB(target); done?.(); return; }
    const from = vb.slice(), t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      setVB(from.map((f, i) => f + (target[i] - f) * ease(k)));
      if (k < 1) frame = requestAnimationFrame(step); else done?.();
    };
    frame = requestAnimationFrame(step);
  }

  // --- Route: dotted arcs between stops, drawn up to the current one ---------
  const NS = 'http://www.w3.org/2000/svg';
  const route = svg.querySelector('.tour-route');
  const DRAW_MS = still ? 0 : 1500;
  const LEAD_MS = 500; // the line sets off this long before the next state appears
  const QUICK_DRAW_MS = 800; // a hop within the same state
  let drawFrame = null, revealTimer = null;
  const node = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 2;

  // A gentle arc from a to b: the control point is pushed sideways a little.
  function arc(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), bend = Math.min(len * 0.18, 60);
    return { a, b, c: { x: (a.x + b.x) / 2 - (dy / len) * bend, y: (a.y + b.y) / 2 + (dx / len) * bend } };
  }
  // The first k (0..1) of that quadratic curve, as path data.
  function partial({ a, b, c }, k) {
    const q1 = { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k };
    const q2 = { x: c.x + (b.x - c.x) * k, y: c.y + (b.y - c.y) * k };
    const e = { x: q1.x + (q2.x - q1.x) * k, y: q1.y + (q2.y - q1.y) * k };
    const f = (n) => n.toFixed(1);
    return `M${f(a.x)},${f(a.y)}Q${f(q1.x)},${f(q1.y)} ${f(e.x)},${f(e.y)}`;
  }

  // Returns the draw time (ms) when a new leg is being drawn, else false.
  function drawRoute() {
    cancelAnimationFrame(drawFrame);
    if (!route) return false;
    const legs = node('g', {}), dots = node('g', {});
    route.replaceChildren(legs, dots);
    const reached = stops.slice(0, idx + 1);
    const cur = reached[reached.length - 1];
    const dot = (s, now) => dots.append(node('circle', { class: now ? 'stop stop-now' : 'stop', cx: s.x, cy: s.y, r: now ? 5.5 : 3.5 }));
    reached.slice(0, -1).forEach((s, i) => {
      if (i && !same(reached[i - 1], s)) legs.append(node('path', { class: 'leg', d: partial(arc(reached[i - 1], s), 1) }));
      if (!same(s, cur)) dot(s, false);
    });
    const prev = reached[reached.length - 2];
    if (!prev || same(prev, cur)) { dot(cur, true); return false; }
    const leg = node('path', { class: 'leg leg-now' }), seg = arc(prev, cur);
    const dur = prev.state === cur.state ? QUICK_DRAW_MS : DRAW_MS;
    legs.append(leg);
    if (!DRAW_MS || document.visibilityState === 'hidden') { leg.setAttribute('d', partial(seg, 1)); dot(cur, true); return false; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      leg.setAttribute('d', partial(seg, Math.max(0.001, (1 - Math.cos(Math.PI * k)) / 2))); // gentle in-out, so it's visibly underway early
      if (k < 1) drawFrame = requestAnimationFrame(step); else dot(cur, true);
    };
    drawFrame = requestAnimationFrame(step);
    return dur;
  }

  // A view around stop i's state plus where the line comes from, padded, never closer than
  // MIN_VIEW of the whole map, kept inside the map. Same-state runs get the same view, so it holds still.
  function boxFor(i) {
    const s = stops[i], prev = stops[i - 1];
    const b = svg.querySelector(`.st[data-code="${s.state}"] path`).getBBox();
    let x0 = Math.min(b.x, s.x), y0 = Math.min(b.y, s.y), x1 = Math.max(b.x + b.width, s.x), y1 = Math.max(b.y + b.height, s.y);
    if (prev) { x0 = Math.min(x0, prev.x); y0 = Math.min(y0, prev.y); x1 = Math.max(x1, prev.x); y1 = Math.max(y1, prev.y); }
    let w = Math.max((x1 - x0) * 1.35, W * MIN_VIEW), h = Math.max((y1 - y0) * 1.35, H * MIN_VIEW);
    if (w / h > W / H) h = (w * H) / W; else w = (h * W) / H;
    w = Math.min(w, W); h = Math.min(h, H);
    const x = Math.max(0, Math.min(W - w, (x0 + x1) / 2 - w / 2));
    const y = Math.max(0, Math.min(H - h, (y0 + y1) / 2 - h / 2));
    return [x, y, w, h];
  }

  function setFollow(on) {
    if (!touring || follow === on) return;
    follow = on;
    svg.classList.toggle('following', on);
    zoomTo(on ? boxFor(idx) : FULL, ZOOM_MS);
  }

  // Reveal every state the timeline has reached; the rest of the map is blank.
  function paint() {
    const cur = stops[idx].state;
    const seen = new Set(stops.slice(0, idx + 1).map((s) => s.state));
    for (const el of visited) {
      const code = el.dataset.code;
      const wasBlank = el.classList.contains('tour-future');
      el.classList.toggle('tour-future', !seen.has(code));
      el.classList.toggle('tour-past', seen.has(code) && code !== cur);
      el.classList.toggle('tour-on', code === cur);
      if (code === cur && wasBlank && !still) {
        el.classList.remove('tour-new'); void el.getBBox(); el.classList.add('tour-new');
      }
    }
    svg.querySelectorAll('.pin').forEach((p) => p.classList.toggle('tour-on', p.dataset.code === cur));
  }

  function show(i) {
    idx = (i + stops.length) % stops.length;
    const s = stops[idx];
    // Start the travel line first; the state (and its date) appear while it's still drawing.
    clearTimeout(revealTimer);
    const reveal = () => {
      paint();
      dateBtn.querySelector('b').textContent = fmt(s.date);
      dateBtn.querySelector('small').textContent = `${s.name} · ${s.title}`;
      dateBtn.title = `${s.name}: ${s.title}`;
    };
    const drawing = drawRoute();
    if (drawing) revealTimer = setTimeout(reveal, Math.min(LEAD_MS, drawing / 3)); else reveal();
    if (follow) zoomTo(boxFor(idx), ZOOM_MS);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    ctl.classList.remove('running');
    if (!running) return;
    void ctl.offsetWidth; // restart the progress bar animation
    // Hurry through a run of dates in one state; the last one in the run gets the full time.
    const dwell = stops[idx + 1]?.state === stops[idx].state ? QUICK_STEP_MS : STEP_MS;
    ctl.style.setProperty('--dwell', `${dwell / 1000}s`);
    ctl.classList.add('running');
    timer = setTimeout(() => { if (!document.hidden) show(idx + 1); else schedule(); }, dwell);
  }

  function setRunning(on) {
    running = on;
    ctl.classList.toggle('paused', !on);
    dateBtn.setAttribute('aria-label', on ? 'Pause the tour' : 'Resume the tour');
    schedule();
  }

  function start() {
    play.hidden = true;
    if (legend) legend.hidden = true;
    ctl.hidden = false;
    touring = true;
    svg.classList.add('touring');
    follow = !still; // ease in to follow the trip (reduced motion: keep the whole map)
    svg.classList.toggle('following', follow);
    running = true;
    ctl.classList.remove('paused');
    show(0);
    dateBtn.focus({ preventScroll: true });
  }

  function stop() {
    touring = running = follow = false;
    clearTimeout(timer);
    ctl.classList.remove('running');
    ctl.hidden = true;
    play.hidden = false;
    if (legend) legend.hidden = false;
    svg.classList.remove('following');
    cancelAnimationFrame(drawFrame);
    clearTimeout(revealTimer);
    route?.replaceChildren();
    svg.querySelectorAll('.tour-on, .tour-past, .tour-future, .tour-new')
      .forEach((el) => el.classList.remove('tour-on', 'tour-past', 'tour-future', 'tour-new'));
    zoomTo(FULL, ZOOM_MS, () => { if (!touring) { svg.classList.remove('touring'); svg.setAttribute('viewBox', FULL.join(' ')); } });
  }

  play.addEventListener('click', start);
  dateBtn.addEventListener('click', () => setRunning(!running));
  ctl.querySelector('.tour-prev').addEventListener('click', () => show(idx - 1));
  ctl.querySelector('.tour-next').addEventListener('click', () => show(idx + 1));
  ctl.querySelector('.tour-close').addEventListener('click', () => { stop(); play.focus({ preventScroll: true }); });
  document.addEventListener('keydown', (e) => {
    if (ctl.hidden || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') stop();
    else if (e.key === 'ArrowLeft' && ctl.contains(document.activeElement)) show(idx - 1);
    else if (e.key === 'ArrowRight' && ctl.contains(document.activeElement)) show(idx + 1);
  });

  // During the tour a click on the map toggles follow-zoom instead of opening a state.
  svg.addEventListener('click', (e) => {
    if (!touring) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setFollow(!follow);
  }, true);

  // Phones: pinch out to follow zoomed in, pinch in to see the whole map again.
  let pinch0 = 0;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  svg.addEventListener('touchstart', (e) => { pinch0 = touring && e.touches.length === 2 ? spread(e.touches) : 0; }, { passive: true });
  svg.addEventListener('touchmove', (e) => {
    if (!pinch0 || e.touches.length !== 2) return;
    e.preventDefault();
    const r = spread(e.touches) / pinch0;
    if (r > 1.15) { setFollow(true); pinch0 = 0; } else if (r < 0.87) { setFollow(false); pinch0 = 0; }
  }, { passive: false });
  svg.addEventListener('gesturestart', (e) => { if (touring) e.preventDefault(); }); // iOS Safari page zoom
})();
