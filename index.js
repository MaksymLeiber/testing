import { showWarning, showError, showInfo } from '../toast.js';
import { initTooltips, attachHelpTooltip } from '../tooltips.js';

class ServerInspector {
  constructor() {
    if (window.__serverInspectorInstance) {
      return window.__serverInspectorInstance;
    }

    this.isInitialized = false;
    this.isVisible = false;
    this.isCollapsed = false;
    this._resizeHandler = null;
    this._skeletonTimer = null;
    this._skeletonUntil = 0;
    this._lastData = null;
    this._lastJsMem = null; // Последнее значение памяти
    this._currentArrow = ''; // Текущая стрелка
    
    // Garbage Collection tracking
    this._gcCount = 0; // Количество GC
    this._minorGcCount = 0; // Счетчик Minor GC (5-15% падение)
    this._majorGcCount = 0; // Счетчик Major GC (15%+ падение)
    this._lastGcTime = null; // Время последней GC
    this._lastMemForGc = null; // Последнее значение памяти для отслеживания GC
    this._gcDetectionTimer = null; // Таймер для отслеживания GC
    this._lastGcFreed = null; // Сколько памяти было освобождено при последней GC

    // History
    this.serverHistory = [];
    this.maxHistoryLength = 50;

    // Interval / realtime
    this.checkInterval = this._loadInterval(); // ms
    this.realtimeEnabled = this._loadRealtime();
    this.intervalId = null;
    this._realtimeFallbackTimer = null;
    this._httpPollId = null;
    this._lastServerInfoTs = 0;
    this._settingsNs = 'srv_settings_';

    // Thresholds (loaded from settings)
    this.cpuWarn = this._loadSetting('cpuWarn', 60);
    this.cpuCrit = this._loadSetting('cpuCrit', 80);
    this.memWarn = this._loadSetting('memWarn', 60);
    this.memCrit = this._loadSetting('memCrit', 80);
    this.tempCpuWarn = this._loadSetting('tempCpuWarn', 75);
    this.tempCpuCrit = this._loadSetting('tempCpuCrit', 85);
    this.tempGpuWarn = this._loadSetting('tempGpuWarn', 80);
    this.tempGpuCrit = this._loadSetting('tempGpuCrit', 90);
    this.toastsEnabled = this._loadSetting('toastsEnabled', true);
    this.notifyInterval = this._loadSetting('notifyInterval', 60000);
    this._viewSettings = this._loadSetting('viewSettings', {});
    this.disableAllNotifications = this._loadSetting('disableAll', false);

    // Anti-spam for notifications
    this._lastNotifyTimes = {}; // key -> timestamp

    // DOM cache
    this.root = null;
    this.els = null;

    // Keybinding
    this._keydownBound = false;

    window.__serverInspectorInstance = this;
    try { if (!window.serverInspector) window.serverInspector = this; } catch(_) {}
  }

