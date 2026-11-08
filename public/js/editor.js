// Author-only editor dialog: list a state's entries, create/edit/delete them, manage photos.
(() => {
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-D50': '1' } };
    if (body instanceof FormData) opts.body = body;
    else if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  const fmtDate = (d) => d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'No date';

  // Shrink big photos in the browser before upload (also turns HEIC into JPEG in Safari).
  async function prepare(file) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && /jpe?g|png|webp/i.test(file.type) && file.size < 6e6) { bmp.close(); return file; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch {
      return file; // let the server try
    }
  }

  const dlg = h('dialog', { class: 'editor' });
  document.body.append(dlg);
  let dirty = false;
  dlg.addEventListener('close', () => { if (dirty) location.reload(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  function frame(title, sub, ...body) {
    dlg.replaceChildren(
      h('div', { class: 'ed-head' },
        h('div', {}, sub ? h('p', { class: 'script' }, sub) : null, h('h2', {}, title)),
        h('button', { class: 'ed-close', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
      h('div', { class: 'ed-body' }, ...body));
    if (!dlg.open) dlg.showModal();
  }

  async function openState(code, name) {
    frame(name, 'Loading…');
    let entries;
    try { ({ entries } = await api('GET', `/api/states/${code}/entries`)); }
    catch (e) { frame(name, null, h('p', { class: 'error' }, e.message)); return; }
    if (!entries.length) return openForm({ state: code, stateName: name });
    frame(name, `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`,
      h('ul', { class: 'ed-list' }, entries.map((e) => h('li', {},
        h('div', { class: 't' }, h('b', {}, e.title), h('small', {}, `${fmtDate(e.date)} · ${e.photos.length} photos`)),
        h('button', { class: 'btn small ghost', onclick: () => openForm({ ...e, stateName: name }) }, 'Edit')))),
      h('div', { class: 'ed-actions' },
        h('a', { href: `${document.body.dataset.base || ''}/state/${code.toLowerCase()}`, class: 'btn ghost' }, 'View page'),
        h('div', { class: 'right' }, h('button', { class: 'btn', onclick: () => openForm({ state: code, stateName: name }) }, '＋ New entry'))));
  }

  function openForm(entry) {
    let current = entry.id ? entry : null;
    const stateName = entry.stateName || entry.state;
    const status = h('span', { class: 'ed-status' });
    const say = (msg, err) => { status.textContent = msg; status.classList.toggle('err', Boolean(err)); };

    const f = {
      title: h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'Sunset at Glacier Point', value: entry.title || '' }),
      date: h('input', { name: 'date', type: 'date', value: entry.id ? (entry.date || '') : new Date().toLocaleDateString('en-CA') }),
      place: h('input', { name: 'place', maxlength: 200, placeholder: 'City, park, or campground', value: entry.place || '' }),
      body: h('textarea', { name: 'body', placeholder: 'Tell the story… (Markdown works: **bold**, _italics_, > quotes)' }),
      album_url: h('input', { name: 'album_url', type: 'url', placeholder: 'https://photos.icloud.com/shared/album/…', value: entry.album_url || '' }),
    };
    f.body.value = entry.body || '';

    const photosEl = h('div', { class: 'ed-photos' });
    const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button' });
    const syncBtn = h('button', { type: 'button', class: 'btn small ghost' }, 'Sync album now');
    const syncNote = h('span', { class: 'hint' });
    let pollTimer = null;

    function renderPhotos() {
      const has = Boolean(current);
      drop.classList.toggle('disabled', !has);
      drop.textContent = has ? 'Click to choose photos (pick “Photos” in the sidebar), or drop image files here' : 'Save the entry first, then add photos';
      syncBtn.hidden = current?.album_kind !== 'legacy';
      syncNote.textContent = current?.album_kind === 'collection'
        ? `Album linked${current.album_title ? ` (“${current.album_title}”)` : ''}: shown as a link on the entry. iCloud doesn’t allow importing this album type, so add the photos you want here.`
        : current?.syncing ? 'Pulling photos from iCloud…'
        : current?.album_error ? `Album sync failed: ${current.album_error}`
          : current?.album_synced_at ? `Album last synced ${current.album_synced_at} UTC` : '';
      photosEl.replaceChildren(...(current?.photos || []).map((p) => h('div', { class: `ed-photo${p.id === current.cover_photo_id ? ' cover' : ''}` },
        h('img', { src: `/media/${p.thumb}`, alt: '' }),
        h('div', { class: 'badges' },
          p.id === current.cover_photo_id ? h('span', { class: 'badge' }, 'COVER') : null,
          p.id === current.map_photo_id ? h('span', { class: 'badge map' }, 'MAP') : null),
        h('div', { class: 'tools' },
          h('button', { type: 'button', title: 'Use as cover', onclick: () => photoAction('PUT', p.id, { cover: true }) }, '★'),
          h('button', { type: 'button', title: p.id === current.map_photo_id ? 'Stop using on the map' : `Fill ${stateName} on the map with this photo`,
            onclick: () => photoAction('PUT', p.id, { map: p.id !== current.map_photo_id }) }, '🗺'),
          h('button', { type: 'button', title: 'Remove photo', onclick: () => { if (confirm('Remove this photo?')) photoAction('DELETE', p.id); } }, '✕')))));
      clearTimeout(pollTimer);
      if (current?.syncing) pollTimer = setTimeout(refresh, 3000);
    }

    async function refresh() {
      if (!current || !dlg.open) return;
      try { ({ entry: current } = await api('GET', `/api/entries/${current.id}`)); renderPhotos(); } catch { /* ignore */ }
    }

    async function photoAction(method, id, body) {
      try { ({ entry: current } = await api(method, `/api/photos/${id}`, body)); dirty = true; renderPhotos(); }
      catch (e) { say(e.message, true); }
    }

    async function uploadFiles(files) {
      if (!current) return say('Save the entry first.', true);
      const list = [...files].filter((x) => x.type.startsWith('image/') || /\.(heic|heif)$/i.test(x.name));
      if (!list.length) return;
      for (let i = 0; i < list.length; i += 4) {
        say(`Uploading ${Math.min(i + 4, list.length)} of ${list.length}…`);
        const fd = new FormData();
        for (const file of list.slice(i, i + 4)) fd.append('photos', await prepare(file));
        try {
          const r = await api('POST', `/api/entries/${current.id}/photos`, fd);
          current = r.entry; dirty = true; renderPhotos();
          if (r.failed.length) say(`Couldn’t read: ${r.failed.join(', ')}`, true);
          if (r.limitNote) return say(r.limitNote, true);
        } catch (e) { return say(e.message, true); }
      }
      say('Photos added.');
    }

    drop.addEventListener('click', () => current && fileInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
    fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
    syncBtn.addEventListener('click', async () => {
      try { await api('POST', `/api/entries/${current.id}/sync`); current.syncing = true; renderPhotos(); }
      catch (e) { say(e.message, true); }
    });

    const saveBtn = h('button', { class: 'btn', type: 'submit' }, current ? 'Save' : 'Create entry');
    const delBtn = h('button', { class: 'btn danger', type: 'button', hidden: !current }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete “${current.title}” and all its photos? This can’t be undone.`)) return;
      try { await api('DELETE', `/api/entries/${current.id}`); dirty = true; dlg.close(); }
      catch (e) { say(e.message, true); }
    });

    const form = h('form', { class: 'ed-form', onsubmit: async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      saveBtn.disabled = true; say('Saving…');
      try {
        const r = current
          ? await api('PUT', `/api/entries/${current.id}`, data)
          : await api('POST', '/api/entries', { ...data, state: entry.state });
        const wasNew = !current;
        current = r.entry; dirty = true;
        saveBtn.textContent = 'Save'; delBtn.hidden = false;
        say(wasNew ? 'Created! Now add some photos.' : 'Saved.');
        renderPhotos();
      } catch (err) { say(err.message, true); }
      finally { saveBtn.disabled = false; }
    } },
      h('label', {}, 'Title', f.title),
      h('div', { class: 'ed-row' }, h('label', {}, 'Date', f.date), h('label', {}, 'Where', f.place)),
      h('label', {}, 'The story', f.body),
      h('label', {}, h('span', {}, 'iCloud shared album link ', h('small', {}, '(optional; shown as a link on the entry. Classic “Public Website” albums also get their photos imported)')), f.album_url),
      h('div', { class: 'ed-actions' }, delBtn, h('div', { class: 'right' }, status, saveBtn)));

    frame(current ? 'Edit entry' : 'New entry', stateName,
      form,
      h('p', { class: 'ed-sub' }, 'PHOTOS ', syncBtn, ' ', syncNote),
      drop, fileInput, photosEl);
    renderPhotos();
    f.title.focus();
  }

  window.D50Editor = { openState };

  // State page buttons
  document.addEventListener('click', async (e) => {
    const edit = e.target.closest('.edit-entry');
    if (edit) {
      try {
        const { entry } = await api('GET', `/api/entries/${edit.dataset.id}`);
        openForm({ ...entry, stateName: document.querySelector('.state-name')?.dataset.text });
      } catch (err) { alert(err.message); }
    }
    const neu = e.target.closest('.new-entry');
    if (neu) openForm({ state: neu.dataset.state, stateName: neu.dataset.name });
  });
})();
