// Split from index.html — maintain in separate files under js/
import {
  state, $, isDesktop, desktopApi, readerContainer,
  desktopReadyForBooks, setDesktopReadyForBooks, pendingDesktopBookPaths,
  initializeDesktopStorage, initializeUpdater
} from './state.js';
import {
  getSavedFolder, getSavedLibrary, setStoredJson, getStoredJson,
  createLibraryIdentity, loadMarks, saveLibrarySnapshot, getSavedProgress
} from './storage.js';
import {
  hasRestorableSnapshotContent, getHistoryProgress,
  renderReadingHistory, updateHistoryEntry
} from './history.js';
import {
  requestFolderPermission, setFolderSource, loadFromDirectory,
  loadFromDesktopFolder, loadDesktopBookPath
} from './folder-io.js';
import { getWordCount, setPunctuationOptions, renderCustomRules } from './text-utils.js';
import { applyChapterEdits, loadChapterEdits } from './chapter.js';
import { inferChapterTypes, getChapterBodyContent } from './parser.js';
import { exitDirectEditing, handleCloseRequest } from './editing.js';
import { showToast, toggleSidebar, openReader, showHome, loadSettings } from './loader.js';
import { renderChapter } from './chapter-render.js';





export async function restoreSavedFolder() {
  const saved = await getSavedFolder();
  if (state.demo || state.chapters.length) return;
  const snapshot = await getSavedLibrary();
  const handle = saved?.handle || null;
  if (handle && await requestFolderPermission(handle, false)) {
    if (state.demo || state.chapters.length) return;
    state.punctuationOptions = snapshot?.punctuationOptions || null;
  state.customReplaceRules = Array.isArray(snapshot?.customReplaceRules) ? snapshot.customReplaceRules : [];
    state.chapterEdits = { ...loadChapterEdits(handle.name), ...(snapshot?.chapterEdits || {}) };
    setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
    setFolderSource(handle);
    await loadFromDirectory(handle, { isUpdate: false, restoring: true });
    showToast(`已恢复 ${state.chapters.length} 个章节`);
    return;
  }
  if (!snapshot?.chapters?.length) return;
  if (isDesktop && snapshot.sourcePath) {
    const restored = snapshot.sourceType === 'folder'
      ? await loadFromDesktopFolder(snapshot.sourcePath, { restoring: true })
      : await loadDesktopBookPath(snapshot.sourcePath, { restoring: true });
    if (restored) {
      showToast(`已从原文件恢复 ${state.chapters.length} 个章节`);
      return;
    }
  }
  if (isDesktop && snapshot.sourcePath && !hasRestorableSnapshotContent(snapshot)) {
    showToast('原始文件无法读取，请在历史记录中移除该条目或重新导入文件。');
    return;
  }
  state.demo = false;
  state.bookTitle = snapshot.bookTitle || '我的小说';
  state.sourcePath = snapshot.sourcePath || '';
  state.sourceType = snapshot.sourceType || '';
  state.sourceAvailable = false;
  state.sourceDocuments = {};
  state.libraryIdentity = snapshot.libraryIdentity || createLibraryIdentity(snapshot);
  state.marks = loadMarks(state);
  state.search = { query: '', scope: 'chapter', matches: [], currentIndex: -1 };
  const restoredChapters = inferChapterTypes(snapshot.chapters);
  state.chapterEdits = { ...loadChapterEdits(state.bookTitle, state), ...(snapshot.chapterEdits || {}) };
  state.chapters = applyChapterEdits(restoredChapters);
  state.punctuationOptions = snapshot.punctuationOptions || null;
  state.customReplaceRules = Array.isArray(snapshot.customReplaceRules) ? snapshot.customReplaceRules : [];
  setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
  const progress = getSavedProgress(state);
  state.currentChapter = Math.min(Number(progress?.chapter ?? snapshot.currentChapter) || 0, state.chapters.length - 1);
  $('bookTitle').textContent = state.bookTitle;
  document.title = `${state.bookTitle} - 阅读器`;
  setFolderSource(null);
  openReader();
  renderChapter(state.currentChapter);
  if (progress?.scroll) requestAnimationFrame(() => { readerContainer.scrollTop = progress.scroll; });
  if (window.innerWidth >= 841 && state.chapters.length >= 3) toggleSidebar(true);
  showToast('已恢复上次阅读内容，点击更新同步新章节');
}

