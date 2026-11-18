export const knowledgeStates = {
  matched: '已命中', empty: '未命中 · 按当前资料核对', unavailable: '知识库暂不可用 · 按当前资料核对',
};
const matchStates = { exact: '基线一致', relocate: '待在当前程序定位', reference: '相似设备参考 · 待定位' };
const entryStates = { static: '历史静态分析', pending: '待核实', reviewed: '已审核发布', draft: '待审核' };
export const draftStates = { queued: '待生成', generating: '正在生成', failed: '生成失败', review: '待审核',
  published: '已发布', rejected: '已驳回', empty: '无新增知识', unbound: '关联设备后生成' };

export function createKnowledgePage({ api, text, btn, heading, panel, field, dialog, refresh, notice, active, devices }) {
  let selected = '';
  let query = '';
  let data;
  let serial = 0;

  function positions(items, historical = false) {
    return `<ul class="knowledge-positions">${items.map(position => {
      const step = position.step != null ? ` · GX 步号 ${text(position.step)}${position.endStep ? '–' + text(position.endStep) : ''}` : '';
      const line = position.line ? ` · ${historical ? '历史 ' : ''}CSV 行 ${position.line}${position.endLine ? '–' + position.endLine : ''}` : '';
      return `<li>${text(position.file)}${step}${line}${position.meaning ? `<p>${text(position.meaning)}</p>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  function sources(items) {
    return `<ul class="knowledge-positions">${items.map(source => {
      const title = text([source.label, source.section].filter(Boolean).join(' · '));
      if (source.evidenceId) return `<li><a href="/api/electric/download?${text(new URLSearchParams({
        id: source.runId, kind: 'evidence', file: source.evidenceId }))}" download>${title}</a></li>`;
      return `<li>${source.path && source.projectId ? `<a href="/api/electric/project-archive?${text(new URLSearchParams({ id: source.projectId, file: source.path }))}" download>${title}</a>` :
        source.runId ? btn(title, `run:${source.runId}`, 'ghost') : title}</li>`;
    }).join('')}</ul>`;
  }

  function hitDetails(knowledge) {
    if (!knowledge) return '';
    return `<div class="detail-group"><h3>知识引用</h3><p>${text(knowledgeStates[knowledge.status])}</p>
      <p>${knowledge.devices.map(device => text(`${device.name}${device.version ? ' v' + device.version : ' · 暂无发布版'}${device.reference ? '（参考）' : ''}`)).join('、') || '未选择设备库'}</p>
      ${knowledge.hits.map(hit => `<details><summary>${text(hit.title)} · ${matchStates[hit.match]}</summary>
        <p>${text(hit.name)} v${hit.version} · ${entryStates[hit.status]}</p><p>${text(hit.meaning)}</p>
        ${positions(hit.positions, hit.match !== 'exact')}${sources(hit.sources)}</details>`).join('')}</div>`;
  }

  function render() {
    const catalog = devices();
    const groups = data?.entries || [];
    const jobs = data?.drafts || [];
    const fields = `<form class="knowledge-search" data-knowledge-search>
      ${field('设备', `<select name="device" aria-label="设备">${catalog.map(item => `<option value="${text(item.id)}"${item.id === selected ? ' selected' : ''}>${text(item.name)}</option>`).join('')}</select>`)}
      ${field('关键词', `<input name="query" type="search" maxlength="160" value="${text(query)}">`)}
      <button type="submit" class="button">搜索</button></form>`;
    return heading('PLC 知识库', '按设备查找 PLC 程序含义、程序位置与排查线索。', btn('＋ 新建设备', 'knowledge-new', 'primary')) +
      (catalog.length ? panel('设备知识', `<div class="panel-body pane-list">${fields}
        ${groups.length ? groups.map(entry => `<details class="knowledge-entry" data-preserve-key="${text(entry.id)}"><summary>
        <strong>${text(entry.title)}</strong><span>${text(entry.category)} · ${entryStates[entry.status]}</span></summary>
        <div><p>${text(entry.meaning)}</p><p class="small">适用 · ${text(entry.applicability)}</p>
        ${positions(entry.positions, true)}${sources(entry.sources)}</div></details>`).join('') :
        `<p class="empty">${data ? '没有匹配的条目。' : '正在读取设备知识…'}</p>`}</div>`,
        data?.version ? `v${data.version} · ${groups.length} 条` : '') +
      panel('完工知识草稿', `<div class="panel-body pane-list">${jobs.length ? jobs.map(job => `<div class="list-item"><div>
        <strong>${text(job.project || '工程运行')}${job.testRun ? ' · 测试草稿' : ''}</strong><p>${draftStates[job.state]}${job.publishedVersion ? ` · v${job.publishedVersion}` : ''}
        ${job.error ? ' · ' + text(job.error) : ''}</p></div><div class="actions">${btn('查看运行', `run:${job.runId}`)}
        ${job.state === 'review' ? btn(job.testRun ? '查看草稿' : '审核', `knowledge-review:${job.runId}`) : ''}
        ${job.state === 'failed' ? btn('重试', `knowledge-retry:${job.runId}`) : ''}</div></div>`).join('') :
        '<p class="empty">此设备暂无完工草稿。</p>'}</div>`, '', btn('刷新', 'knowledge-refresh')) :
      panel('设备知识', '<div class="panel-body"><p class="empty">暂无设备。先创建一个设备，再从工程项目关联。</p></div>'));
  }

  async function load(device = selected, term = query, force = true) {
    const index = ++serial;
    selected = devices().find(item => item.id === device)?.id || devices()[0]?.id || '';
    query = term;
    const value = selected ? await api(`knowledge?${new URLSearchParams({ device: selected, q: query })}`) : null;
    if (serial !== index || !active()) return;
    if (force || JSON.stringify(value) !== JSON.stringify(data)) {
      data = value;
      refresh();
    }
  }

  async function search(form) {
    const values = new FormData(form);
    await load(values.get('device'), values.get('query').trim());
  }

  async function review(runId) {
    const current = await api(`knowledge?${new URLSearchParams({ device: selected })}`);
    const draft = current.drafts.find(job => job.runId === runId && job.state === 'review');
    if (!draft) { await load(); return; }
    const entries = draft.entries.map((entry, index) => {
      const older = current.entries.find(item => item.id === entry.replaces);
      return `<fieldset class="knowledge-review"><legend>${text(entry.category)}</legend>
        ${draft.testRun ? '' : `<label><input type="checkbox" name="accept" value="${index}" checked> 发布此条</label>`}
        ${older ? `<details><summary>当前条目 · ${text(older.title)}</summary><p>${text(older.meaning)}</p><p class="small">适用 · ${text(older.applicability)}</p></details>` : ''}
        ${field('标题', `<input name="title-${index}" maxlength="120" value="${text(entry.title)}"${draft.testRun ? ' readonly' : ''}>`)}
        ${field('程序含义', `<textarea name="meaning-${index}" maxlength="1000"${draft.testRun ? ' readonly' : ''}>${text(entry.meaning)}</textarea>`)}
        ${field('适用条件', `<textarea name="condition-${index}" maxlength="500"${draft.testRun ? ' readonly' : ''}>${text(entry.applicability)}</textarea>`)}
        ${positions(entry.positions)}${entry.positions[0]?.excerpt ? `<pre>${text(entry.positions[0].excerpt)}</pre>` : ''}</fieldset>`;
    }).join('');
    const evidence = draft.evidence.map(log => `<li><a href="/api/electric/download?${text(new URLSearchParams({
      id: runId, kind: 'evidence', file: log.id }))}" download>${draft.testRun ? '测试记录' : log.kind === 'compile' ? '编译' : '仿真'} · ${text(log.fileName)}</a>
      <span class="small"> · ${text(log.tool)} · ${text(log.date)}</span></li>`).join('');
    dialog(draft.testRun ? '查看测试知识草稿' : '审核知识草稿', `<p>${text(draft.project)} · ${draft.entries.length} 条${draft.testRun ? ' · 仅供演练' : ''}</p>
      <ul class="knowledge-positions">${evidence}</ul>${entries}
      ${btn('驳回草稿', `knowledge-reject:${runId}`, 'danger')}`, draft.testRun ? '关闭' : '发布选中条目',
    async values => {
      if (draft.testRun) return;
      const selectedEntries = [...document.querySelectorAll('#dialog input[name=accept]:checked')].map(option => {
        const index = Number(option.value);
        return { id: draft.entries[index].id, title: values[`title-${index}`],
          meaning: values[`meaning-${index}`], applicability: values[`condition-${index}`] };
      });
      await api('knowledge', { op: 'publish', runId, expected: current.version || 0, entries: selectedEntries });
      await load();
      return '知识已发布。';
    });
  }

  return { render, load, search, positions, hitDetails, review, show: id => load(id, ''),
    async poll() {
      if (!active() || document.querySelector('dialog[open]') || document.activeElement?.closest('[data-knowledge-search]')) return;
      if (data?.drafts.some(job => ['queued', 'generating'].includes(job.state))) await load(selected, query, false);
    },
    async retry(runId) {
      await api('knowledge', { op: 'retry', runId });
      await load();
      notice('草稿已重新排队。');
    },
    reject(runId) {
      dialog('驳回知识草稿', '<p>该草稿将结束审核。</p>', '确认驳回', async () => {
        await api('knowledge', { op: 'reject', runId });
        await load();
        return '草稿已驳回。';
      }, true);
    },
  };
}
