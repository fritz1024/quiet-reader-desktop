// Split from index.html — maintain in separate files under js/
import { isDesktop, desktopApi, desktopStorage, desktopStorageWrite, setDesktopStorageWrite, desktopStorageTimer, setDesktopStorageTimer, state, textFilePattern, bookFilePattern, pdfFilePattern, folderDatabaseName, folderStoreName, folderDatabasePromise, setFolderDatabasePromise, historyStorageKey, historyLimit } from './state.js';
import { showToast } from './loader.js';
import { getBookWordCount } from './text-utils.js';
import { saveReadingHistory } from './history.js';

export function getStoredJson(key, fallback = null) {
  if (isDesktop) return Object.prototype.hasOwnProperty.call(desktopStorage, key) ? desktopStorage[key] : fallback;
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch (_) { return fallback; }
}

export function persistDesktopStorage() {
  if (!isDesktop) return Promise.resolve();
  setDesktopStorageWrite(desktopStorageWrite.catch(() => undefined).then(() => desktopApi.saveStorage(desktopStorage)));
  return desktopStorageWrite.catch(error => {
    console.error(error);
    showToast('本地保存失败，请检查磁盘空间');
  });
}

export function scheduleDesktopStorageSave() {
  if (!isDesktop) return;
  clearTimeout(desktopStorageTimer);
  setDesktopStorageTimer(setTimeout(() => { persistDesktopStorage(); }, 350));
}

export function setStoredJson(key, value, { immediate = false } = {}) {
  if (isDesktop) {
    desktopStorage[key] = value;
    return immediate ? persistDesktopStorage() : (scheduleDesktopStorageSave(), Promise.resolve());
  }
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* browser storage quota can be smaller than a complete library */ }
  return Promise.resolve();
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

export function formatNumber(num) { return Number(num || 0).toLocaleString('zh-CN'); }
export function isSupportedFile(file) { return textFilePattern.test(file.name); }
export function isBookFile(file) { return bookFilePattern.test(file.name); }
export function isPdfFile(file) { return pdfFilePattern.test(typeof file === 'string' ? file : file.name); }
export function isMarkdownFile(file) {
  const name = typeof file === 'string' ? file : file?.name;
  return /\.(md|markdown)$/i.test(String(name || ''));
}
export function getFilenameWithoutExtension(filename) { return filename.replace(/\.(txt|md|markdown|epub|zip|pdf)$/i, ''); }

