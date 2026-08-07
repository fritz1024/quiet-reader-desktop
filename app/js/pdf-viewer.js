// Split from index.html — maintain in separate files under js/
// ── PDF Viewer Engine ──
const pdfPageCache = new Map();
const PDF_CACHE_MAX = 10;

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

async function renderPdfViewer(chapter, chapterIndex) {
  await cleanupPdfDocument();
  state.epubViewer = { chapters: [], currentEpubChapter: 0 };
  if (!chapter.pdfBuffer && chapter.pdfLazyFolder && chapter.pdfLazyPath && isDesktop) {
    readerContent.innerHTML = '<div class="pdf-viewer-container"><div class="pdf-canvas-wrapper"><div class="pdf-loading">正在加载 PDF...</div></div></div>';
    try {
      const result = await desktopApi.readFolderFile(chapter.pdfLazyFolder, chapter.pdfLazyPath);
      const file = nativeFileFromResult(result);
      chapter.pdfBuffer = await readBinaryFile(file);
    } catch(e) {
      console.error('Lazy PDF load failed:', e);
      readerContent.innerHTML = '<div class="pdf-viewer-container"><div class="pdf-canvas-wrapper"><div class="pdf-loading">PDF 加载失败，请重新导入文件夹。</div></div></div>';
      return;
    }
  }
  if (!chapter.pdfBuffer) {
    readerContent.innerHTML = '<div class="pdf-viewer-container"><div class="pdf-canvas-wrapper"><div class="pdf-loading">PDF 数据不可用，请重新从原文件导入。</div></div></div>';
    return;
  }
  readerContent.innerHTML = '<div class="pdf-viewer-container"><div class="pdf-toolbar"><div class="pdf-page-controls"><button id="pdfFirstPage" class="icon-button" title="首页"><i class="fa-solid fa-angles-left"></i></button><button id="pdfPrevPage" class="icon-button" title="上一页"><i class="fa-solid fa-angle-left"></i></button><span class="pdf-page-indicator"><input type="number" id="pdfPageInput" min="1" value="1" /> / <span id="pdfPageCount">-</span></span><button id="pdfNextPage" class="icon-button" title="下一页"><i class="fa-solid fa-angle-right"></i></button><button id="pdfLastPage" class="icon-button" title="末页"><i class="fa-solid fa-angles-right"></i></button></div><div class="pdf-zoom-controls"><button id="pdfZoomOut" class="icon-button" title="缩小"><i class="fa-solid fa-magnifying-glass-minus"></i></button><button id="pdfFitWidth" class="icon-button active" title="适合宽度"><i class="fa-solid fa-arrows-left-right"></i></button><button id="pdfZoomIn" class="icon-button" title="放大"><i class="fa-solid fa-magnifying-glass-plus"></i></button></div><div class="pdf-dark-toggle"><button id="pdfDarkInvert" class="icon-button" title="反色模式"><i class="fa-solid fa-circle-half-stroke"></i></button></div></div><div class="pdf-canvas-wrapper" id="pdfCanvasWrapper"><div class="pdf-loading" id="pdfLoading">正在加载 PDF...</div></div></div>';

  const savedPage = getPdfSavedPage(chapterIndex);
  try {
    const loadingTask = pdfjsLib.getDocument({ data: chapter.pdfBuffer.slice(0) });
    const pdfDocument = await loadingTask.promise;
    state.pdfViewer.document = pdfDocument;
    state.pdfViewer.pageCount = pdfDocument.numPages;
    state.pdfViewer.currentPage = savedPage || 1;
    $('pdfPageCount').textContent = pdfDocument.numPages;
    $('pdfPageInput').max = pdfDocument.numPages;
    $('pdfPageInput').value = state.pdfViewer.currentPage;
    $('pdfLoading').style.display = 'none';
    bindPdfToolbarEvents();
    await renderPdfPage(state.pdfViewer.currentPage);
  } catch (error) {
    console.error('PDF load error:', error);
    const loading = $('pdfLoading');
    if (loading) loading.textContent = 'PDF 加载失败：' + (error.message || '未知错误');
  }
}

async function renderPdfPage(pageNumber) {
  const pdfDocument = state.pdfViewer.document;
  if (!pdfDocument || state.pdfViewer.rendering) return;
  if (state.pdfViewer.renderTask) { try { state.pdfViewer.renderTask.cancel(); } catch(_) {} }
  state.pdfViewer.rendering = true;
  let wrapper = $('pdfCanvasWrapper');
  if (!wrapper) { state.pdfViewer.rendering = false; return; }
  let canvas = $('pdfCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'pdfCanvas';
    wrapper.appendChild(canvas);
  }
  const context = canvas.getContext('2d');
  try {
    const page = await pdfDocument.getPage(pageNumber);
    const wrapperWidth = wrapper.clientWidth - 32;
    const wrapperHeight = wrapper.clientHeight - 16;
    const defaultViewport = page.getViewport({ scale: 1 });
    let scale;
    if (state.pdfViewer.zoomMode === 'fit-width') {
      scale = wrapperWidth / defaultViewport.width;
    } else if (state.pdfViewer.zoomMode === 'fit-page') {
      scale = Math.min(wrapperWidth / defaultViewport.width, wrapperHeight / defaultViewport.height);
    } else {
      scale = state.pdfViewer.zoomLevel;
    }
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * outputScale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / outputScale) + 'px';
    canvas.style.height = Math.floor(viewport.height / outputScale) + 'px';
    if (state.pdfViewer.darkInvert) canvas.classList.add('pdf-inverted');
    else canvas.classList.remove('pdf-inverted');
    const renderContext = { canvasContext: context, viewport: viewport };
    state.pdfViewer.renderTask = page.render(renderContext);
    await state.pdfViewer.renderTask.promise;
    page.cleanup();
    state.pdfViewer.currentPage = pageNumber;
    const input = $('pdfPageInput');
    if (input) input.value = pageNumber;
    prefetchPdfPage(pageNumber + 1);
    prefetchPdfPage(pageNumber - 1);
    updatePdfProgress();
    if (typeof updateNavButtonStates === 'function') updateNavButtonStates();
    saveProgress();
  } catch (error) {
    if (error && error.name !== 'RenderingCancelledException') console.error('PDF page render error:', error);
  } finally {
    state.pdfViewer.rendering = false;
    state.pdfViewer.renderTask = null;
  }
}

