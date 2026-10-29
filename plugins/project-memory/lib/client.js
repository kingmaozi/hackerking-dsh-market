window.__ModuleLoader__.load({
  id: 'project-memory',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    // All selectors belong to this section. Host aliases follow light/dark theme changes.
    const css = `
.pm-settings{--pm-text:var(--dsw-alias-label-primary,CanvasText);--pm-muted:var(--dsw-alias-label-secondary,GrayText);--pm-border:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 15%,transparent));--pm-layer:var(--dsw-alias-bg-layer-2,Canvas);--pm-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 5%,transparent));--pm-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#5078ed);color:var(--pm-text);font-family:inherit;font-size:14px;line-height:1.5;width:100%;min-width:0;padding:4px 0 16px;container:pm-settings / inline-size;overflow-wrap:anywhere}
.pm-settings,.pm-settings *{box-sizing:border-box}
.pm-settings button,.pm-settings input,.pm-settings select{font-family:inherit;font-size:14px;line-height:20px;color:inherit}
.pm-settings button{cursor:pointer}
.pm-settings button:disabled,.pm-settings select:disabled{cursor:default;opacity:.5}
.pm-settings :is(button,input,select):focus-visible{outline:2px solid var(--pm-accent);outline-offset:3px}
.pm-header{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.pm-mark{display:grid;place-items:center;flex:none;width:34px;height:34px;border:1px solid color-mix(in srgb,var(--pm-accent) 22%,transparent);border-radius:10px;background:color-mix(in srgb,var(--pm-accent) 8%,transparent);color:var(--pm-accent)}
.pm-settings h2{font-size:18px;line-height:24px;font-weight:600;margin:0 0 2px;letter-spacing:-.3px}
.pm-settings p{margin:0}
.pm-caption{font-size:12px;line-height:18px;color:var(--pm-muted)}
.pm-icon{width:16px;height:16px;flex:none;vertical-align:middle}
.pm-workspace{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.pm-select-wrap{position:relative;display:flex;align-items:center;flex:1;min-width:0;border:1px solid var(--pm-border);border-radius:9px;background:var(--pm-layer)}
.pm-select-wrap>.pm-icon{position:absolute;left:10px;pointer-events:none;color:var(--pm-muted)}
.pm-select-wrap>.pm-chevron{left:auto;right:10px;width:12px}
.pm-settings select{appearance:none;width:100%;min-width:0;height:36px;padding:6px 30px 6px 34px;border:0;background:transparent;border-radius:9px;text-overflow:ellipsis}
.pm-settings option{background:var(--pm-layer);color:var(--pm-text)}
.pm-icon-button{display:grid;place-items:center;width:36px;height:36px;flex:none;border:1px solid var(--pm-border);border-radius:9px;background:transparent}
.pm-icon-button:hover:not(:disabled){background:var(--pm-hover)}
.pm-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--pm-border);border-bottom:1px solid var(--pm-border)}
.pm-row-title{font-size:14px;font-weight:500;margin-bottom:3px}
.pm-switch-control{display:flex;align-items:center;gap:8px;flex:none}
.pm-state{font-size:12px;color:var(--pm-muted)}
.pm-switch{position:relative;width:34px;height:20px;padding:0;border:1px solid var(--pm-border);border-radius:20px;background:color-mix(in srgb,currentColor 16%,transparent);transition:background .15s}
.pm-switch[aria-checked=true]{background:var(--pm-accent);border-color:var(--pm-accent)}
.pm-switch:after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .15s}
.pm-switch[aria-checked=true]:after{transform:translateX(14px)}
.pm-stats{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 10px;font-size:12px;color:var(--pm-muted)}
.pm-count{font-size:14px;font-weight:600;color:var(--pm-text);margin-right:4px}
.pm-search{position:relative;display:flex;align-items:center;margin-bottom:12px}
.pm-search>.pm-icon{position:absolute;left:10px;color:var(--pm-muted);pointer-events:none}
.pm-settings .pm-search-input{width:100%;min-width:0;height:34px;padding:6px 10px 6px 34px;border:1px solid var(--pm-border);border-radius:8px;background:transparent;font-size:13px}
.pm-search-input::placeholder{color:var(--pm-muted)}
.pm-browser{display:grid;grid-template-columns:minmax(160px,.85fr) minmax(0,1.15fr);border:1px solid var(--pm-border);border-radius:10px;overflow:hidden;min-width:0}
.pm-list{list-style:none;margin:0;padding:5px;max-height:360px;overflow:auto;border-right:1px solid var(--pm-border)}
.pm-list li+li{margin-top:3px}
.pm-settings .pm-entry{display:block;text-align:left;width:100%;padding:9px 8px;border:1px solid transparent;border-radius:7px;background:transparent;font-size:13px}
.pm-entry:hover{background:var(--pm-hover)}
.pm-entry[aria-current=true]{background:color-mix(in srgb,var(--pm-accent) 9%,transparent);border-color:color-mix(in srgb,var(--pm-accent) 20%,transparent)}
.pm-entry-head{display:flex;align-items:flex-start;gap:7px}
.pm-entry-head>.pm-icon{color:var(--pm-muted);margin-top:2px;width:14px;height:14px}
.pm-entry-title{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pm-entry time{display:block;font-size:11px;line-height:17px;color:var(--pm-muted);margin:3px 0 3px 21px}
.pm-excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:18px;color:var(--pm-muted);margin-left:21px}
.pm-detail{min-width:0;padding:14px;max-height:360px;overflow:auto;background:color-mix(in srgb,currentColor 2%,transparent)}
.pm-settings .pm-detail-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:0;border:0;background:transparent;font-size:14px;font-weight:600;cursor:pointer}
.pm-detail-toggle>.pm-icon{display:block}
.pm-detail-body[data-open=false]{display:none}
.pm-detail time{display:block;font-size:11px;color:var(--pm-muted);margin-top:5px}
.pm-settings .pm-body{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:1.8;margin:12px 0 0}
.pm-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:28px 18px;border:1px dashed var(--pm-border);border-radius:10px;color:var(--pm-muted);font-size:12px}
.pm-empty>.pm-icon{width:22px;height:22px;margin-bottom:3px;opacity:.7}
.pm-empty strong{font-size:14px;color:var(--pm-text);font-weight:500}
.pm-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d14d53) 30%,transparent);border-radius:8px;padding:10px 12px;margin:10px 0;color:var(--dsw-alias-state-error-primary,#d14d53);font-size:12px}
.pm-storage{margin-top:12px;border-top:1px solid var(--pm-border);padding-top:8px}
.pm-settings .pm-storage-toggle{display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:4px 0;color:var(--pm-muted);font-size:12px}
.pm-storage-toggle>.pm-icon{width:12px;height:12px;transition:transform .15s}
.pm-storage-toggle[aria-expanded=true]>.pm-icon{transform:rotate(90deg)}
.pm-path{font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:18px;color:var(--pm-muted);padding:7px 10px;margin-top:4px;border-radius:6px;background:var(--pm-hover);overflow-wrap:anywhere}
.pm-spinner{animation:pm-spin 1s linear infinite}
@keyframes pm-spin{to{transform:rotate(360deg)}}
@container pm-settings (max-width:440px){.pm-browser{grid-template-columns:minmax(0,1fr)}.pm-list{border-right:0;border-bottom:1px solid var(--pm-border);max-height:240px}.pm-detail{max-height:none;padding:12px}.pm-settings .pm-detail-toggle{cursor:pointer}.pm-detail-toggle>.pm-icon{display:block}.pm-detail-body[data-open=false]{display:none}.pm-stats{flex-wrap:wrap}.pm-state{display:none}}
@media(prefers-reduced-motion:reduce){.pm-settings *{animation:none!important;transition:none!important}}
`;
    function icon(name, className = '') {
      const paths = {
        memory: 'M5 3h10a2 2 0 0 1 2 2v14H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 12h12M7 7h6M7 10h4',
        folder: 'M3 6V4h6l2 2h10v13H3V6Z',
        refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1',
        search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        note: 'M6 3h9l4 4v14H6V3Zm8 0v5h5M9 12h7M9 16h5',
        down: 'm7 10 5 5 5-5',
        right: 'm9 6 6 6-6 6'
      };
      return h('svg', { className: 'pm-icon ' + className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] }));
    }
    function dateLabel(value) {
      if (!value) return '未记录时间';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    function MemorySettings() {
      const [projects, setProjects] = React.useState([]);
      const [requestedId, setRequestedId] = React.useState('');
      const [memory, setMemory] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [selectedKey, setSelectedKey] = React.useState('');
      const [detailOpen, setDetailOpen] = React.useState(true);
      const [storageOpen, setStorageOpen] = React.useState(false);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [reload, setReload] = React.useState(0);
      const csrf = React.useRef('');
      const preferredId = React.useRef('');
      const version = React.useRef(0);
      const writing = React.useRef(false);
      const regionId = React.useId();
      async function api(path, init) {
        const response = await fetch('/api/project-memory/' + path, init);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}；请刷新后重试`);
        return data;
      }
      React.useEffect(() => {
        const current = ++version.current;
        const active = () => current === version.current;
        setLoading(true); setMemory(null); setError('');
        // Refresh catalog first: a removed workspace must never receive a stale memory read.
        (async () => {
          try {
            const data = await api('workspaces');
            if (!active()) return;
            csrf.current = data.csrfToken;
            setProjects(data.projects);
            const preferred = preferredId.current || requestedId;
            const id = data.projects.some(row => row.id === preferred) ? preferred : data.projects[0]?.id;
            preferredId.current = id || '';
            if (!id) return;
            const next = await api('memory?id=' + encodeURIComponent(id));
            if (active()) setMemory({ ...next, id });
          } catch (e) { if (active()) setError(e.message); }
          finally { if (active()) setLoading(false); }
        })();
        return () => { version.current++; };
      }, [requestedId, reload]);
      function refresh() {
        if (writing.current) return;
        version.current++; setMemory(null); setLoading(true); setReload(n => n + 1);
      }
      function chooseProject(id) {
        if (writing.current) return;
        version.current++; setMemory(null); setLoading(true); setError('');
        preferredId.current = id;
        setRequestedId(id); setReload(value => value + 1); setQuery(''); setSelectedKey(''); setStorageOpen(false); setDetailOpen(true);
      }
      async function toggle() {
        if (!memory || loading || writing.current) return;
        const selected = memory.id; const current = version.current;
        writing.current = true; setBusy(true); setError('');
        try {
          const next = await api('enabled', { method: 'POST', headers: { 'content-type': 'application/json', 'x-project-memory-csrf': csrf.current }, body: JSON.stringify({ id: selected, enabled: !memory.enabled }) });
          if (current === version.current) setMemory(previous => ({ ...previous, enabled: next.enabled }));
        } catch (e) { if (current === version.current) setError(e.message); }
        finally { writing.current = false; if (current === version.current) setBusy(false); }
      }
      const id = memory?.id || (projects.some(row => row.id === requestedId) ? requestedId : projects[0]?.id) || '';
      const search = query.trim().toLowerCase();
      // Identity is assigned before filtering, not by filtered position. Preserve duplicate entries too.
      const duplicates = new Map();
      const all = (memory?.entries || []).map(entry => {
        const identity = JSON.stringify([entry.title, entry.timestamp, entry.body]);
        const duplicate = duplicates.get(identity) || 0;
        duplicates.set(identity, duplicate + 1);
        return { ...entry, key: identity + ':' + duplicate };
      });
      const entries = all.filter(entry => (entry.title + '\n' + entry.body).toLowerCase().includes(search));
      const selected = entries.find(entry => entry.key === selectedKey) || entries[0];
      const latest = all.reduce((value, entry) => {
        const time = Date.parse(entry.timestamp);
        return Number.isFinite(time) && (!value || time > Date.parse(value)) ? entry.timestamp : value;
      }, '');
      const empty = (title, description, status = true) => h('div', { className: 'pm-empty', role: status ? 'status' : undefined }, icon('memory'), h('strong', null, title), h('p', null, description));
      return h('section', { className: 'pm-settings', 'data-testid': 'project-memory-settings', 'aria-label': '项目记忆' },
        h('header', { className: 'pm-header' }, h('span', { className: 'pm-mark' }, icon('memory')), h('div', null, h('h2', null, '项目记忆'), h('p', { className: 'pm-caption' }, '让已验证的结论、约定与命令，随项目延续。'))),
        h('div', { className: 'pm-workspace' },
          h('div', { className: 'pm-select-wrap' }, icon('folder'), h('select', { 'aria-label': '记忆工作区', value: id, disabled: busy || loading || !projects.length, onChange: e => chooseProject(e.target.value) }, !projects.length && h('option', { value: '' }, loading ? '正在获取工作区…' : '暂无工作区'), projects.map(row => h('option', { key: row.id, value: row.id }, row.title))), icon('down', 'pm-chevron')),
          h('button', { type: 'button', className: 'pm-icon-button', 'aria-label': '刷新记忆', title: '刷新记忆', disabled: busy, onClick: refresh }, icon('refresh', loading ? 'pm-spinner' : ''))),
        error && h('div', { className: 'pm-error', role: 'alert' }, '读取或保存失败：' + error + '。可点击右上角刷新重试。'),
        loading && empty('正在加载记忆', '正在同步工作区与最新内容…'),
        !loading && !error && !memory && empty('还没有项目工作区', '打开一个项目后，即可在这里管理它的记忆。'),
        memory && h(React.Fragment, null,
          h('div', { className: 'pm-switch-row' }, h('div', null, h('div', { className: 'pm-row-title' }, '工作区记忆'), h('p', { className: 'pm-caption' }, '停用仅暂停工具与技能加载，已有内容仍保留。')), h('div', { className: 'pm-switch-control' }, h('span', { className: 'pm-state', 'aria-live': 'polite' }, busy ? '保存中…' : memory.enabled ? '已启用' : '已停用'), h('button', { type: 'button', role: 'switch', 'aria-label': '启用此项目记忆', 'aria-checked': memory.enabled, disabled: busy, className: 'pm-switch', onClick: toggle }))),
          h('div', { className: 'pm-stats', role: 'status' }, h('span', null, h('span', { className: 'pm-count' }, all.length), '条记忆', search ? ` · 匹配 ${entries.length} 条` : ''), h('span', null, '最近更新 · ', all.length ? dateLabel(latest) : '暂无')),
          h('div', { className: 'pm-search' }, icon('search'), h('input', { type: 'search', className: 'pm-search-input', 'aria-label': '搜索记忆', value: query, placeholder: '搜索标题或内容…', onChange: e => { setQuery(e.target.value); setDetailOpen(true); } })),
          !entries.length ? empty(all.length ? '没有匹配的记忆' : '这个项目尚无记忆', all.length ? '换一个关键词，试试搜索标题或内容。' : '与 Agent 协作时保存已验证结论，记忆会出现在这里。') :
            h('div', { className: 'pm-browser' },
              h('ul', { className: 'pm-list', 'aria-label': '记忆条目' }, entries.map(entry => h('li', { key: entry.key }, h('button', { type: 'button', className: 'pm-entry', 'aria-current': entry.key === selected.key ? 'true' : undefined, onClick: () => { setSelectedKey(entry.key); setDetailOpen(true); } }, h('span', { className: 'pm-entry-head' }, icon('note'), h('span', { className: 'pm-entry-title' }, entry.title || '未命名记忆')), h('time', { title: entry.timestamp }, dateLabel(entry.timestamp)), h('span', { className: 'pm-excerpt' }, entry.body.replace(/\s+/g, ' ').slice(0, 140)))))),
              h('article', { className: 'pm-detail', 'aria-label': '记忆详情' }, h('button', { type: 'button', className: 'pm-detail-toggle', 'aria-expanded': detailOpen, 'aria-controls': regionId + '-detail', onClick: () => setDetailOpen(value => !value) }, h('span', null, selected.title || '未命名记忆'), icon('down')), h('time', { title: selected.timestamp }, dateLabel(selected.timestamp)), h('div', { className: 'pm-detail-body', id: regionId + '-detail', 'data-open': detailOpen }, h('pre', { className: 'pm-body' }, selected.body)))),
          h('div', { className: 'pm-storage' }, h('button', { type: 'button', className: 'pm-storage-toggle', 'aria-expanded': storageOpen, 'aria-controls': regionId + '-storage', onClick: () => setStorageOpen(value => !value) }, icon('right'), '存储信息'), storageOpen && h('div', { id: regionId + '-storage' }, h('p', { className: 'pm-caption' }, '仅保存在当前项目的本地文件中'), h('div', { className: 'pm-path' }, memory.file)))
        ));
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const style = document.createElement('style');
        style.dataset.plugin = 'project-memory';
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'project-memory', label: '记忆', order: 65 }, MemorySettings));
    } };
  }
});