  _formatBytesShort(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const units = ['Б','КБ','МБ','ГБ'];
    let v = bytes, i = 0; while (v >= 1024 && i < units.length-1) { v/=1024; i++; }
    return `${Math.round(v)} ${units[i]}`;
  }
  _formatMsBrief(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return `${Math.round(ms)} мс`;
    return `${(ms/1000).toFixed(2)} с`;
  }
  _estimateAppDomCount() {
    try {
      const total = document.getElementsByTagName('*').length;
      const inspectorNodes = document.querySelectorAll('#client-inspector-panel, #server-inspector-panel');
      let insp = 0; inspectorNodes.forEach(n => { try { insp += (n.getElementsByTagName('*').length + 1); } catch(_){} });
      return Math.max(0, total - insp);
    } catch(_) { return 0; }
  }
  _loadClientExcludeSelectors() {
    try {
      const saved = localStorage.getItem('srv_client_dom_exclude');
      if (saved && typeof saved === 'string') {
        return saved.split(',').map(s => s.trim()).filter(Boolean);
      }
    } catch(_) {}
    return ['#client-inspector-panel', '#server-inspector-panel', '#connection-placeholder', '#toast-container'];
  }
  _getExcludedRoots() {
    const selectors = this._loadClientExcludeSelectors();
    const found = [];
    try {
      selectors.forEach(sel => { try { document.querySelectorAll(sel).forEach(el => found.push(el)); } catch(_) {} });
      const roots = [];
      found.forEach(el => { if (!found.some(other => other !== el && other.contains(el))) roots.push(el); });
      return roots;
    } catch(_) { return []; }
  }
  _startClientMetricsRealtime() {
    try { if (this._clientDomObserver) { this._clientDomObserver.disconnect(); this._clientDomObserver = null; } } catch(_) {}
    const debounced = (() => { let t = null; return () => { if (t) cancelAnimationFrame(t); t = requestAnimationFrame(() => this._updateClientMetrics()); }; })();
    try {
      this._clientDomObserver = new MutationObserver(() => debounced());
      this._clientDomObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch(_) {}
    
    // Инициализируем отслеживание GC
    this._initGCTracking();
  }
  
  _initGCTracking() {
    // Инициализируем отслеживание памяти для определения GC
    if (performance && performance.memory) {
      this._lastMemForGc = performance.memory.usedJSHeapSize;
      
      // Проверяем изменения памяти каждые 5 секунд
      this._gcDetectionTimer = setInterval(() => {
        try {
          const currentMem = performance.memory.usedJSHeapSize;
          
          // Если память уменьшилась значительно, вероятно была GC
          if (this._lastMemForGc !== null && currentMem < this._lastMemForGc) {
            const dropPercent = 1 - (currentMem / this._lastMemForGc);
            
            // Minor GC: падение на 5-15%, Major GC: падение на 15%+
            if (dropPercent >= 0.05) {
              // Защита от дребезга: не считаем GC чаще чем раз в 500мс
              if (Date.now() - this._lastGcTime > 500) {
                this._gcCount++;
                this._lastGcTime = Date.now();
                this._lastGcFreed = this._lastMemForGc - currentMem; // Запоминаем сколько освободилось
                
                // Определяем тип GC и обновляем счетчики
                const gcType = dropPercent >= 0.15 ? 'Major' : 'Minor';
                if (gcType === 'Major') {
                  this._majorGcCount++;
                } else {
                  this._minorGcCount++;
                }
                console.log(`${gcType} GC: освобождено ${(this._lastGcFreed / 1024 / 1024).toFixed(2)} МБ (${(dropPercent * 100).toFixed(1)}%)`);
              }
            }
          }
          
          // Запоминаем новый максимум памяти (для более точного определения GC)
          this._lastMemForGc = Math.max(this._lastMemForGc, currentMem);
        } catch(_) {}
      }, 5000);
    }
    
    // Используем FinalizationRegistry для более точного отслеживания (если поддерживается)
    if (typeof FinalizationRegistry !== 'undefined') {
      this._finalizationRegistry = new FinalizationRegistry((heldValue) => {
        // Это не означает GC, но может помочь в отслеживании
      });
    }
  }
  

  
  _sumJsTransferredBytes() {
    try {
      if (!(performance && performance.getEntriesByType)) return null;
      const entries = performance.getEntriesByType('resource') || [];
      let sum = 0, cnt = 0;
      entries.forEach(e => {
        const name = (e.name || '').toLowerCase();
        if (name.endsWith('.js') || name.includes('/js/')) {
          cnt += 1;
          const b = (e.transferSize || e.encodedBodySize || e.decodedBodySize || 0);
          sum += (Number.isFinite(b) ? b : 0);
        }
      });
      return { sumBytes: sum, count: cnt };
    } catch(_) { return null; }
  }
  _updateClientMetrics() {
    try {
      const totalDom = document.getElementsByTagName('*').length;
      const appDom = this._estimateAppDomCount();
      const perf = (performance && performance.timing) ? performance.timing : null;
      const jsStats = this._sumJsTransferredBytes();
      if (this.els.clDomTotal) this.els.clDomTotal.textContent = String(totalDom);
      if (this.els.clDomApp) this.els.clDomApp.textContent = String(appDom);
      if (this.els.clJsCount) this.els.clJsCount.textContent = jsStats ? String(jsStats.count) : '-';
      if (this.els.clJsBytes) this.els.clJsBytes.textContent = jsStats ? this._formatBytesShort(jsStats.sumBytes) : '-';
      if (this.els.clJsMem) {
        try {
          const mem = performance && performance.memory && performance.memory.usedJSHeapSize;
          if (Number.isFinite(mem)) {
            // Сравниваем с последним значением
            if (this._lastJsMem !== null) {
              const diff = mem - this._lastJsMem;
              const diffKb = diff / 1024;
              
              // Уменьшаем порог до 20 КБ для более чувствительного отображения
              if (Math.abs(diffKb) > 20) {
                if (diff > 0) {
                  // Память растет - красная стрелка вверх
                  this._currentArrow = '<i class="bi bi-arrow-up status-crit" style="margin-right: 4px;"></i>';
                } else {
                  // Память падает - зеленая стрелка вниз
                  this._currentArrow = '<i class="bi bi-arrow-down status-ok" style="margin-right: 4px;"></i>';
                }
              }
              // Если изменение меньше 20 КБ, оставляем предыдущую стрелку
            }
            
            // Показываем стрелку только если скелетон закончился
            if (Date.now() >= this._skeletonUntil) {
              // Создаем элемент через createElement вместо innerHTML
              this.els.clJsMem.innerHTML = '';
              
              if (this._currentArrow) {
                const arrow = document.createElement('span');
                arrow.innerHTML = this._currentArrow;
                arrow.style.marginRight = '4px';
                this.els.clJsMem.appendChild(arrow);
              }
              
              const memText = document.createTextNode(`${(mem/1048576).toFixed(1)} МБ`);
              this.els.clJsMem.appendChild(memText);
            }
            this._lastJsMem = mem; // Запоминаем текущее значение
          } else {
            this.els.clJsMem.textContent = '-';
            this._lastJsMem = null;
            this._currentArrow = '';
          }
        } catch(_) { 
          this.els.clJsMem.textContent = '-'; 
          this._lastJsMem = null;
          this._currentArrow = '';
        }
      }
      if (this.els.clDcl && perf) {
        const dcl = perf.domContentLoadedEventEnd - perf.navigationStart;
        this.els.clDcl.textContent = this._formatMsBrief(dcl);
      }
      if (this.els.clLoad && perf) {
        const load = perf.loadEventEnd - perf.navigationStart;
        this.els.clLoad.textContent = this._formatMsBrief(load);
      }
      
      // Обновляем GC метрики
      if (this.els.clGc) {
        const now = Date.now();
        let gcText = '';
        let fullText = ''; // Для tooltip
        
        if (this._lastGcTime) {
          const timeSinceLastGc = now - this._lastGcTime;
          const timeSinceLastGcSec = Math.floor(timeSinceLastGc / 1000);
          
          let timeText = '';
          if (timeSinceLastGcSec < 60) {
            timeText = `${timeSinceLastGcSec}с`;
          } else if (timeSinceLastGcSec < 3600) {
            const minutes = Math.floor(timeSinceLastGcSec / 60);
            timeText = `${minutes}м`;
          } else {
            const hours = Math.floor(timeSinceLastGcSec / 3600);
            timeText = `${hours}ч`;
          }
          
          // Форматируем освобожденную память
          let freedText = '';
          if (this._lastGcFreed !== null) {
            const freedMB = (this._lastGcFreed / 1048576).toFixed(1);
            freedText = `${freedMB}МБ`;
            gcText = `${freedMB}МБ (${timeText}) | (${this._gcCount})`;
            fullText = `GC: ${this._gcCount} раз, последний: ${timeText} назад, освобождено ${freedMB} МБ`;
          } else {
            gcText = `${this._gcCount} (${timeText}) | (${this._gcCount})`;
            fullText = `GC: ${this._gcCount} раз, последний: ${timeText} назад`;
          }
          
          // Создаем GC элемент через createElement
          const gcContainer = document.createElement('span');
          gcContainer.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';
          
          const gcIcon = document.createElement('i');
          gcIcon.className = 'bi bi-check-circle-fill';
          gcIcon.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; color: #6bcf7f;';
          
          const gcTextNode = document.createTextNode(gcText);
          
          gcContainer.appendChild(gcIcon);
          gcContainer.appendChild(gcTextNode);
          
          gcText = gcContainer;
        } else {
          // Создаем элемент ожидания GC через createElement
          const waitContainer = document.createElement('span');
          waitContainer.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';
          
          const waitIcon = document.createElement('i');
          waitIcon.className = 'bi bi-arrow-clockwise';
          waitIcon.style.cssText = 'animation: spin 1s linear infinite; color: #6bcf7f;';
          
          const waitText = document.createTextNode('Ожидание GC...');
          
          waitContainer.appendChild(waitIcon);
          waitContainer.appendChild(waitText);
          
          gcText = waitContainer;
          fullText = 'Ожидание первой сборки мусора...';
        }
        
        // Показываем иконки только если скелетон закончился
        if (Date.now() >= this._skeletonUntil) {
          this.els.clGc.innerHTML = '';
          this.els.clGc.appendChild(gcText);
          this.els.clGc.title = fullText;
          this.els.clGc.style.cursor = 'help';
        }
        
        // Обновляем метрику типов GC
        if (this.els.clGcTypes) {
          if (this._gcCount > 0) {
            this.els.clGcTypes.textContent = `Minor: ${this._minorGcCount}, Major: ${this._majorGcCount}`;
            this.els.clGcTypes.title = `Minor GC: ${this._minorGcCount} раз (5-15% падение), Major GC: ${this._majorGcCount} раз (15%+ падение)`;
            this.els.clGcTypes.style.cursor = 'help';
          } else {
            this.els.clGcTypes.textContent = 'Ожидание GC...';
            this.els.clGcTypes.title = 'Ожидание первой сборки мусора';
            this.els.clGcTypes.style.cursor = 'default';
          }
        }
      }
    } catch(_) {}
    try { clearInterval(this._clientMetricsTimer); } catch(_) {}
    this._clientMetricsTimer = setInterval(() => this._updateClientMetrics(), 5000);
  }

  _renderComponents(comps) {
    if (!this.els || !this.els.componentsBar) return;
    const order = ['python','nginx','redirect','http2','ws','workers','database'];
      const label = { python: 'Python', nginx: 'Nginx', redirect: 'Redirect', http2: 'HTTP/2', ws: 'WS', workers: 'Workers', database: 'DB' };
    const iconBy = (k, st) => {
      const base = st === 'ok' ? 'bi-check-circle-fill status-ok' : (st === 'warn' ? 'bi-exclamation-triangle-fill status-warn' : 'bi-x-circle-fill status-crit');
      if (k === 'nginx') return `bi-hdd-network ${base}`;
      if (k === 'redirect') return `bi-arrow-left-right ${base}`;
      if (k === 'http2') return `bi-lightning-charge-fill ${base}`;
      if (k === 'ws') return `bi-wifi ${base}`;
      if (k === 'workers') return `bi-diagram-3 ${base}`;
      if (k === 'database') return `bi-database ${base}`;
      return `bi-cpu ${base}`;
    };
    
    // Очищаем панель компонентов через removeChild вместо innerHTML
    while (this.els.componentsBar.firstChild) {
      this.els.componentsBar.removeChild(this.els.componentsBar.firstChild);
    }
    
    order.forEach(key => {
      const c = comps[key] || {};
      const st = c.status || 'warn';
      const item = document.createElement('div');
      item.className = `srv-comp-item ${st === 'ok' ? 'status-ok' : (st === 'warn' ? 'status-warn' : 'status-crit')}`;
      
      // Создаем элементы через createElement вместо innerHTML
      const icon = document.createElement('i');
      icon.className = `bi ${iconBy(key, st)}`;
      
      const name = document.createElement('span');
      name.className = 'srv-comp-name';
      name.textContent = label[key] || key.toUpperCase();
      
      item.appendChild(icon);
      item.appendChild(name);
      
      try { attachHelpTooltip(item, this._formatComponentTooltip(key, c)); } catch(_) { item.title = JSON.stringify(c); }
      this.els.componentsBar.appendChild(item);
    });
  }

  _formatComponentTooltip(key, c) {
    try {
      const statusText = c.status === 'ok' ? 'OK' : (c.status === 'warn' ? 'Предупреждение' : 'Критично');
      if (key === 'nginx') return `Nginx: ${statusText}\nПорт 80: ${c.p80 ? 'да' : 'нет'}\nПорт 443: ${c.p443 ? 'да' : 'нет'}`;
      if (key === 'redirect') return `Redirect: ${statusText}\nHTTP→HTTPS: ${c.ok !== false ? 'да' : 'нет'}\nКод: ${c.code || '-'}\nLocation: ${c.location || '-'}`;
      if (key === 'http2') return `HTTP/2: ${statusText}\nALPN: ${c.alpn || '-'}`;
      if (key === 'ws') return `WebSocket: ${statusText}\nКлиенты: ${c.clients ?? '-'}\nПауза с последнего сообщения: ${c.last_msg_age_s != null ? (c.last_msg_age_s + 'с') : '-'}`;
      if (key === 'workers') return `Workers: ${statusText}\nАктивные/всего: ${c.active ?? '-'} / ${c.total ?? '-'}\nОчередь: ${c.length ?? '-'}\nЛаг очереди: ${c.lag_ms != null ? (c.lag_ms + ' мс') : '-'}`;
      if (key === 'database') return `DB: ${statusText}\nAvg запрос: ${c.avg_query_ms ?? '-'} мс\nМедленных/1м: ${c.slow_1m ?? '-'}\nБлокировки: ${c.locks ?? '-'}`;
      return `Python: ${statusText}`;
    } catch(_) { return ''; }
  }
  _loadInterval() {
    try {
      const v = parseInt(localStorage.getItem('srv_inspector_interval'), 10);
      return Number.isFinite(v) ? Math.max(5000, Math.min(60000, v)) : 30000;
    } catch(_) { return 30000; }
  }
  _saveInterval(v) {
    try { localStorage.setItem('srv_inspector_interval', String(v)); } catch(_) {}
  }
  _loadRealtime() {
    try { const v = localStorage.getItem('srv_inspector_realtime'); return v === 'true'; } catch(_) { return false; }
  }
  _saveRealtime(on) { try { localStorage.setItem('srv_inspector_realtime', on ? 'true' : 'false'); } catch(_) {}
  }

  _loadSetting(key, defVal) {
    try {
      const v = localStorage.getItem(this._settingsNs + key);
      if (v == null) return defVal;
      if (v === 'true' || v === 'false') return v === 'true';
      const num = Number(v);
      return Number.isFinite(num) ? num : defVal;
    } catch(_) { return defVal; }
  }
  _saveSetting(key, val) {
    try { localStorage.setItem(this._settingsNs + key, String(val)); } catch(_) {}
  }

  init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    this._ensureStyles();
    // Панель будет создана "лениво" при первом показе.
    // Здесь только привязываем hotkey.
    this._bindKeydown();
  }