function updatePdfProgress() {
  const total = state.pdfViewer.pageCount;
  const current = state.pdfViewer.currentPage;
  if (total > 0) {
    progressFill.style.width = `${(current / total) * 100}%`;
  }
}

function getPdfSavedPage(chapterIndex) {
  try {
    const key = 'reader_pdf_pages';
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const libKey = state.libraryIdentity || state.bookTitle;
    const pages = data[libKey];
    if (pages && typeof pages[chapterIndex] === 'number') return pages[chapterIndex];
  } catch(_) {}
  return 0;
}

function savePdfPage(chapterIndex, page) {
  try {
    const key = 'reader_pdf_pages';
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const libKey = state.libraryIdentity || state.bookTitle;
    if (!data[libKey]) data[libKey] = {};
    data[libKey][chapterIndex] = page;
    localStorage.setItem(key, JSON.stringify(data));
  } catch(_) {}
}

async function prefetchPdfPage(pageNumber) {
  const pdfDocument = state.pdfViewer.document;
  if (!pdfDocument || pageNumber < 1 || pageNumber > state.pdfViewer.pageCount) return;
  const cacheKey = `${state.currentChapter}_${pageNumber}`;
  if (pdfPageCache.has(cacheKey)) return;
  try {
    const page = await pdfDocument.getPage(pageNumber);
    pdfPageCache.set(cacheKey, page);
    if (pdfPageCache.size > PDF_CACHE_MAX) {
      const firstKey = pdfPageCache.keys().next().value;
      const evicted = pdfPageCache.get(firstKey);
      if (evicted) try { evicted.cleanup(); } catch(_) {}
      pdfPageCache.delete(firstKey);
    }
  } catch(_) {}
}

function bindPdfToolbarEvents() {
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  bind('pdfFirstPage', () => pdfGoToPage(1));
  bind('pdfPrevPage', () => pdfGoToPage(state.pdfViewer.currentPage - 1));
  bind('pdfNextPage', () => pdfGoToPage(state.pdfViewer.currentPage + 1));
  bind('pdfLastPage', () => pdfGoToPage(state.pdfViewer.pageCount));
  bind('pdfZoomIn', () => pdfZoomIn());
  bind('pdfZoomOut', () => pdfZoomOut());
  bind('pdfFitWidth', () => pdfFitWidth());
  bind('pdfDarkInvert', () => pdfToggleDarkInvert());
  const input = $('pdfPageInput');
  if (input) {
    input.addEventListener('change', () => {
      const val = parseInt(input.value, 10);
      if (val >= 1 && val <= state.pdfViewer.pageCount) pdfGoToPage(val);
      else input.value = state.pdfViewer.currentPage;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      e.stopPropagation();
    });
  }
}

function pdfGoToPage(pageNumber) {
  const clamped = Math.max(1, Math.min(pageNumber, state.pdfViewer.pageCount));
  if (clamped !== state.pdfViewer.currentPage) {
    renderPdfPage(clamped);
    savePdfPage(state.currentChapter, clamped);
  }
}

function pdfZoomIn() {
  state.pdfViewer.zoomMode = 'custom';
  state.pdfViewer.zoomLevel = Math.min(state.pdfViewer.zoomLevel * 1.25, 5.0);
  const btn = $('pdfFitWidth'); if (btn) btn.classList.remove('active');
  renderPdfPage(state.pdfViewer.currentPage);
}

function pdfZoomOut() {
  state.pdfViewer.zoomMode = 'custom';
  state.pdfViewer.zoomLevel = Math.max(state.pdfViewer.zoomLevel / 1.25, 0.25);
  const btn = $('pdfFitWidth'); if (btn) btn.classList.remove('active');
  renderPdfPage(state.pdfViewer.currentPage);
}

function pdfFitWidth() {
  state.pdfViewer.zoomMode = 'fit-width';
  const btn = $('pdfFitWidth'); if (btn) btn.classList.add('active');
  renderPdfPage(state.pdfViewer.currentPage);
}

function pdfToggleDarkInvert() {
  state.pdfViewer.darkInvert = !state.pdfViewer.darkInvert;
  const btn = $('pdfDarkInvert'); if (btn) btn.classList.toggle('active', state.pdfViewer.darkInvert);
  const canvas = $('pdfCanvas');
  if (canvas) canvas.classList.toggle('pdf-inverted', state.pdfViewer.darkInvert);
}

async function cleanupPdfDocument() {
  if (state.pdfViewer.renderTask) { try { state.pdfViewer.renderTask.cancel(); } catch(_) {} }
  if (state.pdfViewer.document) {
    try { state.pdfViewer.document.destroy(); } catch(_) {}
    state.pdfViewer.document = null;
  }
  state.pdfViewer.pageCount = 0;
  state.pdfViewer.currentPage = 1;
  state.pdfViewer.rendering = false;
  state.pdfViewer.renderTask = null;
  for (const page of pdfPageCache.values()) {
    try { page.cleanup(); } catch(_) {}
  }
  pdfPageCache.clear();
}

function isCurrentChapterPdf() {
  return Boolean(state.chapters[state.currentChapter]?.isPdf);
}
