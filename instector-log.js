// Log subsystem wrapper for ServerInspector
// Encapsulates all log-related interactions so index.js can delegate.

export class ServerInspectorLogs {
  constructor(mainInspector) {
    this.main = mainInspector; // reference to parent ServerInspector
    // move state from main as needed (still referencing main's settings for now)
    this._onLogsBatch = null;
  }

  // Initialization from index after panel build
  initializeAfterBuild() {
    try { this.bindPanel(); } catch (e) {}
    try { this.ensureBackgroundSubscription(); } catch (e) {}
  }

  // Capture element refs from parent after panel build
  captureElements(els) {
    this.els = els;
  }

  // --- Implementations migrated from index.js ---
  bindPanel() {
    const self = this.main;
    if (this._bound) return; // prevent double-binding
    // Render log panel structure inside container
    const host = document.getElementById('srv-log-panel');
    if (host && !host._rendered) {
      host.innerHTML = `
        <div class="srv-log-header">
          <div class="srv-log-title"><i class="bi bi-journal-text" style="margin-right:6px"></i>Логи</div>
          <div class="srv-log-head-controls">
            <select id="srv-log-level" class="srv-input">
              <option value="ALL" selected>ALL</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARNING">WARNING</option>
              <option value="ERROR">ERROR</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
            <input id="srv-log-grep" class="srv-input" placeholder="поиск" style="flex:1; min-width: 80px;" />
          </div>
          <button class="srv-btn" id="srv-logs-close"><i class="bi bi-x-lg"></i> Закрыть</button>
        </div>
        <div class="srv-log-toolbar" style="justify-content: space-between;">
          <div style="display:flex; align-items:center; gap:6px;">
            <label class="srv-setting-item" style="gap:4px; align-items:center;"><input type="checkbox" id="srv-logs-live" checked> Live</label>
            <label class="srv-setting-item" style="gap:4px; align-items:center;"><input type="checkbox" id="srv-logs-autoscroll" checked> Автоскролл</label>
            <button class="srv-btn" id="srv-logs-refresh" title="Обновить"><i class="bi bi-arrow-clockwise"></i> Обновить</button>
            <button class="srv-btn" id="srv-logs-download" title="Скачать"><i class="bi bi-download"></i> Скачать</button>
            <button class="srv-btn" id="srv-logs-clear" title="Очистить"><i class="bi bi-trash"></i> Очистить</button>
            <button class="srv-btn" id="srv-logs-toggle-new" title="Показать только новые" disabled data-state="all"><i class="bi bi-lightning-charge"></i> Новые</button>
          </div>
          
        </div>
        <div id="srv-log-body" class="srv-log-body"></div>
      `;
      host._rendered = true;
      // refresh element refs on parent
      self.els.logsPanel = host;
      self.els.logsClose = host.querySelector('#srv-logs-close');
      self.els.logsRefresh = host.querySelector('#srv-logs-refresh');
      self.els.logsClear = host.querySelector('#srv-logs-clear');
      self.els.logsDownload = host.querySelector('#srv-logs-download');
      self.els.logsBody = host.querySelector('#srv-log-body');
      self.els.logsLevel = host.querySelector('#srv-log-level');
      self.els.logsGrep = host.querySelector('#srv-log-grep');
      self.els.logsLive = host.querySelector('#srv-logs-live');
      self.els.logsAutoscroll = host.querySelector('#srv-logs-autoscroll');
      self.els.logsToggleNew = host.querySelector('#srv-logs-toggle-new');
    }
    const open = async () => { try {
      self.els.logsPanel?.classList.add('open');
      // Синхронизируем уровень бэйджа из главного инспектора перед открытием
      try {
        if (self && typeof self._loadSetting === 'function') {
          const saved = String(self._loadSetting('badgeLevel', self.logsBadgeLevel || 'INFO')||'INFO').toUpperCase().trim();
          self.logsBadgeLevel = saved;
        }
      } catch(_) {}
      await this.fetchOnce(false);
      const newCnt = self._logsNewCounter || 0; self._logsLastNewCount = newCnt;
      if (newCnt > 0 && self.els?.logsBody) {
        const children = Array.from(self.els.logsBody.children);
        const total = children.length;
        for (let i = Math.max(0, total - newCnt); i < total; i++) {
          const node = children[i]; if (node) node.classList.add('new');
        }
        const tn = self.els.logsToggleNew; if (tn) { tn.disabled = false; tn.dataset.state='all'; tn.textContent='Новые'; tn.setAttribute('data-badge', String(newCnt)); }
        setTimeout(() => { try { for (const n of self.els.logsBody.querySelectorAll('.srv-log-line.new')) { n.classList.remove('new'); } } catch(_) {} }, 2500);
        self._logsNewCounter = 0; this.updateBadge();
      } else { const tn = self.els.logsToggleNew; if (tn) { tn.disabled = true; tn.dataset.state='all'; tn.textContent='Новые'; tn.removeAttribute('data-badge'); } }
      this.startLive();
    } catch(_) {} };
    const close = () => { try {
      self.els.logsPanel?.classList.remove('open');
      this.ensureHandler();
      // повторно применим сохранённый уровень при закрытии
      try {
        if (self && typeof self._loadSetting === 'function') {
          const saved = String(self._loadSetting('badgeLevel', self.logsBadgeLevel || 'INFO')||'INFO').toUpperCase().trim();
          self.logsBadgeLevel = saved;
        }
      } catch(_) {}
      this.subscribe(self.logsBadgeLevel || 'INFO', '');
      if (self.els.logsBody) self.els.logsBody.innerHTML = '';
      this.ensureBackgroundSubscription();
    } catch(_) {} };
    self.els.logsBtn && self.els.logsBtn.addEventListener('click', open);
    self.els.logsClose && self.els.logsClose.addEventListener('click', close);
    self.els.logsRefresh && self.els.logsRefresh.addEventListener('click', () => this.fetchOnce());
    try { if (self.els.logsLevel) { self.els.logsLevel.value = 'ALL'; } } catch(_) {}
    // фильтрация по уровню локально + при Live обновляем подписку
    const levelOrder = { DEBUG:1, INFO:2, WARNING:3, ERROR:4, CRITICAL:5 };
    const applyLevelFilter = () => {
      const body = self.els?.logsBody; if (!body) return;
      const sel = (self.els.logsLevel?.value || 'ALL').toUpperCase();
      const minLevel = sel === 'ALL' ? null : sel;
      const children = Array.from(body.children);
      for (const el of children) {
        const m = /level-([A-Z]+)/.exec(el.className || '');
        const lvl = m ? m[1] : null;
        if (!minLevel) { el.style.display = ''; continue; }
        if (!lvl) { el.style.display = 'none'; continue; }
        el.style.display = (levelOrder[lvl] || 0) >= (levelOrder[minLevel] || 0) ? '' : 'none';
      }
    };
    const deb = (() => { let t=null; return () => { if (t) clearTimeout(t); t=setTimeout(()=>{
      applyLevelFilter();
      const live = !!(self.els?.logsLive?.checked);
      if (live) this.startLive();
    }, 250); }; })();
    self.els.logsLevel && self.els.logsLevel.addEventListener('change', deb);
    self.els.logsGrep && self.els.logsGrep.addEventListener('input', deb);
    if (self.els.logsLive) {
      self.els.logsLive.addEventListener('change', () => {
        const live = !!self.els.logsLive.checked;
        if (live) this.startLive(); else this.unsubscribe();
      });
    }
    if (self.els.logsAutoscroll) {
      self.els.logsAutoscroll.addEventListener('change', () => {
        if (self.els.logsAutoscroll.checked) {
          const body = self.els?.logsBody; if (body) { body.scrollTop = body.scrollHeight; }
          self._logsNewCounter = 0; this.updateBadge();
        }
      });
    }
    if (self.els.logsDownload) {
      self.els.logsDownload.addEventListener('click', async () => {
        try {
          const level = self.els.logsLevel?.value || 'DEBUG';
          const grep = self.els.logsGrep?.value || '';
          const params = new URLSearchParams();
          params.set('level', String(level).toUpperCase()==='ALL'?'DEBUG':level);
          if (grep) params.set('grep', grep);
          params.set('limit', '2000');
          const res = await fetch('/api/logs?' + params.toString(), { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          const lines = (Array.isArray(data.logs) ? data.logs : []).map(r => {
            const ts = Number(r.ts_ms) ? new Date(r.ts_ms).toISOString() : '';
            const lvl = String(r.level || '').toUpperCase();
            return `[${ts}] ${lvl} ${r.logger || 'app'}: ${r.message || ''}`;
          }).join('\n');
          const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = 'logs.txt';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch(_) {}
      });
    }
    // Очистить: сбросить DOM и счётчики
    if (self.els.logsClear) {
      self.els.logsClear.addEventListener('click', () => {
        try {
          if (self.els.logsBody) self.els.logsBody.innerHTML = '';
          self._logsNewCounter = 0; this.updateBadge();
          const tn = self.els.logsToggleNew; if (tn) { tn.removeAttribute('data-badge'); tn.dataset.state = 'all'; tn.innerHTML = '<i class="bi bi-lightning-charge"></i> Новые'; }
        } catch(_) {}
      });
    }
    // Toggle "Новые"
    if (self.els.logsToggleNew) {
      self.els.logsToggleNew.addEventListener('click', () => {
        try {
          const body = self.els?.logsBody; if (!body) return;
          const state = self.els.logsToggleNew.dataset.state || 'all';
          if (state === 'all') {
            const n = self._logsLastNewCount || 0; if (!n) return;
            const all = Array.from(body.children);
            const total = all.length; const start = Math.max(0, total - n);
            for (let i = 0; i < start; i++) { const el = all[i]; if (el) el.style.display = 'none'; }
            for (let i = start; i < total; i++) { const el = all[i]; if (el) { el.style.display = ''; el.classList.add('new'); } }
            self.els.logsToggleNew.dataset.state = 'new';
            const label = (self.logsBadgeLevel || 'INFO').toUpperCase();
            self.els.logsToggleNew.textContent = `${label} (новые)`;
          } else {
            for (const el of Array.from(body.children)) { el.style.display = ''; }
            self.els.logsToggleNew.dataset.state = 'all';
            self.els.logsToggleNew.textContent = 'Все';
          }
        } catch(_) {}
      });
    }
    this._bound = true;
  }

  ensureHandler() {
    if (!this._onLogsBatch) {
      this._onLogsBatch = (payload) => {
        const self = this.main;
        try {
          const lines = Array.isArray(payload?.logs) ? payload.logs : [];
          if (!lines.length) return;
          const body = self.els?.logsBody;
          if (!body || !self.els?.logsPanel?.classList.contains('open')) {
            // Корректная фильтрация по уровню (числовой порядок, не лексикографический)
            const order = { DEBUG:1, INFO:2, WARNING:3, ERROR:4, CRITICAL:5 };
            const minLvl = order[(self.logsBadgeLevel || 'INFO').toString().toUpperCase()] || 2;
            const passed = lines.filter(r => (order[String(r.level||'').toUpperCase()] || 0) >= minLvl);
            if (passed.length) {
              self._logsNewCounter = (self._logsNewCounter || 0) + passed.length;
              this.updateBadge();
              self._newLogsBuffer.push(...passed);
              if (self._newLogsBuffer.length > self._newLogsMax) self._newLogsBuffer.splice(0, self._newLogsBuffer.length - self._newLogsMax);
              const toggle = self.els?.logsToggleNew; if (toggle && !self.els?.logsPanel?.classList.contains('open')) {
                toggle.setAttribute('data-badge', String(Math.min(99, (self._logsNewCounter||0))));
              }
            }
            return;
          }
          // Ограничиваем рост DOM: максимум 1000 строк, старые удаляем
          const autoscroll = !!(self.els?.logsAutoscroll?.checked);
          const atBottom = autoscroll && Math.abs((body.scrollTop + body.clientHeight) - body.scrollHeight) < 12;
          const frag = document.createDocumentFragment();
          for (const rec of lines) { frag.appendChild(this._renderLogLine(rec)); }
          body.appendChild(frag);
          // Трим до лимита
          const maxLines = Number(self._loadSetting ? self._loadSetting('logsDomLimit', 1000) : 1000) || 1000;
          const extra = Math.max(0, body.children.length - maxLines);
          for (let i = 0; i < extra; i++) { const n = body.firstChild; if (n) body.removeChild(n); }
          if (autoscroll && atBottom) { setTimeout(()=>{ try { body.scrollTop = body.scrollHeight; } catch(_) {} }, 0); self._logsNewCounter = 0; this.updateBadge(); }
          else { self._logsNewCounter = (self._logsNewCounter || 0) + lines.length; this.updateBadge(); }
        } catch(_) {}
      };
      try { window.socket && window.socket.on('log_record_batch', this._onLogsBatch); } catch(_) {}
    }
  }

  subscribe(level='INFO', grep='') { try { if (window.socket) { window.socket.emit('subscribe_logs', { level, grep }); this.main._logsSubscribed = true; this.main._logsSubLevel = level; this.main._logsSubGrep = grep; } } catch(_) {} }
  unsubscribe() {
    try { if (window.socket) { window.socket.emit('unsubscribe_logs'); } } catch(_) {}
    try { if (this._onLogsBatch && window.socket) { window.socket.off('log_record_batch', this._onLogsBatch); this._onLogsBatch = null; } } catch(_) {}
    this.main._logsSubscribed = false;
  }

  ensureBackgroundSubscription() {
    const self = this.main; if (!self.isVisible) return;
    this.ensureHandler();
    let wantLevel = (self.logsBadgeLevel || 'INFO').toString().toUpperCase();
    if (wantLevel === 'WARN' || wantLevel === 'WARNINGG' || wantLevel === 'WARNIGG' || wantLevel === 'WARNINGS') wantLevel = 'WARNING';
    const wantGrep='';
    if (!self._logsSubscribed || self._logsSubLevel !== wantLevel || self._logsSubGrep !== wantGrep) {
      this.unsubscribe();
      this.subscribe(wantLevel, wantGrep);
    }
  }

  updateBadge() {
    const self = this.main;
    try {
      const btn = self.els?.logsBtn; if (!btn) return;
      let badge = btn.querySelector('.logs-new-badge');
      const cnt = self._logsNewCounter || 0;
      if (cnt > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'logs-new-badge';
          badge.style.cssText = 'position:absolute; transform: translate(8px,-6px); background:#ff5252; color:#fff; border-radius:10px; padding:0 4px; font-size:10px; line-height:14px;';
          btn.style.position = 'relative';
          btn.appendChild(badge);
        }
        badge.textContent = String(Math.min(99, cnt));
      } else if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    } catch(_) {}
  }

  async fetchOnce() {
    const self = this.main;
    try {
      let level = (self.els?.logsLevel?.value || 'ALL');
      if (String(level).toUpperCase() === 'ALL') level = 'DEBUG';
      const grep = self.els?.logsGrep?.value || '';
      const params = new URLSearchParams();
      params.set('level', level);
      if (grep) params.set('grep', grep);
      params.set('limit', String(self.logsHttpLimit || 500));
      const res = await fetch('/api/logs?' + params.toString(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const lines = Array.isArray(data.logs) ? data.logs : [];
      const body = self.els?.logsBody; if (!body) return;
      const autoscroll = !!(self.els?.logsAutoscroll?.checked);
      const atBottom = autoscroll && Math.abs((body.scrollTop + body.clientHeight) - body.scrollHeight) < 12;
      body.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const rec of lines) { frag.appendChild(this._renderLogLine(rec)); }
      body.appendChild(frag);
      if (autoscroll && atBottom) body.scrollTop = body.scrollHeight;
    } catch(_) {}
  }

  startLive() {
    const self = this.main;
    try {
      if (!window.socket || !self.els) { this.fetchOnce(); return; }
      let level = (self.els.logsLevel?.value || 'ALL');
      const wantLevel = String(level).toUpperCase() === 'ALL' ? 'DEBUG' : String(level).toUpperCase();
      const wantGrep = String(self.els.logsGrep?.value || '');
      this.ensureHandler();
      const same = !!(self._logsSubscribed && self._logsSubLevel === wantLevel && self._logsSubGrep === wantGrep);
      if (!same) {
        this.unsubscribe();
        this.subscribe(wantLevel, wantGrep);
      }
    } catch(_) { this.fetchOnce(); }
  }

  _renderLogLine(rec) {
    const self = this.main;
    const div = document.createElement('div');
    const ts = Number(rec.ts_ms) ? new Date(rec.ts_ms).toLocaleTimeString() : '';
    const lvl = String(rec.level || '').toUpperCase();
    const logger = rec.logger || 'app';
    // Экранируем исходный текст и затем применяем подсветки
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m] || m));
    let msg = escapeHtml(rec.message || '');
    // Feature toggles
    const fx = self._logFx || { http:true, uuid:true, err:true, errRe:'(Exception|Traceback|Error:|Ошибка)' };
    // Highlight IP (all occurrences)
    msg = msg.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m)=>`<span class=\"log-ip\">${m}</span>`);
    // HTTP method/path/status — поддержка формата с кавычками и HTTP/1.x
    if (fx.http) {
      const applyHttp = (_m, method, path, code) => {
        const cls = Number(code) >=500? 's5xx' : Number(code)>=400? 's4xx' : Number(code)>=300? 's3xx' : 's2xx';
        const mcls = `method-${method}`;
        return `<span class=\"log-http-method ${mcls}\">${method}</span> <span class=\"log-http-path\">${path}</span> <span class=\"log-http-status ${cls}\">${code}</span>`;
      };
      const reQuoted = /"(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+([^"\s]+)\s+HTTP\/[\d.]+"\s+(\d{3})/;
      const reHttp = /\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b\s+([^\s]+)\s+HTTP\/[\d.]+\s+(\d{3})/;
      const reSimple = /\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b\s+([^\s]+)\s+(\d{3})\b/;
      if (reQuoted.test(msg)) msg = msg.replace(reQuoted, applyHttp);
      else if (reHttp.test(msg)) msg = msg.replace(reHttp, applyHttp);
      else msg = msg.replace(reSimple, applyHttp);
    }
    // UUID (8-4-4-4-12 or 32 hex подряд)
    if (fx.uuid) {
      msg = msg.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b[0-9a-fA-F]{32}\b/, (m)=>`<span class=\"log-uuid\">${m}</span>`);
    }
    // Error RegExp
    if (fx.err && fx.errRe) {
      try {
        const re = new RegExp(fx.errRe, 'i');
        msg = msg.replace(re, (m)=>`<span class=\"log-errre\">${m}</span>`);
      } catch(_) {}
    }
    div.className = `srv-log-line level-${lvl}`;
    // Собираем DOM-узлы безопасно
    const tsEl = document.createElement('span'); tsEl.className = 'log-ts'; tsEl.textContent = `[${ts}]`;
    const lvlEl = document.createElement('span'); lvlEl.className = 'log-level'; lvlEl.textContent = lvl;
    const loggerEl = document.createElement('span'); loggerEl.className = 'log-logger'; loggerEl.textContent = `${logger}:`;
    const msgEl = document.createElement('span'); msgEl.className = 'log-msg'; msgEl.innerHTML = msg; // msg уже экранирован и размечен
    const frag = document.createDocumentFragment();
    frag.appendChild(tsEl);
    frag.appendChild(lvlEl);
    frag.appendChild(loggerEl);
    frag.appendChild(msgEl);
    div.appendChild(frag);
    return div;
  }
}


