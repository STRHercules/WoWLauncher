/* Private chat media: authorize on visibility, keep only bounded blobs, purge at expiry. */
(() => {
  const expired = (attachment, now = Date.now()) => attachment.expired || attachment.expiresAt <= now;
  const withinLimits = (files, policy) => files.length <= policy.MaxAttachmentsPerMessage &&
    files.every(file => file.size > 0 && file.size <= policy.MaxUploadBytes && /^image\/(png|jpeg|gif|webp)$/.test(file.type) && policy.formats.includes(file.type.slice(6).replace('jpeg', 'jpg'))) &&
    files.reduce((sum, file) => sum + file.size, 0) <= policy.MaxMessageUploadBytes;
  const entries = new Set();
  let animated = 0;
  let bytes = 0;
  let policy;
  let authorization;
  let base;
  let autoplay = localStorage.getItem('chat-autoplay') !== 'false';
  function release(entry) {
    entry.generation = (entry.generation || 0) + 1;
    entry.controller?.abort();
    entry.controller = null;
    if (entry.url) { URL.revokeObjectURL(entry.url); bytes -= entry.bytes; entry.url = null; }
    if (entry.animating) { animated--; entry.animating = false; }
    entry.image?.remove();
    entry.image = null;
  }
  function unavailable(entry, text) {
    release(entry);
    entry.root.textContent = text;
  }
  async function show(entry) {
    if (!entry.visible || entry.controller || entry.image) return;
    const a = entry.attachment;
    if (expired(a)) { unavailable(entry, 'Attachment expired'); return; }
    entry.controller = new AbortController();
    const controller = entry.controller;
    const generation = entry.generation || 0;
    try {
      const response = await fetch(`${base}/api/v2/social/chat/attachments/${encodeURIComponent(a.id)}`, {
        headers: { authorization: authorization() }, signal: entry.controller.signal, cache: 'no-store'
      });
      if (response.status === 410) { a.expired = true; unavailable(entry, 'Attachment expired'); return; }
      if (!response.ok) throw new Error('Media unavailable. Click to retry.');
      a.expiresAt = Math.min(a.expiresAt, Number(response.headers.get('x-chat-expires-at')) || a.expiresAt);
      const reader = response.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > policy.MaxUploadBytes) { await reader.cancel(); throw new Error('Media exceeds server limits.'); }
        parts.push(value);
      }
      if (!entry.visible || expired(a) || !entries.has(entry) || generation !== (entry.generation || 0)) return;
      while (bytes + size > policy.CacheMaxBytes) {
        const old = [...entries].find(e => e !== entry && e.url);
        if (!old) throw new Error('Media cache limit reached.');
        unavailable(old, 'Media paused. Click to reload.');
      }
      entry.url = URL.createObjectURL(new Blob(parts, { type: response.headers.get('content-type') }));
      entry.bytes = size; bytes += size;
      const image = new Image();
      image.alt = a.frames > 1 ? 'Animated chat attachment' : 'Chat attachment';
      image.src = entry.url;
      await image.decode();
      if (generation !== (entry.generation || 0)) return;
      if (!entries.has(entry) || !entry.visible || expired(a)) { release(entry); return; }
      entry.root.replaceChildren();
      if (a.frames > 1 && (!autoplay || animated >= policy.MaxConcurrentAnimations)) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(a.width, 640);
        canvas.height = Math.round(a.height * canvas.width / a.width);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Animation paused');
        entry.image = canvas; entry.root.append(canvas);
      } else {
        entry.image = image;
        entry.root.append(image);
        if (a.frames > 1) { entry.animating = true; animated++; }
      }
      entry.root.title = `Available until ${new Date(a.expiresAt).toLocaleString()}. Saved copies cannot be recalled.`;
    } catch (error) {
      if (error.name !== 'AbortError' && entries.has(entry) && generation === (entry.generation || 0)) unavailable(entry, error.message);
    } finally { if (entry.controller === controller) entry.controller = null; }
  }
  const observer = new IntersectionObserver(changes => {
    for (const change of changes) {
      const entry = [...entries].find(e => e.root === change.target);
      if (!entry) continue;
      entry.visible = change.isIntersecting && document.visibilityState === 'visible';
      if (entry.visible) void show(entry); else release(entry);
    }
  });
  function clear() {
    for (const entry of entries) { observer.unobserve(entry.root); release(entry); }
    entries.clear();
  }
  function render(attachment) {
    const root = document.createElement('button');
    root.type = 'button'; root.className = 'chat-attachment';
    root.textContent = expired(attachment) ? 'Attachment expired' : 'Loading attachment…';
    const entry = { attachment, root, visible: false, url: null, bytes: 0 };
    entries.add(entry); observer.observe(root);
    root.addEventListener('click', () => { release(entry); void show(entry); });
    return root;
  }
  setInterval(() => {
    for (const entry of entries) if (expired(entry.attachment)) unavailable(entry, 'Attachment expired');
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    for (const entry of entries) {
      if (document.hidden) { entry.visible = false; release(entry); }
      else { observer.unobserve(entry.root); observer.observe(entry.root); }
    }
  });
  window.ChatMedia = { expired, withinLimits, clear, render,
    configure(config, origin, auth) { policy = config.media; base = origin; authorization = auth; },
    setAutoplay(value) {
      autoplay = value; localStorage.setItem('chat-autoplay', String(value));
      for (const entry of entries) { release(entry); if (entry.visible) void show(entry); }
    },
    update(attachments) {
      for (const entry of entries) {
        const next = attachments.find(a => a.id === entry.attachment.id);
        if (next) { entry.attachment = next; if (expired(next)) unavailable(entry, 'Attachment expired'); }
      }
    }, ids() { return [...entries].map(e => e.attachment.id).slice(0, 128); }
  };
})();
