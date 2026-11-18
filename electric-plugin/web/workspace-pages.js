export function workspacePages({ api, btn, tag, field, heading, panel, dialog, notice, text, refresh, active }) {
  let models, plugins, licenses;
  const loading = '<div class="initial" role="status">正在加载…</div>';
  const byId = (list, id) => list?.find(row => row.id === id);
  const buttonKey = key => encodeURIComponent(key);
  const wrap = content => `<div class="panel-body pane-list">${content}</div>`;
  const row = (title, info, actions) => `<div class="list-item"><div><strong>${text(title)}</strong>${info}</div><div class="actions">${actions}</div></div>`;
  const option = (id, label, selected) => `<option value="${text(id)}"${selected ? ' selected' : ''}>${text(label)}</option>`;

  function modelPage() {
    return heading('模型设置', '配置工作流和 Agent 会话使用的模型连接。', models?.writable ? btn('添加连接', 'model-add', 'primary') : '') +
      (models ? panel('模型连接', wrap(models.providers.filter(item => item.configured).map(item => {
        const key = buttonKey(item.id);
        const info = `<p>${text(item.baseURL || item.defaultEndpoint || item.id)}</p>${item.models.length ? `<p>${item.models.map(text).join(' · ')}</p>` : ''}`;
        return row(item.label || item.id, info, (models.writable ? btn('编辑', `model-edit:${key}`, '', `aria-label="编辑 ${text(item.label || item.id)}"`) : '') +
          btn('测试连接', `model-test:${key}`, '', `aria-label="测试 ${text(item.label || item.id)}"`) +
          (item.removable ? btn('移除', `model-remove:${key}`, 'danger') : ''));
      }).join('') || '<p class="empty">暂无模型连接。</p>')) : loading);
  }

  function modelDialog(item) {
    const existing = Boolean(item);
    const protocol = item?.protocol || 'openai-completions';
    const fields = (existing ? '' : field('连接标识', '<input name="id" required pattern="[a-z][a-z0-9-]{0,62}" placeholder="例如 lab-endpoint">')) +
      (item?.fixed ? '' : field('连接名称', `<input name="label" maxlength="80" value="${text(item?.label)}">`)) +
      field('服务地址', `<input type="url" name="baseURL" value="${text(item?.baseURL)}" placeholder="${text(item?.defaultEndpoint || 'https://example.com/v1')}"${item?.fixed ? '' : ' required'}>`) +
      (item?.fixed ? '' : field('接口协议', `<select name="protocol">${Object.entries(models.protocols).map(([key, name]) => option(key, name, key === protocol)).join('')}</select>`)) +
      field('API Key', '<input type="password" name="apiKey" autocomplete="new-password" placeholder="留空以保留现有密钥">') +
      field('模型 ID（每行一个）', `<textarea name="models">${text(item?.models.join('\n'))}</textarea>`) +
      `<div class="actions"><button type="button" class="button" data-discover>发现模型</button><span class="small" role="status" data-discovery></span></div>`;
    const form = dialog(existing ? `编辑 ${item.label || item.id}` : '添加模型连接', fields, '保存连接', async values => {
      await api('models', { ...values, id: item?.id || values.id, op: 'save', existing, revision: item?.revision ?? null,
        models: values.models.split(/\r?\n/) });
      models = await api('models');
      return '模型连接已保存。';
    });
    const discover = form.querySelector('[data-discover]');
    discover.addEventListener('click', async () => {
      if (!form.reportValidity()) return;
      const status = form.querySelector('[data-discovery]');
      discover.disabled = true;
      status.textContent = '正在发现模型…';
      try {
        const values = Object.fromEntries(new FormData(form));
        const result = await api('models', { ...values, id: item?.id || values.id, op: 'discover' });
        form.elements.models.value = result.models.slice(0, 50).join('\n');
        status.textContent = result.models.length > 50 ? '已带入前 50 个模型，可编辑列表。' : `发现 ${result.models.length} 个模型。`;
      } catch (error) { status.textContent = error.message; }
      finally { discover.disabled = false; }
    });
  }

  function testModel(item) {
    const choices = item.available.length ? item.available : item.models;
    dialog('测试模型连接', field('模型 ID', `<input name="model" required list="probe-models" value="${text(choices[0])}"><datalist id="probe-models">${choices.map(id => option(id, id)).join('')}</datalist>`) +
      '<p class="small">仅发送一条测试消息。</p>', '执行测试', async ({ model }) => {
      await api('models', { op: 'test', id: item.id, model });
      return '模型连接测试通过。';
    });
  }

  function pluginPage() {
    const actions = '<a class="button" href="https://github.com/topics/dsh-plugin" target="_blank" rel="noopener noreferrer">社区插件目录 ↗</a>' + btn('安装插件', 'plugin-add', 'primary');
    return heading('插件管理', '安装和管理本机工作区的扩展。', actions) + (plugins ? panel('可用插件', wrap(plugins.map(plugin => {
      const key = buttonKey(plugin.name);
      const own = plugin.name === 'agents-electric-workbench';
      const enabled = plugin.error ? tag(plugin.error === 'incompatible-version' ? '版本不兼容' : '加载异常', 'bad')
        : tag(plugin.enabled ? '已启用' : plugin.installed ? '已停用' : '可安装', plugin.enabled ? 'ok' : '');
      const info = `<p>${text(plugin.version)} ${text(plugin.description)}</p>`;
      return row(own ? 'Agents Electric 工作台' : plugin.name.replace(/^@deepseek-ai\/dsh-/, ''), info, enabled +
        (!own && plugin.installed && plugin.manageable ? btn(plugin.enabled ? '停用' : '启用', `plugin-toggle:${key}`) : '') +
        (!plugin.installed && plugin.offered ? btn('安装', `plugin-offered:${key}`) : '') +
        (!own && plugin.removable ? btn('卸载', `plugin-remove:${key}`, 'danger') : ''));
    }).join('') || '<p class="empty">暂无本机插件。</p>')) : loading);
  }

  function installPlugin() {
    dialog('安装社区插件', field('包名或安装地址', '<input name="spec" required maxlength="1000" placeholder="@scope/plugin@version">') +
      '<p class="small">检查包来源与版本后再安装。启用后插件可在本机运行代码。</p>', '检查插件', async ({ spec }) => {
      const plugin = await api('plugins', { op: 'inspect', spec });
      setTimeout(() => {
        if (!active('plugins')) return;
        confirmPlugin(spec, plugin);
      }, 0);
    });
  }

  function confirmPlugin(spec, plugin, packages = []) {
    const buildFields = packages.length ? `<p>安装需要允许以下依赖执行构建脚本。</p><ul>${packages.map(name => `<li>${text(name)}</li>`).join('')}</ul>` : '';
    dialog(packages.length ? '允许插件构建脚本' : '确认安装插件',
      `<div class="form-hint"><strong>${text(plugin.name)} ${text(plugin.version)}</strong><p>${text(plugin.description)}</p><p class="mono">${text(spec)}</p></div>${buildFields}`,
      packages.length ? '允许并安装' : '安装', async () => {
        const result = await api('plugins', { op: 'install', spec, approvedBuilds: packages });
        if (result.status === 'approval-required') {
          setTimeout(() => { if (active('plugins')) confirmPlugin(spec, plugin, result.packages); }, 0);
          return;
        }
        plugins = await api('plugins');
        return result.status === 'restart-required' ? '插件已安装，重启工作台后生效。' : '插件已安装。';
      });
  }

  function aboutPage() {
    return heading('关于 Agents Electric', '电气工程工作台', '') +
      (licenses ? panel('开源许可', wrap(licenses.map(item => `<details class="license"><summary>${text(item.name)}</summary><pre>${text(item.text)}</pre></details>`).join(''))) : loading);
  }

  return {
    render(view) {
      const renderers = { settings: modelPage, plugins: pluginPage, about: aboutPage };
      return renderers[view]?.() || loading;
    },
    async open(view) {
      if (view === 'settings') models = await api('models');
      if (view === 'plugins') plugins = await api('plugins');
      if (view === 'about') licenses = await api('licenses');
    },
    async action(verb, rawKey) {
      const key = rawKey && decodeURIComponent(rawKey);
      const item = byId(models?.providers, key);
      switch (verb) {
        case 'model-add': return modelDialog();
        case 'model-edit': return modelDialog(item);
        case 'model-test': return testModel(item);
        case 'model-remove': return dialog('移除模型连接', `<p>${text(item.label || item.id)}</p>`, '移除', async () => {
          await api('models', { op: 'remove', id: key, revision: item.revision });
          models = await api('models');
          return '模型连接已移除。';
        }, true);
        case 'plugin-add': return installPlugin();
        case 'plugin-offered': {
          const plugin = plugins.find(entry => entry.name === key);
          return confirmPlugin(plugin.offered, plugin);
        }
        case 'plugin-toggle': {
          const plugin = plugins.find(entry => entry.name === key);
          const result = await api('plugins', { op: 'enable', name: key, enabled: !plugin.enabled });
          plugins = await api('plugins');
          refresh();
          if (result.status === 'restart-required') notice('插件状态已保存，重启工作台后生效。');
          return;
        }
        case 'plugin-remove': return dialog('卸载插件', `<p>${text(key)}</p>`, '卸载', async () => {
          const result = await api('plugins', { op: 'remove', name: key });
          plugins = await api('plugins');
          return result.status === 'restart-required' ? '已登记卸载，重启工作台后生效。' : '插件已卸载。';
        }, true);
      }
    },
  };
}
