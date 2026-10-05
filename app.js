(() => {
  /* ── State ── */
  let currentId = null;
  let scrollSaveTimer = null;
  let chapters = [];

  /* ── DOM ── */
  const $ = id => document.getElementById(id);
  const fileInput     = $('fileInput');
  const bookList      = $('bookList');
  const emptyLib      = $('emptyLibrary');
  const emptyState    = $('emptyState');
  const bookContainer = $('bookContainer');
  // the page itself scrolls (not an inner box): nested scrollers misbehave on phones
  const scroller      = document.scrollingElement || document.documentElement;
  const reader        = $('reader');
  const sidebar       = $('sidebar');
  const sidebarToggle = $('sidebarToggle');
  const tocSection    = $('tocSection');
  const tocList       = $('tocList');
  const addFolderBtn  = $('addFolderBtn');
  const folderInput   = $('folderInput');
  const mdInput       = $('mdInput');
  const widthRange    = $('widthRange');
  const widthValue    = $('widthValue');
  const fontRange     = $('fontRange');
  const fontValue     = $('fontValue');
  const backdrop      = $('backdrop');
  const fullscreenBtn = $('fullscreenBtn');
  const isMobile      = () => matchMedia('(max-width: 600px)').matches;

  /* ── Init ── */
  function init() {
    renderBookList();
    initSettings();
    fileInput.addEventListener('change', handleFiles);
    addFolderBtn.addEventListener('click', pickFolder);
    folderInput.addEventListener('change', handleFolderInput);
    mdInput.addEventListener('change', handleMdInput);
    backdrop.addEventListener('click', () => sidebar.classList.remove('open'));
    initToggleAutoHide();
    initFullscreen();
    sidebarToggle.addEventListener('click', toggleSidebar);

    // restore last open book
    const savedId = localStorage.getItem('epub-current-id');
    if (savedId && getLibrary().some(b => b.id === savedId)) {
      openBook(savedId);
    }
  }

  /* ── File handling ── */
  async function handleFiles(e) {
    for (const file of e.target.files) {
      if (!file.name.toLowerCase().endsWith('.epub')) continue;
      const id = uid();
      const ab = await file.arrayBuffer();
      const meta = await extractMeta(ab);
      addBookToLibrary(id, { id, name: file.name.replace(/\.epub$/i, ''), ...meta });
      await idbSave(id, ab);
    }
    fileInput.value = '';
    renderBookList();
  }

  /* ── Folder of .md chapters ──
     Stored in IDB as { kind: 'folder', handle?, files: [{ name, text }] }.
     With a directory handle (Chrome/Edge) chapters are re-read from disk on open;
     `files` is the last snapshot, used when access to the folder isn't granted. */
  async function pickFolder() {
    refreshTargetId = null;
    if (!window.showDirectoryPicker) {
      // phones can't pick folders reliably: select the chapter files instead
      (matchMedia('(pointer: coarse)').matches ? mdInput : folderInput).click();
      return;
    }
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'md-books' }); } catch { return; }  // cancelled
    const files = await readFolderHandle(handle);
    if (!files.length) { alert('В папке не найдено .md глав (ожидается подпапка chapters)'); return; }
    await addFolderBook(handle.name, { kind: 'folder', handle, files });
  }

  async function handleFolderInput() {
    const all = [...folderInput.files].filter(f => f.name.toLowerCase().endsWith('.md'));
    folderInput.value = '';
    // webkitRelativePath: "Book/chapters/chapter-001.md"
    let picked = all.filter(f => f.webkitRelativePath.split('/').slice(-2, -1)[0] === 'chapters');
    if (!picked.length) picked = all.filter(f => f.webkitRelativePath.split('/').length === 2);
    if (!picked.length) { alert('В папке не найдено .md глав (ожидается подпапка chapters)'); return; }
    const files = await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() })));
    const rootName = picked[0].webkitRelativePath.split('/')[0];
    await addFolderBook(rootName, { kind: 'folder', files });
  }

  async function handleMdInput() {
    const picked = [...mdInput.files].filter(f => /\.(md|markdown|txt)$/i.test(f.name));
    mdInput.value = '';
    const targetId = refreshTargetId;
    refreshTargetId = null;
    if (!picked.length) return;
    if (targetId) {  // "refresh" on a book without folder access: replace its chapters
      const files = await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() })));
      const data = await idbLoad(targetId);
      await idbSave(targetId, { ...data, kind: 'folder', files });
      if (currentId === targetId) rerenderFolderBook(files);
      return;
    }
    const folderBooks = getLibrary().filter(b => b.kind === 'folder');
    const hint = folderBooks.length ? '\n(то же название — главы обновятся в существующей книге)' : '';
    const name = prompt('Название книги' + hint, folderBooks.at(-1)?.name || 'Новая книга');
    if (!name || !name.trim()) return;
    const files = await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() })));
    await addFolderBook(name.trim(), { kind: 'folder', files });
  }

  async function readFolderHandle(handle) {
    let dir = handle;
    try { dir = await handle.getDirectoryHandle('chapters'); } catch {}  // or chapters are in the folder itself
    const files = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
        files.push({ name: entry.name, text: await (await entry.getFile()).text() });
      }
    }
    return files;
  }

  async function addFolderBook(folderName, data) {
    // same folder added again → update its chapters, keep reading progress
    const existing = getLibrary().find(b => b.kind === 'folder' && b.name === folderName);
    if (existing) {
      await idbSave(existing.id, data);
      if (currentId === existing.id) { saveScrollPosition(); currentId = null; }
      openBook(existing.id);
      return;
    }
    const id = uid();
    // "ReturnOfACrazyGeniusComposer" → "Return Of A Crazy Genius Composer"
    const title = folderName.replace(/([a-zа-я])([A-ZА-Я])/g, '$1 $2').replace(/([A-ZА-Я])([A-ZА-Я][a-zа-я])/g, '$1 $2');
    await idbSave(id, data);
    addBookToLibrary(id, { id, name: folderName, title, kind: 'folder' });
    renderBookList();
    openBook(id);
  }

  // re-read chapters from disk if we still have access; otherwise keep the snapshot
  async function refreshFolder(id, data) {
    if (!data.handle) return data;
    try {
      let perm = await data.handle.queryPermission({ mode: 'read' });
      if (perm === 'prompt') perm = await data.handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return data;
      const files = await readFolderHandle(data.handle);
      if (!files.length) return data;
      const fresh = { ...data, files };
      await idbSave(id, fresh);
      return fresh;
    } catch {
      return data;  // e.g. no user gesture when restoring on page load
    }
  }

  /* ── Refresh a folder book (pick up edited / added chapters) ── */
  let refreshTargetId = null;  // md-file picker was opened to update this book

  async function refreshFolderBook(id, btn) {
    const data = await idbLoad(id);
    if (!data) return;
    if (!data.handle) {  // phone / one-time snapshot: no folder access, pick the files again
      refreshTargetId = id;
      mdInput.click();
      return;
    }
    btn.classList.add('spinning');
    try {
      let perm = await data.handle.queryPermission({ mode: 'read' });
      if (perm === 'prompt') perm = await data.handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') throw new Error('нет доступа к папке');
      const files = await readFolderHandle(data.handle);
      if (!files.length) throw new Error('в папке не найдено .md глав');
      await idbSave(id, { ...data, files });
      if (currentId === id) rerenderFolderBook(files);
    } catch (err) {
      alert('Не удалось обновить: ' + err.message);
    } finally {
      btn.classList.remove('spinning');
    }
  }

  // re-render the open book in place, keeping the reading position
  function rerenderFolderBook(files) {
    saveScrollPosition();
    renderMarkdownBook(files);
    renderToc(chapters);
    restorePosition(localStorage.getItem(`epub-progress-${currentId}`));
  }

  // natural order; drop variants like "chapter-483-gpt54.md" when "chapter-483.md" exists
  function orderChapterFiles(files) {
    const names = new Set(files.map(f => f.name.toLowerCase()));
    return files
      .filter(f => {
        const m = f.name.match(/^(.*?\d+)[^\d].*\.md$/i);
        return !(m && names.has((m[1] + '.md').toLowerCase()));
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  function renderMarkdownBook(files) {
    const ordered = orderChapterFiles(files);
    const sections = ordered.map(f => ({ href: f.name, md: f.text }));  // parsed when shown
    chapters = ordered.map(f => {
      const h = f.text.match(/^#{1,3}\s+(.+)$/m);
      return { title: h ? h[1].trim() : f.name.replace(/\.md$/i, ''), href: f.name, level: 0 };
    });
    mountSections(sections, '');
  }

  /* ── Export a .md folder book as EPUB 3 (with an NCX for older readers) ── */
  async function exportFolderAsEpub(id) {
    const book = getLibrary().find(b => b.id === id);
    let data = await idbLoad(id);
    if (!book || !data) return;
    data = await refreshFolder(id, data);  // pick up chapters added since the last open

    const title = book.title || book.name;
    const ordered = orderChapterFiles(data.files);
    const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const toXhtml = html => {
      // HTML → well-formed XHTML (self-closed <br/>, <hr/>, escaped entities)
      const body = new DOMParser().parseFromString(html, 'text/html').body;
      const ser = new XMLSerializer();
      return [...body.childNodes].map(n => ser.serializeToString(n)).join('\n');
    };
    const page = (heading, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ru" xml:lang="ru">
<head><meta charset="utf-8"/><title>${xmlEsc(heading)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
${body}
</body>
</html>`;

    const items = ordered.map((f, i) => {
      const h = f.text.match(/^#{1,3}\s+(.+)$/m);
      return {
        file: `ch${String(i + 1).padStart(4, '0')}.xhtml`,
        title: h ? h[1].trim().replace(/[*_`]/g, '') : f.name.replace(/\.md$/i, ''),
        html: toXhtml(marked.parse(f.text)),
      };
    });

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });  // must be first, uncompressed
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

    const bookId = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : uid());
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ru">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:language>ru</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${items.map((it, i) => `    <item id="c${i + 1}" href="${it.file}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${items.map((it, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}
  </spine>
</package>`);

    zip.file('OEBPS/nav.xhtml', page('Содержание', `<nav epub:type="toc" id="toc"><h1>Содержание</h1><ol>
${items.map(it => `<li><a href="${it.file}">${xmlEsc(it.title)}</a></li>`).join('\n')}
</ol></nav>`));

    zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${bookId}"/></head>
  <docTitle><text>${xmlEsc(title)}</text></docTitle>
  <navMap>
${items.map((it, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(it.title)}</text></navLabel><content src="${it.file}"/></navPoint>`).join('\n')}
  </navMap>
