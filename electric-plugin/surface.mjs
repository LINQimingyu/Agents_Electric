import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { registerModelRoutes } from './surface-models.mjs';
import { registerSessionRoutes } from './surface-sessions.mjs';
import { publicMessage } from './diagnostics.mjs';

export const name = 'agents-electric-surface';
export const inject = ['webServer', 'connection', 'pluginManager', 'llm', 'settingsController', 'credentialsController', 'sessionController', 'sessions'];

const blankIcon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" };

function htmlResponse(data, pageHeaders = headers) {
  return new Response(data, { headers: { ...pageHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

function authorizePage(ctx, request, peer, render) {
  if (peer !== undefined) return render(peer);
  const refusal = ctx.connection.requestRejection(request);
  if (refusal === 403) return new Response('此地址无法访问本机工作台。', { status: 403, headers });

  const url = new URL(request.url);
  let status = 401;
  let authHeaders = {};
  const allowed = ctx.connection.authorizeIndex({ method: request.method, url: url.pathname + url.search, headers: request.headers }, {
    writeHead(code, values) { status = code; authHeaders = values; },
    end() {},
  });
  if (allowed) return render(ctx.connection.browserPeer);
  if (status === 303) return new Response(null, { status, headers: authHeaders });
  return new Response('Agents Electric 尚未登录。请从「打开电气工作台」重新进入。', {
    status, headers: { ...authHeaders, ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function pluginView(bundle) {
  return { name: bundle.name, description: publicMessage(bundle.description), version: bundle.version || '',
    enabled: bundle.enabled, installed: bundle.installed || bundle.availability === 'installation', removable: bundle.removable,
    manageable: !bundle.readOnlyReason, error: bundle.error?.code || null, offered: bundle.installTarget?.spec || '' };
}

export async function apply(ctx) {
  const entry = await readFile(new URL('./web/index.html', import.meta.url));
  for (const path of ['/', '/index.html']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path,
      resource: async (request, peer) => authorizePage(ctx, request, peer, () => htmlResponse(entry)) }));
  }
  const require = createRequire(import.meta.url);
  const nativeIndex = join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html');
  const nativePage = (await readFile(nativeIndex, 'utf8'))
    .replace(/<title>[^<]*<\/title>/i, '<title>Agent 会话 · Agents Electric</title>')
    .replace(/<meta name="apple-mobile-web-app-title"[^>]*>/i, '<meta name="apple-mobile-web-app-title" content="Agents Electric">')
    .replace(/<link rel="(?:manifest|icon)"[^>]*>/gi, '')
    .replace(/<head(?:\s[^>]*)?>/i, head => head +
      '<base href="/"><link rel="icon" type="image/png" href="/electric-blank-v1.png"><link rel="stylesheet" href="/api/electric/native-session.css">');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/agent-sessions',
    resource: async (request, peer) => authorizePage(ctx, request, peer, authorized =>
      htmlResponse(ctx.webServer.renderIndex(nativePage, authorized), {
        ...headers, 'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
      })) }));
  for (const path of ['/electric-blank-v1.png', '/favicon.ico', '/favicon.svg', '/favicon-dark.svg', '/apple-touch-icon.png']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path,
      resource: async () => new Response(blankIcon, { headers: { ...headers, 'Content-Type': 'image/png' } }) }));
  }
  function route(path, methods, handler) {
    ctx.effect(() => ctx.connection.fetch.register({ path: '/api/electric/' + path, methods, requestBody: 'buffered', async fetch(request) {
      try {
        const result = await handler(request, new URL(request.url));
        return result instanceof Response ? result : Response.json(result, { headers });
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
        return Response.json({ error: publicMessage(error.message || '操作未完成。') }, { status, headers });
      }
    } }));
  }
  route('workbench', ['GET'], () => htmlResponse(entry));
  for (const [file, mime] of [['ui.js', 'text/javascript'], ['workspace-pages.js', 'text/javascript'], ['knowledge-page.js', 'text/javascript'],
    ['style.css', 'text/css'], ['native-session.css', 'text/css']]) {
    route(file, ['GET'], async () => new Response(await readFile(new URL('./web/' + file, import.meta.url)), {
      headers: { ...headers, 'Content-Type': `${mime}; charset=utf-8` },
    }));
  }
  registerModelRoutes(ctx, route);
  registerSessionRoutes(ctx, route, publicMessage);
  route('plugins', ['GET', 'POST'], async request => {
    const manager = ctx.pluginManager;
    if (request.method === 'GET') return (await manager.listBundles())
      .filter(bundle => bundle.installed || bundle.enabled || (bundle.optional && bundle.listedByDefault)).map(pluginView);
    const body = await request.json();
    const name = String(body.name || '');
    if (['enable', 'remove'].includes(body.op) && name === 'agents-electric-workbench') {
      throw new Error('工作台组件由启动器管理。');
    }
    if (body.op === 'inspect') {
      const result = await manager.inspect(requireSpec(body.spec), undefined, request.signal);
      if (result.status === 'refused') throw new Error(result.reason || '此插件无法安装。');
      return { name: result.name || result.packageName || body.spec, version: result.version || '', description: publicMessage(result.description) };
    }
    let result;
    if (body.op === 'install') {
      const approvedBuilds = Array.isArray(body.approvedBuilds)
        ? body.approvedBuilds.filter(value => typeof value === 'string' && value.length <= 300).slice(0, 100) : undefined;
      result = await manager.installBundle(requireSpec(body.spec), { enabled: false, approvedBuilds });
    }
    else if (body.op === 'enable') result = await manager.setBundleEnabled(name, body.enabled === true);
    else if (body.op === 'remove') result = await manager.removeBundle(name);
    else throw new Error('插件操作未知。');
    if (result.application === 'failed') {
      if (result.pendingBuilds?.length) return { status: 'approval-required', packages: result.pendingBuilds };
      const incompatible = result.error?.code === 'incompatible-version' || result.packageResult?.incompatible?.length;
      throw new Error(incompatible ? '此插件与当前运行时版本不兼容。' : publicMessage(result.error?.message || result.packageResult?.output || '插件操作失败，请检查包来源和版本。'));
    }
    if (result.application === 'overridden') throw new Error('当前配置覆盖了此操作，请检查插件状态。');
    if (result.application === 'cancelled') throw new Error('已取消安装。');
    return { status: result.application, target: result.target };
  });
  route('licenses', ['GET'], async () => {
    const rootRequire = createRequire(import.meta.url);
    const profileRequire = createRequire(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'));
    const items = [
      ['DeepSeek Harness', join(dirname(rootRequire.resolve('@deepseek-ai/dsh/package.json')), 'LICENSE')],
      ['pnpm', new URL('../node_modules/pnpm/LICENSE', import.meta.url)],
      ['fflate', new URL('../node_modules/fflate/LICENSE', import.meta.url)],
    ];
    try { items.push(['Agent DAG Workflow', join(dirname(profileRequire.resolve('@gm-hz/agent-dag-workflow/package.json')), 'LICENSE')]); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    return Promise.all(items.map(async ([name, path]) => ({ name, text: await readFile(path, 'utf8') })));
  });
}

function requireSpec(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('请输入有效的插件包名或地址。');
  return value.trim();
}
