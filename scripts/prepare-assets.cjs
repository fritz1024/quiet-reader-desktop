const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendorPath = path.join(root, 'app', 'vendor');

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
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
copyDirectory(
  path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'css'),
  path.join(vendorPath, 'fontawesome', 'css')
);
copyDirectory(
  path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts'),
  path.join(vendorPath, 'fontawesome', 'webfonts')
);
