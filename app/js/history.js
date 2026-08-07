// Split from index.html — maintain in separate files under js/
function getChapterKey(chapter) {
  return String(chapter?.sourceKey || `${chapter?.filename || ''}\u0000${chapter?.title || ''}`);
}

function getSnapshotWordCount(snapshot) {
  if (Number.isFinite(Number(snapshot?.wordCount))) return Math.max(0, Number(snapshot.wordCount));
  return (snapshot?.chapters || [])
    .filter(chapter => !chapter?.isCover)
    .reduce((total, chapter) => total + getWordCount(getChapterBodyContent(chapter), chapter.isMarkdown), 0);
}

function hasRestorableSnapshotContent(snapshot) {
  return Array.isArray(snapshot?.chapters) && snapshot.chapters.some(chapter => (
    Object.prototype.hasOwnProperty.call(chapter || {}, 'content') ||
    Object.prototype.hasOwnProperty.call(chapter || {}, 'htmlContent')
  ));
}

function makeHistoryEntry(snapshot) {
  const chapterCount = Number.isFinite(Number(snapshot?.chapterCount))
    ? Math.max(0, Number(snapshot.chapterCount))
    : (Array.isArray(snapshot?.chapters) ? snapshot.chapters.length : 0);
  return {
    id: getHistoryIdentity(snapshot),
    libraryIdentity: getHistoryIdentity(snapshot),
    bookTitle: snapshot?.bookTitle || '未命名书籍',
    sourcePath: snapshot?.sourcePath || '',
    sourceType: snapshot?.sourceType || '',
    punctuationOptions: snapshot?.punctuationOptions ? { ...snapshot.punctuationOptions } : null,
    pinned: Boolean(snapshot?.pinned),
    sourceMissing: Boolean(snapshot?.sourceMissing),
    currentChapter: Math.max(0, Math.min(Number(snapshot?.currentChapter) || 0, Math.max(0, chapterCount - 1))),
    chapterCount,
    wordCount: getSnapshotWordCount(snapshot),
    lastOpenedAt: Date.now(),
    snapshot: snapshot?.sourcePath && snapshot?.sourceAvailable !== false ? null : snapshot
  };
}

function normalizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const entries = rawHistory
    .filter(item => item && typeof item === 'object' && item.bookTitle)
    .map(item => ({ ...item, pinned: Boolean(item.pinned), sourceMissing: Boolean(item.sourceMissing) }));
  const pinned = entries
    .filter(item => item.pinned)
    .sort((a, b) => Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0));
  const regular = entries
    .filter(item => !item.pinned)
    .sort((a, b) => Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0))
    .slice(0, Math.max(0, historyLimit - pinned.length));
  return [...pinned, ...regular];
}

async function getReadingHistory() {
  const storedHistory = getStoredJson(historyStorageKey, null);
  if (Array.isArray(storedHistory)) return normalizeHistory(storedHistory);
  const snapshot = await getSavedLibrary();
  if (!snapshot?.chapters?.length) return [];
  const migrated = [makeHistoryEntry(snapshot)];
  await setStoredJson(historyStorageKey, migrated, { immediate: true });
  return migrated;
}

async function saveReadingHistory(snapshot) {
  const entry = makeHistoryEntry(snapshot);
  const history = await getReadingHistory();
  const previous = history.find(item => item.id === entry.id);
  entry.pinned = Boolean(previous?.pinned);
  entry.sourceMissing = Boolean(snapshot?.sourceMissing);
  const next = normalizeHistory([entry, ...history.filter(item => item.id !== entry.id)]);
  await setStoredJson(historyStorageKey, next, { immediate: true });
  if (document.body.classList.contains('home-mode')) renderReadingHistory();
}

async function deleteHistoryEntry(id) {
  const history = normalizeHistory(getStoredJson(historyStorageKey, []));
  const next = history.filter(entry => entry.id !== id);
  await setStoredJson(historyStorageKey, next, { immediate: true });
  await renderReadingHistory();
  showToast('已从阅读历史移除');
}

