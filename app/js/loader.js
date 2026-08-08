/* global JSZip */
// Split from index.html — maintain in separate files under js/
import {
  state, isDesktop, desktopApi, $, readingPresets,
  uploadArea, readerContainer, readerContent, chapterList, sidebar,
  progressFill, pageNav, settingsPanel, importPanel, editorPanel,
  backupPanel, searchPanel, marksPanel, exportPanel, mobileMorePanel,
  readerDialog, readerDialogTitle, readerDialogMessage,
  dialogKeepEditingBtn, dialogDiscardBtn, dialogSaveBtn,
  pendingReaderDialogResolve, bookInput, folderInput, folderUploadBox,
  textFilePattern, bookFilePattern
, historyStorageKey} from './state.js';
import {
  getStoredJson, setStoredJson, escapeHtml, formatNumber,
  isSupportedFile, isBookFile, isPdfFile, isMarkdownFile,
  getFilenameWithoutExtension, saveFolderHandle, getSavedFolder,
  saveLibrarySnapshot, getSavedLibrary, getProgressStorageKey,
  getSavedProgress, getChapterEditsStorageKey, loadMarks, saveMarks,
  createLibraryIdentity, getHistoryIdentity
} from './storage.js';
import {
  getChapterKey, normalizeHistory, getReadingHistory,
  saveReadingHistory, renderReadingHistory, updateHistoryEntry,
  getHistoryProgress
} from './history.js';
import {
  setFolderSource, syncMobileMoreActions, closeFloatingPanels,
  openFloatingPanel, toggleMobileMorePanel, requestFolderPermission,
  chooseFolder, toggleImportPanel, updateFolder, nativeFileFromResult,
  loadDesktopBookPath, loadFromDesktopFolder, reloadSource,
  showSourceInExplorer, getSourceBackupRequest, openSourceBackups,
  loadFromDirectory
} from './folder-io.js';
import {
  naturalCompare, getWordCount, getBookWordCount, markdownToPlainText,
  normalizePunctuation, getPunctuationOptions, setPunctuationOptions,
  renderCustomRules, getCustomRules, addCustomRule, removeCustomRule, toggleCustomRule
} from './text-utils.js';
import {
  normalizeChapters, cloneChapters, getChapterSourceKey,
  loadChapterEdits, saveChapterEdits, applyChapterEdits,
  syncEditedChapterEdits, canSaveChapterToSource,
  getChapterSourceDocumentKey
} from './chapter.js';
import {
  inferChapterTypes, getChapterBodyContent, readBinaryFile, readFile,
  chaptersFromTextContent, parseBookFile, parseEpubFile, getEpubHtmlText,
  formatImportDiagnostics
} from './parser.js';
import {
  setDirectEditing, exitDirectEditing, saveDirectEdit,
  getDirectEditSnapshot, hasUnsavedDirectEdit, askUnsavedAction,
  updateEditorResult, handleCloseRequest, askAppDataImport,
  closeReaderDialog, getCurrentFileChapters
} from './editing.js';
import { replacePunctuation, undoPunctuation } from './punctuation-replace.js';
import { renderMarkdown } from './markdown.js';
import {
  renderSearchResults, updateSearch, refreshSearchIndex, setSearchScope,
  goToSearchMatch, renderMarks, addBookmark, addAnnotation, applyTextMarks,
  exportCurrentContent, updateExportControls, hideContextMenu,
  showContextMenu, copySelectionText, searchSelectionText,
  replaceSelectionText, closeReplaceDialog, applyReplaceDialog,
  saveContextMenuImage, setContextMenuImageSrc, contextMenu
} from './search.js';
import { renderChapterList, renderChapter, sidebarCollapsedGroups, setSidebarCollapsedGroups } from './chapter-render.js';
import {
  renderPdfViewer, cleanupPdfDocument, pdfGoToPage, pdfZoomIn,
  pdfZoomOut, isCurrentChapterPdf, savePdfPage, renderPdfPage
} from './pdf-viewer.js';
import { getChapterGroupInfo, updateNavButtonLabels, updateNavButtonStates } from './chapter-nav.js';
import { renderEpubViewer, epubGoToChapter, saveEpubChapter } from './epub-viewer.js';


async function lazyLoadChapter(chapter) {
  if (!chapter.lazyFolder || !chapter.lazyPath || !isDesktop) return;
  if (chapter.isEpubFile) {
    if (chapter.epubChapters && chapter.epubChapters.length > 0) return;
    try {
      const result = await desktopApi.readFolderFile(chapter.lazyFolder, chapter.lazyPath);
      const file = nativeFileFromResult(result);
      const parsed = await parseEpubFile(file);
      chapter.epubChapters = parsed.chapters.map((ch, i) => ({ ...ch, sourceKey: `${chapter.filename}\u0000${ch.sourceKey || ch.title}\u0000${i}` }));
      chapter.title = parsed.title || chapter.title;
      chapter.lazyFolder = '';
      chapter.lazyPath = '';
    } catch(e) {
      console.error('Lazy epub load failed:', e);
      chapter.epubChapters = [{ title: '加载失败', content: '请重新导入文件夹' }];
    }
    return;
  }
  if (chapter.content !== null) return;
  try {
    const result = await desktopApi.readFolderFile(chapter.lazyFolder, chapter.lazyPath);
    const file = nativeFileFromResult(result);
    const content = await readFile(file);
    chapter.content = content;
    if (!chapter.wordCount) chapter.wordCount = getWordCount(getChapterBodyContent(chapter), chapter.isMarkdown);
    chapter.lazyFolder = '';
    chapter.lazyPath = '';
    const relativePath = chapter.filename || '';
    if (relativePath) {
      state.sourceDocuments[relativePath] = { content, encoding: file.readerEncoding || '', bom: Boolean(file.readerBom) };
    }
  } catch(e) {
    console.error('Lazy chapter load failed:', e);
    chapter.content = '（加载失败，请重新导入文件夹）';
  }
}

