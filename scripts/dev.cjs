const { createServer } = require('vite');
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

let electronProcess = null;

async function start() {
  const vite = await createServer({
    root: path.resolve(__dirname, '..', 'app'),
    server: { port: 5173, strictPort: true },
  });
  await vite.listen();

  const info = vite.resolvedUrls;
  const url = info.local[0] || `http://localhost:5173`;
  console.log(`[dev] Vite dev server: ${url}`);

  electronProcess = spawn(
    electron,
    ['.', '--dev'],
    {
      stdio: 'inherit',
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
    }
  );

  electronProcess.on('close', async (code) => {
    await vite.close();
    process.exit(code ?? 0);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