async function updateHistoryEntry(id, updater) {
  const history = normalizeHistory(getStoredJson(historyStorageKey, []));
  const index = history.findIndex(entry => entry.id === id);
  if (index < 0) return null;
  const nextEntry = typeof updater === 'function' ? updater({ ...history[index] }) : history[index];
  if (!nextEntry) return null;
  history[index] = nextEntry;
  const next = normalizeHistory(history);
  await setStoredJson(historyStorageKey, next, { immediate: true });
  return next.find(entry => entry.id === nextEntry.id) || nextEntry;
}

async function toggleHistoryPinned(id) {
  const entry = await updateHistoryEntry(id, value => ({ ...value, pinned: !value.pinned }));
  if (!entry) return;
  await renderReadingHistory();
  showToast(entry.pinned ? '已置顶这本书' : '已取消置顶');
}

function getHistoryProgress(entry) {
  const saved = getSavedProgress(entry);
  const maxChapter = Math.max(0, Number(entry.chapterCount || 1) - 1);
  const chapter = Number.isInteger(saved?.chapter)
    ? Math.max(0, Math.min(saved.chapter, maxChapter))
    : Math.max(0, Math.min(Number(entry.currentChapter) || 0, maxChapter));
  return { chapter, scroll: Number(saved?.scroll) || 0 };
}

function getHistorySourceLabel(entry) {
  if (entry.sourceType === 'folder') return '章节文件夹';
  if (entry.sourceType === 'book') return '书籍文件';
  return '本地导入';
}

function formatHistoryTime(timestamp) {
  if (!timestamp) return '最近阅读';
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  } catch (_) {
    return '最近阅读';
  }
}

async function renderReadingHistory() {
  const list = $('historyList');
  const empty = $('historyEmpty');
  if (!list || !empty) return;
  const history = await getReadingHistory();
  const filter = String($('historyFilterInput')?.value || '').trim().toLocaleLowerCase('zh-CN');
  const sort = $('historySortSelect')?.value || 'recent';
  const visibleHistory = history
    .filter(entry => !filter || String(entry.bookTitle || '').toLocaleLowerCase('zh-CN').includes(filter))
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      if (sort === 'title') return String(a.bookTitle || '').localeCompare(String(b.bookTitle || ''), 'zh-CN');
      if (sort === 'wordCount') return Number(b.wordCount || 0) - Number(a.wordCount || 0) || Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0);
      return Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0);
    });
  list.innerHTML = '';
  $('historyCount').textContent = `${history.length} 本`;
  empty.hidden = visibleHistory.length > 0;
  empty.querySelector('span:last-child').textContent = history.length && !visibleHistory.length
    ? '没有符合筛选条件的阅读记录。'
    : '导入书籍后，最近阅读的内容会出现在这里。';
  visibleHistory.forEach(entry => {
    const progress = getHistoryProgress(entry);
    const item = document.createElement('article');
    item.className = `history-item${entry.sourceMissing ? ' missing' : ''}`;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'history-open';
    openButton.title = `继续阅读《${entry.bookTitle}》`;
    openButton.innerHTML = `
      <span class="history-item-icon"><i class="fa-solid ${entry.sourceType === 'folder' ? 'fa-folder-open' : 'fa-book-open'}"></i></span>
      <span class="min-w-0">
        <span class="history-item-title">${escapeHtml(entry.bookTitle)}</span>
        <span class="history-item-meta"><span>${getHistorySourceLabel(entry)}</span><span>${formatNumber(entry.chapterCount)} 章</span><span>正文 ${formatNumber(entry.wordCount)} 字</span><span>第 ${progress.chapter + 1} 章</span>${entry.sourceMissing ? '<span class="history-missing">原文件未找到</span>' : ''}<span>${formatHistoryTime(entry.lastOpenedAt)}</span></span>
      </span>
      <span class="history-item-action">继续阅读 <i class="fa-solid fa-arrow-right-long"></i></span>`;
    openButton.addEventListener('click', () => loadHistoryEntry(entry));

    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = `history-pin${entry.pinned ? ' active' : ''}`;
    pinButton.title = entry.pinned ? '取消置顶' : '置顶到最前';
    pinButton.setAttribute('aria-label', `${entry.pinned ? '取消置顶' : '置顶'}《${entry.bookTitle}》`);
    pinButton.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
    pinButton.addEventListener('click', () => toggleHistoryPinned(entry.id));

    const relinkButton = document.createElement('button');
    relinkButton.type = 'button';
    relinkButton.className = 'history-relink';
    relinkButton.title = '重新关联原文件';
    relinkButton.setAttribute('aria-label', `重新关联《${entry.bookTitle}》的原文件`);
    relinkButton.innerHTML = '<i class="fa-solid fa-link"></i>';
    relinkButton.hidden = !entry.sourceMissing || !isDesktop;
    relinkButton.addEventListener('click', () => relinkHistoryEntry(entry));

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'history-remove';
    removeButton.title = `从阅读历史移除《${entry.bookTitle}》`;
    removeButton.setAttribute('aria-label', `从阅读历史移除《${entry.bookTitle}》`);
    removeButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    removeButton.addEventListener('click', () => deleteHistoryEntry(entry.id));

    item.append(openButton, pinButton, relinkButton, removeButton);
    list.appendChild(item);
  });
}

