import { workspacePages } from './workspace-pages.js';
import { createKnowledgePage, draftStates } from './knowledge-page.js';

const ui = Object.fromEntries(['app', 'nav', 'top', 'notice', 'main', 'dialog', 'question'].map(id => [id, document.getElementById(id)]));
const text = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
const kinds = { knowledge: '设备知识调用', agent: 'Agent 步骤', proposal: '候选建议 Agent', approval: '人工确认', candidate: '候选生成', evidence: '证据导入', release: '交付审核' };
const phases = { delivered: '已交付', implemented: '已实施', accepted: '现场已接受' };
const folderStates = { read: '已读取', listed: '仅列清单', truncated: '部分已读取', unreadable: '正文无法读取' };
const programCount = project => project?.folder?.files.filter(file => file.digest).length || 0;
const taskOutputs = { knowledge: '命中的知识条目、基线匹配结果与来源', agent: '核对结论、发现和待补资料', proposal: '候选改动说明与逐行变更清单',
  approval: '放行或驳回及审核说明', candidate: '候选 CSV、源文件摘要与差异', evidence: '编译和仿真日志及人工判定',
  release: '当前候选版本的交付决定' };
const state = { view: 'workflow', projectId: sessionStorage.getItem('electric-project'), runId: sessionStorage.getItem('electric-run'), stepId: 'intake-check',
  data: { projects: [], templates: [], runs: [], devices: [] }, snapshot: null, events: [], seq: 0, options: null, questions: [],
  editor: null, stepEdit: null, detail: false, sessionPath: '/agent-sessions', collapsed: sessionStorage.getItem('electric-collapse') === 'yes' };
const deferredQuestions = new Map();
let questionRevision = 0;
const btn = (label, action, css = '', attrs = '') => `<button type="button" class="button ${css}" data-action="${action}" ${attrs}>${label}</button>`;
const tag = (label, tone = '') => `<span class="pill ${tone}">${text(label)}</span>`;
const field = (label, element) => `<label class="field">${label}${element}</label>`;
const close = () => btn('×', 'close', 'icon ghost', 'aria-label="关闭"');

