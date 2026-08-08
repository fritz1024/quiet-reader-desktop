// Split from index.html — maintain in separate files under js/
import { showToast } from './loader.js';

export const desktopApi = window.readerDesktop;
export const isDesktop = Boolean(desktopApi?.isDesktop);
export let desktopStorage = {};
export let desktopStorageWrite = Promise.resolve();
export let desktopStorageTimer = null;
export let desktopReadyForBooks = false;
export const pendingDesktopBookPaths = [];
export let updateInfo = null;

export function setDesktopStorageWrite(val) { desktopStorageWrite = val; }
export function setDesktopStorageTimer(val) { desktopStorageTimer = val; }
export function setDesktopReadyForBooks(val) { desktopReadyForBooks = val; }

export const readingPresets = {
  proofread: {
    fontSize: 16,
    lineHeight: 1.7,
    fontFamily: 'sans',
    paperPadding: '52px 58px 94px',
    paperPaddingMobile: '38px 20px 84px'
  },
  comfortable: {
    fontSize: 18,
    lineHeight: 2.05,
    fontFamily: 'serif',
    paperPadding: '68px 72px 100px',
    paperPaddingMobile: '43px 26px 90px'
  },
  large: {
    fontSize: 22,
    lineHeight: 2.35,
    fontFamily: 'serif',
    paperPadding: '72px 82px 110px',
    paperPaddingMobile: '47px 26px 96px'
  }
};

export const state = {
  chapters: [], currentChapter: 0, fontSize: 18, lineHeight: 2.05,
  theme: 'default', fontFamily: 'serif', bookTitle: '', demo: false, folderHandle: null,
  punctuationHistory: null, punctuationOptions: null, customReplaceRules: [], chapterEdits: {}, directEditing: false, directEditOriginalText: '',
  sourcePath: '', sourceType: '', sourceDocuments: {}, libraryIdentity: '', sourceAvailable: false, sourceMissing: false,
  search: { query: '', scope: 'chapter', matches: [], currentIndex: -1 }, marks: [], readingPreset: 'comfortable',
  readerPaperPadding: readingPresets.comfortable.paperPadding,
  readerPaperPaddingMobile: readingPresets.comfortable.paperPaddingMobile,
  exportScope: 'current', exportFormat: 'text',
  pdfViewer: { document: null, pageCount: 0, currentPage: 1, zoomMode: 'fit-width', zoomLevel: 1.0, rendering: false, darkInvert: false, renderTask: null },
  epubViewer: { chapters: [], currentEpubChapter: 0 }
};

export const $ = (id) => document.getElementById(id);
export const uploadArea = $('uploadArea');
export const readerContainer = $('readerContainer');
export const folderUploadBox = $('folderUploadBox');
export const bookInput = $('bookInput');
export const folderInput = $('folderInput');
export const readerContent = $('readerContent');
export const chapterList = $('chapterList');
export const chapterCount = $('chapterCount');
export const sidebar = $('sidebar');
export const progressFill = $('progressFill');
export const pageNav = $('pageNav');
export const settingsPanel = $('settingsPanel');
export const importPanel = $('importPanel');
export const editorPanel = $('editorPanel');
export const backupPanel = $('backupPanel');
export const searchPanel = $('searchPanel');
export const marksPanel = $('marksPanel');
export const exportPanel = $('exportPanel');
export const mobileMorePanel = $('mobileMorePanel');
export const readerDialog = $('readerDialog');
export const readerDialogTitle = $('readerDialogTitle');
export const readerDialogMessage = $('readerDialogMessage');
export const dialogKeepEditingBtn = $('dialogKeepEditingBtn');
export const dialogDiscardBtn = $('dialogDiscardBtn');
export const dialogSaveBtn = $('dialogSaveBtn');
export const textFilePattern = /\.(txt|md|markdown)$/i;
export const bookFilePattern = /\.(txt|md|markdown|epub|zip|pdf)$/i;
export const pdfFilePattern = /\.pdf$/i;
export const maxBookFileBytes = 1024 * 1024 * 1024;
export const maxTextFileBytes = 1024 * 1024 * 1024;
export const REFERENCE_FOLDER_KEYWORDS = ['设定', '世界观', '人物', '大纲', 'outline', 'notes', 'characters', 'worldbuilding', '参考', '资料', '背景', '草稿', '灵感', 'setting', 'reference', '附录', 'extras', '备注'];
export const CONTENT_FOLDER_KEYWORDS = ['正文', '章节', 'chapters', 'content', '卷'];
export const REFERENCE_FILE_KEYWORDS = ['readme', 'notes', '设定', '大纲', '人物', '世界观', 'outline', 'character', 'worldbuilding', '简介', '背景', '草稿', '灵感', 'setting', 'reference', '附录', '备注'];

