// Split from index.html — maintain in separate files under js/
import { state, $, readerContent, readerContainer, progressFill } from './state.js';
import { escapeHtml, formatNumber } from './storage.js';
import { getWordCount } from './text-utils.js';
import { renderMarkdown } from './markdown.js';
import { applyTextMarks } from './search.js';
import { renderChapterList } from './chapter-render.js';
import { syncMobileMoreActions } from './folder-io.js';
import { updateNavButtonLabels, updateNavButtonStates } from './chapter-nav.js';
import { applyReadingSettings, saveProgress } from './loader.js';

export function renderEpubViewer(chapter, chapterIndex) {
  if (state.pdfViewer.document) { try { state.pdfViewer.document.destroy(); } catch(_) {} state.pdfViewer.document = null; }
  state.pdfViewer.pageCount = 0;
  state.pdfViewer.currentPage = 1;
  state.pdfViewer.renderTask = null;
  const epubChapters = chapter.epubChapters || [];
  if (!epubChapters.length) {
    readerContent.innerHTML = '<div class="epub-viewer-container"><div class="epub-loading">该电子书暂无内容。</div></div>';
    return;
  }
  state.epubViewer.chapters = epubChapters;
  const savedIdx = getEpubSavedChapter(chapterIndex);
  const epubIdx = Math.max(0, Math.min(savedIdx, epubChapters.length - 1));
  state.epubViewer.currentEpubChapter = epubIdx;
  renderEpubChapter(chapter, chapterIndex, epubIdx);
}

export function renderEpubChapter(chapter, chapterIndex, epubIdx) {
  const epubChapters = chapter.epubChapters || [];
  const epCh = epubChapters[epubIdx];
  if (!epCh) return;
  state.epubViewer.currentEpubChapter = epubIdx;
  const epContent = (epCh.content || '').replace(/^\uFEFF/, '');
  const isMd = Boolean(epCh.isMarkdown);
  const bodyHtml = epCh.htmlContent || (isMd ? renderMarkdown(epContent) : epContent.split(/\n+/).filter(line => line.trim()).map(line => `<p>${escapeHtml(line.trim())}</p>`).join(''));
  const headerHtml = `<header class="mb-11 text-center"><div class="mb-4 text-[10px] font-bold uppercase tracking-[.17em] text-[var(--accent)]">Chapter ${String(epubIdx + 1).padStart(2, '0')}</div><h1 class="chapter-title">${escapeHtml(epCh.title || '')}</h1><div class="chapter-divider"></div><div class="chapter-meta"><span>第 ${epubIdx + 1} / ${epubChapters.length} 章</span><span class="meta-dot"></span><span class="meta-accent">${formatNumber(getWordCount(epContent, isMd))} 字</span></div></header>`;
  const endHtml = '<div class="chapter-end"><i class="fa-solid fa-feather-pointed mr-2 text-[var(--accent)]"></i>本章完</div>';
  const navOptions = epubChapters.map((ch, i) => `<option value="${i}"${i === epubIdx ? ' selected' : ''}>${escapeHtml(ch.title || ('第 ' + (i + 1) + ' 章'))}</option>`).join('');
  const navHtml = `<div class="epub-nav-bar"><button type="button" id="epubPrevChBtn" title="上一节 (←)" ${epubIdx === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button><select class="epub-nav-select" id="epubNavSelect">${navOptions}</select><button type="button" id="epubNextChBtn" title="下一节 (→)" ${epubIdx >= epubChapters.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div>`;
  readerContent.innerHTML = `<div class="epub-viewer-container">${navHtml}${headerHtml}<div class="chapter-body${epCh.htmlContent ? ' epub-html' : ''}${epCh.isCover ? ' epub-cover' : ''}">${bodyHtml || '<p>本章暂无正文。</p>'}</div>${endHtml}</div>`;
  const prevBtn = $('epubPrevChBtn');
  const nextBtn = $('epubNextChBtn');
  const navSel = $('epubNavSelect');
  if (prevBtn) prevBtn.addEventListener('click', () => epubGoToChapter(epubIdx - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => epubGoToChapter(epubIdx + 1));
  if (navSel) navSel.addEventListener('change', () => { const idx = Number(navSel.value); if (!Number.isNaN(idx)) epubGoToChapter(idx); });
  applyReadingSettings();
  applyTextMarks();
  renderChapterList();
  $('sourceBackupBtn').classList.toggle('show', false);
  syncMobileMoreActions();
  updateNavButtonLabels();
  updateNavButtonStates();
  readerContainer.scrollTop = 0;
  progressFill.style.width = `${epubChapters.length > 0 ? ((epubIdx + 1) / epubChapters.length) * 100 : 0}%`;
  saveProgress();
  saveEpubChapter(chapterIndex, epubIdx);
}

export function getEpubSavedChapter(chapterIndex) {
  try {
    const key = 'reader_epub_chapters';
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const libKey = state.libraryIdentity || state.bookTitle;
    const pages = data[libKey];
    if (pages && typeof pages[chapterIndex] === 'number') return pages[chapterIndex];
  } catch(_) {}
  return 0;
}

export function saveEpubChapter(chapterIndex, epubIdx) {
  try {
    const key = 'reader_epub_chapters';
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const libKey = state.libraryIdentity || state.bookTitle;
    if (!data[libKey]) data[libKey] = {};
    data[libKey][chapterIndex] = epubIdx;
    localStorage.setItem(key, JSON.stringify(data));
  } catch(_) {}
}

export function epubGoToChapter(epubIdx) {
  const chapter = state.chapters[state.currentChapter];
  if (!chapter || !chapter.isEpubFile) return;
  const epubChapters = chapter.epubChapters || [];
  const clamped = Math.max(0, Math.min(epubIdx, epubChapters.length - 1));
  if (clamped !== state.epubViewer.currentEpubChapter) {
    renderEpubChapter(chapter, state.currentChapter, clamped);
  }
}