async function selectChapter(index) {
  if (!state.chapters[index]) return false;
  if ((state.chapters[state.currentChapter]?.isPdf || state.chapters[state.currentChapter]?.isEpubFile) && !state.chapters[index]?.isPdf && !state.chapters[index]?.isEpubFile) {
    await cleanupPdfDocument();
  }
  if (state.directEditing && getDirectEditSnapshot() !== state.directEditOriginalText) {
    const action = await askUnsavedAction('switch');
    if (action === 'keep') return false;
    if (action === 'save' && !(await saveDirectEdit(false))) return false;
    setDirectEditing(false);
  } else if (state.directEditing) {
    setDirectEditing(false);
  }
  const ch = state.chapters[index];
  const needsLazyLoad = (ch && ch.lazyFolder && (ch.content === null || (ch.isEpubFile && (!ch.epubChapters || !ch.epubChapters.length))));
  if (needsLazyLoad) {
    showLoading(true);
    await lazyLoadChapter(ch);
    showLoading(false);
  }
  renderChapter(index);
  if (window.innerWidth < 841) toggleSidebar(false);
  return true;
}
function showLoading(show) { $('loading').classList.toggle('show', show); }

async function loadParsedChapters(chapters, bookTitle, folderHandle = null, options = {}) {
  if (!chapters.length) { showToast('没有解析出可阅读的章节'); return false; }
  if (state.directEditing && !(await exitDirectEditing())) return false;
  if (!options.isUpdate && !options.restoring) setSidebarCollapsedGroups({});
  syncEditedChapterEdits();
  const parsedChapters = inferChapterTypes(chapters);
  const previousEdits = { ...state.chapterEdits };
  const previousChapter = state.chapters[state.currentChapter];
  const previousKey = previousChapter ? (previousChapter.sourceKey || `${previousChapter.filename}\u0000${previousChapter.title}`) : '';
  const previousScroll = readerContainer.scrollTop;
  const shouldReapplyPunctuation = (options.isUpdate || options.restoring) ? state.punctuationOptions : null;
  if (!options.isUpdate && !options.restoring) state.punctuationOptions = null;
  state.customReplaceRules = [];
  state.demo = false;
  state.bookTitle = bookTitle || '我的小说';
  state.folderHandle = folderHandle || (options.isUpdate || options.restoring ? state.folderHandle : null);
  state.sourcePath = options.sourcePath || '';
  state.sourceType = options.sourceType || '';
  state.sourceAvailable = Boolean(state.sourcePath);
  state.sourceMissing = false;
  state.libraryIdentity = createLibraryIdentity({
    sourcePath: state.sourcePath,
    sourceType: state.sourceType,
    bookTitle: state.bookTitle,
    chapters: parsedChapters
  });
  state.marks = loadMarks();
  state.search = { query: '', scope: 'chapter', matches: [], currentIndex: -1 };
  state.sourceDocuments = options.sourceDocuments && typeof options.sourceDocuments === 'object'
    ? options.sourceDocuments
    : ((options.isUpdate || options.restoring) ? state.sourceDocuments : {});
  const sourceIsText = isDesktop && (
    state.sourceType === 'folder' ||
    (state.sourceType === 'book' && textFilePattern.test(state.sourcePath))
  );
  state.chapterEdits = sourceIsText
    ? {}
    : { ...loadChapterEdits(state.bookTitle, state), ...((options.isUpdate || options.restoring) ? previousEdits : {}) };
  if (sourceIsText) saveChapterEdits();
  state.punctuationHistory = null;
  $('punctuationUndoBtn').disabled = true;
  updateEditorResult('');
  $('bookTitle').textContent = state.bookTitle;
  document.title = `${state.bookTitle} - 阅读器`;

  state.chapters = parsedChapters;
  if (shouldReapplyPunctuation) {
    state.chapters = normalizeChapters(state.chapters, shouldReapplyPunctuation);
    setPunctuationOptions(shouldReapplyPunctuation);
  }
  state.chapters = applyChapterEdits(state.chapters);
  setFolderSource(folderHandle || state.folderHandle);
  openReader();

  let nextChapter = 0;
  if (options.isUpdate && previousKey) {
    const matchedIndex = state.chapters.findIndex(chapter => chapter.sourceKey === previousKey);
    if (matchedIndex >= 0) nextChapter = matchedIndex;
  }
  state.currentChapter = nextChapter;
  renderChapter(nextChapter, { saveProgress: false });
  if (options.isUpdate && previousKey) requestAnimationFrame(() => { readerContainer.scrollTop = previousScroll; });
  else if (!options.skipProgressRestore) restoreProgress();
  if (window.innerWidth >= 841 && state.chapters.length >= 3) toggleSidebar(true);
  await saveLibrarySnapshot();
  return true;
}

