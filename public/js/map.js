// Map hover tooltip; authors get the editor dialog instead of navigation.
(() => {
  const svg = document.querySelector('.usa');
  const tip = document.querySelector('.map-tip');
  if (!svg || !tip) return;
  const card = svg.closest('.map-card');
  const authed = Boolean(document.querySelector('.driver-bar'));

  function show(el, evt) {
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

// Map tour: ▶ zooms gently from state to state in date order and loops.
// ‹ › step, clicking the date pauses/resumes, × or Esc zooms back out.
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
  const ZOOM_MS = still ? 0 : 1600;
  const DWELL = still ? 6000 : 4200;
  const dateBtn = ctl.querySelector('.tour-date');
  let idx = 0, running = false, timer = null, frame = null, vb = FULL.slice();

  const fmt = (d) => d
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : 'Undated';
  const setVB = (v) => { vb = v; svg.setAttribute('viewBox', v.map((n) => n.toFixed(2)).join(' ')); };
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

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

  // A box around the state at a modest zoom (never closer than half the map), kept inside the map.
  function boxFor(code) {
    const b = svg.querySelector(`.st[data-code="${code}"] path`).getBBox();
    let w = Math.max(b.width * 1.9, W * 0.5), h = Math.max(b.height * 1.9, H * 0.5);
    if (w / h > W / H) h = (w * H) / W; else w = (h * W) / H;
    w = Math.min(w, W); h = Math.min(h, H);
    // Nudge up a little so the control in the corner doesn't sit on the state.
    // (lets the view run a little past the map's bottom edge for that).
    const x = Math.max(0, Math.min(W - w, b.x + b.width / 2 - w / 2 + w * 0.04));
    const y = Math.max(0, Math.min(H - h * 0.88, b.y + b.height / 2 - h / 2 + h * 0.1));
    return [x, y, w, h];
  }

  function show(i) {
    idx = (i + stops.length) % stops.length;
    const s = stops[idx];
    svg.querySelectorAll('.tour-on').forEach((el) => el.classList.remove('tour-on'));
    svg.querySelectorAll(`[data-code="${s.state}"]`).forEach((el) => el.classList.add('tour-on'));
    dateBtn.querySelector('b').textContent = fmt(s.date);
    dateBtn.querySelector('small').textContent = `${s.name} · ${s.title}`;
    dateBtn.title = `${s.name}: ${s.title}`;
    zoomTo(boxFor(s.state), ZOOM_MS);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    ctl.classList.remove('running');
    if (!running) return;
    void ctl.offsetWidth; // restart the progress bar animation
    ctl.style.setProperty('--dwell', `${(ZOOM_MS + DWELL) / 1000}s`);
    ctl.classList.add('running');
    timer = setTimeout(() => { if (!document.hidden) show(idx + 1); else schedule(); }, ZOOM_MS + DWELL);
  }

  function setRunning(on) {
    running = on;
    ctl.classList.toggle('paused', !on);
    dateBtn.setAttribute('aria-label', on ? 'Pause the tour' : 'Resume the tour');
    schedule();
  }

  function start() {
    play.hidden = true;
    ctl.hidden = false;
    svg.classList.add('touring');
    running = true;
    ctl.classList.remove('paused');
    show(0);
    dateBtn.focus({ preventScroll: true });
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    ctl.classList.remove('running');
    ctl.hidden = true;
    play.hidden = false;
    svg.querySelectorAll('.tour-on').forEach((el) => el.classList.remove('tour-on'));
    zoomTo(FULL, ZOOM_MS, () => { svg.classList.remove('touring'); svg.setAttribute('viewBox', FULL.join(' ')); });
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
})();