export function openFolderDatabase() {
  if (isDesktop) return Promise.resolve(null);
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!folderDatabasePromise) {
    setFolderDatabasePromise(new Promise((resolve) => {
      try {
        const request = indexedDB.open(folderDatabaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(folderStoreName, { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    }));
  }
  return folderDatabasePromise;
}

export async function saveFolderHandle(handle) {
  if (isDesktop) return;
  const database = await openFolderDatabase();
  if (!database || !handle) return;
  await new Promise((resolve) => {
    const transaction = database.transaction(folderStoreName, 'readwrite');
    transaction.objectStore(folderStoreName).put({ id: 'last-folder', handle, title: handle.name });
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

export async function getSavedFolder() {
  if (isDesktop) return null;
  const database = await openFolderDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const request = database.transaction(folderStoreName, 'readonly').objectStore(folderStoreName).get('last-folder');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

export async function saveLibrarySnapshot() {
  if (!state.chapters.length || state.demo) return;
  const sourceBacked = isDesktop && Boolean(state.sourcePath) && state.sourceAvailable;
  const snapshot = {
    id: 'last-library',
    libraryIdentity: state.libraryIdentity,
    bookTitle: state.bookTitle,
    currentChapter: state.currentChapter,
    sourcePath: state.sourcePath,
    sourceType: state.sourceType,
    sourceAvailable: state.sourceAvailable,
    sourceMissing: state.sourceMissing,
    punctuationOptions: state.punctuationOptions ? { ...state.punctuationOptions } : null,
    customReplaceRules: Array.isArray(state.customReplaceRules) ? [...state.customReplaceRules] : [],
    chapterEdits: { ...state.chapterEdits },
    chapterCount: state.chapters.length,
    wordCount: getBookWordCount(),
    chapters: state.chapters.map(({ title, content, htmlContent, filename, sourceKey, sourceDocumentKey, sourceBodyStart, sourceBodyEnd, isMarkdown, isEpubHtml, isCover, isPdf, isEpubFile, lazyFolder, lazyPath, category, wordCount }) => ({
      title,
      ...(sourceBacked ? {} : (isPdf ? {} : { content, htmlContent })),
      filename,
      sourceKey,
      sourceDocumentKey,
      sourceBodyStart,
      sourceBodyEnd,
      isMarkdown,
      isEpubHtml,
      isCover,
      isPdf: Boolean(isPdf),
      isEpubFile: Boolean(isEpubFile),
      lazyFolder: isEpubFile ? (lazyFolder || '') : undefined,
      lazyPath: isEpubFile ? (lazyPath || '') : undefined,
      category,
      wordCount: typeof wordCount === 'number' ? wordCount : undefined
    }))
  };
  if (isDesktop) {
    await setStoredJson('reader_last_library', snapshot, { immediate: true });
    await saveReadingHistory(snapshot);
    return;
  }
  try { localStorage.setItem('reader_last_library', JSON.stringify(snapshot)); } catch (_) { /* IndexedDB remains the primary store for large libraries */ }
  const database = await openFolderDatabase();
  if (database) {
    await new Promise((resolve) => {
      const transaction = database.transaction(folderStoreName, 'readwrite');
      transaction.objectStore(folderStoreName).put(snapshot);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }
  await saveReadingHistory(snapshot);
}

export async function getSavedLibrary() {
  if (isDesktop) return getStoredJson('reader_last_library');
  const database = await openFolderDatabase();
  if (database) {
    const saved = await new Promise((resolve) => {
      const request = database.transaction(folderStoreName, 'readonly').objectStore(folderStoreName).get('last-library');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
    if (saved) return saved;
  }
  try { return JSON.parse(localStorage.getItem('reader_last_library') || 'null'); } catch (_) { return null; }
}

export function hashLibrarySignature(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createLibraryIdentity({ sourcePath = '', sourceType = '', bookTitle = '', chapters = [] } = {}) {
  const normalizedPath = String(sourcePath).trim();
  if (normalizedPath) return `${sourceType || 'book'}:${normalizedPath.toLowerCase()}`;
  const chapterSignature = (Array.isArray(chapters) ? chapters : [])
    .map(chapter => `${chapter?.sourceKey || ''}\u0000${chapter?.filename || ''}\u0000${chapter?.title || ''}\u0000${String(chapter?.content || '').length}`)
    .join('\u0001');
  return `local:${bookTitle || 'untitled'}:${hashLibrarySignature(chapterSignature || bookTitle || 'untitled')}`;
}

export function getHistoryIdentity(snapshot) {
  const savedIdentity = String(snapshot?.libraryIdentity || '').trim();
  if (savedIdentity) return savedIdentity;
  const sourcePath = String(snapshot?.sourcePath || '').trim();
  if (sourcePath) return `${snapshot?.sourceType || 'book'}:${sourcePath.toLowerCase()}`;
  const firstChapter = snapshot?.chapters?.[0];
  return `local:${snapshot?.bookTitle || 'untitled'}:${firstChapter?.filename || firstChapter?.title || ''}`;
}

export function getProgressStorageKey(snapshot = state) {
  return `reader_progress_${getHistoryIdentity(snapshot)}`;
}

export function getLegacyProgressStorageKey(bookTitle = state.bookTitle) {
  return `reader_${bookTitle || 'untitled'}`;
}

export function getSavedProgress(snapshot = state) {
  const saved = getStoredJson(getProgressStorageKey(snapshot), null);
  if (saved) return saved;
  return snapshot?.libraryIdentity ? null : getStoredJson(getLegacyProgressStorageKey(snapshot?.bookTitle), null);
}

export function getChapterEditsStorageKey(snapshot = state) {
  return `reader_edits_${getHistoryIdentity(snapshot)}`;
}

export function getMarksStorageKey(snapshot = state) {
  return `reader_marks_${getHistoryIdentity(snapshot)}`;
}

export function loadMarks(snapshot = state) {
  const saved = getStoredJson(getMarksStorageKey(snapshot), []);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(mark => mark && typeof mark === 'object' && ['bookmark', 'annotation'].includes(mark.kind) && mark.chapterKey)
    .map(mark => ({
      id: String(mark.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      kind: mark.kind,
      chapterKey: String(mark.chapterKey),
      scroll: Math.max(0, Number(mark.scroll) || 0),
      start: Math.max(0, Number(mark.start) || 0),
      end: Math.max(0, Number(mark.end) || 0),
      quote: String(mark.quote || '').slice(0, 1200),
      note: String(mark.note || '').slice(0, 500),
      createdAt: Number(mark.createdAt) || Date.now(),
      updatedAt: Number(mark.updatedAt) || Number(mark.createdAt) || Date.now()
    }))
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

export function saveMarks() {
  return setStoredJson(getMarksStorageKey(), state.marks, { immediate: true });
}
