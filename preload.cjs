const { contextBridge, ipcRenderer } = require('electron');

const queuedBookPaths = [];
const bookOpenListeners = new Set();

ipcRenderer.on('reader:open-book', (_event, paths) => {
  const safePaths = Array.isArray(paths) ? paths.filter(value => typeof value === 'string') : [];
  if (!safePaths.length) return;
  if (!bookOpenListeners.size) {
    queuedBookPaths.push(...safePaths);
    return;
  }
  bookOpenListeners.forEach(listener => listener(safePaths));
});

contextBridge.exposeInMainWorld('readerDesktop', {
  isDesktop: true,
  chooseBook: () => ipcRenderer.invoke('reader:choose-book'),
  chooseFolder: () => ipcRenderer.invoke('reader:choose-folder'),
  readBook: (filePath) => ipcRenderer.invoke('reader:read-book', filePath),
  readFolder: (folderPath) => ipcRenderer.invoke('reader:read-folder', folderPath),
  showSource: (sourcePath, isFolder) => ipcRenderer.invoke('reader:show-source', sourcePath, Boolean(isFolder)),
  takeOpenBookPaths: async () => [...queuedBookPaths.splice(0), ...await ipcRenderer.invoke('reader:take-open-book-paths')],
  onOpenBook: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    bookOpenListeners.add(listener);
    if (queuedBookPaths.length) listener(queuedBookPaths.splice(0));
    return () => bookOpenListeners.delete(listener);
  },
  getStorage: () => ipcRenderer.invoke('reader:get-storage'),
  saveStorage: (data) => ipcRenderer.invoke('reader:save-storage', data)
});
