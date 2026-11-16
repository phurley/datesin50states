(() => {
  const box = document.querySelector('.lightbox');
  if (!box) return;
  const img = box.querySelector('img');
  const vid = box.querySelector('video');
  const cap = box.querySelector('figcaption');
  let group = [], idx = 0;

  function stopVideo() {
    if (!vid) return;
    vid.pause();
    vid.removeAttribute('src');
    vid.removeAttribute('poster');
    vid.load();
  }

  function show(i) {
    idx = (i + group.length) % group.length;
    const a = group[idx];
    const isVideo = a.dataset.video === '1' && vid;
    img.hidden = Boolean(isVideo);
    if (vid) vid.hidden = !isVideo;
    if (isVideo) {
      img.removeAttribute('src');
      vid.poster = a.querySelector('img')?.src || '';
      vid.src = a.href;
      vid.play().catch(() => { /* needs a tap: the controls are right there */ });
    } else {
      stopVideo();
      img.src = a.href;
    }
    img.alt = a.dataset.caption || '';
    cap.textContent = a.dataset.caption || '';
    box.querySelector('.lb-prev').hidden = box.querySelector('.lb-next').hidden = group.length < 2;
  }
  function open(a) {
    group = [...document.querySelectorAll(`a[data-lightbox="${a.dataset.lightbox}"]`)];
    show(group.indexOf(a));
    box.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function close() { box.hidden = true; stopVideo(); img.src = ''; document.body.style.overflow = ''; }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-lightbox]');
    if (a) { e.preventDefault(); open(a); }
  });
  box.querySelector('.lb-close').onclick = close;
  box.querySelector('.lb-prev').onclick = () => show(idx - 1);
  box.querySelector('.lb-next').onclick = () => show(idx + 1);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    // On a playing video the arrows seek; use the on-screen buttons to change slides then.
    if (e.target === vid) return;
    if (e.key === 'ArrowLeft') show(idx - 1);
    if (e.key === 'ArrowRight') show(idx + 1);
  });
  let x0 = null;
  box.addEventListener('touchstart', (e) => { x0 = e.target === vid ? null : e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) show(idx + (dx < 0 ? 1 : -1));
    x0 = null;
  });
})();
