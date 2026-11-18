import { spawn, spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(process.env.AGENTS_ELECTRIC_HOME || join(root, '.local', 'dsh'));
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents-home') };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = join(root, 'node_modules', '.bin') + delimiter + (env[pathKey] || '');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令退出码 ${result.status}`);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) throw new Error('需要 Node.js 24.9 或更新版本');
if (!existsSync(cli) || !existsSync(join(root, 'node_modules', 'pnpm', 'package.json'))) {
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/c', 'npm.cmd ci --ignore-scripts --no-fund --no-audit']);
  else run('npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit']);
}

const workspace = join(home, 'electric', 'workspace');
const skillPath = join(home, 'skills', 'plc-change-review');
mkdirSync(workspace, { recursive: true });
mkdirSync(skillPath, { recursive: true });
const destination = join(skillPath, 'SKILL.md');
if (!existsSync(destination)) copyFileSync(join(root, 'samples', 'plc-change-review', 'SKILL.md'), destination, constants.COPYFILE_EXCL);

const manifest = join(home, 'profiles', 'web', 'package.json');
const dependencies = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {} : {};
if (!dependencies['@gm-hz/agent-dag-workflow']) {
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '@gm-hz/agent-dag-workflow@1.0.1']);
}
if (!dependencies['agents-electric-workbench']) {
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', `link:${join(root, 'electric-plugin')}`]);
}
if (process.argv.includes('--setup-only')) process.exit(0);

const port = process.env.AGENTS_ELECTRIC_PORT || '3080';
if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('本机端口无效');
const args = [cli, 'web', '--host', '127.0.0.1', '--port', port, '--no-open'];
const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
let pending = '';
child.stdout.setEncoding('utf8').on('data', chunk => {
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop();
  for (const line of lines) {
    const tokenUrl = line.match(/^dsh web:\s+(http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+)$/)?.[1];
    if (!tokenUrl) { console.log(line); continue; }
    const url = new URL(tokenUrl);
    url.hash = 'electric';
    console.log(`电气工程工作台已启动（${url.origin}）`);
    if (process.argv.includes('--no-open')) continue;
    const open = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]] :
      process.platform === 'darwin' ? ['open', [url.href]] : ['xdg-open', [url.href]];
    const browser = spawn(open[0], open[1], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.error('无法打开浏览器，请检查系统默认浏览器设置后重新启动。'));
    browser.unref();
  }
});
child.stderr.pipe(process.stderr);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
