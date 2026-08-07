const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendorPath = path.join(root, 'app', 'vendor');

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination, options = {}) {
  if (options.clean) fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (options.filter && !options.filter(entry)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFile(sourcePath, destinationPath);
  }
}

copyFile(
  path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
  path.join(vendorPath, 'jszip.min.js')
);
copyFile(
  path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'),
  path.join(vendorPath, 'pdf.min.js')
);
copyFile(
  path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js'),
  path.join(vendorPath, 'pdf.worker.min.js')
);
copyDirectory(
  path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'css'),
  path.join(vendorPath, 'fontawesome', 'css')
);
copyDirectory(
  path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts'),
  path.join(vendorPath, 'fontawesome', 'webfonts')
);
copyDirectory(
  path.join(root, 'node_modules', '@fontsource-variable', 'noto-serif-sc'),
  path.join(vendorPath, 'fonts', 'noto-serif-sc'),
  { clean: true }
);
copyDirectory(
  path.join(root, 'node_modules', '@fontsource-variable', 'noto-sans-sc'),
  path.join(vendorPath, 'fonts', 'noto-sans-sc'),
  { clean: true }
);
copyDirectory(
  path.join(root, 'assets', 'fonts'),
  path.join(vendorPath, 'fonts', 'custom'),
  {
    clean: true,
    filter: entry => entry.name === 'LICENSES.md' || entry.name.endsWith('.woff2')
  }
);