  _ensureStyles() {
    if (document.getElementById('server-inspector-styles')) return;
    const style = document.createElement('style');
    style.id = 'server-inspector-styles';
    style.textContent = `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      
      #server-inspector-panel {
        position: fixed;
        top: 20px;
        left: -425px;
        width: 425px;
        height: calc(100vh - 40px);
        background: rgba(0,0,0,0.95);
        color: #fff;
        z-index: 10002; /* above client inspector */
        box-shadow: 4px 0 12px rgba(0,0,0,0.4);
        display: flex;
        flex-direction: column;
        transition: left 0.25s ease;
        font-family: monospace;
        font-size: 70%;
        border-radius: 0px 8px 8px 0px;
      }
      #server-inspector-panel.open { left: 0; }
      #server-inspector-header { display:flex; align-items:center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.2); }
      #server-inspector-title { font-weight: bold; }
      .srv-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3); color:#fff; padding: 2px 6px; border-radius: 4px; font-size: 9px; cursor: pointer; display:inline-flex; align-items:center; gap:6px; }
      .srv-icon-btn { background: transparent; border: none; color:#ccc; cursor:pointer; font-size: 14px; padding: 4px; margin-right: 6px; }
      .srv-icon-btn:hover { color:#fff; }
      #server-inspector-content { flex: 1; overflow:auto; padding: 10px 12px; }
      #server-inspector-content { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.28) transparent; }
      #server-inspector-content::-webkit-scrollbar { width: 8px; }
      #server-inspector-content::-webkit-scrollbar-thumb { background: linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.32)); border-radius: 8px; }
      #server-inspector-content::-webkit-scrollbar-track { background: transparent; }
      #server-inspector-content .server-section-title { font-weight:bold; color:#4CAF50; margin: 8px 0 6px; display:flex; align-items:center; gap:6px; }
      #server-inspector-content .server-metric { display:grid; grid-template-columns: 1fr auto; align-items:center; gap: 10px; margin: 4px 0; }
      #server-inspector-content .server-metric-label { color:#ccc; display:flex; align-items:center; gap:6px; }
      #server-inspector-content .server-metric-label i { opacity: 0.9; }
      #server-inspector-content .server-metric-value { font-weight:bold; }
      .server-help { color:#8ab4f8; cursor: help !important; opacity: 0.85; }
      .server-help:hover { opacity: 1; cursor: help !important; }
      .metric-with-icon { display:flex; align-items:center; gap:6px; justify-content:flex-end; }
      .status-ok { color:#6bcf7f; }
      .status-warn { color:#ffb74d; }
      .status-crit { color:#f44336; }
      .server-group { margin: 6px 0 10px; }
      .server-group-title { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
      .server-group-title .caret { transition: transform .2s ease; }
      .server-group.collapsed .server-group-body { display:none; }
      .server-group.collapsed .caret { transform: rotate(-90deg); }
      .srv-skel { position: relative; overflow: hidden; color: transparent !important; background: #1f1f1f; border-radius: 6px; min-height: 12px; min-width: 60px; }
      .srv-skel::after { content:''; position:absolute; inset:0; background: linear-gradient(90deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.18) 40%, rgba(255,255,255,0.32) 50%, rgba(255,255,255,0.18) 60%, rgba(255,255,255,0.05) 100%); animation: srv-shimmer 1.1s infinite; }
      @keyframes srv-shimmer { 0%{ transform: translateX(-100%);} 100%{ transform: translateX(100%);} }
      #server-inspector-footer { padding: 8px 12px; border-top:1px solid rgba(255,255,255,0.2); display:flex; align-items:center; gap:8px; }
      #srv-interval { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3); color:#fff; padding: 2px 6px; border-radius: 4px; font-size: 9px; }
      #srv-realtime { transform: scale(0.9); }

      /* Settings drawer */
      .srv-header-actions { display:flex; align-items:center; gap:6px; }
      #server-settings-drawer { 
        position:absolute; 
        top:0; 
        left:0px;
        width: 425px; 
        height: 100%; 
        background: rgb(15, 15, 15); 
        border-right: 1px solid rgba(255,255,255,0.12); 
        box-shadow: 6px 0 12px rgba(0,0,0,0.4); 
        transition: transform .25s ease, opacity .25s ease; 
        display:flex; 
        flex-direction:column;
        opacity: 0;
        transform: translateX(-100%);
        pointer-events: none;
        z-index: 10;
        border-radius: 0px 8px 8px 0px;
      }
      #server-settings-drawer.open { 
        opacity: 1;
        transform: translateX(0);
        pointer-events: auto;
      }
      .srv-drawer-header { display:flex; align-items:center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .srv-drawer-title { font-weight: bold; color:#fff; }
      .srv-drawer-body { padding: 10px 12px; color:#ddd; overflow:auto; }
      .srv-setting-item { display:flex; align-items:center; gap:8px; }
      .srv-setting-item.disabled { opacity: 0.5; }
      .srv-grid.disabled { opacity: 0.7; }
      .srv-setting-group { margin: 12px 0; }
      .srv-setting-group-title { font-weight: bold; color:#6bcf7f; cursor:pointer; user-select:none; display:flex; align-items:center; justify-content: space-between; gap:8px; }
      .srv-setting-group-title .left { display: inline-flex; align-items:center; gap:8px; }
      .srv-setting-group-title .caret { transition: transform .2s ease; margin-left: 12px; }
      .srv-setting-group-title .left .bi-question-circle-fill { opacity: .8; }
      .srv-setting-group-title .left .bi-question-circle-fill:hover { opacity: 1; }
      .srv-setting-group.collapsed .srv-setting-group-body { display:none; }
      .srv-setting-group.collapsed .caret { transform: rotate(-90deg); }
      .srv-grid { display:grid; grid-template-columns: 1fr auto; gap: 6px 8px; align-items:center; padding-top: 6px; }
      .srv-input { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color:#fff; padding: 2px 6px; border-radius: 4px; width: 70px; font-size: 11px; }
      .srv-input-with-unit { display: flex; align-items: center; gap: 6px; }
      .server-group[data-key="system"] .server-metric-label,
      .server-group[data-key="system"] .server-metric-value { font-size: 90%; white-space: nowrap; }
      .server-group[data-key="system"] .server-metric-value { overflow: hidden; text-overflow: ellipsis; text-align: right; }
      #srv-interval option { background: rgb(15, 15, 15); color: #fff; }
      #srv-interval:disabled { cursor: not-allowed; opacity: 0.5; }
      .srv-interval-label.disabled { opacity: 0.5; }
      #srv-workers-active-names { font-size: 90%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hidden-by-settings { display: none !important; }




      .srv-setting-group > div { margin-bottom: 5px; }
      .srv-setting-group-title { cursor: pointer; font-weight: bold; color: #6bcf7f; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
      .srv-setting-group.collapsed .srv-setting-content { display: none; }
      .srv-setting-group-title .bi-chevron-down { transition: transform 0.2s; }
      .srv-setting-group.collapsed .bi-chevron-down { transform: rotate(-90deg); }
      .srv-input-with-unit { display: flex; align-items: center; }
      .srv-input-with-unit input { flex-grow: 1; }
      .srv-input-with-unit span { margin-left: 8px; }
      .srv-view-toggle-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }

      .hidden { display: none !important; }
      .hidden-by-settings { display: none !important; }

      /* Components status bar */
      #srv-components-bar {
        display: flex;
        align-items: center;
        gap: 1px;
        padding: 6px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.03);
        flex-wrap: nowrap;
        overflow: hidden;
      }
      .srv-comp-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        border-radius: 6px;
        background: rgba(255,255,255,0.06);
        color: #ccc;
        font-weight: 600;
        font-size: 10px;
        white-space: nowrap;
      }
      .srv-comp-item i {
        font-size: 12px;
      }
      .srv-comp-name {
        opacity: 0.95;
      }

      /* unified skeleton bar for components (same shimmer as .srv-skel) */
      .srv-comps-skel {
        width: 100%;
        height: 12px;
        border-radius: 6px;
        background: #1f1f1f;
        position: relative;
        overflow: hidden;
      }
      .srv-comps-skel::after {
        content:'';
        position:absolute;
        inset:0;
        background: linear-gradient(90deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.18) 40%, rgba(255,255,255,0.32) 50%, rgba(255,255,255,0.18) 60%, rgba(255,255,255,0.05) 100%);
        animation: srv-shimmer 1.1s infinite;
      }
    `;
    document.head.appendChild(style);
  }