async function loadFromFileItems(items, bookTitle, folderHandle = null, options = {}) {
  const textItems = items
    .filter(item => (item?.file && isSupportedFile(item.file)) || (item?.lazyLoad && /\.(txt|md|markdown)$/i.test(item?.lazyFileName || item?.relativePath || '')))
    .sort((a, b) => naturalCompare(a.relativePath || a.file.name, b.relativePath || b.file.name));
  const pdfItems = items
    .filter(item => (item?.file && isPdfFile(item.file)) || (item?.lazyLoad && /\.pdf$/i.test(item?.lazyFileName || item?.relativePath || '')))
    .sort((a, b) => naturalCompare(a.relativePath || a.file.name, b.relativePath || b.file.name));
  const epubItems = items
    .filter(item => item?.isEpub || (item?.file && /\.epub$/i.test(item.file.name)) || (item?.lazyLoad && /\.epub$/i.test(item?.lazyFileName || item?.relativePath || '')))
    .sort((a, b) => naturalCompare(a.relativePath || a.file.name, b.relativePath || b.file.name));
  if (!textItems.length && !pdfItems.length && !epubItems.length) { showToast('没有找到可阅读的文件'); return false; }

  const chapters = [];
  const sourceDocuments = {};
  for (const item of textItems) {
    const relativePath = item.relativePath || item.file?.webkitRelativePath || item.file?.name || item.lazyFileName || '';
    const fileName = item.file?.name || item.lazyFileName || '';
    if (item.file && item.file.size > 0) {
      const content = await readFile(item.file);
      sourceDocuments[relativePath] = { content, encoding: item.file.readerEncoding || '', bom: Boolean(item.file.readerBom) };
      const textChapters = chaptersFromTextContent(content, fileName, relativePath, item.category || 'content');
      textChapters.forEach(ch => { ch.wordCount = getWordCount(getChapterBodyContent(ch), ch.isMarkdown); });
      chapters.push(...textChapters);
    } else {
      const isMd = /\.(md|markdown)$/i.test(fileName);
      chapters.push({
        title: getFilenameWithoutExtension(fileName),
        content: null,
        filename: relativePath,
        sourceKey: `${relativePath}\u0000${getFilenameWithoutExtension(fileName)}`,
        isMarkdown: isMd,
        isEpubHtml: false,
        isPdf: false,
        lazyFolder: item.folderPath || '',
        lazyPath: relativePath,
        wordCount: typeof item.wordCount === 'number' ? item.wordCount : 0,
        category: item.category || 'content'
      });
    }
  }
  for (const item of pdfItems) {
    const relativePath = item.relativePath || item.file?.webkitRelativePath || item.file?.name || item.lazyFileName || '';
    const fileName = item.file?.name || item.lazyFileName || '';
    if (item.file && item.file.size > 0) {
      const buffer = await readBinaryFile(item.file);
      chapters.push({
        title: getFilenameWithoutExtension(fileName),
        content: '',
        filename: relativePath,
        sourceKey: `${relativePath}\u0000pdf`,
        isMarkdown: false,
        isEpubHtml: false,
        isPdf: true,
        pdfBuffer: buffer,
        category: item.category || 'content'
      });
    } else {
      chapters.push({
        title: getFilenameWithoutExtension(fileName),
        content: '',
        filename: relativePath,
        sourceKey: `${relativePath}\u0000pdf`,
        isMarkdown: false,
        isEpubHtml: false,
        isPdf: true,
        pdfBuffer: null,
        pdfLazyFolder: item.folderPath || '',
        pdfLazyPath: relativePath,
        category: item.category || 'content'
      });
    }
  }
  for (const item of epubItems) {
    const relativePath = item.relativePath || item.file?.webkitRelativePath || item.file?.name || item.lazyFileName || '';
    const fileName = item.file?.name || item.lazyFileName || '';
    if ((!item.file || item.file.size === 0) && isDesktop && item.folderPath) {
      try {
        const result = await desktopApi.readFolderFile(item.folderPath, relativePath);
        item.file = nativeFileFromResult(result);
      } catch(e) { console.error('Lazy epub load failed:', relativePath, e); continue; }
    }
    try {
      const parsed = await parseEpubFile(item.file);
      const epubTitle = parsed.title || getFilenameWithoutExtension(fileName);
      chapters.push({
        title: epubTitle,
        content: '',
        filename: relativePath,
        sourceKey: `${relativePath}\u0000epub`,
        isMarkdown: false,
        isEpubHtml: false,
        isPdf: false,
        isEpubFile: true,
        epubChapters: parsed.chapters.map((ch, i) => ({ ...ch, sourceKey: `${relativePath}\u0000${ch.sourceKey || ch.title}\u0000${i}` })),
        lazyFolder: item.folderPath || '',
        lazyPath: relativePath,
        category: item.category || 'content'
      });
    } catch(e) { console.error('EPUB parse error in folder:', fileName, e); }
  }
  return loadParsedChapters(chapters, bookTitle, folderHandle, { ...options, sourceDocuments });
}

async function loadFromFiles(files) {
  const items = normalizeFileItems(files);
  if (!items.length) { showToast('没有找到可阅读的文件'); return; }
  showLoading(true);
  try {
    const firstPath = items[0].relativePath;
    const pathParts = firstPath.split('/');
    const bookTitle = pathParts.length > 1 ? pathParts[0] : '我的小说';
    setFolderSource(null);
    await loadFromFileItems(items, bookTitle, null);
    showToast(`已导入 ${state.chapters.length} 个章节`);
  } catch (error) {
    console.error(error); showToast('读取文件失败，请重试');
  } finally { showLoading(false); }
}

async function loadBookFile(file, options = {}) {
  showLoading(true);
  try {
    const parsed = await parseBookFile(file);
    setFolderSource(null);
    parsed.chapters.forEach(ch => { if (!ch.isPdf && !ch.isEpubFile) ch.wordCount = getWordCount(getChapterBodyContent(ch), ch.isMarkdown); });
    const loaded = await loadParsedChapters(parsed.chapters, parsed.title || getFilenameWithoutExtension(file.name), null, {
      ...options,
      sourceDocuments: parsed.sourceDocuments || {}
    });
    if (loaded) {
      const diagnostics = formatImportDiagnostics(parsed.diagnostics);
      showToast(`已导入 ${state.chapters.length} 个章节${diagnostics ? `；${diagnostics}` : ''}`);
    }
    return loaded;
  } catch (error) {
    console.error(error);
    showToast(error?.message || '解析书籍失败，请检查文件格式');
    return false;
  } finally {
    showLoading(false);
  }
}

async function loadBookFiles(files) {
  const supported = Array.from(files || []).filter(isBookFile);
  if (!supported.length) { showToast('请选择 TXT、EPUB、PDF 或 ZIP 文件'); return; }
  if (supported.length > 1) {
    showToast('一次请选择一本书');
    return;
  }
  await loadBookFile(supported[0]);
}

