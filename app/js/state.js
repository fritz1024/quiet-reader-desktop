// Split from index.html — maintain in separate files under js/
const desktopApi = window.readerDesktop;
const isDesktop = Boolean(desktopApi?.isDesktop);
let desktopStorage = {};
let desktopStorageWrite = Promise.resolve();
let desktopStorageTimer = null;
let desktopReadyForBooks = false;
const pendingDesktopBookPaths = [];
let updateInfo = null;

const readingPresets = {
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

const state = {
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

const $ = (id) => document.getElementById(id);
const uploadArea = $('uploadArea');
const readerContainer = $('readerContainer');
const folderUploadBox = $('folderUploadBox');
const bookInput = $('bookInput');
const folderInput = $('folderInput');
const readerContent = $('readerContent');
const chapterList = $('chapterList');
const chapterCount = $('chapterCount');
const sidebar = $('sidebar');
const progressFill = $('progressFill');
const pageNav = $('pageNav');
const settingsPanel = $('settingsPanel');
const importPanel = $('importPanel');
const editorPanel = $('editorPanel');
const backupPanel = $('backupPanel');
const searchPanel = $('searchPanel');
const marksPanel = $('marksPanel');
const exportPanel = $('exportPanel');
const mobileMorePanel = $('mobileMorePanel');
const readerDialog = $('readerDialog');
const readerDialogTitle = $('readerDialogTitle');
const readerDialogMessage = $('readerDialogMessage');
const dialogKeepEditingBtn = $('dialogKeepEditingBtn');
const dialogDiscardBtn = $('dialogDiscardBtn');
const dialogSaveBtn = $('dialogSaveBtn');
const textFilePattern = /\.(txt|md|markdown)$/i;
const bookFilePattern = /\.(txt|md|markdown|epub|zip|pdf)$/i;
const pdfFilePattern = /\.pdf$/i;
const maxBookFileBytes = 1024 * 1024 * 1024;
const maxTextFileBytes = 1024 * 1024 * 1024;
const REFERENCE_FOLDER_KEYWORDS = ['设定', '世界观', '人物', '大纲', 'outline', 'notes', 'characters', 'worldbuilding', '参考', '资料', '背景', '草稿', '灵感', 'setting', 'reference', '附录', 'extras', '备注'];
const CONTENT_FOLDER_KEYWORDS = ['正文', '章节', 'chapters', 'content', '卷'];
const REFERENCE_FILE_KEYWORDS = ['readme', 'notes', '设定', '大纲', '人物', '世界观', 'outline', 'character', 'worldbuilding', '简介', '背景', '草稿', '灵感', 'setting', 'reference', '附录', '备注'];

function classifyFileCategory(relativePath) {
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
const maxZipEntries = 5000;
const maxZipUncompressedBytes = 512 * 1024 * 1024;
const maxEmbeddedImageBytes = 24 * 1024 * 1024;
const folderDatabaseName = 'quiet-reader-reader';
const folderStoreName = 'sources';
const historyStorageKey = 'reader_history';
const historyLimit = 12;
let folderDatabasePromise;
let pendingReaderDialogResolve = null;
let closeRequestInProgress = false;

function setUpdateButtonLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle('opacity-60', loading);
  button.classList.toggle('cursor-wait', loading);
}

function renderUpdateStatus(info) {
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

async function initializeUpdater() {
  if (!isDesktop || !desktopApi?.getUpdateInfo) return;
  desktopApi.onUpdateStatus(renderUpdateStatus);
  try {
    renderUpdateStatus(await desktopApi.getUpdateInfo());
  } catch (error) {
    console.error(error);
    renderUpdateStatus({ enabled: false, status: 'error', message: '无法读取更新状态' });
  }
}

async function initializeDesktopStorage() {
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