export async function restoreHistorySnapshot(snapshot, entry) {
  if (!hasRestorableSnapshotContent(snapshot)) return false;
  state.demo = false;
  state.bookTitle = snapshot.bookTitle || entry?.bookTitle || '我的小说';
  state.sourcePath = snapshot.sourcePath || entry?.sourcePath || '';
  state.sourceType = snapshot.sourceType || entry?.sourceType || '';
  state.sourceAvailable = false;
  state.sourceMissing = true;
  state.sourceDocuments = {};
  state.libraryIdentity = snapshot.libraryIdentity || entry?.libraryIdentity || createLibraryIdentity({ ...snapshot, sourcePath: state.sourcePath, sourceType: state.sourceType });
  state.marks = loadMarks(state);
  state.search = { query: '', scope: 'chapter', matches: [], currentIndex: -1 };
  const restoredChapters = inferChapterTypes(snapshot.chapters);
  state.chapterEdits = { ...loadChapterEdits(state.bookTitle, state), ...(snapshot.chapterEdits || {}) };
  state.chapters = applyChapterEdits(restoredChapters);
  state.punctuationOptions = snapshot.punctuationOptions || entry?.punctuationOptions || null;
  state.customReplaceRules = Array.isArray(snapshot?.customReplaceRules || entry?.customReplaceRules) ? (snapshot.customReplaceRules || entry.customReplaceRules) : [];
  setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
  const progress = getHistoryProgress({ ...entry, bookTitle: state.bookTitle, chapterCount: state.chapters.length, currentChapter: snapshot.currentChapter });
  state.currentChapter = progress.chapter;
  $('bookTitle').textContent = state.bookTitle;
  document.title = `${state.bookTitle} - 阅读器`;
  setFolderSource(null);
  openReader();
  renderChapter(state.currentChapter);
  if (progress.scroll) requestAnimationFrame(() => { readerContainer.scrollTop = progress.scroll; });
  if (window.innerWidth >= 841 && state.chapters.length >= 3) toggleSidebar(true);
  await saveLibrarySnapshot();
  return true;
}

export async function loadHistoryEntry(entry) {
  if (!entry) return;
  if (state.directEditing && !(await exitDirectEditing())) return;
  let loaded = false;
  let sourceLoadAttempted = false;
  if (isDesktop && entry.sourcePath) {
    sourceLoadAttempted = true;
    state.punctuationOptions = entry.punctuationOptions || null;
  state.customReplaceRules = Array.isArray(entry?.customReplaceRules) ? entry.customReplaceRules : [];
    setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
    loaded = entry.sourceType === 'folder'
      ? await loadFromDesktopFolder(entry.sourcePath, { restoring: true })
      : await loadDesktopBookPath(entry.sourcePath, { restoring: true });
  }
  if (!loaded && sourceLoadAttempted) {
    await updateHistoryEntry(entry.id, value => ({ ...value, sourceMissing: true }));
    await renderReadingHistory();
  }
  if (!loaded && entry.snapshot) loaded = await restoreHistorySnapshot(entry.snapshot, entry);
  if (loaded) {
    showToast(`已打开《${state.bookTitle}》`);
    return;
  }
  showToast('原始文件无法读取，且没有可用的本地副本');
}

export async function openDesktopPaths(paths) {
  const bookPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!bookPaths.length) return false;
  if (bookPaths.length > 1) showToast('一次只能打开一本书，已载入第一个文件');
  return loadDesktopBookPath(bookPaths[0]);
}

export async function startReader() {
  await initializeDesktopStorage();
  loadSettings();
  $('dataTransferSection').hidden = !isDesktop;
  $('storagePathSection').hidden = !isDesktop;
  if (isDesktop && desktopApi?.getStorageInfo) {
    try {
      const info = await desktopApi.getStorageInfo();
      $('currentStoragePath').textContent = info.currentPath || '-';
      $('resetStoragePathBtn').hidden = !info.isCustom;
    } catch(_) {}
  }
  initializeUpdater();
  if (isDesktop) {
    desktopApi.onCloseRequested?.(() => { handleCloseRequest(); });
    desktopApi.onOpenBook(paths => {
      if (!desktopReadyForBooks) {
        pendingDesktopBookPaths.push(...paths);
        return;
      }
      openDesktopPaths(paths);
    });
    const initialPaths = [...await desktopApi.takeOpenBookPaths(), ...pendingDesktopBookPaths.splice(0)];
    setDesktopReadyForBooks(true);
    if (initialPaths.length) {
      await openDesktopPaths(initialPaths);
      return;
    }
  }
  await showHome();
}

startReader();