function loadDemo() {
  state.demo = true; state.bookTitle = '雾港来信'; $('bookTitle').textContent = state.bookTitle; document.title = `${state.bookTitle} - 阅读器`;
  state.sourcePath = '';
  state.sourceType = '';
  state.sourceAvailable = false;
  state.libraryIdentity = '';
  state.marks = [];
  state.search = { query: '', scope: 'chapter', matches: [], currentIndex: -1 };
  state.sourceDocuments = {};
  setFolderSource(null);
  state.chapterEdits = {};
  state.punctuationHistory = null;
  state.punctuationOptions = null;
  $('punctuationUndoBtn').disabled = true;
  updateEditorResult('');
  state.chapters = [
    { title: '第一章 潮汐写下的地址', filename: '01-潮汐写下的地址.txt', isMarkdown: false, content: '凌晨四点，雾港还没有醒来。\n\n潮水退到堤岸之外，露出一条窄窄的石路。林澈沿着石路往前走，手里的信封被海风吹得微微发抖。信上没有寄件人的名字，只有一个地址：灯塔下，第三块蓝色礁石。\n\n他在礁石旁找到了一只旧铁盒。盒盖上刻着一行字：如果你收到了这封信，说明我终于学会了告别。' },
    { title: '第二章 没有寄出的信', filename: '02-没有寄出的信.txt', isMarkdown: false, content: '铁盒里只有一张折叠得很整齐的纸。纸张已经发黄，墨水却清晰得像刚刚写下。\n\n"林澈，见字如面。你总说海会替人保守秘密，可海水也会把秘密送回岸上。等下一次潮汐来到这里，请替我看看灯塔的光。"\n\n他读了两遍，把信放回盒中。远处的灯塔忽然亮起，像有人在雾里按下了一盏迟到多年的灯。' },
    { title: '第三章 灯塔的回声', filename: '03-灯塔的回声.txt', isMarkdown: false, content: '天亮以后，雾散得很慢。林澈登上灯塔，窗外的海面被晨光切成细碎的银片。\n\n墙角摆着一台老式收音机，旋钮旁贴着一张褪色的便签：调到 87.6。\n\n杂音之后，熟悉的声音从很远的地方传来。那声音说，别急着把故事读完。有些答案，只有在你愿意继续往前走时，才会出现。' }
  ];
  openReader(); renderChapter(0); if (window.innerWidth >= 841) toggleSidebar(true); showToast('已加载示例章节');
}

function openReader() {
  document.body.classList.remove('home-mode');
  uploadArea.style.display = 'none';
  readerContainer.style.display = 'block';
  pageNav.style.display = 'flex';
}

async function showHome() {
  if (state.directEditing && !(await exitDirectEditing())) return false;
  await cleanupPdfDocument();
  state.epubViewer = { chapters: [], currentEpubChapter: 0 };
  if (state.chapters.length && !state.demo) await saveLibrarySnapshot();
  toggleSidebar(false);
  settingsPanel.classList.remove('show');
  editorPanel.classList.remove('show');
  backupPanel.classList.remove('show');
  searchPanel.classList.remove('show');
  marksPanel.classList.remove('show');
  exportPanel.classList.remove('show');
  toggleImportPanel(false);
  toggleMobileMorePanel(false);
  document.body.classList.add('home-mode');
  readerContainer.style.display = 'none';
  pageNav.style.display = 'none';
  uploadArea.style.display = 'block';
  progressFill.style.width = '0%';
  $('bookTitle').textContent = '阅读器';
  document.title = '阅读器';
  await renderReadingHistory();
  return true;
}

function toggleSidebar(force) {
  if (document.body.classList.contains('home-mode')) force = false;
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  readerContainer.classList.toggle('sidebar-open', open);
  pageNav.classList.toggle('sidebar-open', open);
}

function copyCurrentChapter() {
  const chapter = state.chapters[state.currentChapter]; if (!chapter) { showToast('请先导入一本书'); return; }
  const content = state.directEditing ? getDirectEditContent() : getChapterBodyContent(chapter);
  const text = chapter.isEpubHtml ? getEpubHtmlText(chapter.htmlContent || content) : (chapter.isMarkdown ? markdownToPlainText(content) : content);
  const done = () => showToast('已复制到剪贴板');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text)); else fallbackCopy(text);
}
function fallbackCopy(text) { const textarea = document.createElement('textarea'); textarea.value = text; textarea.style.position = 'fixed'; textarea.style.left = '-9999px'; document.body.appendChild(textarea); textarea.select(); try { document.execCommand('copy'); showToast('已复制到剪贴板'); } catch (_) { showToast('复制失败，请手动选择文本'); } textarea.remove(); }
function showToast(message) { $('copyToast').querySelector('span').textContent = message; $('copyToast').classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => $('copyToast').classList.remove('show'), 1700); }

function getReadingPreset(name = state.readingPreset) {
  return readingPresets[name] || readingPresets.comfortable;
}

function updateReadingSettingControls() {
  document.querySelectorAll('[data-preset]').forEach(el => el.classList.toggle('active', el.dataset.preset === state.readingPreset));
  document.querySelectorAll('[data-font]').forEach(el => el.classList.toggle('active', el.dataset.font === state.fontFamily));
  document.querySelectorAll('[data-line]').forEach(el => el.classList.toggle('active', Number(el.dataset.line) === Number(state.lineHeight)));
}

function setReadingPreset(name) {
  const preset = readingPresets[name];
  if (!preset) return;
  state.readingPreset = name;
  state.fontSize = preset.fontSize;
  state.lineHeight = preset.lineHeight;
  state.fontFamily = preset.fontFamily;
  state.readerPaperPadding = preset.paperPadding;
  state.readerPaperPaddingMobile = preset.paperPaddingMobile;
  applyReadingSettings();
  saveSettings();
}

function markCustomReadingSettings() {
  if (state.readingPreset !== 'custom') state.readingPreset = 'custom';
}