function copyStoredValue(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return Promise.resolve();
  if (isDesktop) {
    return Object.prototype.hasOwnProperty.call(desktopStorage, fromKey)
      ? setStoredJson(toKey, desktopStorage[fromKey], { immediate: true })
      : Promise.resolve();
  }
  try {
    const value = localStorage.getItem(fromKey);
    if (value !== null) localStorage.setItem(toKey, value);
  } catch (_) { /* Browser storage can be unavailable. */ }
  return Promise.resolve();
}

async function relinkHistoryEntry(entry) {
  if (!isDesktop || !entry) return;
  const oldIdentity = getHistoryIdentity(entry);
  const oldProgress = getSavedProgress(entry);
  const path = entry.sourceType === 'folder'
    ? await desktopApi.chooseFolder()
    : await desktopApi.chooseBook();
  if (!path) return;
  const loaded = entry.sourceType === 'folder'
    ? await loadFromDesktopFolder(path, { restoring: true, skipProgressRestore: true })
    : await loadDesktopBookPath(path, { restoring: true, skipProgressRestore: true });
  if (!loaded) return;
  const newIdentity = getHistoryIdentity(state);
  await Promise.all([
    copyStoredValue(`reader_progress_${oldIdentity}`, `reader_progress_${newIdentity}`),
    copyStoredValue(`reader_edits_${oldIdentity}`, `reader_edits_${newIdentity}`),
    copyStoredValue(`reader_marks_${oldIdentity}`, `reader_marks_${newIdentity}`)
  ]);
  state.marks = loadMarks();
  const progress = oldProgress || { chapter: entry.currentChapter, scroll: 0 };
  const targetChapter = Math.max(0, Math.min(Number(progress.chapter) || 0, state.chapters.length - 1));
  const targetScroll = Math.max(0, Number(progress.scroll) || 0);
  renderChapter(targetChapter, { saveProgress: false });
  await setStoredJson(getProgressStorageKey(), { chapter: targetChapter, scroll: targetScroll }, { immediate: true });
  await new Promise(resolve => requestAnimationFrame(resolve));
  readerContainer.scrollTop = targetScroll;
  await setStoredJson(getProgressStorageKey(), { chapter: targetChapter, scroll: readerContainer.scrollTop }, { immediate: true });
  const history = normalizeHistory(getStoredJson(historyStorageKey, []));
  const nextEntry = {
    ...entry,
    id: newIdentity,
    libraryIdentity: newIdentity,
    bookTitle: state.bookTitle,
    sourcePath: state.sourcePath,
    sourceType: state.sourceType,
    sourceMissing: false,
    chapterCount: state.chapters.length,
    wordCount: getBookWordCount(),
    currentChapter: targetChapter,
    lastOpenedAt: Date.now(),
    snapshot: null
  };
  await setStoredJson(historyStorageKey, normalizeHistory([nextEntry, ...history.filter(item => item.id !== entry.id && item.id !== newIdentity)]), { immediate: true });
  await saveLibrarySnapshot();
  showToast('已重新关联原文件，并保留阅读进度与标记');
}
