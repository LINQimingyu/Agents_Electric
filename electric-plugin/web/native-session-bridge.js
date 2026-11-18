window.__ModuleLoader__.load({
  id: 'agents-electric-workbench',
  factory: () => ({
    name: 'electric-session-bridge',
    inject: ['uiWorkspace', 'layout', 'sessions', 'workspaces', 'slots'],
    apply(ctx) {
      if (location.pathname !== '/agent-sessions') return;
      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding', id: 'welcome-notice', priority: 100,
      }, () => null));
      ctx.effect(() => {
        const updateTitle = () => {
          if (document.title.includes('DeepSeek Harness')) document.title = document.title.replace('DeepSeek Harness', 'Agents Electric');
        };
        const observer = new MutationObserver(updateTitle);
        observer.observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
        updateTitle();
        return () => observer.disconnect();
      });
      ctx.effect(() => {
        let initialized = false;
        const expand = () => {
          if (initialized) return;
          const toggle = document.querySelector('[data-sidebar-toggle]');
          if (!toggle) return;
          initialized = true;
          if (matchMedia('(min-width: 900px)').matches && /打开侧边栏|open sidebar/i.test(toggle.getAttribute('aria-label') || '')) {
            ctx.layout.toggleSidebar();
          }
          observer.disconnect();
        };
        const observer = new MutationObserver(expand);
        observer.observe(document.body, { childList: true, subtree: true });
        expand();
        return () => observer.disconnect();
      });
      const params = new URLSearchParams(location.search);
      const session = params.get('session');
      const parent = params.get('parent');
      const id = /^[a-zA-Z0-9_.-]{1,180}$/;
      if (!id.test(session || '') || (parent && !id.test(parent))) return;
      ctx.effect(() => {
        const list = ctx.sessions.list;
        let opened = false;
        const open = () => {
          const snapshot = list.getSnapshot();
          const known = snapshot.byId ? Boolean(snapshot.byId[session]) : snapshot.items?.some(item => item.sessionId === session);
          if (opened || snapshot.phase !== 'ready' || ctx.workspaces.list.getSnapshot().phase !== 'ready' || (!parent && !known)) return;
          opened = true;
          ctx.layout.beginNavigation();
          ctx.uiWorkspace.openSession(parent
            ? { kind: 'subagent', childSessionId: session, parentSessionId: parent, mode: 'continuable' }
            : session);
        };
        let disposed = false;
        const afterRestore = () => queueMicrotask(() => { if (!disposed) open(); });
        const unsubscribe = list.subscribe(afterRestore);
        const stopWorkspaces = ctx.workspaces.list.subscribe(afterRestore);
        afterRestore();
        return () => { disposed = true; unsubscribe(); stopWorkspaces(); };
      });
    },
  }),
});