function applyReadingSettings() {
  $('fontSizeValue').textContent = `${state.fontSize} px`;
  document.querySelectorAll('.chapter-body p, .chapter-body ul, .chapter-body ol').forEach(el => el.style.fontSize = `${state.fontSize}px`);
  document.querySelectorAll('.chapter-body p, .chapter-body ul, .chapter-body ol, .chapter-body blockquote').forEach(el => el.style.lineHeight = state.lineHeight);
  const fonts = {
    serif: '"Noto Serif SC Variable", serif',
    sans: '"Noto Sans SC Variable", sans-serif',
    kai: '"LXGW WenKai Reader", serif',
    yuan: '"Smiley Sans Reader", sans-serif'
  };
  readerContent.style.setProperty('--reader-font-family', fonts[state.fontFamily] || fonts.serif);
  readerContent.style.setProperty('--reader-paper-padding', state.readerPaperPadding || getReadingPreset().paperPadding);
  readerContent.style.setProperty('--reader-paper-padding-mobile', state.readerPaperPaddingMobile || getReadingPreset().paperPaddingMobile);
  updateReadingSettingControls();
}
function saveSettings() {
  setStoredJson('reader_settings', {
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    theme: state.theme,
    fontFamily: state.fontFamily,
    readingPreset: state.readingPreset,
    readerPaperPadding: state.readerPaperPadding,
    readerPaperPaddingMobile: state.readerPaperPaddingMobile
  });
}
function loadSettings() {
  const saved = getStoredJson('reader_settings', {});
  const savedPreset = saved?.readingPreset === 'custom'
    ? 'custom'
    : (Object.prototype.hasOwnProperty.call(readingPresets, saved?.readingPreset) ? saved.readingPreset : 'comfortable');
  const preset = getReadingPreset(savedPreset === 'custom' ? 'comfortable' : savedPreset);
  Object.assign(state, {
    fontSize: Number(saved?.fontSize) || preset.fontSize,
    lineHeight: Number(saved?.lineHeight) || preset.lineHeight,
    theme: saved?.theme || 'default',
    fontFamily: saved?.fontFamily || preset.fontFamily,
    readingPreset: savedPreset,
    readerPaperPadding: saved?.readerPaperPadding || preset.paperPadding,
    readerPaperPaddingMobile: saved?.readerPaperPaddingMobile || preset.paperPaddingMobile
  });
  document.body.dataset.theme = state.theme; document.querySelectorAll('.theme-swatch').forEach(el => el.classList.toggle('active', el.dataset.theme === state.theme));
  applyReadingSettings();
}
function updateHistoryProgress() {
  if (!state.bookTitle || state.demo || !state.chapters.length) return;
  const history = normalizeHistory(getStoredJson(historyStorageKey, []));
  const historyId = getHistoryIdentity(state);
  const index = history.findIndex(entry => entry.id === historyId);
  if (index < 0) return;
  const entry = history[index];
  const now = Date.now();
  if (entry.currentChapter === state.currentChapter && now - Number(entry.lastOpenedAt || 0) < 30000) return;
  history[index] = { ...entry, currentChapter: state.currentChapter, lastOpenedAt: now };
  setStoredJson(historyStorageKey, history);
}
function saveProgress() {
  if (!state.bookTitle || state.demo) return;
  const chapter = state.chapters[state.currentChapter];
  const progressData = { chapter: state.currentChapter, scroll: readerContainer.scrollTop };
  if (chapter && chapter.isEpubFile) {
    progressData.epubChapter = state.epubViewer.currentEpubChapter;
    saveEpubChapter(state.currentChapter, state.epubViewer.currentEpubChapter);
  } else if (chapter && chapter.isPdf) {
    progressData.pdfPage = state.pdfViewer.currentPage;
    savePdfPage(state.currentChapter, state.pdfViewer.currentPage);
  }
  setStoredJson(getProgressStorageKey(), progressData);
  updateHistoryProgress();
}
async function restoreProgress() {
  if (state.demo) return;
  const saved = getSavedProgress();
  if (saved && saved.chapter < state.chapters.length) {
    const ch = state.chapters[saved.chapter];
    const needsLazy = ch && ch.lazyFolder && (ch.content === null || (ch.isEpubFile && (!ch.epubChapters || !ch.epubChapters.length)));
    if (needsLazy) {
      showLoading(true);
      await lazyLoadChapter(ch);
      showLoading(false);
    }
    renderChapter(saved.chapter, { saveProgress: false });
    const chapter = state.chapters[saved.chapter];
    if (chapter && chapter.isEpubFile) {
      // Epub chapter is restored inside renderEpubViewer via getEpubSavedChapter
    } else if (chapter && chapter.isPdf && saved.pdfPage) {
      // PDF page is restored inside renderPdfViewer via getPdfSavedPage
    } else {
      requestAnimationFrame(() => {
        readerContainer.scrollTop = saved.scroll || 0;
        saveProgress();
      });
    }
  }
}