  _buildPanel() {
    if (document.getElementById('server-inspector-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'server-inspector-panel';
    panel.innerHTML = `
      <div id="server-inspector-header">
        <div id="server-inspector-title">Сервер</div>
        <div class="srv-header-actions">
          <button class="srv-icon-btn" id="srv-settings-btn" title="Настройки"><i class="bi bi-gear"></i></button>
          <button class="srv-btn" id="srv-close-btn">Закрыть</button>
        </div>
      </div>

          <!-- Components compact status bar -->
      <div id="srv-components-bar"></div>
      </div>
      <div id="server-inspector-content">
        <div class="server-group" data-key="metrics">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-server"></i> Метрики</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-cpu"></i> CPU <i class="bi bi-question-circle-fill server-help" data-help="Загрузка процессора текущего процесса сервера в процентах."></i></span><span class="server-metric-value" id="srv-cpu">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-speedometer2"></i> Память <i class="bi bi-question-circle-fill server-help" data-help="Потребление ОЗУ текущим процессом сервера (МБ и %)."></i></span><span class="server-metric-value" id="srv-mem">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-collection"></i> Потоки <i class="bi bi-question-circle-fill server-help" data-help="Количество потоков в процессе сервера."></i></span><span class="server-metric-value" id="srv-threads">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-plug"></i> WS соединения <i class="bi bi-question-circle-fill server-help" data-help="Количество активных WebSocket соединений с этим сервером."></i></span><span class="server-metric-value" id="srv-conns">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-clock-history"></i> Uptime <i class="bi bi-question-circle-fill server-help" data-help="Время непрерывной работы процесса сервера."></i></span><span class="server-metric-value" id="srv-uptime">-</span></div>
          </div>
        </div>

        <div class="server-group" data-key="disk">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-hdd"></i> Диск I/O</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-speedometer"></i> Нагрузка <i class="server-help bi bi-question-circle-fill" data-help="Занятость диска. Если прямой показатель недоступен в ОС, рассчитывается по скорости чтения/записи."></i></span><span class="server-metric-value" id="srv-disk-busy">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-download"></i> Чтение <i class="bi bi-question-circle-fill server-help" data-help="Скорость чтения данных диском (байт/сек)."></i></span><span class="server-metric-value" id="srv-disk-rbytes">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-upload"></i> Запись <i class="bi bi-question-circle-fill server-help" data-help="Скорость записи данных на диск (байт/сек)."></i></span><span class="server-metric-value" id="srv-disk-wbytes">-</span></div>
          </div>
        </div>

        <div class="server-group" data-key="queues">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-diagram-3"></i> Очереди / Воркеры</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-list-ol"></i> Длина очереди <i class="bi bi-question-circle-fill server-help" data-help="Сколько задач сейчас ожидает обработки в очереди."></i></span><span class="server-metric-value" id="srv-q-len">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-hourglass-split"></i> Лаг <i class="bi bi-question-circle-fill server-help" data-help="Задержка выполнения задач (задержка ожидания), мс."></i></span><span class="server-metric-value" id="srv-q-lag">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-people"></i> Воркеры <i class="bi bi-question-circle-fill server-help" data-help="Активные/всего рабочих процессов, обрабатывающих очередь."></i></span><span class="server-metric-value" id="srv-workers">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-person-check"></i> Активные <i class="bi bi-question-circle-fill server-help" data-help="Имена (профили) воркеров, которые были активны в последний момент."></i></span><span class="server-metric-value" id="srv-workers-active-names">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-clock"></i> Задержка воркеров <i class="bi bi-question-circle-fill server-help" data-help="Сколько времени прошло с последнего сигнала 'я жив' от любого воркера сверх его нормального интервала. Помогает заметить засыпание/подвисание воркеров."></i></span><span class="server-metric-value" id="srv-workers-lag">-</span></div>
          </div>
        </div>

        <div class="server-group" data-key="db">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-database"></i> База данных</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-database"></i> Размер БД <i class="bi bi-question-circle-fill server-help" data-help="Размер файла базы данных на диске (МБ)."></i></span><span class="server-metric-value" id="srv-db-size">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-card-list"></i> Записей <i class="bi bi-question-circle-fill server-help" data-help="Суммарное количество записей в основных таблицах."></i></span><span class="server-metric-value" id="srv-db-recs">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-stopwatch"></i> Avg запрос <i class="bi bi-question-circle-fill server-help" data-help="Среднее время выполнения SQL-запросов за последнюю минуту."></i></span><span class="server-metric-value" id="srv-db-avgq">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-activity"></i> Медленные/1м <i class="bi bi-question-circle-fill server-help" data-help="Количество запросов дольше 200 мс за последнюю минуту."></i></span><span class="server-metric-value" id="srv-db-slow">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-lock"></i> Блокировки <i class="bi bi-question-circle-fill server-help" data-help="Сколько раз база сообщала о блокировке за последнюю минуту."></i></span><span class="server-metric-value" id="srv-db-locks">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-clock-history"></i> Последняя TX <i class="bi bi-question-circle-fill server-help" data-help="Когда была последняя успешная транзакция в БД."></i></span><span class="server-metric-value" id="srv-db-lasttx">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-plus-circle"></i> Последняя вставка <i class="bi bi-question-circle-fill server-help" data-help="Когда была последняя запись данных."></i></span><span class="server-metric-value" id="srv-db-lastins">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-shield-exclamation"></i> Последняя блокировка <i class="bi bi-question-circle-fill server-help" data-help="Когда последний раз база фиксировала блокировку."></i></span><span class="server-metric-value" id="srv-db-lastlock">-</span></div>
          </div>
        </div>

        <div class="server-group" data-key="runtime">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-cpu"></i> Память / GC / Темп</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-memory"></i> RSS <i class="bi bi-question-circle-fill server-help" data-help="Память процесса (Resident Set Size)."></i></span><span class="server-metric-value" id="srv-rss">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-recycle"></i> GC/мин <i class="bi bi-question-circle-fill server-help" data-help="Скорость сборок мусора (GC) в минуту. 0.0 — это нормальное, здоровое состояние, означающее, что приложение не создает избыточного 'мусора'. Постоянно высокие значения могут указывать на неэффективное использование памяти или утечки."></i></span><span class="server-metric-value" id="srv-gc">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-thermometer-half"></i> CPU макс <i class="bi bi-question-circle-fill server-help" data-help="Максимальная температура CPU."></i></span><span class="server-metric-value" id="srv-tcpu">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-thermometer"></i> GPU макс <i class="bi bi-question-circle-fill server-help" data-help="Максимальная температура GPU."></i></span><span class="server-metric-value" id="srv-tgpu">-</span></div>
          </div>
        </div>

        <div class="server-group" data-key="system">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-info-circle"></i> Инфо о системе</span></div>
          <div class="server-group-body">
            <div class="server-metric">
              <span class="server-metric-label"><i class="bi bi-clock-history"></i> Uptime системы <i class="bi bi-question-circle-fill server-help" data-help="Время непрерывной работы операционной системы с момента последней загрузки."></i></span>
              <span class="server-metric-value" id="srv-sys-uptime">-</span>
            </div>
            <div class="server-metric">
              <span class="server-metric-label"><i class="bi bi-windows"></i> ОС <i class="bi bi-question-circle-fill server-help" data-help="Название и версия операционной системы."></i></span>
              <span class="server-metric-value" id="srv-sys-os">-</span>
            </div>
            <div class="server-metric">
              <span class="server-metric-label"><i class="bi bi-cpu"></i> Процессор <i class="bi bi-question-circle-fill server-help" data-help="Модель центрального процессора."></i></span>
              <span class="server-metric-value" id="srv-sys-cpu">-</span>
            </div>
            <div class="server-metric">
              <span class="server-metric-label"><i class="bi bi-motherboard"></i> Мат. плата <i class="bi bi-question-circle-fill server-help" data-help="Производитель и модель материнской платы."></i></span>
              <span class="server-metric-value" id="srv-sys-board">-</span>
            </div>
            <div class="server-metric">
              <span class="server-metric-label"><i class="bi bi-memory"></i> Всего ОЗУ <i class="bi bi-question-circle-fill server-help" data-help="Общий объем оперативной памяти, установленной в системе."></i></span>
              <span class="server-metric-value" id="srv-sys-ram">-</span>
            </div>
          </div>
        </div>
        <div class="server-group" data-key="client">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-window"></i> Клиент</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-boxes"></i> DOM всего <i class="bi bi-question-circle-fill server-help" data-help="Количество DOM-элементов на странице (включая инспектор)."></i></span><span class="server-metric-value" id="cl-dom-total">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-layers"></i> DOM без инспектора <i class="bi bi-question-circle-fill server-help" data-help="DOM-элементы без узлов инспектора (оценочно)."></i></span><span class="server-metric-value" id="cl-dom-app">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-code-slash"></i> Скрипты (JS) <i class="bi bi-question-circle-fill server-help" data-help="Количество подключенных JS-скриптов (script и module)."></i></span><span class="server-metric-value" id="cl-js-count">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-lightning-charge"></i> Загрузка JS суммарно <i class="bi bi-question-circle-fill server-help" data-help="Суммарный размер загруженных JS по Performance API (если доступно)."></i></span><span class="server-metric-value" id="cl-js-bytes">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-pie-chart"></i> Память JS <i class="bi bi-question-circle-fill server-help" data-help="Используемая память JS по Performance.memory (если поддерживается браузером)."></i></span><span class="server-metric-value" id="cl-js-mem">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-recycle"></i> Garbage Collection <i class="bi bi-question-circle-fill server-help" data-help="Сборка мусора JavaScript - автоматическая очистка неиспользуемой памяти. Показывает количество очисток, время последней и объем освобожденной памяти."></i></span><span class="server-metric-value" id="cl-gc">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-diagram-3"></i> Типы GC <i class="bi bi-question-circle-fill server-help" data-help="Minor GC - небольшая очистка памяти (падение на 5-15%): удаление временных объектов, очистка стека. Major GC - глубокая очистка памяти (падение на 15%+): удаление неиспользуемых объектов, дефрагментация памяти. Частые Major GC могут указывать на неэффективное использование памяти."></i></span><span class="server-metric-value" id="cl-gc-types">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-clock-history"></i> DOMContentLoaded <i class="bi bi-question-circle-fill server-help" data-help="Время DOMContentLoaded по PerformanceTiming."></i></span><span class="server-metric-value" id="cl-dcl">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-stopwatch"></i> Load Event <i class="bi bi-question-circle-fill server-help" data-help="Время полной загрузки страницы по PerformanceTiming."></i></span><span class="server-metric-value" id="cl-load">-</span></div>
          </div>
        </div>

      <div id="server-settings-drawer">
        <div class="srv-drawer-header">
          <div class="srv-drawer-title">Настройки</div>
          <button class="srv-btn" id="srv-settings-close"><i class="bi bi-x-lg"></i> Закрыть</button>
        </div>
        <div class="srv-drawer-body">
          
          <div class="srv-setting-group" data-key="notifications">
            <div class="srv-setting-group-title">
              <span class="left">
                <i class="bi bi-bell-fill"></i>
                <span>Уведомления</span>
                <i class="bi bi-question-circle-fill server-help" data-help="Настройте пороги и частоту всплывающих уведомлений о состоянии сервера."></i>
              </span>
              <i class="bi bi-caret-down-fill caret"></i>
            </div>
            <div class="srv-setting-group-body">
          <label class="srv-setting-item"><input type="checkbox" id="srv-toasts-enabled"> Показывать тосты <i class="bi bi-question-circle-fill server-help" data-help="Включает всплывающие сообщения (toast) от инспектора: предупреждения и ошибки о нагрузке CPU/памяти и температурах. Отключение скрывает любые всплывающие уведомления."></i></label>
          <label class="srv-setting-item"><input type="checkbox" id="srv-only-critical"> Только критичные <i class="bi bi-question-circle-fill server-help" data-help="Показывать только критичные уведомления (красные). Предупреждения (оранжевые) скрываются. Полезно для тихого режима, когда нужны только важные сигналы."></i></label>
          <div class="srv-grid">
                <div>Отключить все сообщения</div>
                <label class="srv-setting-item"><input type="checkbox" id="srv-disable-all"> Выключить уведомления <i class="bi bi-question-circle-fill server-help" data-help="Полностью блокирует уведомления инспектора. Никакие тосты (включая критичные) не будут показываться. Все остальные настройки уведомлений временно отключаются."></i></label>
                <div>Интервал уведомлений</div>
                <div class="srv-input-with-unit">
                  <input class="srv-input" type="number" id="srv-notify-interval" min="0" max="360">
                  <span>сек</span>
                </div>
            <div>CPU предупреждение %</div><input class="srv-input" type="number" id="srv-cpu-warn" min="1" max="100">
            <div>CPU критично %</div><input class="srv-input" type="number" id="srv-cpu-crit" min="1" max="100">
            <div>Память предупреждение %</div><input class="srv-input" type="number" id="srv-mem-warn" min="1" max="100">
            <div>Память критично %</div><input class="srv-input" type="number" id="srv-mem-crit" min="1" max="100">
            <div>CPU t° предупреждение</div><input class="srv-input" type="number" id="srv-tcpu-warn" min="25" max="120">
            <div>CPU t° критично</div><input class="srv-input" type="number" id="srv-tcpu-crit" min="25" max="120">
            <div>GPU t° предупреждение</div><input class="srv-input" type="number" id="srv-tgpu-warn" min="25" max="120">
            <div>GPU t° критично</div><input class="srv-input" type="number" id="srv-tgpu-crit" min="25" max="120">
          </div>
            </div>
          </div>

          <div class="srv-setting-group" data-key="appearance">
            <div class="srv-setting-group-title">
              <span class="left">
                <i class="bi bi-palette-fill"></i>
                <span>Внешний вид</span>
                <i class="bi bi-question-circle-fill server-help" data-help="Настройте, какие секции мониторинга будут отображаться в основной панели."></i>
              </span>
              <i class="bi bi-caret-down-fill caret"></i>
            </div>
            <div class="srv-setting-group-body">
              <div class="srv-grid" style="grid-template-columns: 1fr;">
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="metrics"> Секция "Метрики"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="disk"> Секция "Диск I/O"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="queues"> Секция "Очереди / Воркеры"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="db"> Секция "База данных"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="runtime"> Секция "Память / GC / Темп"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="system"> Секция "Инфо о системе"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="ws"> Секция "WebSocket"</label>
                <label class="srv-setting-item"><input type="checkbox" class="srv-view-toggle" data-key="client"> Секция "Клиент"</label>
              </div>
            </div>
          </div>

        </div>
      </div>

        <div class="server-group" data-key="ws">
          <div class="server-group-title"><i class="bi bi-caret-down-fill caret"></i><span class="server-section-title"><i class="bi bi-wifi"></i> WebSocket</span></div>
          <div class="server-group-body">
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-arrow-up-right-square"></i> Отправлено <i class="bi bi-question-circle-fill server-help" data-help="Сколько сообщений отправлено сервером с момента запуска."></i></span><span class="server-metric-value" id="srv-ws-sent">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-arrow-down-left-square"></i> Получено <i class="bi bi-question-circle-fill server-help" data-help="Сколько сообщений принято сервером."></i></span><span class="server-metric-value" id="srv-ws-recv">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-arrows-expand"></i> Средний размер <i class="bi bi-question-circle-fill server-help" data-help="Средний размер сообщений по сети (в байтах)."></i></span><span class="server-metric-value" id="srv-ws-avgsize">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-braces"></i> Средняя длина <i class="bi bi-question-circle-fill server-help" data-help="Среднее число символов в WS‑сообщениях. Индикатор: зелёный < 1200, оранжевый < 4000, красный ≥ 4000."></i></span><span class="server-metric-value" id="srv-ws-avglength">-</span></div>
          </div>
        </div>
      </div>
      <div id="server-inspector-footer">
        <span class="srv-interval-label" style="color:#ccc;">Интервал:</span>
        <select id="srv-interval">
          <option value="10000">10с</option>
          <option value="15000">15с</option>
          <option value="20000">20с</option>
          <option value="30000">30с</option>
          <option value="45000">45с</option>
          <option value="60000">60с</option>
        </select>
        <label style="margin-left:8px; display:flex; align-items:center; gap:6px; color:#ccc;">
          <input type="checkbox" id="srv-realtime"> Реал‑тайм <i class="bi bi-question-circle-fill server-help" data-help="Зависит от настроек WS‑сервера. В моем случае, примерно от 2 до 5 сек."></i>
        </label>
      </div>
    `;
    document.body.appendChild(panel);
    this.root = panel;

    // Cache elements
    this.els = {
      cpu: panel.querySelector('#srv-cpu'),
      mem: panel.querySelector('#srv-mem'),
      threads: panel.querySelector('#srv-threads'),
      conns: panel.querySelector('#srv-conns'),
      uptime: panel.querySelector('#srv-uptime'),
      diskBusy: panel.querySelector('#srv-disk-busy'),
      diskRBytes: panel.querySelector('#srv-disk-rbytes'),
      diskWBytes: panel.querySelector('#srv-disk-wbytes'),
      qLen: panel.querySelector('#srv-q-len'),
      qLag: panel.querySelector('#srv-q-lag'),
      workers: panel.querySelector('#srv-workers'),
      workersActiveNames: panel.querySelector('#srv-workers-active-names'),
      workersLag: panel.querySelector('#srv-workers-lag'),
      dbSize: panel.querySelector('#srv-db-size'),
      dbRecs: panel.querySelector('#srv-db-recs'),
      dbAvg: panel.querySelector('#srv-db-avgq'),
      dbSlow: panel.querySelector('#srv-db-slow'),
      dbLocks: panel.querySelector('#srv-db-locks'),
      dbLastTx: panel.querySelector('#srv-db-lasttx'),
      dbLastIns: panel.querySelector('#srv-db-lastins'),
      dbLastLock: panel.querySelector('#srv-db-lastlock'),
      rss: panel.querySelector('#srv-rss'),
      gc: panel.querySelector('#srv-gc'),
      tCpu: panel.querySelector('#srv-tcpu'),
      tGpu: panel.querySelector('#srv-tgpu'),
      wsSent: panel.querySelector('#srv-ws-sent'),
      wsRecv: panel.querySelector('#srv-ws-recv'),
      wsAvgSize: panel.querySelector('#srv-ws-avgsize'),
      wsAvgLen: panel.querySelector('#srv-ws-avglength'),

      sysUptime: panel.querySelector('#srv-sys-uptime'),
      sysOs: panel.querySelector('#srv-sys-os'),
      sysCpu: panel.querySelector('#srv-sys-cpu'),
      sysBoard: panel.querySelector('#srv-sys-board'),
      sysRam: panel.querySelector('#srv-sys-ram'),

      intervalSel: panel.querySelector('#srv-interval'),
      realtimeChk: panel.querySelector('#srv-realtime'),
      closeBtn: panel.querySelector('#srv-close-btn'),
      componentsBar: panel.querySelector('#srv-components-bar'),
      clDomTotal: panel.querySelector('#cl-dom-total'),
      clDomApp: panel.querySelector('#cl-dom-app'),
      clJsCount: panel.querySelector('#cl-js-count'),
              clJsBytes: panel.querySelector('#cl-js-bytes'),
              clDcl: panel.querySelector('#cl-dcl'),
      clLoad: panel.querySelector('#cl-load'),
      clJsMem: panel.querySelector('#cl-js-mem'),
      clGc: panel.querySelector('#cl-gc'),
      clGcTypes: panel.querySelector('#cl-gc-types')
    };
    if (this.els.intervalSel) {
      this.els.intervalSel.value = String(this.checkInterval);
      this.els.intervalSel.addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isFinite(v)) return;
        this.checkInterval = v;
        this._saveInterval(v);
        if (!this.disableAllNotifications) {
          showInfo(`Интервал сервера: ${Math.round(v/1000)}с`);
        }
        this._restartPolling();
      });
    }
    if (this.els.realtimeChk) {
      this.els.realtimeChk.checked = !!this.realtimeEnabled;
      if (this.els.intervalSel) this.els.intervalSel.disabled = !!this.realtimeEnabled;
      this.root.querySelector('.srv-interval-label').classList.toggle('disabled', !!this.realtimeEnabled);
      this.els.realtimeChk.addEventListener('change', (e) => {
        this.realtimeEnabled = !!e.target.checked;
        this._saveRealtime(this.realtimeEnabled);
        if (this.els.intervalSel) this.els.intervalSel.disabled = this.realtimeEnabled;
        this.root.querySelector('.srv-interval-label').classList.toggle('disabled', this.realtimeEnabled);
        if (this.realtimeEnabled) {
          if (!this.disableAllNotifications) {
            showInfo('Сервер: реал‑тайм включен');
          }
          this._stopPolling();
          this._startRealtimeFallback();
        } else {
          if (!this.disableAllNotifications) {
            showInfo('Сервер: реал‑тайм отключен');
          }
          this._stopRealtimeFallback();
          this._restartPolling();
        }
      });
    }
    if (this.els.closeBtn) {
      this.els.closeBtn.addEventListener('click', () => this.hide());
    }
    // Инициализируем тултипы
    try { initTooltips(); panel.querySelectorAll('.server-help').forEach((el) => attachHelpTooltip(el, el.getAttribute('data-help') || '')); } catch(_) {}
    // Аккордеоны групп
    this._bindAccordions();
    // Привязываем настройки после создания панели
    this._bindSettingsPanel();
    // Привязываем настройки вида
    this._bindViewSettings();
    this._startClientMetricsRealtime();
    this._updateClientMetrics();
  }

  _bindKeydown() {
    if (this._keydownBound) return;
    this._keydownBound = true;
    document.addEventListener('keydown', (e) => {
      const isCtrlQ = (e.ctrlKey && (e.key === 'q' || e.key === 'Q' || e.keyCode === 81));
      if (isCtrlQ) {
        this.toggle();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  _bindSocket() {
    const wait = () => {
      if (window.socket) {
        // Listeners
        this._onServerInfo = (payload) => this._handleServerInfo(payload);
        window.socket.on('server_info', this._onServerInfo);

        this._onConnect = () => { this._requestOnce(); this.realtimeEnabled ? (this._startRealtimeFallback()) : (this._restartPolling()); this._stopHttpFallback(); };
        this._onDisconnect = () => { this._stopPolling(); this._stopRealtimeFallback(); this._startHttpFallback(); };
        window.socket.on('connect', this._onConnect);
        window.socket.on('disconnect', this._onDisconnect);

        if (window.socket.connected) { this._requestOnce(); this.realtimeEnabled ? this._startRealtimeFallback() : this._restartPolling(); } else { this._startHttpFallback(); }
      } else {
        setTimeout(wait, 300);
      }
    };
    wait();
  }

  _bindSettingsPanel() {
    const drawer = () => document.getElementById('server-settings-drawer');
    const btn = () => document.getElementById('srv-settings-btn');
    const btnClose = () => document.getElementById('srv-settings-close');

    const close = () => { const d = drawer(); if (d) d.classList.remove('open'); };
    const toggle = () => { const d = drawer(); if (d) d.classList.toggle('open'); };
    
    this._closeSettingsDrawer = close;

    // --- Accordions ---
    const stateKey = 'srv_settings_groups';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(stateKey) || '{}'); } catch(_) {}
    const groups = this.root.querySelectorAll('#server-settings-drawer .srv-setting-group');
    groups.forEach(g => {
      const key = g.getAttribute('data-key') || '';
      // По умолчанию свёрнуто; если в saved true — раскрываем
      if (saved[key] !== true) g.classList.add('collapsed');
      const title = g.querySelector('.srv-setting-group-title');
      title && title.addEventListener('click', () => {
        g.classList.toggle('collapsed');
        try {
          const cur = JSON.parse(localStorage.getItem(stateKey) || '{}');
          cur[key] = !g.classList.contains('collapsed');
          localStorage.setItem(stateKey, JSON.stringify(cur));
        } catch(_) {}
      });
    });

    const syncInputs = () => {
      const set = (id, val, isBool=false) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isBool) el.checked = !!val; else el.value = String(val);
      };
      set('srv-disable-all', this.disableAllNotifications, true);
      set('srv-toasts-enabled', this.toastsEnabled, true);
      set('srv-only-critical', this._loadSetting('onlyCritical', false), true);
      set('srv-cpu-warn', this.cpuWarn); set('srv-cpu-crit', this.cpuCrit);
      set('srv-mem-warn', this.memWarn); set('srv-mem-crit', this.memCrit);
      set('srv-tcpu-warn', this.tempCpuWarn); set('srv-tcpu-crit', this.tempCpuCrit);
      set('srv-tgpu-warn', this.tempGpuWarn); set('srv-tgpu-crit', this.tempGpuCrit);
      set('srv-notify-interval', this.notifyInterval / 1000);
    };

    const bindChange = (id, key, isBool=false) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        let v = isBool ? !!el.checked : Number(el.value);
        if (!isBool && !Number.isFinite(v)) return;
        this._saveSetting(key, v);
        this[key] = v;
      });
    };

    // Элементы гарантированно существуют, т.к. вызов идет из _buildPanel
    syncInputs();
    bindChange('srv-toasts-enabled', 'toastsEnabled', true);
    bindChange('srv-cpu-warn', 'cpuWarn'); bindChange('srv-cpu-crit', 'cpuCrit');
    const onlyCritChk = document.getElementById('srv-only-critical');
    if (onlyCritChk) {
      onlyCritChk.addEventListener('change', () => {
        const v = !!onlyCritChk.checked;
        this._saveSetting('onlyCritical', v);
        this.onlyCritical = v;
      });
    }
    // Disable All toggle
    const disableAllChk = document.getElementById('srv-disable-all');
    const blockIds = ['srv-toasts-enabled','srv-notify-interval','srv-cpu-warn','srv-cpu-crit','srv-mem-warn','srv-mem-crit','srv-tcpu-warn','srv-tcpu-crit','srv-tgpu-warn','srv-tgpu-crit'];
    const applyDisableAll = () => {
      const off = !!this.disableAllNotifications;
      blockIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = off;
        if (el && el.closest('.srv-setting-item')) el.closest('.srv-setting-item').classList.toggle('disabled', off);
      });
      const grid = (disableAllChk && disableAllChk.closest('.srv-grid'));
      if (grid) grid.classList.toggle('disabled', off);
    };
    if (disableAllChk) {
      disableAllChk.addEventListener('change', () => {
        this.disableAllNotifications = !!disableAllChk.checked;
        this._saveSetting('disableAll', this.disableAllNotifications);
        applyDisableAll();
      });
    }
    applyDisableAll();
    bindChange('srv-mem-warn', 'memWarn'); bindChange('srv-mem-crit', 'memCrit');
    bindChange('srv-tcpu-warn', 'tempCpuWarn'); bindChange('srv-tcpu-crit', 'tempCpuCrit');
    bindChange('srv-tgpu-warn', 'tempGpuWarn'); bindChange('srv-tgpu-crit', 'tempGpuCrit');
    
    // Custom handler for notify interval
    const notifyIntervalInput = document.getElementById('srv-notify-interval');
    if (notifyIntervalInput) {
      notifyIntervalInput.addEventListener('change', () => {
        let v_secs = Number(notifyIntervalInput.value);
        if (!Number.isFinite(v_secs)) return;

        // Clamp to range 0, or 5-360
        if (v_secs > 0 && v_secs < 5) v_secs = 5;
        v_secs = Math.max(0, Math.min(360, v_secs));
        
        notifyIntervalInput.value = String(v_secs); // Update UI if clamped
        
        const v_ms = v_secs * 1000;
        this._saveSetting('notifyInterval', v_ms);
        this.notifyInterval = v_ms;
      });
    }

    // Clamp and cross-validate numeric ranges for % (1..100) and °C (25..120)
    const clampNumber = (id, min, max) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        let v = Number(el.value);
        if (!Number.isFinite(v)) return;
        v = Math.max(min, Math.min(max, v));
        el.value = String(v);
        this._saveSetting(el.id.replace('srv-',''), v);
        this[el.id.replace('srv-','')] = v;
      });
    };
    ['srv-cpu-warn','srv-cpu-crit','srv-mem-warn','srv-mem-crit'].forEach(id => clampNumber(id, 1, 100));
    ['srv-tcpu-warn','srv-tcpu-crit','srv-tgpu-warn','srv-tgpu-crit'].forEach(id => clampNumber(id, 25, 120));

    btn() && btn().addEventListener('click', toggle);
    btnClose() && btnClose().addEventListener('click', close);
  }

  _unbindSocket() {
    try {
      const s = window.socket;
      if (!s || typeof s.off !== 'function') return;
      if (this._onServerInfo) s.off('server_info', this._onServerInfo);
      if (this._onConnect) s.off('connect', this._onConnect);
      if (this._onDisconnect) s.off('disconnect', this._onDisconnect);
    } catch(_) {}
  }

  _requestOnce() {
    try { if (window.socket && window.socket.connected) window.socket.emit('request_server_info'); } catch(_) {}
  }

  _restartPolling() {
    this._stopPolling();
    if (this.realtimeEnabled) return;
    if (window.socket && window.socket.connected) this.intervalId = setInterval(() => this._requestOnce(), this.checkInterval);
  }
  _stopPolling() { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } }
  _startRealtimeFallback() {
    this._stopRealtimeFallback();
    // Если долго нет данных — подёргиваем разово
    this._realtimeFallbackTimer = setInterval(() => {
      const now = Date.now();
      if (now - this._lastServerInfoTs > 5000) this._requestOnce();
    }, 2000);
  }
  _stopRealtimeFallback() { if (this._realtimeFallbackTimer) { clearInterval(this._realtimeFallbackTimer); this._realtimeFallbackTimer = null; } }

  // HTTP fallback when WS недоступен
  _startHttpFallback() {
    if (this._httpPollId) return;
    this._fetchHealthOnce();
    this._httpPollId = setInterval(() => this._fetchHealthOnce(), Math.max(10000, this.checkInterval));
  }
  _stopHttpFallback() { if (this._httpPollId) { clearInterval(this._httpPollId); this._httpPollId = null; } }

  async _fetchHealthOnce() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.components) {
        this._renderComponents(data.components);
      }
    } catch(_) {}
  }

  toggle() {
    if (!this.isInitialized) this.init();
    this.isVisible ? this.hide() : this.show();
  }

  show() {
    // "Ленивое" создание панели и ее элементов при первом показе
    if (!this.root) {
      this._buildPanel();
    }
    
    // Привязываем сокеты только при показе
    this._bindSocket();

    this._applyHeaderOffset();
    this.root.classList.add('open');
    this.isVisible = true;
    this._startSkeleton();
    this._applyViewSettings(); // Применяем видимость секций
    if (!this._resizeHandler) { this._resizeHandler = () => this._applyHeaderOffset(); window.addEventListener('resize', this._resizeHandler); }
    this._requestOnce();
  }

  hide() {
    // Гарантированно закрываем панель настроек
    if (this._closeSettingsDrawer) {
      this._closeSettingsDrawer();
    }
    
    if (this.root) this.root.classList.remove('open');
    this.isVisible = false;
    this._stopRealtimeFallback();
    this._stopPolling();
    this._stopHttpFallback();
    this._unbindSocket();

    // Полностью удаляем панель из DOM при закрытии
    try { if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root); } catch(_) {}
    this.root = null; this.els = null;
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    
    // Очищаем GC таймер
    try { 
      if (this._gcDetectionTimer) { 
        clearInterval(this._gcDetectionTimer); 
        this._gcDetectionTimer = null; 
      } 
    } catch(_) {}
  }

  _applyViewSettings() {
    if (!this.root) return;
    const keys = ['metrics', 'disk', 'queues', 'db', 'runtime', 'system', 'ws', 'client'];
    keys.forEach(key => {
      const section = this.root.querySelector(`.server-group[data-key="${key}"]`);
      if (section) {
        const isVisible = this._viewSettings[key] !== false; // По умолчанию все видно
        section.classList.toggle('hidden-by-settings', !isVisible);
      }
    });
  }

  _bindViewSettings() {
    const toggles = this.root.querySelectorAll('.srv-view-toggle');
    // Синхронизация чекбоксов с настройками
    toggles.forEach(chk => {
      const key = chk.getAttribute('data-key');
      if (key) {
        chk.checked = this._viewSettings[key] !== false;
      }
    });
    // Обработчики
    toggles.forEach(chk => {
      chk.addEventListener('change', () => {
        const key = chk.getAttribute('data-key');
        if (key) {
          this._viewSettings[key] = chk.checked;
          this._saveSetting('viewSettings', this._viewSettings);
          this._applyViewSettings();
        }
      });
    });
  }

  _applyHeaderOffset() {
    try {
      const header = document.querySelector('.header');
      const h = header ? header.offsetHeight : 0;
      const top = Math.max(0, h + 20);
      const height = `calc(100vh - ${h + 40}px)`;
      if (this.root) { this.root.style.top = `${top}px`; this.root.style.height = height; }
    } catch(_) {}
  }

  _bindAccordions() {
    const stateKey = 'srv_group_states';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(stateKey) || '{}'); } catch(_) {}
    const groups = this.root.querySelectorAll('.server-group');
    groups.forEach(g => {
      const key = g.getAttribute('data-key') || '';
      if (saved[key] === false) g.classList.add('collapsed');
      const title = g.querySelector('.server-group-title');
      title && title.addEventListener('click', () => {
        g.classList.toggle('collapsed');
        try {
          const cur = JSON.parse(localStorage.getItem(stateKey) || '{}');
          cur[key] = !g.classList.contains('collapsed');
          localStorage.setItem(stateKey, JSON.stringify(cur));
        } catch(_) {}
      });
    });
  }

  _startSkeleton() {
    this._skeletonUntil = Date.now() + 2000;
    if (!this.root) return;
    this.root.querySelectorAll('.server-metric-value').forEach(el => { el.classList.add('srv-skel'); el.textContent = ''; });
    if (this._skeletonTimer) clearTimeout(this._skeletonTimer);
    // Unified skeleton for components bar
    try {
      if (this.els && this.els.componentsBar) {
        // Очищаем панель компонентов через removeChild
        while (this.els.componentsBar.firstChild) {
          this.els.componentsBar.removeChild(this.els.componentsBar.firstChild);
        }
        const sk = document.createElement('div');
        sk.className = 'srv-comps-skel';
        this.els.componentsBar.appendChild(sk);
      }
    } catch(_) {}
    this._skeletonTimer = setTimeout(() => this._endSkeleton(), 2100);
  }
  _endSkeleton() {
    if (!this.root) return;
    this.root.querySelectorAll('.server-metric-value').forEach(el => el.classList.remove('srv-skel'));
    // Remove components skeleton
    try {
      if (this.els && this.els.componentsBar) {
        // Очищаем панель компонентов через removeChild
        while (this.els.componentsBar.firstChild) {
          this.els.componentsBar.removeChild(this.els.componentsBar.firstChild);
        }
      }
    } catch(_) {}
    if (this._lastData) this._updateUI(this._lastData);
  }

  _handleServerInfo(info) {
    this._lastServerInfoTs = Date.now();
    const data = {
      ts: Date.now(),
      cpu_percent: info?.cpu_percent || 0,
      memory_mb: info?.memory_mb || 0,
      memory_percent: info?.memory_percent || 0,
      num_threads: info?.num_threads || 0,
      connections: info?.connections || 0,
      uptime: info?.uptime || '0с',
      disk: info?.disk || null, // { busy_percent, read_bytes_sec, write_bytes_sec }
      queues: info?.queues || null, // { length, lag_ms, workers_active, workers_total }
      database: info?.database || null,
      websocket: info?.websocket || null,
      gc: info?.gc || null,
      temps: info?.temps || null,
      system_info: info?.system_info || null,
      components: info?.components || null,

    };

    // сохраняем историю для расчёта GC/мин
    this.serverHistory.push(data);
    if (this.serverHistory.length > this.maxHistoryLength) this.serverHistory.shift();

    this._lastData = data;
    if (Date.now() >= this._skeletonUntil) this._updateUI(data);
    this._maybeNotify(data);
  }

  _updateUI(d) {
    if (!this.els) return;

    // Сохраняем последние данные для health checks
    localStorage.setItem('lastServerDataTime', Date.now().toString());

    // Затем все остальные метрики
    const colorBy = (val) => val >= this.cpuCrit ? '#f44336' : (val >= this.cpuWarn ? '#ff9800' : '#6bcf7f');
    if (this.els.cpu) this.els.cpu.style.color = colorBy(d.cpu_percent), this.els.cpu.textContent = `${d.cpu_percent}%`;
    if (this.els.mem) this.els.mem.style.color = colorBy(d.memory_percent), this.els.mem.textContent = `${d.memory_mb} МБ (${d.memory_percent}%)`;
    if (this.els.threads) this.els.threads.textContent = `${d.num_threads}`;
    if (this.els.conns) this.els.conns.textContent = `${d.connections}`;
    if (this.els.uptime) this.els.uptime.textContent = `${d.uptime}`;

    // Disk
    if (this.els.diskBusy) {
      let busy = d.disk?.busy_percent;
      if (busy == null) {
        const sumBps = (d.disk?.read_bytes_sec || 0) + (d.disk?.write_bytes_sec || 0);
        const baseline = 100 * 1024 * 1024; // 100 МБ/с условная полка
        busy = Math.min(100, Math.round((sumBps / baseline) * 100));
      }
      if (busy != null) {
        const level = busy < 60 ? 'ok' : (busy < 85 ? 'warn' : 'crit');
        this._setIconValue(this.els.diskBusy, level, `${busy}%`);
      } else {
        this.els.diskBusy.textContent = '-';
      }
    }
    if (this.els.diskRBytes) {
      const v = d.disk?.read_bytes_sec;
      if (v != null) this._setIconValue(this.els.diskRBytes, v < 50*1024*1024 ? 'ok' : (v < 150*1024*1024 ? 'warn' : 'crit'), `${this._formatBytes(v)}/с`);
      else this.els.diskRBytes.textContent = '-';
    }
    if (this.els.diskWBytes) {
      const v = d.disk?.write_bytes_sec;
      if (v != null) this._setIconValue(this.els.diskWBytes, v < 50*1024*1024 ? 'ok' : (v < 150*1024*1024 ? 'warn' : 'crit'), `${this._formatBytes(v)}/с`);
      else this.els.diskWBytes.textContent = '-';
    }

    // Queues / Workers
    if (this.els.qLen) {
      const q = d.queues?.length;
      if (q != null) this._setIconValue(this.els.qLen, q === 0 ? 'ok' : (q < 10 ? 'warn' : 'crit'), `${q}`);
      else this.els.qLen.textContent = '-';
    }
    if (this.els.qLag) {
      const lag = d.queues?.lag_ms;
      if (lag != null) this._setIconValue(this.els.qLag, lag < 2000 ? 'ok' : (lag < 10000 ? 'warn' : 'crit'), `${this._formatMs(lag)}`);
      else this.els.qLag.textContent = '-';
    }
    if (this.els.workers) {
      const a = d.queues?.workers_active, t = d.queues?.workers_total;
      if (a != null && t != null) {
        const level = a === t ? 'ok' : 'crit';
        this._setIconValue(this.els.workers, level, `${a} / ${t}`);
      } else {
        this.els.workers.textContent = '-';
      }
    }
    if (this.els.workersActiveNames) {
        const names = d.queues?.active_worker_names;
        if (names && Array.isArray(names) && names.length > 0) {
            const level = 'ok';
            this._setIconValue(this.els.workersActiveNames, level, names.join(', '));
        } else {
            this.els.workersActiveNames.textContent = '-';
        }
    }
    if (this.els.workersLag) {
      const wlag = d.queues?.workers_lag_ms;
      if (wlag != null) this.els.workersLag.textContent = `${this._formatMs(wlag)}`;
      else this.els.workersLag.textContent = '-';
    }

    if (this.els.dbSize) this.els.dbSize.textContent = d.database?.db_size_mb != null ? `${d.database.db_size_mb} МБ` : '-';
    if (this.els.dbRecs) this.els.dbRecs.textContent = d.database?.total_records != null ? `${d.database.total_records}` : '-';
    if (this.els.dbAvg) {
      const ms = d.database?.avg_query_time_ms;
      if (ms != null) this._setIconValue(this.els.dbAvg, ms < 10 ? 'ok' : (ms < 40 ? 'warn' : 'crit'), `${this._formatMs(ms)}`);
      else this.els.dbAvg.textContent = '-';
    }
    if (this.els.dbSlow) {
      const slow = d.database?.slow_queries_1m;
      if (slow != null) this._setIconValue(this.els.dbSlow, slow === 0 ? 'ok' : (slow < 5 ? 'warn' : 'crit'), `${slow}`);
      else this.els.dbSlow.textContent = '-';
    }
    if (this.els.dbLocks) {
      const locks = d.database?.locks;
      if (locks != null) this._setIconValue(this.els.dbLocks, locks === 0 ? 'ok' : 'crit', `${locks}`);
      else this.els.dbLocks.textContent = '-';
    }
    // DB pulse
    const nowSec = Math.floor(Date.now()/1000);
    const fmtAgo = (ts) => {
      if (!Number.isFinite(ts) || ts <= 0) return '-';
      const ago = Math.max(0, nowSec - Math.floor(ts));
      if (ago < 60) return `${ago}с назад`;
      const m = Math.floor(ago/60);
      return `${m}м назад`;
    };
    if (this.els.dbLastTx) this.els.dbLastTx.textContent = fmtAgo(d.database?.last_tx_time ?? 0);
    if (this.els.dbLastIns) this.els.dbLastIns.textContent = fmtAgo(d.database?.last_insert_time ?? 0);
    if (this.els.dbLastLock) this.els.dbLastLock.textContent = fmtAgo(d.database?.last_lock_time ?? 0);

    // Runtime/GC/Temps
    if (this.els.rss) this.els.rss.textContent = (d.gc?.rss_mb != null) ? `${d.gc.rss_mb} МБ` : '-';
    // GC/мин: считаем по двум последним точкам истории
    if (this.els.gc) {
      let gcPerMin = null;
      try {
        const hist = this.serverHistory;
        if (hist && hist.length >= 2) {
          const last = hist[hist.length - 1];
          const prev = hist[hist.length - 2];
          const cLast = last?.gc?.collections_total;
          const cPrev = prev?.gc?.collections_total;
          const tLast = last?.ts;
          const tPrev = prev?.ts;
          if (Number.isFinite(cLast) && Number.isFinite(cPrev) && Number.isFinite(tLast) && Number.isFinite(tPrev) && tLast > tPrev) {
            const dCount = Math.max(0, cLast - cPrev);
            const dMin = (tLast - tPrev) / 60000;
            if (dMin > 0) gcPerMin = (dCount / dMin);
          }
        }
      } catch(_) {}
      
      if (gcPerMin != null) {
        const level = gcPerMin < 10 ? 'ok' : (gcPerMin < 60 ? 'warn' : 'crit');
        this._setIconValue(this.els.gc, level, gcPerMin.toFixed(1));
      } else {
        this.els.gc.textContent = '-';
      }
    }
    if (this.els.tCpu) {
        if (d.temps?.cpu_max != null) {
            const tCpu = d.temps.cpu_max;
            const level = tCpu < this.tempCpuWarn ? 'ok' : (tCpu < this.tempCpuCrit ? 'warn' : 'crit');
            this._setIconValue(this.els.tCpu, level, `${Math.round(tCpu)}°C`);
        } else {
            this.els.tCpu.textContent = '-';
        }
    }
    if (this.els.tGpu) {
        if (d.temps?.gpu_max != null) {
            const tGpu = d.temps.gpu_max;
            const level = tGpu < this.tempGpuWarn ? 'ok' : (tGpu < this.tempGpuCrit ? 'warn' : 'crit');
            this._setIconValue(this.els.tGpu, level, `${Math.round(tGpu)}°C`);
        } else {
            this.els.tGpu.textContent = '-';
        }
    }

    if (this.els.wsSent) this.els.wsSent.textContent = d.websocket?.messages_sent != null ? `${d.websocket.messages_sent}` : '-';
    if (this.els.wsRecv) this.els.wsRecv.textContent = d.websocket?.messages_received != null ? `${d.websocket.messages_received}` : '-';
    if (this.els.wsAvgSize) {
      const s = d.websocket?.average_message_size;
      if (s != null) this._setIconValue(this.els.wsAvgSize, s < 8*1024 ? 'ok' : (s < 64*1024 ? 'warn' : 'crit'), `${this._formatBytes(s)}`);
      else this.els.wsAvgSize.textContent = '-';
    }
    if (this.els.wsAvgLen) {
      const l = d.websocket?.average_message_length;
      if (l != null) this._setIconValue(this.els.wsAvgLen, l < 1200 ? 'ok' : (l < 4000 ? 'warn' : 'crit'), `${l} симв.`);
      else this.els.wsAvgLen.textContent = '-';
    }

    // Components compact bar via helper
    try {
      if (d.components) this._renderComponents(d.components);
      else if (this.els.componentsBar) { 
        // Очищаем панель компонентов через removeChild
        while (this.els.componentsBar.firstChild) {
          this.els.componentsBar.removeChild(this.els.componentsBar.firstChild);
        }
        const sk = document.createElement('div');
        sk.className = 'srv-comps-skel';
        this.els.componentsBar.appendChild(sk);
      }
    } catch(_) {}

    // Update header with computer name if present
    try {
      const title = this.root?.querySelector('#server-inspector-title');
      const name = (window && window.computerName) ? String(window.computerName) : '';
      if (title) title.textContent = name ? `Сервер — ${name}` : 'Сервер';
    } catch(_) {}

    // System Info
    if (this.els.sysUptime) {
      const up = d.system_info?.uptime_s;
      this.els.sysUptime.textContent = (up != null) ? this._formatDuration(up) : '-';
      this.els.sysUptime.title = (up != null) ? `Загружен: ${new Date(Date.now() - up * 1000).toLocaleString()}` : '';
    }
    if (this.els.sysOs) { this.els.sysOs.textContent = d.system_info?.os || '-'; this.els.sysOs.title = d.system_info?.os || ''; }
    if (this.els.sysCpu) { this.els.sysCpu.textContent = d.system_info?.cpu || '-'; this.els.sysCpu.title = d.system_info?.cpu || ''; }
    if (this.els.sysBoard) { this.els.sysBoard.textContent = d.system_info?.board || '-'; this.els.sysBoard.title = d.system_info?.board || ''; }
    if (this.els.sysRam) {
      const ram = d.system_info?.total_ram_gb;
      this.els.sysRam.textContent = (ram != null) ? `${ram.toFixed(1)} ГБ` : '-';
    }
  }



  _maybeNotify(d) {
    try {
      if (!this.toastsEnabled || this.disableAllNotifications) return;
      const now = Date.now();
      const canNotify = (key) => {
        if (this.notifyInterval === 0) return true;
        const last = this._lastNotifyTimes[key] || 0;
        if (now - last > this.notifyInterval) {
          this._lastNotifyTimes[key] = now;
          return true;
        }
        return false;
      };

      const onlyCrit = !!this.onlyCritical;

      if (d.cpu_percent >= this.cpuCrit) {
        if (canNotify('cpuCrit')) showError(`Сервер CPU критично: ${d.cpu_percent}%`);
      } else if (!onlyCrit && d.cpu_percent >= this.cpuWarn) {
        if (canNotify('cpuWarn')) showWarning(`Сервер CPU высоко: ${d.cpu_percent}%`);
      }

      if (d.memory_percent >= this.memCrit) {
        if (canNotify('memCrit')) showError(`Сервер память критично: ${d.memory_percent}%`);
      } else if (!onlyCrit && d.memory_percent >= this.memWarn) {
        if (canNotify('memWarn')) showWarning(`Сервер память высоко: ${d.memory_percent}%`);
      }

      const tCpu = d.temps?.cpu_max;
      if (Number.isFinite(tCpu)) {
        if (tCpu >= this.tempCpuCrit) {
          if (canNotify('tCpuCrit')) showError(`CPU температура критично: ${Math.round(tCpu)}°C`);
        } else if (!onlyCrit && tCpu >= this.tempCpuWarn) {
          if (canNotify('tCpuWarn')) showWarning(`CPU температура высокая: ${Math.round(tCpu)}°C`);
        }
      }
      const tGpu = d.temps?.gpu_max;
      if (Number.isFinite(tGpu)) {
        if (tGpu >= this.tempGpuCrit) {
          if (canNotify('tGpuCrit')) showError(`GPU температура критично: ${Math.round(tGpu)}°C`);
        } else if (!onlyCrit && tGpu >= this.tempGpuWarn) {
          if (canNotify('tGpuWarn')) showWarning(`GPU температура высокая: ${Math.round(tGpu)}°C`);
        }
      }
    } catch(_) {}
  }

  // --- Helpers for colored status icons ---
  _statusIcon(level) {
    if (level === 'ok') return { cls: 'status-ok', icon: 'bi-check-circle-fill' };
    if (level === 'warn') return { cls: 'status-warn', icon: 'bi-exclamation-triangle-fill' };
    return { cls: 'status-crit', icon: 'bi-x-circle-fill' };
  }
  _setIconValue(el, level, text) {
    if (!el) return;
    const s = this._statusIcon(level);
    
    // Создаем элементы через createElement вместо innerHTML
    el.innerHTML = '';
    
    const container = document.createElement('span');
    container.className = 'metric-with-icon';
    
    const icon = document.createElement('i');
    icon.className = `bi ${s.icon} ${s.cls}`;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    
    container.appendChild(icon);
    container.appendChild(textSpan);
    el.appendChild(container);
    
    // Подсказки для полей WS
    if (el.id === 'srv-ws-avgsize') el.title = 'Средний размер сообщения. Зелёный — нормально, оранжевый — заметно, красный — крупные пакеты.';
    if (el.id === 'srv-ws-avglength') el.title = 'Средняя длина текстового сообщения. Иконка загорается при больших значениях: проверьте избыточные поля или частоту отправки.';
  }

  _formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    const units = ['Б','КБ','МБ','ГБ'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
    return `${Math.round(v)} ${units[i]}`;
  }
  _formatMs(ms) {
    if (!Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${Math.round(ms)} мс`;
    return `${(ms/1000).toFixed(1)} с`;
  }
  _formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '-';
    seconds = Math.floor(seconds);
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);

    const parts = [];
    if (d > 0) parts.push(`${d} дн`);
    if (h > 0) parts.push(`${h} ч`);
    if (m > 0 || (d === 0 && h === 0)) parts.push(`${m} мин`);

    if (parts.length === 0) return '0 мин';
    return parts.join(' ');
  }










}

const serverInspector = new ServerInspector();
export { ServerInspector, serverInspector };