</ncx>`);

    zip.file('OEBPS/style.css', 'body { line-height: 1.6; }\np { margin: 0 0 0.6em; }\nhr { border: none; border-top: 1px solid #999; margin: 1.5em 0; }\n');
    items.forEach(it => zip.file('OEBPS/' + it.file, page(it.title, it.html)));

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (book.name || title).replace(/[\\/:*?"<>|]+/g, '_') + '.epub';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function extractMeta(ab) {
    try {
      const zip = await JSZip.loadAsync(ab);
      const opfText = await getOpfText(zip);
      if (!opfText) return {};
      const title = xmlTag(opfText, 'dc:title') || '';
      const creator = xmlTag(opfText, 'dc:creator') || '';
      return { title, creator };
    } catch {
      return {};
    }
  }

  /* ── Library (localStorage) ── */
  function getLibrary() {
    try { return JSON.parse(localStorage.getItem('epub-library') || '[]'); } catch { return []; }
  }
  function setLibrary(lib) { localStorage.setItem('epub-library', JSON.stringify(lib)); }
  function addBookToLibrary(id, data) {
    const lib = getLibrary();
    lib.push(data);
    setLibrary(lib);
  }
  function removeFromLibrary(id) {
    setLibrary(getLibrary().filter(b => b.id !== id));
    localStorage.removeItem(`epub-progress-${id}`);
    idbDelete(id);
  }

  /* ── Settings ── */
  function initSettings() {
    const saved = parseInt(localStorage.getItem('epub-reader-width'), 10);
    applyWidth(saved >= 20 && saved <= 100 ? saved : 36);
    widthRange.addEventListener('input', () => {
      captureAnchor();  // anchor the exact current spot, then restore it right away
      applyWidth(+widthRange.value);
      restoreAnchor();  // (the resize observer only needs to cover window resizes)
      localStorage.setItem('epub-reader-width', widthRange.value);
    });

    const savedFont = parseInt(localStorage.getItem('epub-reader-font'), 10);
    applyFont(savedFont >= 12 && savedFont <= 28 ? savedFont : 16);
    fontRange.addEventListener('input', () => {
      captureAnchor();
      applyFont(+fontRange.value);
      restoreAnchor();  // width didn't change, so the observer won't do it
      localStorage.setItem('epub-reader-font', fontRange.value);
    });
    initReadingAnchor();
  }

  /* ── Keep reading position when the text reflows (window resize, width setting) ──
     Remember the element at the top of the viewport and how far into it we are;
     when the reader width changes, scroll so that same spot is at the top again. */
  let anchor = null;

  function captureAnchor() {
    const r = reader.getBoundingClientRect();
    // prefer a paragraph over the gap between paragraphs (that hits the whole section)
    let el = null;
    for (let y = 4; y < 80 && !(el && el !== reader && reader.contains(el) && !el.classList.contains('section-content')); y += 8) {
      el = document.elementFromPoint(r.left + r.width / 2, y);
    }
    if (!el || el === reader || !reader.contains(el)) { anchor = null; return; }
    const rect = el.getBoundingClientRect();
    anchor = {
      el,
      width: reader.offsetWidth,
      frac: rect.height ? -rect.top / rect.height : 0,
    };
  }

  function restoreAnchor() {
    if (!anchor) return;
    if (!reader.contains(anchor.el)) { anchor = null; return; }  // book was switched
    const rect = anchor.el.getBoundingClientRect();
    scroller.scrollTop += rect.top + anchor.frac * rect.height;
    anchor.width = reader.offsetWidth;
  }

  function initReadingAnchor() {
    // browser's own scroll anchoring fights with ours
    document.documentElement.style.overflowAnchor = 'none';

    let pending = false;
    window.addEventListener('scroll', () => {
      if (!(anchor && reader.contains(anchor.el) && anchor.width !== reader.offsetWidth)) fillWindow();
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        // skip scroll events caused by a reflow we haven't restored yet
        if (anchor && reader.contains(anchor.el) && anchor.width !== reader.offsetWidth) return;
        captureAnchor();
      });
    }, { passive: true });

    new ResizeObserver(() => {
      if (anchor && anchor.width !== reader.offsetWidth) restoreAnchor();
    }).observe(reader);
  }

  function applyFont(px) {
    fontRange.value = px;
    fontValue.textContent = px + 'px';
    document.documentElement.style.setProperty('--font-size', px + 'px');
  }

  // on a phone the menu button covers the first lines: hide it while scrolling down
  function initToggleAutoHide() {
    let lastTop = 0;
    window.addEventListener('scroll', () => {
      const top = scroller.scrollTop;
      if (Math.abs(top - lastTop) < 8) return;
      sidebarToggle.classList.toggle('tucked', isMobile() && top > lastTop && top > 60);
      lastTop = top;
    }, { passive: true });
  }

  // hides the browser's address bar and system bars (not supported on iPhone Safari)
  function initFullscreen() {
    if (!document.fullscreenEnabled) return;
    // the installed app already starts fullscreen (manifest display_override)
    if (matchMedia('(display-mode: fullscreen)').matches) return;
    fullscreenBtn.hidden = false;
    const update = () => {
      fullscreenBtn.textContent = document.fullscreenElement ? 'Выйти из полноэкранного режима' : 'На весь экран';
    };
    fullscreenBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      sidebar.classList.remove('open');
    });
    document.addEventListener('fullscreenchange', update);
    update();
  }

  function applyWidth(pct) {
    widthRange.value = pct;
    widthValue.textContent = pct + '%';
    document.documentElement.style.setProperty('--reader-width', pct + '%');
  }

  /* ── Sidebar ── */
  function toggleSidebar() { sidebar.classList.toggle('open'); }

  function renderBookList() {
    const lib = getLibrary();
    emptyLib.style.display = lib.length ? 'none' : 'flex';
    bookList.innerHTML = lib.map(b => `
      <div class="book-item${b.id === currentId ? ' active' : ''}" data-id="${b.id}">
        <div class="book-cover-placeholder">${esc((b.title || b.name || '?')[0].toUpperCase())}</div>
        <div class="book-info">
          <div class="book-title">${esc(b.title || b.name)}</div>
          ${b.creator ? `<div class="book-author">${esc(b.creator)}</div>` : ''}
        </div>
        <button class="book-delete" data-id="${b.id}" title="Удалить">&times;</button>
        ${b.kind === 'folder' ? `<button class="book-action book-refresh" data-id="${b.id}" title="Обновить главы из папки">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3v3.5h-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="book-action book-export" data-id="${b.id}" title="Скачать как EPUB">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>` : ''}
      </div>
    `).join('');

    bookList.querySelectorAll('.book-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.book-delete, .book-action')) return;
        openBook(el.dataset.id);
      });
    });
    bookList.querySelectorAll('.book-refresh').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        refreshFolderBook(el.dataset.id, el);
      });
    });
    bookList.querySelectorAll('.book-export').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        exportFolderAsEpub(el.dataset.id).catch(err => alert('Не удалось экспортировать: ' + err.message));
      });
    });
    bookList.querySelectorAll('.book-delete').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const id = el.dataset.id;
        if (currentId === id) {
          currentId = null;
          chapters = [];
          clearInterval(scrollSaveTimer);
          reader.innerHTML = '';
          bookContainer.classList.remove('visible');
          emptyState.style.display = 'flex';
          tocSection.style.display = 'none';
        }
        removeFromLibrary(id);
        renderBookList();
      });
    });
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ── Open / render book ── */
  async function openBook(id) {
    if (currentId === id) { sidebar.classList.remove('open'); return; }

    // save current position before switching
    if (currentId) saveScrollPosition();

    clearInterval(scrollSaveTimer);
    currentId = id;
    localStorage.setItem('epub-current-id', id);
    sidebar.classList.remove('open');
    renderBookList();

    let data = await idbLoad(id);
    if (!data) return;

    emptyState.style.display = 'none';
    bookContainer.classList.add('visible');
    reader.innerHTML = '<p style="text-align:center;padding:40px;color:#666">Загрузка…</p>';

    try {
      if (data.kind === 'folder') {
        data = await refreshFolder(id, data);
        if (currentId !== id) return;  // switched to another book meanwhile
        renderMarkdownBook(data.files);
      } else {
        await renderEpub(data);
      }
    } catch (err) {
      console.error('renderEpub error:', err);
      reader.innerHTML = `<p style="text-align:center;padding:40px;color:#f44">Ошибка загрузки: ${esc(err.message)}</p>`;
      return;
    }

    renderToc(chapters);

    // restore reading position
    restorePosition(localStorage.getItem(`epub-progress-${id}`));

    // periodic save
    scrollSaveTimer = setInterval(() => saveScrollPosition(), 3000);
  }

  /* ── XML helpers (regex-based, namespace-safe) ── */
  async function getOpfText(zip) {
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) return null;
    const m = containerXml.match(/full-path=["']([^"']+)["']/);
    if (!m) return null;
    return await zip.file(m[1])?.async('text');
  }

  function xmlTag(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim().replace(/<[^>]+>/g, '') : null;
  }

  function xmlAttr(xml, tag, attr) {
    const re = new RegExp(`<${tag}[^>]*?${attr}=["']([^"']+)["']`, 'i');
    const m = xml.match(re);
    return m ? m[1] : null;
  }

  function xmlTags(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = {};
      const attrRe = /(\w[\w:-]*)=["']([^"']*)["']/g;
      let a;
      while ((a = attrRe.exec(m[0])) !== null) attrs[a[1]] = a[2];
      results.push(attrs);
    }
    return results;
  }

  /* ── EPUB rendering (manual parse with JSZip) ── */
  async function renderEpub(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. Get OPF text
    const opfText = await getOpfText(zip);
    if (!opfText) throw new Error('Не удалось найти OPF файл');

    // 2. Find OPF directory
    const containerXml = await zip.file('META-INF/container.xml').async('text');
    const rootMatch = containerXml.match(/full-path=["']([^"']+)["']/);
    const rootFilePath = rootMatch[1];
    const opfDir = rootFilePath.split('/').slice(0, -1).join('/');

    // 3. Build manifest (id → href + media-type)
    const manifest = {};
    xmlTags(opfText, 'item').forEach(attrs => {
      if (attrs.id && attrs.href) {
        manifest[attrs.id] = {
          href: attrs.href,
          mediaType: attrs['media-type'] || '',
          properties: attrs.properties || ''
        };
      }
    });

    // 4. Get spine order
    const spineItems = [];
    xmlTags(opfText, 'itemref').forEach(attrs => {
      const idref = attrs.idref;
      if (idref && manifest[idref]) {
        spineItems.push({ id: idref, href: manifest[idref].href });
      }
    });

    // 5. Build full-path lookup for zip files
    const zipFiles = {};
    zip.forEach((path, entry) => {
      if (!entry.dir) zipFiles[path] = entry;
      if (opfDir && path.startsWith(opfDir + '/')) {
        zipFiles[path.slice(opfDir.length + 1)] = entry;
      }
    });

    function resolveFile(href) {
      const clean = href.replace(/^\.\//, '');
      const candidates = [
        clean,
        opfDir ? opfDir + '/' + clean : clean,
        href,
        opfDir ? opfDir + '/' + href : href,
      ];
      for (const c of candidates) {
        if (zipFiles[c]) return zipFiles[c];
      }
      return null;
    }

    // resolve a link found inside a chapter: it is relative to that chapter's folder
    function resolveRelative(baseHref, href) {
      let path = href;
      try { path = decodeURIComponent(href); } catch {}
      const parts = baseHref.split('/').slice(0, -1);
      for (const seg of path.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg && seg !== '.') parts.push(seg);
      }
      return resolveFile(parts.join('/')) || resolveFile(path);
    }

    // 6. Load CSS files and merge
    let mergedCss = '';
    for (const [id, info] of Object.entries(manifest)) {
      if (info.mediaType.includes('css') || info.href.endsWith('.css')) {
        const entry = resolveFile(info.href);
        if (entry) {
          try { mergedCss += await entry.async('text') + '\n'; } catch {}
        }
      }
    }

    // 7. Parse TOC
    chapters = await parseToc(zip, manifest, opfDir, opfText);

    // 8. Render each spine item
    reader.innerHTML = '';
    const parser = new DOMParser();
    const sectionContents = [];

    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i];
      const entry = resolveFile(item.href);
      if (!entry) continue;

      let html = await entry.async('text');

      // parse the section (try XHTML first, then HTML)
      const doc = parser.parseFromString(html, 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) {
        const doc2 = parser.parseFromString(html, 'text/html');
        html = doc2.body ? doc2.body.innerHTML : html;
      } else {
        const body = doc.querySelector('body');
        html = body ? body.innerHTML : new XMLSerializer().serializeToString(doc);
      }

      // resolve image sources to data URLs
      const imgSrcs = [];
      const imgRe = /src=["']([^"'#?]+)["']/g;
      let match;
      while ((match = imgRe.exec(html)) !== null) {
        if (!match[1].startsWith('data:')) imgSrcs.push(match[1]);
      }

      for (const src of imgSrcs) {
        const imgEntry = resolveRelative(item.href, src);
        if (imgEntry) {
          try {
            const b64 = await imgEntry.async('base64');
            const ext = src.split('.').pop().toLowerCase().split('?')[0];
            const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                           gif:'image/gif', svg:'image/svg+xml', webp:'image/webp',
                           bmp:'image/bmp' }[ext] || 'image/png';
            html = html.replace(new RegExp(`src=["']${escRegex(src)}["']`, 'g'),
                                `src="data:${mime};base64,${b64}"`);
          } catch {}
        }
      }

      sectionContents.push({ html, href: item.href });
    }

    // 9. Build final HTML with section anchors
    mountSections(sectionContents, mergedCss);
  }

  /* ── Windowed rendering ──
     Only the chapters around the reading position are in the DOM; neighbours are
     added/removed while scrolling. Phones stop painting very tall pages,
     so the whole book can't be one long page. */
  let bookSections = [];  // { href, html } or { href, md } (markdown parsed on demand)
  let win = { start: 0, end: 0 };  // rendered range [start, end)
  const EDGE = () => innerHeight * 2;  // keep this much text beyond the screen

  function mountSections(sectionContents, css) {
    bookSections = sectionContents;
    win = { start: 0, end: 0 };
    reader.innerHTML = '';

    // apply merged CSS (scoped to #reader)
    if (css) {
      const style = document.createElement('style');
      try {
        style.textContent = scopeCss(css, '#reader .section-content');
      } catch {
        style.textContent = css;
      }
      reader.appendChild(style);
    }

    setupChapterTracking();
  }

  function buildSection(i) {
    const sec = bookSections[i];
    if (sec.html == null) sec.html = marked.parse(sec.md);

    const wrap = document.createElement('div');
    wrap.className = 'section-wrap';
    wrap.dataset.i = i;
    if (i > 0) {
      const hr = document.createElement('hr');
      hr.className = 'section-break';
      wrap.appendChild(hr);
    }
    const div = document.createElement('div');
    div.className = 'section-content';
    div.id = 'section-' + i;
    div.dataset.href = sec.href;
    div.innerHTML = sec.html;
    wrap.appendChild(div);

    // clean up empty paragraphs
    div.querySelectorAll('p').forEach(p => {
      if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    });
    // external links must not navigate the reader away
    div.querySelectorAll('a[href^="http"]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
    return wrap;
  }

  const wraps = () => reader.querySelectorAll('.section-wrap');

  // change the DOM above the screen without moving the text on screen
  function keepingPosition(ref, mutate) {
    const top = ref.getBoundingClientRect().top;
    mutate();
    scroller.scrollTop += ref.getBoundingClientRect().top - top;
  }

  function fillWindow() {
    if (!bookSections.length || win.end === win.start) return;
    const edge = EDGE();
    let w = wraps();
    if (!w.length) return;  // book closed
    // below: add while the rendered text ends less than `edge` past the screen
    while (win.end < bookSections.length && w[w.length - 1].getBoundingClientRect().bottom < innerHeight + edge) {
      reader.appendChild(buildSection(win.end++));
      w = wraps();
    }
    // above
    while (win.start > 0 && w[0].getBoundingClientRect().top > -edge) {
      const first = w[0];
      keepingPosition(first, () => reader.insertBefore(buildSection(--win.start), first));
      w = wraps();
    }
    // drop chapters that are far away (2x the margin, so they don't flip-flop)
    while (w.length > 1 && w[w.length - 1].getBoundingClientRect().top > innerHeight + 2 * edge) {
      w[w.length - 1].remove();
      win.end--;
      w = wraps();
    }
    while (w.length > 1 && w[0].getBoundingClientRect().bottom < -2 * edge) {
      const first = w[0];
      keepingPosition(w[1], () => first.remove());
      win.start++;
      w = wraps();
    }
  }

  // render a fresh window at chapter i, `frac` of the way into it, `offset` px below the top edge
  function goToSection(i, frac = 0, offset = 0) {
    wraps().forEach(w => w.remove());
    if (!bookSections.length) return;
    i = Math.max(0, Math.min(i | 0, bookSections.length - 1));
    win = { start: i, end: i + 1 };
    const wrap = buildSection(i);
    reader.appendChild(wrap);
    // enough text below so the scroll position isn't clamped
    const h = wrap.getBoundingClientRect().height;
    while (win.end < bookSections.length &&
           reader.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top < frac * h + innerHeight + EDGE()) {
      reader.appendChild(buildSection(win.end++));
    }
    const r = wrap.lastElementChild.getBoundingClientRect();  // the text, not the divider above it
    scroller.scrollTop += r.top + frac * r.height - offset;
    fillWindow();
    updateActiveChapter();
  }

  // reading position: first chapter crossing the top edge + how far into it
  function currentPosition() {
    for (const w of wraps()) {
      const r = w.lastElementChild.getBoundingClientRect();
      if (r.bottom > 0) {
        const i = +w.dataset.i;
        return { i, href: bookSections[i].href, f: r.height ? Math.max(0, -r.top) / r.height : 0 };
      }
    }
    return null;
  }

  function restorePosition(saved) {
    let pos = null;
    try { pos = JSON.parse(saved); } catch {}
    if (pos && typeof pos === 'object') {
      // prefer the chapter file name: chapters may have been added/removed since
      const byHref = pos.href ? bookSections.findIndex(s => s.href === pos.href) : -1;
      goToSection(byHref >= 0 ? byHref : pos.i, pos.f);
      return;
    }
    if (typeof pos === 'number' && pos > 0) {
      // old format: a pixel offset in the full book. Lay the whole book out once to convert it
      wraps().forEach(w => w.remove());
      bookSections.forEach((_, i) => reader.appendChild(buildSection(i)));
      win = { start: 0, end: bookSections.length };
      scroller.scrollTop = pos;
      const p = currentPosition();
      goToSection(p ? p.i : 0, p ? p.f : 0);
      saveScrollPosition();
      return;
    }
    goToSection(0);
  }

  /* ── TOC parsing ── */
  async function parseToc(zip, manifest, opfDir, opfText) {
    // try NCX first (EPUB 2)
    const ncxId = Object.keys(manifest).find(id =>
      manifest[id].mediaType.includes('ncx') || manifest[id].href.endsWith('.ncx')
    );
    if (ncxId) {
      const entry = resolveZipFile(zip, opfDir, manifest[ncxId].href);
      if (entry) {
        try {
          const ncxText = await entry.async('text');
          const items = parseNcx(ncxText, opfDir);
          if (items.length) return items;
        } catch {}
      }
    }

    // try nav document (EPUB 3)
    const navId = Object.keys(manifest).find(id =>
      manifest[id].properties?.includes('nav') ||
      (manifest[id].mediaType.includes('xhtml') && manifest[id].href.includes('nav'))
    );
    if (navId) {
      const entry = resolveZipFile(zip, opfDir, manifest[navId].href);
      if (entry) {
        try {
          const navHtml = await entry.async('text');
          const items = parseNav(navHtml);
          if (items.length) return items;
        } catch {}
      }
    }

    // fallback: use spine items
    return xmlTags(opfText, 'itemref').map((attrs, i) => {
      const idref = attrs.idref;
      if (idref && manifest[idref]) {
        return { title: `Глава ${i + 1}`, href: manifest[idref].href, level: 0 };
      }
      return null;
    }).filter(Boolean);
  }

  function resolveZipFile(zip, opfDir, href) {
    const clean = href.replace(/^\.\//, '');
    const candidates = [clean, opfDir + '/' + clean, href, opfDir + '/' + href];
    for (const c of candidates) {
      const entry = zip.file(c);
      if (entry) return entry;
    }
    return null;
  }

  function parseNcx(ncxText, opfDir) {
    const items = [];
    const seen = new Set();

    // extract navLabel+content pairs (handles nested navPoints correctly)
    const pairRe = /<navLabel[^>]*>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s+src=["']([^"']+)["']/gi;
    let m;
    while ((m = pairRe.exec(ncxText)) !== null) {
      const src = m[2];
      if (seen.has(src)) continue;
      seen.add(src);
      const title = m[1].replace(/<[^>]+>/g, '').trim();
      items.push({ title: title || src.split('#')[0], href: src, level: 0 });
    }

    // fallback: try navPoint blocks if nothing found
    if (!items.length) {
      const npRe = /<navPoint[^>]*>([\s\S]*?)<\/navPoint>/gi;
      while ((m = npRe.exec(ncxText)) !== null) {
        const block = m[1];
        const label = xmlTag(block, 'text') || '';
        const src = xmlAttr(block, 'content', 'src') || '';
        if (src && !seen.has(src)) {
          seen.add(src);
          items.push({ title: label || src.split('#')[0], href: src, level: 0 });
        }
      }
    }

    return items;
  }

  function parseNav(navHtml) {
    const items = [];
    // extract <nav> element with toc
    const navMatch = navHtml.match(/<nav[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)
      || navHtml.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
    if (!navMatch) return items;

    const navContent = navMatch[1];
    // parse <li> entries
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(navContent)) !== null) {
      const aMatch = m[1].match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (aMatch) {
        const title = aMatch[2].replace(/<[^>]+>/g, '').trim();
        items.push({ title: title || aMatch[1].split('#')[0], href: aMatch[1], level: 0 });
      }
    }

    return items;
  }

  /* ── TOC rendering ── */
  function renderToc(chaps) {
    if (!chaps.length) {
      tocSection.style.display = 'none';
      return;
    }
    tocSection.style.display = '';
    tocList.innerHTML = chaps.map((ch, i) => {
      const cleanHref = ch.href.split('#')[0];
      return `<button class="toc-item indent-${Math.min(ch.level, 2)}" data-href="${esc(cleanHref)}" data-idx="${i}">${esc(ch.title)}</button>`;
    }).join('');

    tocList.querySelectorAll('.toc-item').forEach(btn => {
      btn.addEventListener('click', () => jumpToChapter(btn.dataset.href));
    });
  }

  function jumpToChapter(href) {
    const cleanHref = href.split('#')[0];
    const section = reader.querySelector(`.section-content[data-href="${CSS.escape(cleanHref)}"]`);
    if (section) {
      const y = scroller.scrollTop + section.getBoundingClientRect().top - 20;
      window.scrollTo({ top: y, behavior: 'smooth' });
    } else {
      const i = bookSections.findIndex(s => s.href === cleanHref);
      if (i >= 0) goToSection(i, 0, 20);
    }
    sidebar.classList.remove('open');
  }

  /* ── Active chapter tracking ── */
  function setupChapterTracking() {
    if (!chapters.length) return;
    window.addEventListener('scroll', updateActiveChapter, { passive: true });
    updateActiveChapter();
  }

  function updateActiveChapter() {
    if (!chapters.length) return;
    const sections = reader.querySelectorAll('.section-content');
    const scrollTop = scroller.scrollTop;
    let activeIdx = 0;

    for (let i = sections.length - 1; i >= 0; i--) {
      const sectionTop = sections[i].getBoundingClientRect().top + scrollTop;
      if (sectionTop - 60 <= scrollTop) {
        activeIdx = i;
        break;
      }
    }

    // find which chapter corresponds to this section
    const activeHref = sections[activeIdx]?.dataset?.href;
    if (!activeHref) return;

    tocList.querySelectorAll('.toc-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.href === activeHref);
    });

    // scroll active TOC item into view
    const activeBtn = tocList.querySelector('.toc-item.active');
    if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
  }

  /* ── CSS scoping helper ── */
  function scopeCss(css, scope) {
    // simple scoping: wrap each rule block with scope selector
    return css.replace(/([^{}]+)\{([^}]*)\}/g, (_, selectors, body) => {
      const scoped = selectors.split(',').map(s => {
        s = s.trim();
        if (!s || s.startsWith('@') || s.startsWith('from') || s.startsWith('to') ||
            s.match(/^\d+%$/)) return s;
        return `${scope} ${s}`;
      }).join(', ');
      return `${scoped} { ${adaptColors(body)} }`;
    });
  }

  // Book CSS is written for white paper: drop text colors (use theme text)
  // and turn solid backgrounds into a subtle theme-colored panel.
  function adaptColors(body) {
    return body.split(';').map(decl => {
      const i = decl.indexOf(':');
      if (i < 0) return decl;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim().toLowerCase();
      if (prop === 'color') return '';
      if (prop === 'background' || prop === 'background-color') {
        if (/url\(|gradient\(/.test(val) || /^(none|transparent|inherit|initial|unset)\b/.test(val)) return decl;
        return 'background-color: var(--sidebar-active)';
      }
      return decl;
    }).filter(d => d.trim()).join(';');
  }

  function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ── Scroll position save/restore ── */
  function saveScrollPosition() {
    if (!currentId) return;
    const pos = currentPosition();
    if (pos) localStorage.setItem(`epub-progress-${currentId}`, JSON.stringify(pos));
  }

  /* ── IndexedDB ── */
  const DB_NAME = 'epub-reader-db';
  const DB_STORE = 'books';

  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function idbSave(id, ab) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(ab, id);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }

  async function idbLoad(id) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(id);
      req.onsuccess = () => { db.close(); res(req.result); };
      req.onerror = () => { db.close(); rej(req.error); };
    });
  }

  async function idbDelete(id) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  }

  /* ── Keyboard shortcuts ── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'b' || e.key === 'B' || e.key === 'и' || e.key === 'И') {
      toggleSidebar();
    }
  });

  /* ── Start ── */
  init();

  // offline cache / installable app (needs https or localhost)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
