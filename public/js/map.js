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