function _initUI() {
folderUploadBox.addEventListener('click', event => { event.stopPropagation(); toggleImportPanel(true); });
folderUploadBox.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleImportPanel(true); } });
['dragenter', 'dragover'].forEach(type => folderUploadBox.addEventListener(type, event => { event.preventDefault(); folderUploadBox.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(type => folderUploadBox.addEventListener(type, event => { event.preventDefault(); folderUploadBox.classList.remove('dragover'); }));
folderUploadBox.addEventListener('drop', event => {
  const files = Array.from(event.dataTransfer.files || []);
  const hasDroppedBook = files.some(file => /\.(epub|zip|pdf)$/i.test(file.name)) || (files.length === 1 && isBookFile(files[0]) && !files[0].webkitRelativePath);
  if (hasDroppedBook) loadBookFiles(files);
  else loadFromFiles(files);
});
folderInput.addEventListener('change', event => { loadFromFiles(event.target.files); event.target.value = ''; });
$('openImportBtn').addEventListener('click', event => { event.stopPropagation(); toggleImportPanel(); });
$('closeImportBtn').addEventListener('click', () => toggleImportPanel(false));
$('chooseBookBtn').addEventListener('click', async () => {
  toggleImportPanel(false);
  if (isDesktop) {
    try {
      const filePath = await desktopApi.chooseBook();
      if (filePath) await loadDesktopBookPath(filePath);
    } catch (error) {
      console.error(error);
      showToast('打开书籍失败，请重试');
    }
    return;
  }
  bookInput.click();
});
$('chooseFolderBtn').addEventListener('click', () => { toggleImportPanel(false); chooseFolder(); });
bookInput.addEventListener('change', event => { loadBookFiles(event.target.files); event.target.value = ''; });
$('updateFolderBtn').addEventListener('click', updateFolder);
$('reloadSourceBtn').addEventListener('click', reloadSource);
$('sourceBackupBtn').addEventListener('click', event => {
  event.stopPropagation();
  openSourceBackups();
});
$('showSourceBtn').addEventListener('click', showSourceInExplorer);
$('mobileMoreBtn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMobileMorePanel();
});
$('mobileSettingsBtn').addEventListener('click', event => {
  event.stopPropagation();
  openFloatingPanel('settings');
});
$('mobileUpdateFolderBtn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMobileMorePanel(false);
  updateFolder();
});
$('mobileReloadSourceBtn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMobileMorePanel(false);
  reloadSource();
});
$('mobilePunctuationBtn').addEventListener('click', event => {
  event.stopPropagation();
  openFloatingPanel('editor');
});
$('mobileBackupsBtn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMobileMorePanel(false);
  openSourceBackups();
});
$('mobileShowSourceBtn').addEventListener('click', event => {
  event.stopPropagation();
  toggleMobileMorePanel(false);
  showSourceInExplorer();
});
$('mobileSearchBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('search', $('searchInput'));
  renderSearchResults();
});
$('mobileMarksBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('marks', $('markNoteInput'));
  renderMarks();
});
$('mobileExportBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('export');
  updateExportControls();
});
$('loadDemoBtn').addEventListener('click', loadDemo);
$('homeBtn').addEventListener('click', () => { showHome(); });
$('toggleSidebar').addEventListener('click', () => toggleSidebar());
$('toolbarCopyBtn').addEventListener('click', copyCurrentChapter);
$('searchBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('search', $('searchInput'));
  renderSearchResults();
});
$('marksBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('marks', $('markNoteInput'));
  renderMarks();
});
$('exportBtn').addEventListener('click', event => {
  event.stopPropagation();
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  openFloatingPanel('export');
  updateExportControls();
});
$('editorBtn').addEventListener('click', event => {
  event.stopPropagation();
  settingsPanel.classList.remove('show');
  editorPanel.classList.remove('show');
  toggleMobileMorePanel(false);
  if (state.directEditing) exitDirectEditing();
  else setDirectEditing(true);
});
$('punctuationRulesBtn').addEventListener('click', event => {
  event.stopPropagation();
  openFloatingPanel('editor');
});
$('closeEditorBtn').addEventListener('click', () => editorPanel.classList.remove('show'));
$('closeBackupBtn').addEventListener('click', () => backupPanel.classList.remove('show'));
$('closeSearchBtn').addEventListener('click', () => searchPanel.classList.remove('show'));
$('closeMarksBtn').addEventListener('click', () => marksPanel.classList.remove('show'));
$('closeExportBtn').addEventListener('click', () => exportPanel.classList.remove('show'));
dialogSaveBtn.addEventListener('click', () => closeReaderDialog('save'));
dialogDiscardBtn.addEventListener('click', () => closeReaderDialog('discard'));
dialogKeepEditingBtn.addEventListener('click', () => closeReaderDialog('keep'));
readerDialog.addEventListener('click', event => {
  if (event.target === readerDialog) closeReaderDialog('keep');
});
$('punctuationReplaceBtn').addEventListener('click', () => replacePunctuation('all'));
$('punctuationReplaceCurrentBtn').addEventListener('click', () => replacePunctuation('current'));
$('punctuationUndoBtn').addEventListener('click', undoPunctuation);
$('settingsBtn').addEventListener('click', event => {
  event.stopPropagation();
  openFloatingPanel('settings');
});
$('closeSettingsBtn').addEventListener('click', () => settingsPanel.classList.remove('show'));
$('changeStoragePathBtn')?.addEventListener('click', async () => {
  if (!desktopApi?.chooseStoragePath || !desktopApi?.migrateStorage) return;
  try {
    const newPath = await desktopApi.chooseStoragePath();
    if (!newPath) return;
    const info = await desktopApi.getStorageInfo();
    if (newPath === info.defaultPath && !info.isCustom) {
      showToast('已在默认位置，无需更改');
      return;
    }
    showToast('正在迁移数据，请勿关闭应用...');
    showLoading(true);
    const result = await desktopApi.migrateStorage(newPath);
    showLoading(false);
    if (result.success) {
      showToast('数据迁移完成，应用即将重启');
      setTimeout(() => { desktopApi.confirmClose && desktopApi.confirmClose(); location.reload(); }, 1500);
    }
  } catch(e) {
    showLoading(false);
    console.error(e);
    showToast(e?.message || '迁移失败，请重试');
  }
});
$('resetStoragePathBtn')?.addEventListener('click', async () => {
  if (!desktopApi?.resetStoragePath) return;
  try {
    showToast('正在恢复默认存储位置...');
    showLoading(true);
    const result = await desktopApi.resetStoragePath();
    showLoading(false);
    if (result.success) {
      showToast('已恢复默认位置，应用即将重启');
      setTimeout(() => { desktopApi.confirmClose && desktopApi.confirmClose(); location.reload(); }, 1500);
    }
  } catch(e) {
    showLoading(false);
    console.error(e);
    showToast(e?.message || '恢复失败，请重试');
  }
});
$('exportAppDataBtn').addEventListener('click', async () => {
  if (!desktopApi?.exportAppData) return;
  try {
    const result = await desktopApi.exportAppData();
    if (!result?.canceled) showToast(`应用数据已导出${result?.backupFiles ? `，包含 ${result.backupFiles} 份原文件备份` : ''}`);
  } catch (error) {
    console.error(error);
    showToast(error?.message || '导出应用数据失败，请重试');
  }
});
$('importAppDataBtn').addEventListener('click', async () => {
  if (!desktopApi?.importAppData) return;
  if ((await askAppDataImport()) !== 'save') return;
  try {
    const result = await desktopApi.importAppData();
    if (result?.canceled) return;
    showToast('应用数据已导入，正在重新加载');
    setTimeout(() => window.location.reload(), 500);
  } catch (error) {
    console.error(error);
    showToast(error?.message || '导入应用数据失败，请重试');
  }
});
$('checkUpdateBtn').addEventListener('click', async () => {
  if (!desktopApi?.checkForUpdates) return;
  try {
    await desktopApi.checkForUpdates();
  } catch (error) {
    console.error(error);
    showToast('检查更新失败，请稍后重试');
  }
});
$('downloadUpdateBtn').addEventListener('click', async () => {
  if (!desktopApi?.downloadUpdate) return;
  try {
    await desktopApi.downloadUpdate();
  } catch (error) {
    console.error(error);
    showToast('下载更新失败，请稍后重试');
  }
});
$('installUpdateBtn').addEventListener('click', () => {
  if (!desktopApi?.installUpdate) return;
  desktopApi.installUpdate().catch(error => {
    console.error(error);
    showToast('启动更新失败，请稍后重试');
  });
});
document.addEventListener('click', event => {
  if (!contextMenu.contains(event.target)) hideContextMenu();
  const selectionActive = !window.getSelection()?.isCollapsed;
  if (!settingsPanel.contains(event.target) && !$('settingsBtn').contains(event.target)) settingsPanel.classList.remove('show');
  if (!importPanel.contains(event.target) && !$('openImportBtn').contains(event.target) && !folderUploadBox.contains(event.target)) toggleImportPanel(false);
  if (!editorPanel.contains(event.target) && !$('editorBtn').contains(event.target) && !$('punctuationRulesBtn').contains(event.target)) editorPanel.classList.remove('show');
  if (!backupPanel.contains(event.target) && !$('sourceBackupBtn').contains(event.target)) backupPanel.classList.remove('show');
  if (!searchPanel.contains(event.target) && !$('searchBtn').contains(event.target) && !$('mobileSearchBtn').contains(event.target)) searchPanel.classList.remove('show');
  if (!selectionActive && !marksPanel.contains(event.target) && !$('marksBtn').contains(event.target) && !$('mobileMarksBtn').contains(event.target)) marksPanel.classList.remove('show');
  if (!exportPanel.contains(event.target) && !$('exportBtn').contains(event.target) && !$('mobileExportBtn').contains(event.target)) exportPanel.classList.remove('show');
  if (!mobileMorePanel.contains(event.target) && !$('mobileMoreBtn').contains(event.target)) toggleMobileMorePanel(false);
});
$('searchInput').addEventListener('input', event => updateSearch(event.target.value));
$('searchInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); goToSearchMatch(state.search.currentIndex + (event.shiftKey ? -1 : 1)); }
});
$('searchPreviousBtn').addEventListener('click', () => goToSearchMatch(state.search.currentIndex - 1));
$('searchNextBtn').addEventListener('click', () => goToSearchMatch(state.search.currentIndex + 1));
document.querySelectorAll('[data-search-scope]').forEach(button => button.addEventListener('click', () => {
  setSearchScope(button.dataset.searchScope);
}));
$('addBookmarkBtn').addEventListener('click', addBookmark);
$('addAnnotationBtn').addEventListener('click', addAnnotation);
readerContent.addEventListener('contextmenu', event => {
  if (state.directEditing) return;
  const image = event.target.closest('img');
  const isImage = Boolean(image && readerContent.contains(image));
  const selection = window.getSelection();
  const hasSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim().length && readerContent.contains(selection.anchorNode));
  if (!hasSelection && !isImage && !state.chapters.length) return;
  event.preventDefault();
  setContextMenuImageSrc(isImage ? image.getAttribute('src') || '' : '');
  showContextMenu(event.clientX, event.clientY, { hasSelection, isImage });
});
contextMenu.addEventListener('click', event => {
  const button = event.target.closest('button[data-menu]');
  if (!button) return;
  const action = button.dataset.menu;
  hideContextMenu();
  if (action === 'copy') copySelectionText();
  else if (action === 'search') searchSelectionText();
  else if (action === 'replace') replaceSelectionText();
  else if (action === 'bookmark') addBookmark();
  else if (action === 'save-image') saveContextMenuImage();
});
window.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('resize', hideContextMenu);
window.addEventListener('resize', () => { if (isCurrentChapterPdf() && state.pdfViewer.zoomMode === 'fit-width') { renderPdfPage(state.pdfViewer.currentPage); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideContextMenu(); });
document.querySelectorAll('[data-export-scope]').forEach(button => button.addEventListener('click', () => {
  state.exportScope = button.dataset.exportScope === 'book' ? 'book' : 'current';
  updateExportControls();
}));
document.querySelectorAll('[data-export-format]').forEach(button => button.addEventListener('click', () => {
  state.exportFormat = button.dataset.exportFormat === 'markdown' ? 'markdown' : 'text';
  updateExportControls();
}));
$('replaceCancelBtn').addEventListener('click', closeReplaceDialog);
$('replaceConfirmBtn').addEventListener('click', applyReplaceDialog);
$('replaceDialog').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); applyReplaceDialog(); } if (event.key === 'Escape') { event.preventDefault(); closeReplaceDialog(); } });
$('customRuleAddBtn').addEventListener('click', () => {
      const fromInput = $('customRuleFrom');
      const toInput = $('customRuleTo');
      const from = fromInput.value;
      const to = toInput.value;
      if (!from) { fromInput.focus(); return; }
      if (addCustomRule(from, to)) {
        fromInput.value = '';
        toInput.value = '';
        fromInput.focus();
        showToast('已添加自定义规则');
      } else {
        showToast('规则重复或原文为空');
      }
    });
    $('customRuleFrom').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('customRuleTo').focus(); } });
    $('customRuleTo').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('customRuleAddBtn').click(); } });
    $('customRulesList').addEventListener('click', event => {
      const item = event.target.closest('.custom-rule-item');
      if (!item) return;
      const index = Number(item.dataset.ruleIndex);
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'delete') removeCustomRule(index);
      else if (action === 'toggle') toggleCustomRule(index);
    });
    renderCustomRules();
    $('confirmExportBtn').addEventListener('click', exportCurrentContent);