async function api(path, data) {
  const response = await fetch(`/api/electric/${path}`, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`工作台连接失败（${response.status}）`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}

function notice(message = '', error = false) {
  ui.notice.innerHTML = message ? `<div class="notice${error ? ' error' : ''}"><span>${text(message)}</span><button type="button" data-action="clear" aria-label="关闭通知">×</button></div>` : '';
}

function currentProject() { return state.data.projects.find(project => project.id === state.projectId); }
function selectProject(id) {
  state.projectId = id;
  if (id) sessionStorage.setItem('electric-project', id);
  else sessionStorage.removeItem('electric-project');
}
function exampleTemplate() { return state.data.templates.find(template => template.id === 'plc-offline'); }
function questionFor(step) {
  const child = state.snapshot?.checkpoint?.nodeProgress?.[step.id]?.sessionId;
  return child ? state.questions.find(question => question.session === child) : null;
}
function approvalBlockers(gate) {
  return (gate?.approvalRequiresName ? gate.materialBlockers : gate?.blockers) || [];
}
function status(step) {
  if (!state.runId && step.id === 'intake-check') return ['待提交资料', 'wait'];
  const value = state.snapshot?.checkpoint?.nodeStates[step.id];
  if (value === 'running' && questionFor(step)) return ['待你补充', 'wait'];
  if (value === 'waiting' && step.kind === 'evidence') return ['待导入证据', 'wait'];
  if (value === 'waiting' && state.snapshot.gates?.some(gate => gate.node === step.id && approvalBlockers(gate).length)) return ['待补资料', 'wait'];
  const labels = { succeeded: ['已完成', 'ok'], running: ['运行中', 'run'], waiting: ['待人工确认', 'wait'],
    ready: ['已就绪', 'run'], failed: ['失败', 'bad'], cancelled: ['已停止', 'bad'], needs_attention: ['待核查', 'wait'], skipped: ['已跳过', ''] };
  return labels[value] || ['待开始', ''];
}

function navButton(icon, label, action, active = false) {
  return `<button type="button" class="navbtn" data-action="${action}" title="${label}" aria-label="${label}"${active ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span><span class="navtxt">${label}</span></button>`;
}

function chrome() {
  const restoreFocus = document.activeElement?.classList.contains('brand-mark');
  ui.app.classList.toggle('collapsed', state.collapsed);
  ui.app.classList.toggle('native-sessions', state.view === 'sessions');
  const tabs = [['▦', '工程项目', 'projects'], ['⌁', '实施流程', 'workflow'], ['▤', '工作流模板', 'templates'], ['◷', '运行记录', 'runs'],
    ['▥', 'PLC 知识库', 'knowledge']];
  const tools = [['◫', 'Agent 会话', 'sessions'], ['◇', '插件管理', 'plugins'], ['⚙', '模型设置', 'settings']];
  const toggle = state.collapsed ? '展开导航' : '收起导航';
  const items = group => group.map(([icon, label, key]) => navButton(icon, label, `view:${key}`, state.view === key)).join('');
  ui.nav.innerHTML = `<div class="rail-brand"><button type="button" class="brand-mark" data-action="collapse" aria-label="${toggle}" aria-expanded="${!state.collapsed}" title="${toggle}"></button><div class="brand-copy"><div class="brand-title">Agents Electric</div><div class="brand-caption">电气工程工作台</div></div></div>
    <div class="navgroup">${items(tabs)}</div><div class="rail-divider"></div>
    <div class="navgroup">${items(tools)}</div>
    <div class="navgroup bottom">${navButton('⇤', toggle, 'collapse')}</div>`;
  if (restoreFocus) ui.nav.querySelector('.brand-mark').focus({ preventScroll: true });
  const caption = [...tabs, ...tools, ['', '关于', 'about']].find(entry => entry[2] === state.view)?.[1] || '工作台';
  ui.top.innerHTML = `<div class="bread">${state.view === 'sessions' ? btn('← 返回工作台', 'view:workflow', 'ghost') : '<span>工作台</span>'}<span aria-hidden="true">/</span><strong>${caption}</strong>${state.view === 'workflow' && currentProject() ? `<span class="hide-narrow" aria-hidden="true">/</span><strong class="hide-narrow">${text(currentProject().name)}</strong>` : ''}</div>
    <div class="top-actions">${state.view === 'sessions' ? btn('会话历史', 'session-history') : ''}<span class="local">本机工作区</span>
    ${btn('', 'workflow-question', 'primary', 'id="questions-button" hidden')}${btn('关于', 'view:about', 'ghost')}</div>`;
  updateQuestionButton();
}

function heading(title, subtitle, actions, eyebrow = '') {
  return `<section class="hero"><div>${eyebrow ? `<p class="eyebrow">${text(eyebrow)}</p>` : ''}<h1>${text(title)}</h1><p class="subtitle">${text(subtitle)}</p></div><div class="actions">${actions}</div></section>`;
}

function panel(title, body, sub = '', action = '') {
  return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2>${sub ? `<p class="panel-sub">${sub}</p>` : ''}</div>${action}</div>${body}</section>`;
}

function download(label, kind, filename = '') {
  return `<a class="button" href="/api/electric/download?id=${encodeURIComponent(state.runId)}&amp;kind=${kind}${filename ? `&amp;file=${encodeURIComponent(filename)}` : ''}">${label}</a>`;
}

function projectList() {
  const rows = state.data.projects.map(project => {
    const device = state.data.devices?.find(item => item.id === project.deviceId);
    return `<div class="list-item"><div><strong>${text(project.name)}</strong><p>${text(project.cpu)} · ${text(project.toolchain)}
      ${device ? ' · ' + text(device.name) : ''}</p></div><div class="actions">
      ${btn(device ? '更换关联设备' : '关联设备', `knowledge-bind:${project.id}`)}
      ${project.hasArchive ? btn('交付物与生成物', `project-archive:${project.id}`) : ''}
      ${btn('打开', `project:${project.id}`)}</div></div>`;
  });
  return heading('工程项目', '管理 PLC/HMI 离线工程项目。', btn('＋ 新建项目', 'new-project', 'primary')) +
    panel('项目列表', `<div class="panel-body pane-list">${rows.join('') || '<p class="empty">尚无项目。</p>'}</div>`, `${rows.length} 个项目`, btn('载入脱敏示例', 'sample'));
}

function runList() {
  const rows = state.data.runs.map(item => {
    const project = state.data.projects.find(candidate => candidate.id === item.projectId);
    return `<div class="list-item"><div><strong>${text(project?.name)} · ${text(item.name)}</strong>${item.testRun ? ' ' + tag('测试运行', 'wait') : ''}<p>模板 v${item.revision} · ${text(time(item.createdAt))}${item.model ? ` · ${text(item.model.model)}` : ''}</p></div>
      <div class="actions">${btn('查看运行', `run:${item.id}`)}${btn('删除', `delete-run:${item.id}`, 'danger')}</div></div>`;
  });
  return heading('运行记录', '按固定模板版本追踪任务、人工决定和工程制品。', btn('＋ 启动流程', 'new-run', 'primary')) +
    panel('历史运行', `<div class="panel-body pane-list">${rows.join('') || '<p class="empty">启动一次流程后，记录会出现在这里。</p>'}</div>`);
}

function listSteps(steps, selected) {
  const row = (step, index) => {
    const [label, tone] = status(step);
    return `<button type="button" class="step${selected === step.id ? ' active' : ''}${tone === 'ok' ? ' done' : ''}" data-action="step:${step.id}" aria-pressed="${selected === step.id}">
      <span class="mark" aria-hidden="true">${tone === 'ok' ? '✓' : index + 1}</span><span><span class="step-name">${text(step.name)}</span><span class="step-role">${text(step.role)}</span></span>${tag(label, tone)}</button>`;
  };
  return steps.map((step, index) => {
    if (step.id === 'requirements' && steps[index + 1]?.id === 'baseline') {
      return `<div class="parallel"><div class="parallel-label">并行核对 · 2 个 Agent</div>${row(step, index)}${row(steps[index + 1], index + 1)}</div>`;
    }
    if (step.id === 'baseline' && steps[index - 1]?.id === 'requirements') return '';
    return row(step, index);
  }).join('');
}

function engineeringPanel(snapshot, plc) {
  if (!plc) return '';
  const { candidate, evidence = [], milestones = [] } = snapshot || {};
  const testRun = snapshot?.item?.testRun;
  const on = kind => evidence.findLast(log => log.kind === kind && log.digest === candidate?.digest);
  const records = ['compile', 'simulation'].map(kind => {
    const log = on(kind);
    const label = testRun ? (kind === 'compile' ? '候选结构检查' : '模拟验收') : (kind === 'compile' ? '编译' : '仿真');
    const result = log?.verdict === 'pass' ? '通过' : '失败';
    return `<div class="log"><strong class="small">${label}</strong> ${log ? tag((testRun ? '测试' : '人工登记') + result, log.verdict === 'pass' ? 'ok' : 'bad') : tag('未验证', 'wait')}
      ${log ? `<p>${text(log.tool)} · ${text(log.date)}</p><p>${text(log.note)}</p>${download('下载日志', 'evidence', log.id)}` : ''}</div>`;
  }).join('');
  const states = Object.entries(testRun ? { tested: '测试验收' } : phases).map(([kind, label]) => {
    const record = milestones.find(item => item.kind === kind);
    return `<div class="stage-chip${record ? ' done' : ''}"><b>${label}</b>${record ? `${text(time(record.at))}<br>${text(record.note)}` : '待登记'}</div>`;
  }).join('');
  const next = milestones.some(item => item.kind === 'delivered') && !milestones.some(item => item.kind === 'accepted') ?
    (milestones.some(item => item.kind === 'implemented') ? 'accepted' : 'implemented') : null;
  return `<div class="detail-group"><h3>${testRun ? '测试候选与记录' : '候选与工程证据'}</h3>${testRun ? '<p>工程验证 · 未验证</p>' : ''}${candidate ? `<p>候选摘要 <span class="mono" title="${candidate.digest}">${candidate.digest.slice(0, 14)}</span></p>
    <div class="actions">${download(testRun ? '测试候选' : candidate.files ? '候选程序组 ZIP' : '候选 CSV', 'candidate')}${download(testRun ? '测试交接包' : '交接包', 'handoff')}</div>
    <details><summary>查看候选差异 · ${candidate.diff.length} 行</summary>${candidate.diff.map(edit => `<div class="diff-row"><p>${edit.file ? `${text(edit.file)} · ` : ''}第 ${edit.line} 行</p><code class="diff-line before">− ${text(edit.before)}</code><code class="diff-line after">＋ ${text(edit.after)}</code></div>`).join('')}</details>` : '<p>等待候选生成后绑定验证日志。</p>'}
    <div class="logs">${records}</div>${candidate && !milestones.length && !['failed', 'cancelled'].includes(snapshot.checkpoint?.status) ? btn('导入验证日志', 'evidence') : ''}</div>
    <div class="detail-group"><h3>${testRun ? '全链路测试' : '交付与实施'}</h3><div class="three">${states}</div>${next && snapshot.checkpoint?.status === 'completed' ? `<div class="actions">${btn(`登记${phases[next]}`, `milestone:${next}`)}</div>` : ''}</div>`;
}

function taskSession(step, snapshot) {
  const id = step.id === 'intake' ? 'intake-check' : step.id;
  const child = snapshot?.checkpoint?.nodeOutputs?.[id]?.runId || snapshot?.checkpoint?.nodeProgress?.[id]?.sessionId;
  return child && `session:${encodeURIComponent(child)}:${encodeURIComponent(snapshot.item.sessionId)}`;
}

function stepDetail(step, snapshot, steps) {
  if (!step) return '';
  const [label, tone] = status(step);
  const gate = snapshot?.gates?.find(item => item.node === step.id);
  const session = taskSession(step, snapshot);
  const task = snapshot?.tasks?.[step.id];
  const stepEvents = state.events.filter(event => event.node?.id === step.id);
  const opening = stepEvents.findLast(event => event.type === 'node.started' || event.type === 'node.waiting');
  const ending = stepEvents.findLast(event => ['node.completed', 'node.failed', 'node.cancelled'].includes(event.type));
  const duration = opening ? `${Math.max(0, ((ending?.occurredAt || Date.now()) - opening.occurredAt) / 1000).toFixed(1)} 秒` : '—';
  const dependencies = step.depends.map(id => steps.find(item => item.id === id)?.name || id).join('、') || '—';
  const hasGate = gate && !gate.decision && gate.mode !== 'evidence' && ['waiting', 'running'].includes(snapshot?.checkpoint?.nodeStates?.[step.id]);
  const blockers = approvalBlockers(gate);
  const findings = gate?.approvalRequiresName ? (gate.blockers || []).filter(item => !blockers.includes(item)) : [];
  const project = ['intake-check', 'intake'].includes(step.id) ? snapshot?.project : null;
  const folder = project?.folder;
  const locations = snapshot?.checkpoint?.nodeOutputs?.[step.id]?.structured?.programLocations;
  const requirementSummary = step.id === 'intake-check' && snapshot?.checkpoint?.nodeOutputs?.knowledge ?
    snapshot.checkpoint.nodeOutputs[step.id]?.structured?.summary : '';
  const citations = snapshot?.checkpoint?.nodeOutputs?.knowledge?.knowledge;
  const folderDetails = folder ? `<details><summary>资料文件夹 · ${text(folder.name)}（${folder.files.length} 个文件）</summary>
    <ul>${folder.files.map(entry => `<li>${text(entry.path)} · ${entry.digest ? `已读取 ${entry.lines} 行` : text(folderStates[entry.state])}</li>`).join('')}</ul></details>` : '';
  return `<button class="drawer-dismiss${state.detail ? ' open' : ''}" data-action="hide-detail" aria-label="关闭详情"></button><aside class="glass detail${state.detail ? ' open' : ''}" aria-label="节点详情">
    <div class="panel-heading"><div><div class="panel-sub">节点详情</div><h2>${text(step.name)}</h2></div>${tag(label, tone)}${btn('×', 'hide-detail', 'icon close-detail', 'aria-label="关闭详情"')}</div>
    <div class="panel-body"><div class="detail-group"><dl class="meta"><dt>负责人</dt><dd>${text(step.role)}</dd><dt>前置节点</dt><dd>${text(dependencies)}</dd><dt>耗时</dt><dd>${duration}</dd>${step.skills.length ? `<dt>Skill</dt><dd>${text(step.skills.join('、'))}</dd>` : ''}</dl></div>
    <div class="detail-group"><h3>任务说明</h3><p>${text(step.prompt)}</p><p class="task-meta">需交付 · ${text(taskOutputs[step.kind])}</p>
      ${step.kind === 'knowledge' ? `<div class="actions">${btn(snapshot ? '从头启动新流程' : '启动流程', 'start-knowledge', 'primary')}</div>
        <p>提交需求和原始程序后，先查询设备知识，再由 Agent 核对。</p>` : ''}
      ${programCount(project) ? `<div class="actions">${download(`下载 ${programCount(project)} 个 CSV 原件`, 'baseline')}</div>` :
        project?.digest ? `<div class="actions">${download('下载原件', 'baseline')}</div><p>${text(project.cpu)} · ${text(project.toolchain)} · ${text(project.fileName)}</p>` : ''}
      ${project?.requirements ? `<details><summary>需求</summary><pre>${text(project.requirements)}</pre></details>` : ''}
      ${folderDetails}
      ${blockers.length ? `<p>待补资料</p><ul>${blockers.map(item => `<li>${text(item)}</li>`).join('')}</ul>` : ''}
      ${findings.length ? `<details><summary>Agent 核对建议 · ${findings.length} 项</summary><ul>${findings.map(item => `<li>${text(item)}</li>`).join('')}</ul></details>` : ''}
      ${hasGate ? `<div class="actions">${btn('通过', `decision:${step.id}:approve`, 'primary', blockers.length ? 'disabled' : '')}${btn('驳回', `decision:${step.id}:reject`, 'danger')}</div>` : ''}
      ${gate?.decision ? `<p>审核 · ${gate.decision.approved ? '通过' : '驳回'}${gate.decision.approver ? ` · 审批人 ${text(gate.decision.approver)} · ${text(time(gate.decision.at))}` : ''}
        ${gate.decision.note ? ` · ${text(gate.decision.note)}` : ''}</p>` : ''}</div>
    ${task?.failure ? `<div class="detail-group"><h3>失败原因</h3><p>${text(task.failure.title)}</p><p>${text(task.failure.next)}</p>
      ${task.failure.detail ? `<details><summary>运行报错${task.failure.code ? ` · ${text(task.failure.code)}` : ''}</summary><pre>${text(task.failure.detail)}</pre></details>` : ''}</div>` : ''}
    ${session ? `<div class="detail-group"><h3>Agent 会话</h3>${task?.latest ? `<p>最近工具 · ${text(task.latest.label)} · ${text(time(task.latest.at))}</p>` : ''}${btn('打开会话', session)}</div>` : ''}
    ${requirementSummary ? `<div class="detail-group"><h3>本次需求理解</h3><p>${text(requirementSummary.slice(0, 400))}</p></div>` : ''}
    ${locations?.length ? `<div class="detail-group"><h3>本次原件定位</h3>${knowledgePage.positions(locations)}</div>` : ''}
    ${step.kind === 'knowledge' ? knowledgePage.hitDetails(citations) : ''}
    ${!task?.failure && opening && tone === 'bad' ? `<div class="detail-group"><h3>失败原因</h3><p>${text(ending?.payload?.message || ending?.payload?.error || snapshot.checkpoint?.error || label)}</p></div>` : ''}
    ${stepEvents.length ? `<div class="detail-group"><details><summary>执行事件 · ${stepEvents.length}</summary><pre>${text(stepEvents.map(event => `${time(event.occurredAt)}  ${event.type}  ${JSON.stringify(event.payload)}`).join('\n'))}</pre></details></div>` : ''}
    ${engineeringPanel(snapshot, steps.some(item => item.kind === 'candidate'))}</div></aside>`;
}

function workflow() {
  const snapshot = state.snapshot;
  const project = snapshot?.project || currentProject();
  const entry = exampleTemplate();
  const form = snapshot?.form || entry?.publishedForm || entry?.form;
  if (!form) return heading('实施流程', '选择项目并启动已发布的工程流程。', btn('新建项目', 'new-project', 'primary'));
  const steps = form.steps;
  const counts = steps.filter(step => status(step)[1] === 'ok').length;
  const nodeStates = snapshot?.checkpoint?.nodeStates || {};
  const settled = snapshot?.checkpoint?.status;
  const priority = settled === 'failed' ? ['failed'] : ['needs_attention', 'waiting', 'running', 'ready', 'failed'];
  const next = priority.map(value => steps.find(step => nodeStates[step.id] === value)).find(Boolean) || steps.find(step => nodeStates[step.id] === 'pending') || steps[0];
  const selected = steps.find(step => step.id === state.stepId) || next;
  const waiting = snapshot?.gates?.find(item => item.node === next.id);
  const question = questionFor(next);
  const blockers = approvalBlockers(waiting);
  const blocked = blockers.length && ['intake', 'plan-review'].includes(next.id);
  const finished = ['completed', 'failed', 'cancelled'].includes(settled);
  const task = snapshot?.tasks?.[next.id];
  const failure = task?.failure;
  const [taskStatus, taskTone] = status(next);
  const activeTask = snapshot?.item?.runId && !['completed', 'cancelled'].includes(settled);
  const failedIntake = settled === 'failed' && next.id === 'intake-check';
  const session = activeTask && taskSession(next, snapshot);
  const testRun = snapshot?.item?.testRun;
  const currentTitle = settled === 'completed' ? (testRun ? '全链路测试已完成' : '本次流程已完成') : settled === 'cancelled' ? '本次流程已停止' : snapshot?.status === 'unknown' ? '启动结果待核查' : next.name;
  const context = settled === 'failed' ? failure?.title || snapshot.checkpoint.error || '检查失败节点后创建新任务。' : settled === 'completed' ?
    `${testRun ? '测试交接包可下载。工程验证 · 未验证。' : '查看交接制品与后续登记。'}${snapshot.knowledgeDraft ? '知识草稿 · ' + draftStates[snapshot.knowledgeDraft] : ''}` : settled === 'cancelled' ? '可查看已有运行记录。' :
    blockers.length ? `待补资料 · ${blockers.join('、')}` : snapshot?.status === 'unknown' ? snapshot.item.error || '请检查待核查运行。' :
      snapshot ? `${status(next)[0]} · ${next.role}` : '选择资料文件夹或单独提交需求与原始程序，由 Agent 核对。';
  const canResume = snapshot?.item?.runId && !finished && !snapshot.executorActive;
  const archive = currentProject()?.hasArchive ? btn('交付物与生成物', `project-archive:${currentProject().id}`) : '';
  const actions = `${archive}${canResume ? btn('恢复 / 核查', 'resume') : ''}${snapshot?.item?.runId && !finished ? btn('停止', 'cancel', 'danger') : ''}${btn(snapshot ? '＋ 启动流程' : '提交需求与原始程序', 'new-run', 'primary')}`;
  const taskActions = !snapshot && next.kind === 'knowledge' ? btn('开始', 'start-knowledge', 'primary') :
    question ? btn('回答 Agent', `workflow-question:${text(question.ticket)}`, 'primary') :
    waiting && !finished && !waiting.decision ?
    (blocked ? btn('补充资料并重新核对', 'retry-intake', 'primary') : waiting.approvalRequiresName ?
      btn('审批通过', `decision:${next.id}:approve`, 'primary') : btn('处理待办', `step:${next.id}`, 'primary')) :
    settled === 'completed' && snapshot?.knowledgeDraft ? (snapshot.knowledgeDraft === 'unbound' ? btn('关联设备', `knowledge-bind:${project.id}`) :
      btn('查看知识草稿', `knowledge-device:${snapshot.knowledgeDraftDeviceId}`)) :
    activeTask ? `${settled === 'failed' ? btn(failedIntake ? '修正并重新核对' : '沿用资料重新运行', 'retry-intake', 'primary') : ''}
      ${btn('查看任务详情', `step:${next.id}`)}${session ? btn('查看 Agent 会话', session) : ''}` : '';
  return heading(form.name, `${project?.name || '选择工程项目'} · ${project?.cpu || form.description || ''}${project?.sample ? ' · 脱敏示例' : ''}`, actions,
    `实施流程 / 模板 v${snapshot?.item?.revision || entry?.publishedRevision || 1}${testRun ? ' / 测试运行' : ''}`) +
    `<div class="overview">${panel('流程总览', `<section class="current${activeTask ? ' task-card' : ''}${settled === 'failed' ? ' task-failed' : ''}">
      <div>${activeTask ? `<p class="task-kicker">${settled === 'failed' ? '失败任务' : '当前任务'}</p>` : ''}
      <div class="current-heading"><span class="dot" aria-hidden="true"></span>${text(currentTitle)}${activeTask ? tag(taskStatus, taskTone) : ''}</div>
      <p>${text(context)}</p>${activeTask ? `<p class="task-meta">${text(next.role)}${snapshot.item.model?.model ? ` · ${text(snapshot.item.model.model)}` : ''}
        ${snapshot.checkpoint?.nodeAttempts?.[next.id] ? ` · 第 ${snapshot.checkpoint.nodeAttempts[next.id]} 次执行` : ''}</p>
        ${failure ? `<p>${text(failure.next)}</p>` : `<div class="task-goal"><p>${text(next.prompt)}</p><p>需交付 · ${text(taskOutputs[next.kind])}</p></div>`}
        ${failedIntake && !project?.digest && !programCount(project) ? '<p>待补资料 · 请重新选择资料文件夹，导入全部程序段 CSV。</p>' : ''}
        ${task?.latest ? `<p class="task-meta">最近工具 · ${text(task.latest.label)}</p>` : ''}` : ''}</div>
        ${taskActions ? `<div class="actions">${taskActions}</div>` : ''}</section><div class="timeline">${listSteps(steps, selected.id)}</div>`,
    snapshot?.item?.model ? `${text(snapshot.item.model.provider)} / ${text(snapshot.item.model.model)}` : '从确认原件到工程交付',
    `<div class="progress"><progress max="${steps.length}" value="${counts}" aria-label="流程进度"></progress>${counts} / ${steps.length}</div>`)}${stepDetail(selected, snapshot, steps)}</div>`;
}

function blankForm() {
  return { id: `workflow-${crypto.randomUUID().slice(0, 8)}`, name: '新工作流', description: '', plc: false,
    steps: [{ id: 'review', name: '人工审核', kind: 'approval', role: '工程师', prompt: '确认该任务后继续。', depends: [], skills: [] }] };
}

function templates() {
  const rows = state.data.templates.map(entry => `<div class="list-item"><div><strong>${text(entry.name)}</strong><p>${text(entry.form.description)} · ${entry.form.steps.length} 个节点 · ${entry.publishedRevision ? `已发布 v${entry.publishedRevision}` : '草稿'}</p></div><div class="actions">
    ${btn('复制', `copy:${entry.id}`)}${btn('编辑', `edit:${entry.id}`)}</div></div>`);
  const e = state.editor;
  if (!e) return heading('工作流模板', '预制步骤、依赖、Agent 任务和人工审核。', `<div class="actions">${btn('添加 Skill', 'new-skill')}${btn('＋ 新建模板', 'new-template', 'primary')}</div>`) +
    panel('模板列表', `<div class="panel-body pane-list">${rows.join('')}</div>`);
  const step = e.form.steps.find(item => item.id === state.stepEdit) || e.form.steps[0];
  const index = step ? e.form.steps.indexOf(step) : -1;
  const protectedStep = e.form.plc && ['knowledge', 'intake-check', 'intake', 'requirements', 'baseline', 'plan', 'plan-review', 'proposal', 'candidate', 'review', 'evidence', 'release'].includes(step?.id);
  const buttons = e.form.steps.map(s => `<button type="button" data-action="edit-step:${s.id}" aria-selected="${s.id === step?.id}">${text(s.name)}</button>`).join('');
  const refs = e.form.steps.filter(s => s.id !== step?.id);
  const pane = step ? `<div class="inputs"><div class="row">${field('名称', `<input data-step="name" maxlength="100" value="${text(step.name)}">`)}
    ${field('类型', `<select data-step="kind"${protectedStep ? ' disabled' : ''}>${Object.entries(kinds).filter(([key]) => ['agent', 'approval', step.kind].includes(key)).map(([key, label]) => `<option value="${key}"${key === step.kind ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}</div>
    ${field('负责人 / Agent 角色', `<input data-step="role" maxlength="72" value="${text(step.role)}">`)}
    ${field('任务说明', `<textarea data-step="prompt" maxlength="4000">${text(step.prompt)}</textarea>`)}
    ${refs.length ? `<div class="field">前置依赖<div class="checks">${refs.map(ref => `<label><input type="checkbox" data-dependency="${ref.id}"${step.depends.includes(ref.id) ? ' checked' : ''}>${text(ref.name)}</label>`).join('')}</div></div>` : ''}
    ${['agent', 'proposal'].includes(step.kind) ? `<div class="field">Skill<div class="checks">${[...new Set([...step.skills, ...(state.options?.skills || []).map(s => s.name)])].map(skill => `<label><input type="checkbox" data-skill="${text(skill)}"${step.skills.includes(skill) ? ' checked' : ''}>${text(skill)}</label>`).join('') || '<span>尚无可用 Skill</span>'}</div>${btn('添加 Skill', 'new-skill')}</div>` : ''}
    <div class="actions">${btn('上移', 'move-up', '', index < 1 ? 'disabled' : '')}${btn('下移', 'move-down', '', index === e.form.steps.length - 1 ? 'disabled' : '')}${btn('删除步骤', 'delete-step', 'danger', protectedStep ? 'disabled' : '')}</div></div>` : '<p class="empty">请先添加一个步骤。</p>';
  return heading('编辑模板', e.form.plc ? 'PLC 工程节点与必要依赖随模板保留。' : '为团队工作预设 Agent 步骤与人工确认。', btn('返回列表', 'back-template')) +
    panel('模板表单', `<div class="panel-body inputs"><div class="row">${field('模板名称', `<input data-template="name" maxlength="100" value="${text(e.form.name)}">`)}
    ${field('模板标识', `<input data-template="id" value="${text(e.form.id)}"${e.draftRevision ? ' readonly' : ''}>`)}</div>
    ${field('说明', `<input data-template="description" maxlength="250" value="${text(e.form.description)}">`)}
    <div class="editor"><div class="editor-steps">${buttons}${btn('＋ 添加步骤', 'add-step')}</div>${pane}</div></div>`,
    e.draftRevision ? `草稿 ${e.draftRevision}${e.publishedRevision ? ` · 已发布 v${e.publishedRevision}` : ''}` : '新草稿',
    `<div class="actions">${btn('保存草稿', 'save-template')}${btn('发布', 'publish-template', 'primary')}</div>`);
}

function body() {
  const focused = document.activeElement?.dataset?.action;
  const detailKey = element => element.dataset.preserveKey || element.querySelector('summary')?.textContent;
  const openDetails = new Set([...ui.main.querySelectorAll('details[open]')].map(detailKey));
  const renderers = { workflow, projects: projectList, runs: runList, templates };
  ui.main.innerHTML = state.view === 'sessions' ? `<iframe class="agent-session-frame" title="Agent 会话" src="${text(state.sessionPath)}"></iframe>` :
    state.view === 'knowledge' ? knowledgePage.render() : renderers[state.view]
    ? state.engineError ? '<div class="initial">流程编排暂不可用。请在插件管理中检查编排插件。</div>' : renderers[state.view]()
    : pages.render(state.view);
  for (const element of ui.main.querySelectorAll('details')) {
    if (openDetails.has(detailKey(element))) element.open = true;
  }
  if (focused) [...ui.main.querySelectorAll('[data-action]')].find(element => element.dataset.action === focused)?.focus({ preventScroll: true });
}

function render() { chrome(); body(); }

async function overview() {
  try {
    state.data = await api('overview');
    state.engineError = false;
    if (!currentProject()) selectProject(state.data.projects[0]?.id || null);
  } catch { state.engineError = true; }
}

async function loadOptions() {
  state.options = await api('options');
  return state.options;
}

function selectRun(id) {
  state.runId = id;
  state.snapshot = null;
  state.events = [];
  state.seq = 0;
  state.snapshotKey = '';
  state.detail = false;
  if (id) sessionStorage.setItem('electric-run', id);
  else sessionStorage.removeItem('electric-run');
}

async function poll() {
  const id = state.runId;
  if (!id || state.view !== 'workflow' || state.engineError) return;
  const fresh = await api(`run?id=${encodeURIComponent(id)}&after=${state.seq}`);
  if (state.runId !== id) return;
  const previous = state.snapshot;
  if (fresh.checkpoint?.seq < previous?.checkpoint?.seq) return;
  state.snapshot = fresh;
  if (state.projectId !== fresh.item.projectId) selectProject(fresh.item.projectId);
  if (fresh.events?.length) {
    state.events.push(...fresh.events.filter(event => event.seq > state.seq));
    state.seq = Math.max(state.seq, fresh.events.at(-1).seq);
  }
  const key = JSON.stringify([state.seq, fresh.gates, fresh.milestones, fresh.evidence, fresh.tasks, fresh.executorActive, fresh.status,
    fresh.knowledgeDraft, fresh.knowledgeDraftDeviceId, state.questions.map(item => item.ticket)]);
  if (previous && key === state.snapshotKey) return;
  if (!previous || fresh.checkpoint?.status === 'failed' && previous.checkpoint?.status !== 'failed') {
    const active = fresh.checkpoint?.status === 'failed' ? ['failed'] : ['waiting', 'running', 'needs_attention'];
    state.stepId = fresh.form?.steps.find(step => active.includes(fresh.checkpoint?.nodeStates[step.id]))?.id || fresh.form?.steps[0]?.id;
  }
  state.snapshotKey = key;
  if (!ui.dialog.open) render();
}

async function pollingLoop() {
  try {
    await pollWorkflowQuestions();
    await poll();
    await knowledgePage.poll();
    if (!ui.dialog.open && !ui.question.open) openWorkflowQuestion(state.questions.find(item => !deferredQuestions.has(item.ticket)));
    state.pollError = null;
  }
  catch (error) { if (error.message !== state.pollError) { state.pollError = error.message; notice(error.message, true); } }
  setTimeout(pollingLoop, 1100);
}

function updateQuestionButton() {
  const button = ui.top.querySelector('#questions-button');
  if (!button) return;
  button.hidden = state.questions.length === 0;
  button.textContent = `待回答 ${state.questions.length}`;
}

async function pollWorkflowQuestions() {
  const revision = questionRevision;
  const next = await api('questions');
  const uses = new Set(state.data.runs.map(run => run.sessionId));
  if (next.some(item => !uses.has(item.parent)) && !state.engineError) {
    await overview();
    for (const run of state.data.runs) uses.add(run.sessionId);
  }
  if (revision !== questionRevision) return;
  state.questions = next.filter(item => uses.has(item.parent));
  const tickets = new Set(state.questions.map(item => item.ticket));
  for (const ticket of deferredQuestions.keys()) if (!tickets.has(ticket)) deferredQuestions.delete(ticket);
  if (ui.question.open && !tickets.has(ui.question.dataset.ticket)) ui.question.close('resolved');
  updateQuestionButton();
}

function openWorkflowQuestion(item) {
  if (!item || ui.dialog.open || ui.question.open) return;
  const run = state.data.runs.find(run => run.sessionId === item.parent);
  const project = state.data.projects.find(project => project.id === run?.projectId);
  const step = state.snapshot?.item.sessionId === item.parent && state.snapshot.form?.steps.find(step => questionFor(step)?.ticket === item.ticket);
  const draft = deferredQuestions.get(item.ticket) || [];
  const context = [project?.name, step?.name || run?.name].filter(Boolean).join(' · ');
  const questions = item.questions.map((question, index) => {
    const options = question.options || [];
    const picks = draft[index]?.selected || [];
    const label = options.length ? '补充说明（可选）' : '补充信息';
    return `<fieldset><legend>${text(question.question || question.header)}</legend><div class="checks">${options.map(choice =>
      `<label><input type="${question.multiSelect ? 'checkbox' : 'radio'}" name="pick-${index}" value="${text(choice.label)}"${picks.includes(choice.label) ? ' checked' : ''}><span>${text(choice.label)}${choice.description ? ` · ${text(choice.description)}` : ''}</span></label>`).join('')}</div>
      ${question.intent?.kind === 'approval' ? '' : field(label,
        `<textarea aria-label="${label}" name="answer-${index}" maxlength="4000" rows="3"${options.length ? '' : ' required'}>${text(draft[index]?.custom)}</textarea>`)}</fieldset>`;
  }).join('');
  ui.question.dataset.ticket = item.ticket;
  ui.question.returnValue = '';
  ui.question.innerHTML = `<form class="agent-question-form"><div class="dialog-head"><div><h2 id="question-title">Agent 需要补充信息</h2>
    ${context ? `<p class="small">${text(context)}</p>` : ''}</div></div><div class="inputs">${questions}</div>
    <div class="form-error" role="alert"></div><div class="actions">
    <button type="button" class="button" data-defer>稍后回答</button><button class="button primary" type="submit">提交答复</button></div></form>`;
  const form = ui.question.querySelector('form');
  function answers() {
    const data = new FormData(form);
    return item.questions.map((question, index) => ({ id: question.id, selected: data.getAll(`pick-${index}`), custom: data.get(`answer-${index}`) }));
  }
  function defer() {
    deferredQuestions.set(item.ticket, answers());
    ui.question.close('deferred');
  }
  form.querySelector('[data-defer]').addEventListener('click', defer);
  ui.question.oncancel = event => {
    event.preventDefault();
    if (!form.querySelector('[type="submit"]').disabled) defer();
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const later = form.querySelector('[data-defer]');
    const errorBox = form.querySelector('[role="alert"]');
    submit.disabled = later.disabled = true;
    errorBox.textContent = '';
    try {
      await api('sessions', { op: 'answer', id: item.session, ticket: item.ticket, answers: answers() });
      questionRevision++;
      deferredQuestions.delete(item.ticket);
      state.questions = state.questions.filter(question => question.ticket !== item.ticket);
      if (ui.question.open && ui.question.dataset.ticket === item.ticket) ui.question.close('resolved');
      updateQuestionButton();
      notice('答复已送达 Agent。');
    } catch (error) { errorBox.textContent = error.message; }
    finally { submit.disabled = later.disabled = false; }
  });
  ui.question.showModal();
}

async function fileData(file, cap) {
  if (!file?.size || file.size > cap) throw new Error(`文件须为 1–${Math.floor(cap / 1000)} KB。`);
  const values = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < values.length; i += 8192) binary += String.fromCharCode(...values.subarray(i, i + 8192));
  return btoa(binary);
}

function readFolder(files) {
  const name = files[0]?.webkitRelativePath.split('/')[0];
  if (!name) return null;
  const entries = Array.from(files, file => ({ file, path: file.webkitRelativePath.slice(name.length + 1) }))
    .filter(entry => entry.path && !entry.path.split('/').some(part => part.startsWith('.') || part.startsWith('~$')))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  if (!entries.length || entries.length > 300) throw new Error('请选择包含 1–300 个可见文件的资料文件夹。');
  let budget = 4000000;
  let programBytes = 0;
  for (const entry of entries) {
    if (/\.csv$/i.test(entry.path)) {
      if (entry.file.size < 1 || entry.file.size > 5000000) throw new Error(`CSV 须为 1 字节至 5 MB：${entry.path}`);
      programBytes += entry.file.size;
      if (programBytes > 32000000) throw new Error('文件夹中的 CSV 总大小须在 32 MB 以内。');
      entry.readLimit = 5000000;
      entry.program = true;
      continue;
    }
    const limit = /\.docx$/i.test(entry.path) ? 1000000 : 64000;
    if (/\.(txt|md|docx)$/i.test(entry.path) && entry.file.size > 0 && entry.file.size <= Math.min(limit, budget)) {
      entry.readLimit = limit;
      budget -= entry.file.size;
    }
  }
  return { name, entries };
}

async function folderPayload(folder) {
  const files = await Promise.all(folder.entries.map(async ({ path, file, readLimit }) => ({
    path, size: file.size, ...(readLimit ? { data: await fileData(file, readLimit) } : {}),
  })));
  return { name: folder.name, files };
}

function dialog(title, fields, label, submit, danger = false) {
  ui.dialog.innerHTML = `<form><div class="dialog-head"><h2 id="dialog-title">${text(title)}</h2>${close()}</div><div class="inputs">${fields}</div>
    <div role="alert" class="form-error"></div><div class="actions">${btn('取消', 'close')}<button class="button ${danger ? 'danger' : 'primary'}" type="submit">${label}</button></div></form>`;
  const form = ui.dialog.querySelector('form');
  const errorBox = form.querySelector('[role="alert"]');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    errorBox.textContent = '';
    try {
      const message = await submit(Object.fromEntries(new FormData(form)));
      ui.dialog.close();
      render();
      if (message) notice(message);
    } catch (error) { errorBox.textContent = error.message; }
    finally { submitButton.disabled = false; }
  });
  ui.dialog.showModal();
  return form;
}

async function showProjectArchive(id) {
  const project = state.data.projects.find(item => item.id === id);
  if (!project?.hasArchive) return;
  const query = new URLSearchParams({ id });
  const archive = await api(`project-archive?${query}`);
  const href = value => text(`/api/electric/project-archive?${new URLSearchParams({ id, ...value })}`);
  const plan = archive.files.find(file => file.role === 'plan');
  const generated = archive.files.filter(file => file.role === 'generated');
  const fileLink = (file, label) => `<a href="${href({ file: file.path })}" download>${text(label)}</a>`;
  ui.dialog.innerHTML = `<div class="archive-dialog"><div class="dialog-head"><div>
    <h2 id="dialog-title">交付物与生成物</h2><p class="small">${text(project.name)} · ${text(archive.source)} · ${archive.files.length} 个文件</p></div>${close()}</div>
    <section class="log"><h3>交付物</h3><p>主方案 · 已归档，待工程验证</p><p>${fileLink(plan, plan.sourcePath)}</p></section>
    <details><summary>生成物 · ${generated.length} 个文件（含参考资料）</summary>
      <ul class="archive-files">${generated.map(file => `<li>${fileLink(file, file.sourcePath)}${file.reference ? ' <span class="small">· 参考</span>' : ''}</li>`).join('')}</ul>
    </details>
    <div class="actions"><a class="button primary" href="${href({ format: 'zip' })}" download>下载全部 ZIP</a></div></div>`;
  ui.dialog.showModal();
}

async function showSessionHistory() {
  const currentView = state.view;
  const { sessions } = await api('session-history');
  if (state.view !== currentView || ui.dialog.open) return;
  const row = session => `<div class="list-item" data-history-row><div><strong>${text(session.title)}</strong>
    <p>${text(session.group || session.category)} · ${text(time(session.updatedAt))}</p></div>
    ${btn('打开会话', `session:${encodeURIComponent(session.id)}${session.parent ? ':' + encodeURIComponent(session.parent) : ''}`)}</div>`;
  ui.dialog.innerHTML = `<div class="archive-dialog"><div class="dialog-head"><h2 id="dialog-title">会话历史</h2>${close()}</div>
    ${field('搜索会话', '<input type="search" data-history-search maxlength="160" placeholder="项目、节点或会话名称">')}
    <div class="pane-list">${sessions.map(row).join('') || '<p class="empty">暂无历史会话。</p>'}</div>
    <p class="empty" data-history-empty hidden>没有匹配的会话。</p></div>`;
  const rows = [...ui.dialog.querySelectorAll('[data-history-row]')];
  ui.dialog.querySelector('[data-history-search]').addEventListener('input', event => {
    const query = event.target.value.trim().toLocaleLowerCase();
    for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
    ui.dialog.querySelector('[data-history-empty]').hidden = rows.some(row => !row.hidden);
  });
  ui.dialog.showModal();
}

async function startKnowledge() {
  let source = state.snapshot?.item?.projectId === state.projectId ? state.snapshot : null;
  const latest = state.data.runs.find(item => item.projectId === state.projectId && item.plc);
  const projectId = state.projectId;
  if (!source && latest) source = await api(`run?id=${encodeURIComponent(latest.id)}`);
  if (projectId !== state.projectId || state.view !== 'workflow') return;
  return newRun(source);
}

function deleteRun(id) {
  const item = state.data.runs.find(run => run.id === id);
  if (!item) return;
  const project = state.data.projects.find(project => project.id === item.projectId);
  dialog('删除运行记录', `<p>${text(project?.name || item.name)} · ${text(time(item.createdAt))}</p>
    <p class="small">删除后，此记录将从运行列表移除。执行中的流程会先停止。工程证据按已有引用留存。</p>`, '确认删除', async () => {
      await api('run', { id, op: 'delete' });
      if (state.runId === id) selectRun(null);
      await overview();
      return '运行记录已删除。';
    }, true);
}

const input = (name, limit, value = '') => `<input name="${name}" required maxlength="${limit}" value="${text(value)}">`;
const textarea = (name, limit, value = '') => `<textarea name="${name}" required maxlength="${limit}">${text(value)}</textarea>`;
const noteField = label => field(label, textarea('note', 1200));

function newProject() {
  dialog('新建工程项目', `${field('项目名称', input('name', 100))}<div class="row">${field('CPU 型号', input('cpu', 100))}
    ${field('工程工具及版本', input('toolchain', 120, 'GX Works2'))}</div>`, '创建项目', async values => {
    const project = await api('project', values);
    await overview();
    selectProject(project.id);
    selectRun(null);
    state.view = 'workflow'; state.stepId = 'intake-check';
    return '项目已创建。请在首节点提交需求与原始程序。';
  });
}

function bindProjectDevice(id) {
  const project = state.data.projects.find(item => item.id === id);
  if (!project) return;
  const options = (state.data.devices || []).map(device => `<option value="${text(device.id)}"${device.id === project.deviceId ? ' selected' : ''}>${text(device.name)}</option>`).join('');
  if (!options) { notice('请先在 PLC 知识库创建一个设备。'); return; }
  dialog('关联设备', `<p>${text(project.name)}</p>${field('设备', `<select name="deviceId" aria-label="设备"><option value="">暂不关联</option>${options}</select>`)}`,
    '保存关联', async values => {
      await api('knowledge', { op: 'bind', projectId: id, deviceId: values.deviceId });
      await overview();
      return '设备关联已保存。';
    });
}

async function newRun(source = null) {
  const options = await loadOptions();
  const projects = state.data.projects;
  const published = state.data.templates.filter(item => item.publishedRevision);
  if (!projects.length || !published.length) throw new Error('需要工程项目和已发布的模板。');
  const allowsModel = entry => entry?.publishedForm?.steps.some(step => ['agent', 'proposal'].includes(step.kind));
  const requestId = crypto.randomUUID();
  const configured = options.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, label: `${group.name} · ${model.name}` })));
  const previousModel = source?.item.model;
  const preferred = configured.some(model => model.provider === previousModel?.provider && model.model === previousModel?.model) ? previousModel : options.default;
  const models = configured.map((model, index) => `<option value="${index}"${model.provider === preferred?.provider && model.model === preferred?.model ? ' selected' : ''}>${text(model.label)}</option>`).join('');
  const preferredTemplate = source?.item.templateId || exampleTemplate()?.id;
  let folder, folderError, previousProject;
  const form = dialog('启动工作流', `${field('工程项目', `<select name="projectId">${projects.map(item => `<option value="${item.id}"${item.id === state.projectId ? ' selected' : ''}>${text(item.name)}</option>`).join('')}</select>`)}
    ${field('已发布模板', `<select name="templateId">${published.map(item => `<option value="${text(item.id)}"${item.id === preferredTemplate ? ' selected' : ''}>${text(item.name)} · v${item.publishedRevision}</option>`).join('')}</select>`)}
    <div class="inputs" data-intake-fields>
    <div class="checks"><label><input type="checkbox" name="testRun"${source?.item.testRun ? ' checked' : ''}>全链路测试（候选仅修改注释，使用测试记录）</label></div>
    ${field('选择资料文件夹', '<input type="file" name="folder" webkitdirectory multiple aria-describedby="folder-help">')}
    <p id="folder-help" class="small">整组读取 CSV 程序段和 TXT、Markdown、Word（DOCX）需求，包含子文件夹。</p>
    <div data-folder-preview aria-live="polite"></div>
    ${field('离线变更需求', textarea('requirements', 16000))}
    <div data-single-csv>${field('原始程序 CSV', '<input type="file" name="csv" accept=".csv">')}</div>
    <p class="form-hint" data-intake-hint></p>${source ? '<p class="small">重新核对会创建一条新运行，原记录可在运行记录中查看。</p>' : ''}</div>
    <div class="inputs" data-knowledge-fields><p class="small" data-device-label></p>
    ${field('相似参考设备（可选）', '<select name="referenceDevice" aria-label="相似参考设备（可选）"></select>')}</div>
    <div class="inputs" data-model-fields>${field('运行模型', `<select name="modelIndex">${models || '<option value="">尚未配置模型</option>'}</select>`)}${!models ? btn('打开模型设置', 'view:settings') : ''}
    <div class="checks"><label><input type="checkbox" name="authorized"><span>我确认需求正文、资料清单、原始程序 CSV 与候选差异可发送到所选模型。<span data-knowledge-consent>包括选用的知识摘要与完工知识草稿所需的候选位置、工程记录和验证摘要。</span></span></label></div></div>`, '启动', async values => {
    const template = published.find(item => item.id === values.templateId);
    const model = allowsModel(template) ? configured[values.modelIndex] : null;
    if (allowsModel(template) && !model) throw new Error('请先在模型设置中配置连接。');
    if (model && !values.authorized) throw new Error('请确认模型资料发送范围。');
    const plc = template.publishedForm?.plc;
    if (plc && folderError) throw new Error(folderError);
    const file = !folder?.entries.some(entry => entry.program) && values.csv?.name ? values.csv : null;
    const materials = plc ? { requirements: values.requirements,
      ...(file ? { fileName: file.name, fileData: await fileData(file, 96000) } : {}),
      ...(folder ? { folder: await folderPayload(folder) } : {}) } : undefined;
    const item = await api('start', { id: requestId, projectId: values.projectId, templateId: values.templateId,
      provider: model?.provider, model: model?.model, authorized: Boolean(values.authorized), materials,
      ...(plc && values.referenceDevice ? { referenceDeviceId: values.referenceDevice } : {}),
      ...(plc && values.testRun ? { testRun: true } : {}),
      sourceRunId: plc && values.projectId === source?.item.projectId ? source.item.id : undefined });
    await overview();
    selectRun(item.id);
    selectProject(item.projectId);
    state.view = 'workflow';
    await poll();
    return plc ? '资料已提交，等待 Agent 核对。' : '已提交工作流。';
  });
  const requirements = form.elements.requirements;
  const folderInput = form.elements.folder;
  const preview = form.querySelector('[data-folder-preview]');
  const projectOriginal = () => {
    const project = projects.find(item => item.id === form.elements.projectId.value);
    return project.id === source?.item.projectId ? source.project : project;
  };
  const sync = () => {
    const template = published.find(item => item.id === form.elements.templateId.value);
    const project = projects.find(item => item.id === form.elements.projectId.value);
    const original = projectOriginal();
    const plc = Boolean(template?.publishedForm?.plc);
    const usesKnowledge = plc && template?.publishedForm.steps.some(step => step.kind === 'knowledge');
    form.querySelector('[data-model-fields]').hidden = !allowsModel(template);
    form.querySelector('[data-intake-fields]').hidden = !plc;
    form.querySelector('[data-knowledge-fields]').hidden = !usesKnowledge;
    form.querySelector('[data-knowledge-consent]').hidden = !usesKnowledge;
    form.elements.referenceDevice.disabled = !usesKnowledge;
    const devices = state.data.devices || [];
    const selectedDevice = devices.find(device => device.id === project.deviceId);
    form.querySelector('[data-device-label]').textContent = selectedDevice ?
      `当前设备 · ${selectedDevice.name}${selectedDevice.version ? ' v' + selectedDevice.version : '（暂无已发布知识）'}` : '当前项目未关联设备';
    const reference = form.elements.referenceDevice.value || (previousProject === undefined ?
      source?.item.knowledgePins?.find(pin => pin.reference)?.deviceId : '');
    form.elements.referenceDevice.innerHTML = '<option value="">不使用相似参考</option>' +
      devices.filter(device => device.id !== project.deviceId && device.version).map(device =>
        `<option value="${text(device.id)}"${device.id === reference ? ' selected' : ''}>${text(device.name)} · v${device.version}</option>`).join('');
    if (previousProject !== project.id) {
      requirements.value = original.requirements || '';
      form.elements.csv.value = '';
      folderInput.value = '';
      folder = null;
      folderError = '';
      previousProject = project.id;
    }
    requirements.required = plc && !folder && !original.folder && !folderError;
    form.elements.csv.required = plc && !folder && !original.folder && !original.digest && !folderError;
    const programs = folder?.entries.filter(entry => entry.program).length || 0;
    form.querySelector('[data-single-csv]').hidden = Boolean(programs || !folder && programCount(original));
    if (folderError) preview.textContent = folderError;
    else if (folder) {
      const docs = folder.entries.filter(entry => entry.readLimit && !entry.program).length;
      preview.innerHTML = `<details class="folder-preview"><summary>${text(folder.name)} · ${programs} 个 CSV · ${docs} 份需求文档</summary>
        <ul>${folder.entries.map(entry => `<li>${text(entry.path)}${entry.readLimit ? ' · 读取正文' : ''}</li>`).join('')}</ul></details>`;
    } else preview.textContent = original.folder ? `沿用资料文件夹 ${original.folder.name}（${original.folder.files.length} 个文件）` : '';
    form.querySelector('[data-intake-hint]').textContent = folder
      ? programs ? '本次将整组导入这些 CSV。Agent 可跨文件查询正文和行号。' : '此文件夹没有 CSV。可补选文件，或先核对已有资料。'
      : programCount(original) ? `沿用已导入的 ${programCount(original)} 个 CSV。重新选择文件夹可更新整组资料。`
      : original.fileName
      ? `留空可沿用原始程序 ${original.fileName}，也可以上传新版本。`
      : original.folder ? '此前只登记了 CSV 文件名。请重新选择资料文件夹，导入整组程序正文。'
        : '请上传 UTF-8 或带 BOM 的 UTF-16LE 原始程序 CSV，最大 96 KB。';
  };
  folderInput.addEventListener('change', () => {
    const old = projectOriginal();
    folder = null;
    folderError = '';
    try { folder = readFolder(folderInput.files); }
    catch (error) { folderError = error.message; }
    if (folder && requirements.value === (old.requirements || '')) requirements.value = '';
    sync();
  });
  form.elements.csv.addEventListener('change', sync);
  form.elements.templateId.addEventListener('change', sync);
  form.elements.projectId.addEventListener('change', sync);
  sync();
}

async function runAction(data) {
  const response = await api('run', { id: state.runId, ...data });
  await poll();
  return response;
}

function approve(node, action) {
  const gate = state.snapshot?.gates?.find(item => item.node === node);
  if (!gate) throw new Error('该节点当前没有待办。');
  const approved = action === 'approve';
  const named = approved && gate.approvalRequiresName;
  const fields = named
    ? field('审批人', input('approver', 80)) + field('审核说明（选填）', '<textarea name="note" maxlength="1200"></textarea>')
    : noteField('审核说明');
  dialog(`${approved ? '通过' : '驳回'} · ${gate.title}`, `${gate.digest ? `<div class="form-hint">候选摘要 <span class="mono">${text(gate.digest)}</span></div>` : ''}${fields}`,
    approved ? '确认通过' : '确认驳回', async ({ note, approver }) => {
      const decision = await runAction({ op: 'decision', node, action, note, approver, invocation: gate.invocation, digest: gate.digest });
      return decision.approved ? decision.resumeRequired ? '已记录放行。请点击「恢复 / 核查」继续运行。' : '已通过审批。' : '已记录驳回。';
    }, !approved);
}

function evidence() {
  const digest = state.snapshot?.candidate?.digest;
  if (!digest) throw new Error('当前运行还没有候选。');
  const testRun = state.snapshot.item.testRun;
  dialog(testRun ? '导入测试记录' : '导入验证日志', `<div class="form-hint">绑定候选 <span class="mono">${text(digest)}</span></div><div class="row">
    ${field('证据类型', `<select name="kind"><option value="compile">${testRun ? '候选结构检查' : '编译'}</option><option value="simulation">${testRun ? '模拟验收' : '仿真'}</option></select>`)}
    ${field('人工判定', '<select name="verdict"><option value="pass">通过</option><option value="fail">失败</option></select>')}</div>
    <div class="row">${field('工具及版本', input('tool', 120))}${field('验证时间', '<input name="date" type="datetime-local" required>')}</div>
    ${field('原始日志', '<input name="log" type="file" required>')}${noteField('人工判定说明')}`, '导入并登记', async values => {
    await runAction({ ...values, log: undefined, op: 'evidence', digest, ...(testRun ? { source: 'test' } : {}), date: new Date(values.date).toISOString(),
      fileName: values.log.name, fileData: await fileData(values.log, 250000) });
    return '证据已绑定当前候选。';
  });
}

function milestone(kind) {
  dialog(`登记${phases[kind]}`, noteField('登记说明'), '登记', async ({ note }) => {
    await runAction({ op: 'milestone', kind, note, digest: state.snapshot.candidate.digest });
    return `已登记${phases[kind]}。`;
  });
}

function resume() {
  const uncertain = Object.entries(state.snapshot?.checkpoint?.nodeStates || {}).filter(([, value]) => value === 'needs_attention');
  if (!uncertain.length) return runAction({ op: 'resume' });
  return dialog('核查中断节点', `<div class="form-hint">先核对已发生的模型或文件操作，再决定如何处理。</div>${uncertain.map(([id]) =>
    field(text(state.snapshot.form.steps.find(step => step.id === id)?.name || id),
      `<select name="${text(id)}"><option value="fail">以失败结束</option><option value="retry">确认可重试</option></select>`)).join('')}`, '提交处置', resolutions =>
    runAction({ op: 'resume', resolutions }).then(() => '处置已提交。'));
}

function newSkill() {
  dialog('添加 Skill', `${field('名称（小写字母、数字和连字符）', input('name', 64))}${field('用途描述', input('description', 300))}
    ${field('SKILL.md 正文', textarea('content', 35000))}`, '保存 Skill', async values => {
    await api('skill', values);
    await new Promise(resolve => setTimeout(resolve, 350));
    await loadOptions();
    return `已添加 ${values.name}。`;
  });
}

function editTemplate(entry, copy) {
  const form = entry ? structuredClone(entry.form) : blankForm();
  if (copy) { form.id = `${form.id.slice(0, 45)}-${crypto.randomUUID().slice(0, 8)}`; form.name += ' · 副本'; }
  state.editor = { form, draftRevision: copy ? 0 : entry?.draftRevision || 0, publishedRevision: copy ? undefined : entry?.publishedRevision };
  state.stepEdit = form.steps[0]?.id;
  state.view = 'templates';
  render();
  void loadOptions().then(() => { if (state.view === 'templates' && state.editor && !ui.dialog.open) body(); }).catch(error => notice(error.message, true));
}

function moveStep(offset) {
  const steps = state.editor.form.steps;
  const index = steps.findIndex(step => step.id === state.stepEdit);
  const other = index + offset;
  if (index < 0 || other < 0 || other >= steps.length) return;
  [steps[index], steps[other]] = [steps[other], steps[index]];
  body();
}

async function saveTemplate(publish) {
  const current = state.editor;
  const result = await api('template', { form: current.form, expected: current.draftRevision, publish });
  state.editor = result;
  await overview();
  render();
  notice(publish ? `模板 v${result.publishedRevision} 已发布。` : '草稿已保存。');
}

const pages = workspacePages({ api, btn, tag, field, heading, panel, dialog, notice, text,
  refresh: body, active: view => state.view === view });

const knowledgePage = createKnowledgePage({ api, text, btn, heading, panel, field, dialog, refresh: body, notice,
  active: () => state.view === 'knowledge', devices: () => state.data.devices || [] });

async function openView(view, session, parent) {
  if (view === 'sessions') {
    if (state.view !== 'sessions') {
      const previousView = state.view;
      const response = await fetch('/agent-sessions', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      if (state.view !== previousView) return;
      if (!response?.ok || !response.headers.get('content-type')?.includes('text/html')) {
        notice('会话界面暂时无法打开。请确认工作台服务已启动后重试。', true);
        return;
      }
    }
    state.sessionPath = session ? `/agent-sessions?${new URLSearchParams({ session, ...(parent ? { parent } : {}) })}` : '/agent-sessions';
  }
  if (ui.dialog.open) ui.dialog.close();
  state.view = view;
  notice();
  render();
  if (view === 'sessions') {
    if (!session) await showSessionHistory();
    return;
  }
  if (view === 'knowledge') {
    await overview();
    if (state.view === view) await knowledgePage.load();
    return;
  }
  if (['workflow', 'projects', 'runs', 'templates'].includes(view)) {
    await overview();
    if (state.view !== view) return;
    render();
    if (view === 'workflow') await poll();
  } else {
    await pages.open(view);
    if (state.view === view) body();
  }
}

async function action(value) {
  const [verb, key, extra] = value.split(':');
  const entry = () => state.data.templates.find(item => item.id === key);
  switch (verb) {
    case 'view': return openView(key);
    case 'collapse': state.collapsed = !state.collapsed; sessionStorage.setItem('electric-collapse', state.collapsed ? 'yes' : 'no'); chrome(); return;
    case 'step': state.stepId = key; state.detail = true; body(); return;
    case 'hide-detail': state.detail = false; body(); return;
    case 'clear': notice(); return;
    case 'close': ui.dialog.close(); return;
    case 'new-project': newProject(); return;
    case 'project-archive': return showProjectArchive(key);
    case 'knowledge-bind': return bindProjectDevice(key);
    case 'knowledge-new': return dialog('新建设备', field('设备名称', input('name', 80)), '创建设备', async values => {
      const device = await api('knowledge', { op: 'device', name: values.name });
      await overview();
      await knowledgePage.show(device.id);
      return '设备已创建。';
    });
    case 'knowledge-device': await openView('knowledge'); return knowledgePage.show(key);
    case 'knowledge-refresh': return knowledgePage.load();
    case 'knowledge-review': return knowledgePage.review(key);
    case 'knowledge-retry': return knowledgePage.retry(key);
    case 'knowledge-reject': return knowledgePage.reject(key);
    case 'new-run': return newRun();
    case 'start-knowledge': return startKnowledge();
    case 'session-history': return showSessionHistory();
    case 'delete-run': return deleteRun(key);
    case 'retry-intake': return newRun(state.snapshot);
    case 'workflow-question': return openWorkflowQuestion(key ? state.questions.find(item => item.ticket === key) : state.questions[0]);
    case 'project': selectRun(null); selectProject(key); state.view = 'workflow'; state.stepId = 'knowledge'; render(); return;
    case 'run': selectRun(key); state.view = 'workflow'; render(); await poll(); return;
    case 'sample': {
      const existing = state.data.projects.find(item => item.sample);
      const project = existing || await api('project', { sample: true });
      await overview(); selectRun(null); selectProject(project.id); state.view = 'workflow'; state.stepId = 'intake-check'; render(); return;
    }
    case 'session': return openView('sessions', decodeURIComponent(key), extra ? decodeURIComponent(extra) : null);
    case 'decision': approve(key, extra); return;
    case 'evidence': evidence(); return;
    case 'milestone': milestone(key); return;
    case 'resume': return resume();
    case 'cancel': dialog('停止工作流', '<p class="small">已有记录和制品会保留。</p>', '停止', async () => {
      await runAction({ op: 'cancel' }); return '已提交停止请求。';
    }, true); return;
    case 'new-skill': newSkill(); return;
    case 'new-template': editTemplate(); return;
    case 'edit': editTemplate(entry()); return;
    case 'copy': editTemplate(entry(), true); return;
    case 'back-template': state.editor = null; body(); return;
    case 'edit-step': state.stepEdit = key; body(); return;
    case 'add-step': {
      const step = { id: `step-${crypto.randomUUID().slice(0, 8)}`, name: '新步骤', kind: 'agent', role: '分析 Agent', prompt: '根据上游资料完成此任务。', skills: [], depends: [] };
      state.editor.form.steps.push(step); state.stepEdit = step.id; body(); return;
    }
    case 'move-up': moveStep(-1); return;
    case 'move-down': moveStep(1); return;
    case 'delete-step': {
      const steps = state.editor.form.steps.filter(step => step.id !== state.stepEdit);
      for (const step of steps) step.depends = step.depends.filter(dependency => dependency !== state.stepEdit);
      state.editor.form.steps = steps; state.stepEdit = steps[0]?.id; body(); return;
    }
    case 'save-template': return saveTemplate(false);
    case 'publish-template': return saveTemplate(true);
    default: return pages.action(verb, key, extra);
  }
}

document.addEventListener('click', event => {
  const element = event.target.closest?.('[data-action]');
  if (!element || element.disabled) return;
  void action(element.dataset.action).catch(error => notice(error.message, true));
});
document.addEventListener('submit', event => {
  if (!event.target.matches('[data-knowledge-search]')) return;
  event.preventDefault();
  void knowledgePage.search(event.target).catch(error => notice(error.message, true));
});
document.addEventListener('change', event => {
  if (!event.target.matches('[data-knowledge-search] select')) return;
  void knowledgePage.search(event.target.form).catch(error => notice(error.message, true));
});
document.addEventListener('input', event => {
  if (!state.editor) return;
  const element = event.target;
  const { template, step: key, dependency, skill } = element.dataset || {};
  if (template) state.editor.form[template] = element.value;
  const step = state.editor.form.steps.find(value => value.id === state.stepEdit);
  if (!step) return;
  if (key) step[key] = element.value;
  if (dependency) step.depends = element.checked ? [...new Set([...step.depends, dependency])] : step.depends.filter(value => value !== dependency);
  if (skill) step.skills = element.checked ? [...new Set([...step.skills, skill])] : step.skills.filter(value => value !== skill);
  if (key === 'kind') body();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.detail && !ui.dialog.open) { state.detail = false; body(); }
});

await overview();
if (!state.engineError && state.runId && !state.data.runs.some(item => item.id === state.runId)) selectRun(null);
render();
void pollingLoop();