export function classifyFileCategory(relativePath) {
  const parts = relativePath.split('/');
  const filename = parts.pop() || '';
  const ext = filename.match(/\.[^.]+$/)?.[0].toLowerCase() || '';
  if (ext === '.pdf' || ext === '.epub') return 'content';
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '').toLowerCase();
  let lastMatch = null;
  for (let i = 0; i < parts.length; i++) {
    const folderLower = parts[i].toLowerCase();
    if (REFERENCE_FOLDER_KEYWORDS.some(k => folderLower.includes(k.toLowerCase()))) {
      lastMatch = 'reference';
    } else if (CONTENT_FOLDER_KEYWORDS.some(k => folderLower.includes(k.toLowerCase()))) {
      lastMatch = 'content';
    }
  }
  if (lastMatch) return lastMatch;
  if (REFERENCE_FILE_KEYWORDS.some(k => nameWithoutExt.includes(k.toLowerCase()))) return 'reference';
  return 'content';
}
export const maxZipEntries = 5000;
export const maxZipUncompressedBytes = 512 * 1024 * 1024;
export const maxEmbeddedImageBytes = 24 * 1024 * 1024;
export const folderDatabaseName = 'quiet-reader-reader';
export const folderStoreName = 'sources';
export const historyStorageKey = 'reader_history';
export const historyLimit = 12;
export let folderDatabasePromise;
export let pendingReaderDialogResolve = null;
export let closeRequestInProgress = false;

export function setFolderDatabasePromise(val) { folderDatabasePromise = val; }
export function setPendingReaderDialogResolve(val) { pendingReaderDialogResolve = val; }
export function setCloseRequestInProgress(val) { closeRequestInProgress = val; }

export function setUpdateButtonLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle('opacity-60', loading);
  button.classList.toggle('cursor-wait', loading);
}

export function renderUpdateStatus(info) {
  updateInfo = info && typeof info === 'object' ? info : null;
  const section = $('updateSection');
  if (!isDesktop || !updateInfo) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const version = updateInfo.version ? `当前版本 v${updateInfo.version}` : '当前版本';
  $('appVersion').textContent = version;
  const status = updateInfo.status || 'idle';
  const statusText = $('updateStatus');
  statusText.textContent = updateInfo.message || '可检查最新版本';
  statusText.classList.toggle('error', status === 'error');
  const checking = status === 'checking';
  const downloading = status === 'downloading';
  setUpdateButtonLoading($('checkUpdateBtn'), checking || downloading || status === 'installing');
  $('checkUpdateBtn').disabled = !updateInfo.enabled || checking || downloading || status === 'installing';
  const showProgress = downloading || status === 'downloaded';
  $('updateProgress').hidden = !showProgress;
  $('updateProgressFill').style.width = `${Math.max(0, Math.min(100, Number(updateInfo.percent) || 0))}%`;
  $('downloadUpdateBtn').classList.toggle('hidden', status !== 'available');
  $('downloadUpdateBtn').disabled = status !== 'available';
  $('installUpdateBtn').classList.toggle('hidden', status !== 'downloaded');
  $('installUpdateBtn').disabled = status !== 'downloaded';
}

export async function initializeUpdater() {
  if (!isDesktop || !desktopApi?.getUpdateInfo) return;
  desktopApi.onUpdateStatus(renderUpdateStatus);
  try {
    renderUpdateStatus(await desktopApi.getUpdateInfo());
  } catch (error) {
    console.error(error);
    renderUpdateStatus({ enabled: false, status: 'error', message: '无法读取更新状态' });
  }
}

export async function initializeDesktopStorage() {
  if (!isDesktop) return;
  try {
    const storageResult = await desktopApi.getStorage();
    const saved = storageResult?.data ?? storageResult;
    desktopStorage = saved && typeof saved === 'object' ? saved : {};
    if (storageResult?.recoveryMessage) showToast(storageResult.recoveryMessage);
  } catch (error) {
    console.error(error);
    showToast('无法读取本地数据，将使用新的阅读记录');
  }
}
