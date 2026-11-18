const official = 'deepseek-official';
const customNamespace = 'llm-pi-ai';
const providerId = /^[a-z][a-z0-9-]{0,62}$/;
const protocols = {
  'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages', 'google-generative-ai': 'Gemini API',
};
const getPath = (value, path) => path.reduce((object, key) => object?.[key], value);

function endpoint(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 服务地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址须使用 HTTP 或 HTTPS，不含凭据、查询参数或片段。');
  }
  return url.href;
}

function directory(ctx) {
  const settings = ctx.settingsController.describe();
  const namespaces = new Map(settings.namespaces.map(view => [view.ns, view]));
  const providers = new Map(ctx.llm.listConfigurableProviders().filter(entry => namespaces.has(entry.settingsNs))
    .map(entry => [entry.provider, entry]));
  return { namespaces, providers, writable: settings.writable };
}

function modelFields(value, oldModels) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('请填写最多 50 个模型 ID。');
  const unique = [...new Set(value.map(id => String(id).trim()).filter(Boolean))];
  if (unique.some(id => id.length > 180)) throw new Error('模型 ID 最长 180 字符。');
  return unique.map(id => oldModels?.find(model => model.id === id) || { id });
}

export function registerModelRoutes(ctx, route) {
  route('models', ['GET', 'POST'], async request => {
    const { namespaces, providers, writable } = directory(ctx);
    if (request.method === 'GET') {
      const catalog = await ctx.sessionController.modelCatalog();
      const available = new Map(catalog.groups.map(group => [group.id, group.models.map(model => model.id)]));
      const rows = [...providers.values()].map(entry => {
        const namespace = namespaces.get(entry.settingsNs);
        const resolved = getPath(namespace.value, entry.settingsPath) || {};
        const configured = entry.provider === official || getPath(namespace.user, entry.settingsPath) !== undefined ||
          entry.settingsPath.length > 0 && getPath(namespace.base, entry.settingsPath) !== undefined;
        return { id: entry.provider, label: resolved.displayName || entry.displayName, configured,
          fixed: entry.provider === official, revision: namespace.revision, defaultEndpoint: entry.defaultBaseURL || '',
          baseURL: resolved.baseURL || '', protocol: resolved.api || '', models: (resolved.models || []).map(model => model.id),
          available: available.get(entry.provider) || [],
          removable: entry.settingsPath.length > 0 && getPath(namespace.user, entry.settingsPath) !== undefined && getPath(namespace.base, entry.settingsPath) === undefined };
      });
      return { providers: rows, protocols, writable, catalog: catalog.groups.map(group => ({
        id: group.id, name: group.name, models: group.models.map(model => model.id),
      })) };
    }
    const body = await request.json();
    const id = String(body.id || '');
    if (!providerId.test(id)) throw new Error('连接标识须以小写字母开头，可包含数字和连字符。');
    if (body.op === 'test') {
      if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('请选择测试模型。');
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
      let finished = false, answered = false;
      for await (const chunk of ctx.llm.stream({ provider: id, model: body.model, maxTokens: 32, signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: '只回复 OK。' }] }] })) {
        if (chunk.type === 'text-delta' && chunk.text.trim()) answered = true;
        if (chunk.type === 'finish') {
          const outcome = chunk.reason?.kind || chunk.reason;
          if (['error', 'aborted'].includes(outcome)) throw new Error('模型未完成测试响应，请检查服务地址、模型 ID 和 API Key。');
          finished = true;
        }
      }
      if (!finished || !answered) throw new Error('模型未返回有效文本。');
      return { connected: true };
    }
    const entry = providers.get(id);
    const namespace = namespaces.get(entry?.settingsNs || customNamespace);
    if (!writable || !namespace) throw new Error('当前模型配置不可写。');
    const path = entry?.settingsPath || ['providers', id];
    const resolved = getPath(namespace.value, path) || {};
    const user = getPath(namespace.user, path);
    if (body.op === 'discover') {
      const baseURL = endpoint(body.baseURL) || resolved.baseURL;
      const api = protocols[body.protocol] ? body.protocol : undefined;
      const models = await ctx.llm.discoverModels(namespace.ns, { provider: entry?.provider, baseURL, api,
        ...(body.apiKey ? { apiKey: String(body.apiKey) } : {}) }, AbortSignal.any([request.signal, AbortSignal.timeout(30000)]))
        .catch(() => { throw new Error('无法发现模型，请检查连接参数。'); });
      return { models: models.map(model => model.id) };
    }
    if (body.revision !== namespace.revision && (entry || body.revision !== null)) throw new Error('连接配置已更新，请重新打开编辑。');
    if (body.op === 'remove') {
      if (!user || path.length === 0 || getPath(namespace.base, path) !== undefined) throw new Error('此连接由运行时管理。');
      await ctx.settingsController.mutate(namespace.ns, [{ op: 'unset', path }], namespace.revision);
      return { removed: true };
    }
    if (body.op !== 'save') throw new Error('模型连接操作未知。');
    const baseURL = endpoint(body.baseURL);
    const models = modelFields(body.models, resolved.models);
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey.length > 8192) throw new Error('API Key 长度无效。');
    const ops = [];
    function edit(key, value) {
      if (value !== undefined) ops.push({ op: 'set', path: [...path, key], value });
      else if (Object.hasOwn(user || {}, key)) ops.push({ op: 'unset', path: [...path, key] });
    }
    if (!entry && (body.existing || !baseURL || !models.length || !protocols[body.protocol])) {
      throw new Error('新连接需要有效的服务地址、协议和至少一个模型 ID。');
    }
    if (id !== official) edit('displayName', label || undefined);
    edit('baseURL', baseURL || undefined);
    if (!entry || entry.declared) {
      if (!baseURL || !models.length || !protocols[body.protocol]) throw new Error('自定义连接需要地址、协议和模型 ID。');
      edit('api', body.protocol);
    }
    if (models.length) {
      if (JSON.stringify(models) !== JSON.stringify(resolved.models)) edit('models', models);
    } else edit('models', undefined);
    const keyRef = resolved.apiKeyEnv || `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    if (apiKey) edit('apiKeyEnv', keyRef);
    if (ops.length) await ctx.settingsController.mutate(namespace.ns, ops, namespace.revision);
    if (apiKey) await ctx.credentialsController.set(keyRef, apiKey).catch(() => { throw new Error('连接配置已保存，API Key 保存失败。请重新输入。'); });
    return { saved: true };
  });
}