$('historyFilterInput').addEventListener('input', () => renderReadingHistory());
$('historySortSelect').addEventListener('change', () => renderReadingHistory());
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => setReadingPreset(button.dataset.preset)));
$('fontPlus').addEventListener('click', () => { state.fontSize = Math.min(28, state.fontSize + 2); markCustomReadingSettings(); applyReadingSettings(); saveSettings(); });
$('fontMinus').addEventListener('click', () => { state.fontSize = Math.max(14, state.fontSize - 2); markCustomReadingSettings(); applyReadingSettings(); saveSettings(); });
document.querySelectorAll('.theme-swatch').forEach(button => button.addEventListener('click', () => { state.theme = button.dataset.theme; document.body.dataset.theme = state.theme; document.querySelectorAll('.theme-swatch').forEach(el => el.classList.toggle('active', el === button)); saveSettings(); }));
document.querySelectorAll('[data-font]').forEach(button => button.addEventListener('click', () => { state.fontFamily = button.dataset.font; markCustomReadingSettings(); applyReadingSettings(); saveSettings(); }));
document.querySelectorAll('[data-line]').forEach(button => button.addEventListener('click', () => { state.lineHeight = Number(button.dataset.line); markCustomReadingSettings(); applyReadingSettings(); saveSettings(); }));
$('prevPageBtn').addEventListener('click', () => {
  const ch = state.chapters[state.currentChapter];
  if (ch?.isPdf) {
    if (state.pdfViewer.currentPage > 1) { pdfGoToPage(state.pdfViewer.currentPage - 1); }
    else if (state.currentChapter > 0) { selectChapter(state.currentChapter - 1); }
    return;
  }
  if (ch?.isEpubFile) {
    const epubChs = ch.epubChapters || [];
    const idx = state.epubViewer.currentEpubChapter || 0;
    if (idx > 0) { epubGoToChapter(idx - 1); }
    else if (state.currentChapter > 0) { selectChapter(state.currentChapter - 1); }
    return;
  }
  if (state.currentChapter > 0) selectChapter(state.currentChapter - 1);
});
$('nextPageBtn').addEventListener('click', () => {
  const ch = state.chapters[state.currentChapter];
  if (ch?.isPdf) {
    const pageCount = state.pdfViewer.pageCount || 1;
    if (state.pdfViewer.currentPage < pageCount) { pdfGoToPage(state.pdfViewer.currentPage + 1); }
    else if (state.currentChapter < state.chapters.length - 1) { selectChapter(state.currentChapter + 1); }
    return;
  }
  if (ch?.isEpubFile) {
    const epubChs = ch.epubChapters || [];
    const idx = state.epubViewer.currentEpubChapter || 0;
    if (idx < epubChs.length - 1) { epubGoToChapter(idx + 1); }
    else if (state.currentChapter < state.chapters.length - 1) { selectChapter(state.currentChapter + 1); }
    return;
  }
  if (state.currentChapter < state.chapters.length - 1) selectChapter(state.currentChapter + 1);
});
$('scrollTopBtn').addEventListener('click', () => { readerContainer.scrollTo({ top: 0, behavior: 'smooth' }); });
$('scrollBottomBtn').addEventListener('click', () => { readerContainer.scrollTo({ top: readerContainer.scrollHeight, behavior: 'smooth' }); });
readerContainer.addEventListener('scroll', () => { const max = readerContent.scrollHeight - readerContainer.clientHeight; progressFill.style.width = `${max > 0 ? (readerContainer.scrollTop / max) * 100 : 0}%`; saveProgress(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pendingReaderDialogResolve) {
    event.preventDefault();
    closeReaderDialog('keep');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (state.directEditing) {
      event.preventDefault(); saveAndExitDirectEditing(); return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFloatingPanel('search', $('searchInput'));
    $('searchInput').focus();
    $('searchInput').select();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    if (state.search.matches.length) goToSearchMatch(state.search.currentIndex + (event.shiftKey ? -1 : 1));
    return;
  }
  if (event.key === 'F3') {
    event.preventDefault();
    if (state.search.matches.length) goToSearchMatch(state.search.currentIndex + (event.shiftKey ? -1 : 1));
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    $('editorBtn').click();
    return;
  }
  if (event.target.matches('input, textarea, button')) return;
  const currentCh = state.chapters[state.currentChapter];
  if (currentCh?.isEpubFile) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); epubGoToChapter(state.epubViewer.currentEpubChapter - 1); return; }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); epubGoToChapter(state.epubViewer.currentEpubChapter + 1); return; }
    if (event.key === 'Home') { event.preventDefault(); epubGoToChapter(0); return; }
    if (event.key === 'End') { event.preventDefault(); epubGoToChapter(state.epubViewer.chapters.length - 1); return; }
    return;
  }
  if (isCurrentChapterPdf()) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); pdfGoToPage(state.pdfViewer.currentPage - 1); return; }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); pdfGoToPage(state.pdfViewer.currentPage + 1); return; }
    if (event.key === 'Home') { event.preventDefault(); pdfGoToPage(1); return; }
    if (event.key === 'End') { event.preventDefault(); pdfGoToPage(state.pdfViewer.pageCount); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); pdfZoomIn(); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); pdfZoomOut(); return; }
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') $('prevPageBtn').click();
  if (event.key === 'ArrowRight' || event.key === 'PageDown') $('nextPageBtn').click();
  if (event.key.toLowerCase() === 'b') toggleSidebar();
  if (event.key === '+' || event.key === '=') $('fontPlus').click();
  if (event.key === '-' || event.key === '_') $('fontMinus').click();
});

}
export { lazyLoadChapter, selectChapter, showLoading, loadParsedChapters, loadFromFileItems, loadFromFiles, loadBookFile, loadBookFiles, loadDemo, openReader, showHome, toggleSidebar, copyCurrentChapter, fallbackCopy, showToast, getReadingPreset, updateReadingSettingControls, setReadingPreset, markCustomReadingSettings, applyReadingSettings, saveSettings, loadSettings, updateHistoryProgress, saveProgress, restoreProgress };


// Defer UI initialization to break circular dependency with state.js
setTimeout(_initUI, 0);