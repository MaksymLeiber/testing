import { showWarning, showError, showInfo } from '../toast.js';
import { initTooltips, attachHelpTooltip } from '../tooltips.js';
import { ServerInspectorLogs } from './instector-log.js';

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
    this._lastLsSaveTs = 0; // ограничение записи lastServerDataTime
    this._lastClientMetricsTs = 0; // throttle для клиентских метрик
    this._clientMetricsMinIntervalMs = 1000; // мин. интервал обновления клиентских метрик
    this._lastJsMem = null; // Последнее значение памяти
    this._serverBootId = null;
    this._restartInProgress = false;
    this._currentArrow = ''; // Текущая стрелка
    
    // Garbage Collection tracking
    this._gcCount = 0; // Количество GC
    this._minorGcCount = 0; // Счетчик Minor GC (5-15% падение)
    this._majorGcCount = 0; // Счетчик Major GC (15%+ падение)
    this._lastGcTime = null; // Время последней GC
    this._lastMemForGc = null; // Последнее значение памяти для отслеживания GC
    this._gcDetectionTimer = null; // Таймер для отслеживания GC
    this._lastGcFreed = null; // Сколько памяти было освобождено при последней GC
    
    // Клиентские метрики
    this._clientMetricsTimer = null;
    this._clientDomObserver = null;
    this._longTasksObserver = null;
    this._longTasksCount = 0;
    this._longTasksRecent = [];
    this._latencyTimerId = null;
    this._pendingRttAt = null;
    this._latencyRttMs = null;
    this._latencyHttpMs = null;
    this._wsSamples = []; // { ts, bytes }
    this._wsIntervals = []; // { ts, d } межсообщенческие интервалы (мс) с таймстампом
    this._wsLastEventTs = null;

    // History
    this.serverHistory = [];
    this.maxHistoryLength = 50;

    // Interval / realtime
    this.checkInterval = this._loadInterval(); // ms
    this.realtimeEnabled = this._loadRealtime();
    this.intervalId = null;
    this._realtimeFallbackTimer = null;
    this._httpPollId = null;
    this._httpPollTimeout = null; // setTimeout-базовый поллинг (с джиттером)
    this._lastServerInfoTs = 0;
    this._settingsNs = 'srv_settings_';

    // UI backpressure и видимость
    this._uiUpdateScheduled = false;
    this._lastUiUpdateAt = 0;
    this._uiUpdateMinIntervalMs = 250;
    this._visHandler = null;
    this._healthFetchInflight = false;

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
    this._viewSettings = this._loadJsonSetting('viewSettings', {});
    this.desktopNotify = this._loadSetting('desktopNotify', false);
    this.disableAllNotifications = this._loadSetting('disableAll', false);
    this.logsBadgeLevel = this._loadSetting('badgeLevel', 'INFO');
    this.logColors = this._loadJsonSetting('logColors', {
      ts: '#9aa0a6',
      ip: '#8ab4f8',
      debug: '#9aa0a6',
      info: '#c3e88d',
      warning: '#ffcb6b',
      error: '#ff6e6e',
      critical: '#ff5555'
    });
    this.logsHttpLimit = Number(this._loadSetting('logsLimit', 500)) || 500;
    this._newLogsBuffer = []; // хранит последние подходящие под уровень бэйджа логи
    this._newLogsMax = Number(this._loadSetting('logsNewBuf', 200)) || 200;   // максимум хранимых "новых" записей
    this._logsAllSnapshot = null; // снимок DOM при переключении в режим "Новые"

    // Anti-spam for notifications
    this._lastNotifyTimes = {}; // key -> timestamp

    // DOM cache
    this.root = null;
    this.els = null;

    // Keybinding
    this._keydownBound = false;

    window.__serverInspectorInstance = this;
    try { if (!window.serverInspector) window.serverInspector = this; } catch(_) {}

    // Compose log subsystem (Phase 1 adapter delegates to existing methods)
    this.logs = new ServerInspectorLogs(this);
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
    // Long Tasks
    this._startLongTasksObserver();
    
    // Запускаем обновление метрик только если панель видима
    if (this.isVisible) {
      this._updateClientMetrics();
      this._clientMetricsTimer = setInterval(() => this._updateClientMetrics(), 5000);
    }
  }

  _startLongTasksObserver() {
    try {
      // Сброс
      this._longTasksCount = 0;
      this._longTasksRecent = [];
      if (this._longTasksObserver && typeof this._longTasksObserver.disconnect === 'function') {
        this._longTasksObserver.disconnect();
        this._longTasksObserver = null;
      }
      if (typeof PerformanceObserver === 'undefined') {
        // нет поддержки
        return;
      }
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.includes('longtask')) {
        return;
      }
      this._longTasksObserver = new PerformanceObserver((list) => {
        try {
          const entries = list.getEntries();
          this._longTasksCount += entries.length;
          for (const entry of entries) {
            
            // Сохраняем не только длительность, но и атрибуцию
            this._longTasksRecent.push({
              duration: entry.duration,
              attribution: this._formatLongTaskAttribution(entry)
            });
          }
          // Ограничиваем историю последних задач
          while(this._longTasksRecent.length > 5) {
            this._longTasksRecent.shift();
          }
          this._renderLongTasks();
        } catch(_) {}
      });
      this._longTasksObserver.observe({entryTypes: ['longtask']});
      this._renderLongTasks();
    } catch(_) {}
  }

  _stopLongTasksObserver() {
    try { if (this._longTasksObserver) { this._longTasksObserver.disconnect(); this._longTasksObserver = null; } } catch(_) {}
  }

  _renderLongTasks() {
    try {
      if (!this.els) return;
      if (this.els.clLongTasksCount) {
        const supported = (typeof PerformanceObserver !== 'undefined') && (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
        this.els.clLongTasksCount.textContent = supported ? String(this._longTasksCount) : 'Недоступно';
      }
      if (this.els.clLongTasksRecent) {
        if (!this._longTasksRecent || this._longTasksRecent.length === 0) {
          this.els.clLongTasksRecent.textContent = '-';
        } else {
          const text = this._longTasksRecent.map((r) => {
            const duration = `${Math.round(r.duration)}мс`;
            return r.attribution ? `${duration} (${r.attribution})` : duration;
          }).join(', ');
          this.els.clLongTasksRecent.textContent = text;
        }
      }
    } catch(_) {}
  }
  
  /**
   * Форматирует информацию об источнике Long Task.
   * @param {PerformanceLongTaskTiming} entry 
   * @returns {string|null}
   */
  _formatLongTaskAttribution(entry) {
    if (!entry.attribution || entry.attribution.length === 0) {
      return null;
    }
    const a = entry.attribution[0];
    // Если имя задачи 'unknown' или отсутствует, не показываем атрибуцию.
    if (!a.name || a.name === 'unknown') {
      return null;
    }
    let res = a.name; // 'script', 'layout', etc.
    if (a.containerType) {
      const type = a.containerType === 'window' ? 'окно' : a.containerType;
      const src = a.containerSrc ? ` "${a.containerSrc.substring(0, 30)}..."` : (a.containerId ? ` #${a.containerId}` : '');
      res += ` в ${type}${src}`;
    }
    return res;
  }
  
  // Метод для принудительной очистки памяти
  _forceMemoryCleanup() {
    try {
      // Сбрасываем счетчики GC
      this._gcCount = 0;
      this._minorGcCount = 0;
      this._majorGcCount = 0;
      this._lastGcTime = null;
      this._lastMemForGc = null;
      this._lastGcFreed = null;
      
      // Принудительно запускаем сборку мусора (если поддерживается)
      if (window.gc) {
        window.gc();
      }
      
      console.log('Принудительная очистка памяти выполнена');
    } catch(_) {}
  }
  
  // Метод для мониторинга использования памяти
  _checkMemoryHealth() {
    try {
      if (!performance || !performance.memory) return;
      
      const mem = performance.memory;
      const usedMB = mem.usedJSHeapSize / 1024 / 1024;
      const totalMB = mem.totalJSHeapSize / 1024 / 1024;
      const limitMB = mem.jsHeapSizeLimit / 1024 / 1024;
      
      // Предупреждение если используется больше 80% доступной памяти
      if (usedMB / limitMB > 0.8) {
        console.warn(`Высокое использование памяти: ${usedMB.toFixed(1)}МБ из ${limitMB.toFixed(1)}МБ`);
        
        // Если Major GC больше Minor GC - это признак утечки
        if (this._majorGcCount > this._minorGcCount) {
          console.warn('Обнаружена потенциальная утечка памяти: Major GC > Minor GC');
          if (!this.disableAllNotifications) {
            showWarning('Обнаружена потенциальная утечка памяти');
          }
        }
      }
    } catch(_) {}
  }
  
  // Метод для оптимизации DOM-операций
  _optimizeDOMOperations() {
    try {
      // Используем DocumentFragment для массовых операций
      if (this.els && this.els.componentsBar) {
        const fragment = document.createDocumentFragment();
        // Здесь можно добавить оптимизированные DOM-операции
      }
      
      // Ограничиваем количество DOM-элементов
      const totalElements = document.getElementsByTagName('*').length;
      if (totalElements > 10000) {
        console.warn(`Большое количество DOM-элементов: ${totalElements}`);
      }
    } catch(_) {}
  }
  
  // Метод для очистки неиспользуемых объектов
  _cleanupUnusedObjects() {
    try {
      // Очищаем неиспользуемые ссылки
      if (this._lastData && !this.isVisible) {
        this._lastData = null;
      }
      
      // Очищаем историю если она слишком большая
      if (this.serverHistory.length > this.maxHistoryLength) {
        this.serverHistory = this.serverHistory.slice(-this.maxHistoryLength);
      }
      
      // Очищаем старые уведомления
      const now = Date.now();
      Object.keys(this._lastNotifyTimes).forEach(key => {
        if (now - this._lastNotifyTimes[key] > 300000) { // 5 минут
          delete this._lastNotifyTimes[key];
        }
      });
    } catch(_) {}
  }
  
  // Метод для мониторинга производительности
  _monitorPerformance() {
    try {
      // Проверяем частоту кадров
      if (performance && performance.now) {
        const now = performance.now();
        if (!this._lastFrameTime) {
          this._lastFrameTime = now;
        } else {
          const frameTime = now - this._lastFrameTime;
          if (frameTime > 16.67) { // Меньше 60 FPS
            console.warn(`Низкая частота кадров: ${(1000/frameTime).toFixed(1)} FPS`);
          }
          this._lastFrameTime = now;
        }
      }
      
      // Проверяем время выполнения GC
      if (this._lastGcTime && performance && performance.now) {
        const gcTime = performance.now() - this._lastGcTime;
        if (gcTime > 100) { // GC дольше 100мс
          console.warn(`Медленная сборка мусора: ${gcTime.toFixed(1)}мс`);
        }
      }
    } catch(_) {}
  }
  
  _initGCTracking() {
    // Инициализируем отслеживание памяти для определения GC
    if (performance && performance.memory) {
      this._lastMemForGc = performance.memory.usedJSHeapSize;
      console.log('[Inspector]: Система GC инициализирована');
      
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
              if (!this._lastGcTime || (Date.now() - this._lastGcTime) > 500) {
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
      // Проверяем, что элементы существуют
      if (!this.els) return;
      // Throttle обновления клиентских метрик
      const _now = Date.now();
      if (this._lastClientMetricsTs && (_now - this._lastClientMetricsTs) < this._clientMetricsMinIntervalMs) return;
      this._lastClientMetricsTs = _now;
      
      const totalDom = document.getElementsByTagName('*').length;
      const appDom = this._estimateAppDomCount();
      const navEntry = (performance && typeof performance.getEntriesByType === 'function')
        ? (performance.getEntriesByType('navigation') || [])[0]
        : null;
      const perf = (performance && performance.timing) ? performance.timing : null; // fallback
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
      if (this.els.clDcl) {
        if (navEntry && Number.isFinite(navEntry.domContentLoadedEventEnd)) {
          this.els.clDcl.textContent = this._formatMsBrief(navEntry.domContentLoadedEventEnd - (navEntry.startTime || 0));
        } else if (perf) {
        const dcl = perf.domContentLoadedEventEnd - perf.navigationStart;
        this.els.clDcl.textContent = this._formatMsBrief(dcl);
        } else {
          this.els.clDcl.textContent = 'Недоступно';
        }
      }
      if (this.els.clLoad) {
        if (navEntry && Number.isFinite(navEntry.loadEventEnd)) {
          // Некоторые браузеры дают navEntry.startTime=0, но на всякий случай нормализуем из navigationStart
          const base = Number.isFinite(navEntry.startTime) ? navEntry.startTime : 0;
          this.els.clLoad.textContent = this._formatMsBrief(navEntry.loadEventEnd - base);
        } else if (perf) {
        const load = perf.loadEventEnd - perf.navigationStart;
        this.els.clLoad.textContent = this._formatMsBrief(load);
        } else {
          this.els.clLoad.textContent = 'Недоступно';
        }
      }
      
      // Обновляем GC метрики
      if (this.els.clGc) {
        if (!(performance && performance.memory)) {
          if (Date.now() >= this._skeletonUntil) {
            this.els.clGc.textContent = 'Недоступно';
            if (this.els.clGcTypes) this.els.clGcTypes.textContent = 'Недоступно';
          }
          return;
        }
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
    
    // Проверяем здоровье памяти
    this._checkMemoryHealth();
    
    // Оптимизируем DOM-операции
    this._optimizeDOMOperations();
    
    // Очищаем неиспользуемые объекты
    this._cleanupUnusedObjects();
    
    // Таймер теперь запускается в _startClientMetricsRealtime
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
      if (k === 'workers') {
        // Зеленая, если активных > 0, иначе красная
        const st2 = (comps['workers'] && comps['workers'].active > 0) ? 'ok' : 'crit';
        const cls = st2 === 'ok' ? 'status-ok' : 'status-crit';
        return `bi-diagram-3 ${cls}`;
      }
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
      // Разрешаем 2с как минимальный интервал по просьбе пользователя
      return Number.isFinite(v) ? Math.max(2000, Math.min(60000, v)) : 30000;
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
      // если это число в строке — вернуть число, иначе вернуть исходную строку
      const isNumeric = /^\s*[-+]?\d+(?:\.\d+)?\s*$/.test(v);
      if (isNumeric) {
      const num = Number(v);
      return Number.isFinite(num) ? num : defVal;
      }
      return v;
    } catch(_) { return defVal; }
  }
  _saveSetting(key, val) {
    try { localStorage.setItem(this._settingsNs + key, String(val)); } catch(_) {}
  }

  // JSON-настройки для сложных значений (например, viewSettings)
  _loadJsonSetting(key, defVal) {
    try {
      const raw = localStorage.getItem(this._settingsNs + key);
      if (!raw) return defVal;
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : defVal;
    } catch(_) { return defVal; }
  }
  _saveJsonSetting(key, obj) {
    try { localStorage.setItem(this._settingsNs + key, JSON.stringify(obj)); } catch(_) {}
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
      .srv-icon-btn.notify-off { color: #f44336; }
      .srv-icon-btn.notify-off:hover { color: #ff7961; }
      #srv-restart-btn { color: #f44336; }
      #srv-restart-btn:hover { color: #ff7961; }
      #srv-restart-btn { color: #f44336; }
      #srv-restart-btn:hover { color: #ff7961; }
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
      .srv-log-panel { position:absolute; top:0; left:0; width: 425px; height: 100%; background: rgb(15,15,15); border-right:1px solid rgba(255,255,255,0.12); box-shadow: 6px 0 12px rgba(0,0,0,0.4); transform: translateX(-100%); opacity:0; pointer-events:none; transition: transform .25s ease, opacity .25s ease; z-index: 12; border-radius: 0 8px 8px 0; display:flex; flex-direction:column; }
      .srv-log-panel.open { transform: translateX(0); opacity:1; pointer-events:auto; }
      .srv-log-header { display:flex; align-items:center; justify-content: space-between; padding: 10px 12px; gap:8px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .srv-log-title { font-weight:bold; color:#fff; }
      .srv-log-head-controls { display:flex; align-items:center; gap:6px; flex: 1; }
      .srv-log-toolbar { display:flex; align-items:center; gap:6px; padding: 8px 12px; border-bottom:1px solid rgba(255,255,255,0.08); }
      .srv-log-body { flex:1; overflow:auto; font-family: monospace; font-size: 11px; padding: 8px 12px; }
      .srv-log-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
      .srv-log-line.level-ERROR { color: #f44336; }
      .srv-log-line.level-WARNING { color: #ffb74d; }
      .srv-log-line.level-INFO { color: #cfd8dc; }
      .srv-log-line.level-DEBUG { color: #90caf9; }
      .srv-log-header .srv-input { height: 22px; font-size: 10px; padding: 1px 6px; }
      .srv-log-header .srv-setting-item { font-size: 10px; }
      .srv-log-header .srv-input, .srv-log-toolbar .srv-input { background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.18); }
      .srv-log-header .srv-input:focus, .srv-log-toolbar .srv-input:focus { outline: none; background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.28); }
      #server-inspector-panel select option { background: rgb(15, 15, 15); color: #fff; }
      .srv-log-header .srv-input, .srv-log-toolbar .srv-input { background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.18); }
      .srv-log-header .srv-input:focus, .srv-log-toolbar .srv-input:focus { outline: none; background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.28); }
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
      #srv-workers-active-names { font-size: 80%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
      /* highlight for newly arrived logs */
      .srv-log-line.new { background: rgba(255,82,82,0.14); }
      #srv-logs-toggle-new[data-badge]::after {
        content: attr(data-badge);
        position:absolute; transform: translate(8px,-6px);
        background:#ff5252; color:#fff; border-radius:10px; padding:0 4px; font-size:10px; line-height:14px;
      }

      /* Rounded, modern checkboxes inside inspector */
      #server-inspector-panel input[type="checkbox"] {
        appearance: none;
        -webkit-appearance: none;
        width: 16px; height: 16px;
        border-radius: 6px;
        border: 2px solid rgba(255,255,255,0.35);
        background: transparent;
        display: inline-block; position: relative; cursor: pointer;
        outline: none; transition: all .15s ease;
      }
      #server-inspector-panel input[type="checkbox"]:hover { border-color: rgba(255,255,255,0.6); }
      #server-inspector-panel input[type="checkbox"]:checked {
        background: linear-gradient(180deg, #4cc0ff, #2b9de4);
        border-color: transparent;
        box-shadow: 0 0 0 2px rgba(76,192,255,0.22);
      }
      #server-inspector-panel input[type="checkbox"]:checked::after {
        content:''; position:absolute; left:4px; top:4px; width:6px; height:6px; border-radius: 3px; background:#0b1a24;
      }

      /* Log coloring via CSS variables */
      #srv-log-panel { 
        --log-ts: ${this.logColors?.ts || '#9aa0a6'}; 
        --log-ip: ${this.logColors?.ip || '#8ab4f8'}; 
        --log-debug: ${this.logColors?.debug || '#9aa0a6'}; 
        --log-info: ${this.logColors?.info || '#c3e88d'}; 
        --log-warning: ${this.logColors?.warning || '#ffcb6b'}; 
        --log-error: ${this.logColors?.error || '#ff6e6e'}; 
        --log-critical: ${this.logColors?.critical || '#ff5555'}; 
        --log-http-method: #82aaff;
        --log-http-path: #a1a1a1;
        --log-http-2xx: #00e676;
        --log-http-3xx: #42a5f5;
        --log-http-4xx: #ffd54f;
        --log-http-5xx: #ef5350;
        --log-uuid: #f78c6c;
        --log-errre: #ff8a80;
      }
      #srv-log-panel .log-ts { color: var(--log-ts); margin-right: 8px; opacity: .9; }
      #srv-log-panel .log-logger { color: #a1a1a1; margin: 0 6px; }
      #srv-log-panel .log-ip { color: var(--log-ip); font-weight: 600; }
      #srv-log-panel .srv-log-line { padding: 2px 6px; white-space: nowrap; }
      #srv-log-panel .srv-log-body { white-space: nowrap; }
      #srv-log-panel .srv-log-line .log-level { font-weight: 700; margin-right: 8px; }
      #srv-log-panel .srv-log-line.level-DEBUG .log-level { color: var(--log-debug); }
      #srv-log-panel .srv-log-line.level-INFO .log-level { color: var(--log-info); }
      #srv-log-panel .srv-log-line.level-WARNING .log-level { color: var(--log-warning); }
      #srv-log-panel .srv-log-line.level-ERROR .log-level { color: var(--log-error); }
      #srv-log-panel .srv-log-line.level-CRITICAL .log-level { color: var(--log-critical); }
      #srv-log-panel .log-http-method { color: var(--log-http-method); font-weight: 700; margin-right:6px; }
      #srv-log-panel .log-http-method.method-GET { color:#82aaff; }
      #srv-log-panel .log-http-method.method-POST { color:#ff79c6; }
      #srv-log-panel .log-http-method.method-PUT { color:#64ffda; }
      #srv-log-panel .log-http-method.method-DELETE { color:#ff9860; }
      #srv-log-panel .log-http-method.method-PATCH { color:#b388ff; }
      #srv-log-panel .log-http-method.method-OPTIONS { color:#9aa0a6; }
      #srv-log-panel .log-http-method.method-HEAD { color:#9aa0a6; }
      #srv-log-panel .log-http-path { color: var(--log-http-path); margin-right:6px; }
      #srv-log-panel .log-http-status { font-weight: 700; }
      #srv-log-panel .log-http-status.s2xx { color: var(--log-http-2xx); }
      #srv-log-panel .log-http-status.s3xx { color: var(--log-http-3xx); }
      #srv-log-panel .log-http-status.s4xx { color: var(--log-http-4xx); }
      #srv-log-panel .log-http-status.s5xx { color: var(--log-http-5xx); }
      #srv-log-panel .log-uuid { color: var(--log-uuid); font-weight: 600; }
      #srv-log-panel .log-errre { color: var(--log-errre); background: rgba(255,138,128,0.1); padding:0 2px; border-radius:3px; }

      /* removed legacy compact-align for logs color grid to avoid conflicts */

      /* Settings drawer refined */
      #server-settings-drawer .srv-grid { display: grid; grid-template-columns: 1fr 160px; gap: 4px 10px; align-items: center; }
      #server-settings-drawer .srv-input { width: 100%; height: 24px; font-size: 12px; }
      #server-settings-drawer .srv-input[type="number"] { text-align: right; max-width: 100px; }
      #server-settings-drawer .srv-grid .srv-input,
      #server-settings-drawer .srv-grid .srv-input-with-unit,
      #server-settings-drawer .srv-grid select.srv-input { justify-self: end; }
      #server-settings-drawer .srv-input-with-unit { display: flex; align-items: center; gap: 6px; }
      #server-settings-drawer .srv-input-with-unit span { color: #9aa0a6; font-size: 11px; }
      #server-settings-drawer .with-help { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }
      #server-settings-drawer .logs-colors-grid { display: grid; grid-template-columns: 1fr min-content; gap: 6px 0; align-items: center; justify-self: stretch; width: 100%; }
      #server-settings-drawer .logs-colors-grid .srv-input[type="color"] { width: 24px; height: 24px; padding: 0; border-radius: 4px; }
      #server-settings-drawer .srv-controls-row { display:flex; gap:10px; align-items:center; flex-wrap: wrap; }
      #server-settings-drawer .srv-log-adv { display: grid; gap:8px; }
      #server-settings-drawer .srv-log-adv .srv-reg-row { display:flex; align-items:center; gap:8px; width: 100%; }
      #server-settings-drawer .srv-log-adv .srv-reg-row .srv-input { flex: 1 1 auto; width: 100%; max-width: none; min-width: 0; }
      #server-settings-drawer .srv-setting-group-body { padding-right: 0; }

      /* Custom checkboxes (grey box with green check) — глобально в инспекторе */
      #server-inspector-panel input[type="checkbox"] {
        appearance: none; -webkit-appearance: none; -moz-appearance: none;
        width: 16px; height: 16px; border-radius: 4px; cursor: pointer;
        background: #2b2b2b; border: 2px solid #6e6e6e; position: relative;
        display: inline-block; vertical-align: middle;
      }
      #server-inspector-panel input[type="checkbox"]:hover { border-color: #8a8a8a; }
      #server-inspector-panel input[type="checkbox"]:focus { outline: none; box-shadow: 0 0 0 2px rgba(76,175,80,0.25); }
      #server-inspector-panel input[type="checkbox"]:checked {
        background: #2e7d32; border-color: #2e7d32;
      }
      #server-inspector-panel input[type="checkbox"]:checked::after {
        content: '';
        position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
        border-right: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(45deg);
      }

      /* Внешний вид — собственная сетка: название слева, чекбокс справа */
      #server-settings-drawer .srv-setting-group[data-key="appearance"] .srv-appearance-grid { 
        display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; align-items: center; width: 100%;
      }
      #server-settings-drawer .srv-setting-group[data-key="appearance"] .srv-appearance-grid .ap-label {
        display: inline-flex; align-items: center; gap: 6px;
      }
      #server-settings-drawer .srv-setting-group[data-key="appearance"] .srv-appearance-grid .ap-ctrl {
        justify-self: end;
      }

      /* Уведомления — отдельная сетка для трёх чекбоксов */
      #server-settings-drawer .srv-setting-group[data-key="notifications"] .srv-notify-grid {
        display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; align-items: center; width: 100%;
      }
      #server-settings-drawer .srv-setting-group[data-key="notifications"] .srv-notify-grid .nt-label {
        display: inline-flex; align-items: center; gap: 6px;
      }
      #server-settings-drawer .srv-setting-group[data-key="notifications"] .srv-notify-grid .nt-ctrl { justify-self: end; }

      /* Убираем стрелки в Chrome, Safari, Edge */
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Убираем стрелки в Firefox */
input[type=number] {
  -moz-appearance: textfield;
}
    `;
    document.head.appendChild(style);
  }

  _buildPanel() {
    // Check if panel exists and remove it if it does
    const existingPanel = document.getElementById('server-inspector-panel');
    if (existingPanel) {
      existingPanel.remove();
    }
    const panel = document.createElement('div');
    panel.id = 'server-inspector-panel';
    panel.innerHTML = `
      <div id="server-inspector-header">
        <div id="server-inspector-title">Сервер</div>
        <div class="srv-header-actions">
          <button class="srv-icon-btn" id="srv-memory-cleanup" title="Очистить память"><i class="bi bi-recycle"></i></button>
          <button class="srv-icon-btn" id="srv-restart-btn" title="Перезапуск сервера"><i class="bi bi-arrow-repeat"></i></button>
          <button class="srv-icon-btn" id="srv-logs-btn" title="Логи сервера"><i class="bi bi-journal-text"></i></button>
          <button class="srv-icon-btn" id="srv-notify-toggle" title="Уведомления включены"><i class="bi bi-bell-fill"></i></button>
          <button class="srv-icon-btn" id="srv-settings-btn" title="Настройки"><i class="bi bi-gear"></i></button>
          <button class="srv-btn" id="srv-close-btn">Закрыть</button>
        </div>
      </div>
      <div id="srv-log-panel" class="srv-log-panel"></div>

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
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-speedometer2"></i> Long Tasks <i class="bi bi-question-circle-fill server-help" data-help="Количество 'долгих задач' на главном потоке (Long Tasks) с момента открытия инспектора. Долгая задача — блокировка UI >50мс."></i></span><span class="server-metric-value" id="cl-longtasks-count">-</span></div>
            <div class="server-metric"><span class="server-metric-label"><i class="bi bi-list-ul"></i> Последние Long Tasks <i class="bi bi-question-circle-fill server-help" data-help="Длительности последних 5 длинных задач (мс). Высокие значения — признак 'фризов' интерфейса."></i></span><span class="server-metric-value" id="cl-longtasks-recent">-</span></div>
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
                <i class="bi bi-question-circle-fill server-help" data-help="Минималистичные уведомления о состоянии: настройте пороги, интервал и режимы."></i>
              </span>
              <i class="bi bi-caret-down-fill caret"></i>
            </div>
            <div class="srv-setting-group-body">
          <div class="srv-notify-grid">
            <div class="nt-label">Показывать тосты <i class="bi bi-question-circle-fill server-help" data-help="Включает всплывающие сообщения о важных событиях."></i></div>
            <div class="nt-ctrl"><input type="checkbox" id="srv-toasts-enabled"></div>

            <div class="nt-label">Только критичные <i class="bi bi-question-circle-fill server-help" data-help="Показывать только критичные уведомления (без предупреждений)."></i></div>
            <div class="nt-ctrl"><input type="checkbox" id="srv-only-critical"></div>

            <div class="nt-label">Системные уведомления <i class="bi bi-question-circle-fill server-help" data-help="Разрешить нативные уведомления браузера. Включается только если тосты включены. Нужно разрешить в браузере."></i></div>
            <div class="nt-ctrl"><input type="checkbox" id="srv-desktop-notify"></div>
                </div>

          <div class="srv-grid" style="margin-top:8px;">
            <div class="with-help">Интервал уведомлений <i class="bi bi-question-circle-fill server-help" data-help="Минимальный интервал между уведомлениями. Сделано для зашиты от спама. Минимальное значение 5 секунд, максимум 360 секунд."></i></div>
            <div class="srv-input-with-unit"><input class="srv-input" type="number" id="srv-notify-interval" min="0" max="360"><span>сек</span></div>

            <div class="with-help">CPU предупреждение % <i class="bi bi-question-circle-fill server-help" data-help="Порог предупреждения загрузки CPU."></i></div>
            <input class="srv-input" type="number" id="srv-cpu-warn" min="1" max="100">

            <div class="with-help">CPU критично % <i class="bi bi-question-circle-fill server-help" data-help="Критический порог CPU."></i></div>
            <input class="srv-input" type="number" id="srv-cpu-crit" min="1" max="100">

            <div class="with-help">Память предупреждение % <i class="bi bi-question-circle-fill server-help" data-help="Порог предупреждения использования памяти."></i></div>
            <input class="srv-input" type="number" id="srv-mem-warn" min="1" max="100">

            <div class="with-help">Память критично % <i class="bi bi-question-circle-fill server-help" data-help="Критический порог памяти."></i></div>
            <input class="srv-input" type="number" id="srv-mem-crit" min="1" max="100">

            <div class="with-help">CPU t° предупреждение <i class="bi bi-question-circle-fill server-help" data-help="Порог предупреждения температуры CPU."></i></div>
            <input class="srv-input" type="number" id="srv-tcpu-warn" min="25" max="120">

            <div class="with-help">CPU t° критично <i class="bi bi-question-circle-fill server-help" data-help="Критическая температура CPU."></i></div>
            <input class="srv-input" type="number" id="srv-tcpu-crit" min="25" max="120">

            <div class="with-help">GPU t° предупреждение <i class="bi bi-question-circle-fill server-help" data-help="Порог предупреждения температуры GPU."></i></div>
            <input class="srv-input" type="number" id="srv-tgpu-warn" min="25" max="120">

            <div class="with-help">GPU t° критично <i class="bi bi-question-circle-fill server-help" data-help="Критическая температура GPU."></i></div>
            <input class="srv-input" type="number" id="srv-tgpu-crit" min="25" max="120">
          </div>
            </div>
          </div>

          <div class="srv-setting-group" data-key="logs">
            <div class="srv-setting-group-title">
              <span class="left">
                <i class="bi bi-journal-text"></i>
                <span>Логи</span>
                <i class="bi bi-question-circle-fill server-help" data-help="Настройка бэйджа, загрузки истории и подсветки логов."></i>
              </span>
              <i class="bi bi-caret-down-fill caret"></i>
            </div>
            <div class="srv-setting-group-body">
              <div class="srv-grid">
                <div class="with-help">Уровень бэйджа <i class="bi bi-question-circle-fill server-help" data-help="Уровень для бэйджа на кнопке логов также в логе. По умолчанию DEBUG."></i></div>
                <select class="srv-input" id="srv-badge-level">
                  <option value="DEBUG">DEBUG</option>
                  <option value="INFO">INFO</option>
                  <option value="WARNING">WARNING</option>
                  <option value="ERROR">ERROR</option>
                  <option value="CRITICAL">CRITICAL</option>
                </select>
              </div>
              <!-- Уровень логов при открытии убран: при открытии всегда ALL -->
              <div class="srv-grid">
                <div class="with-help">Лимит истории (HTTP) <i class="bi bi-question-circle-fill server-help" data-help="Сколько строк загружать при ручной загрузке по HTTP. По умолчанию 500 строк. Максимум 5000 строк."></i></div>
                <div class="srv-input-with-unit">
                <span>строк лога</span>
                  <input class="srv-input" type="number" id="srv-logs-limit" min="100" max="5000">
                </div>
              </div>
              <div class="srv-grid">
                <div class="with-help">Размер буфера новых <i class="bi bi-question-circle-fill server-help" data-help="Сколько 'новых' логов хранить для бэйджа."></i></div>
                <div class="srv-input-with-unit">
                  <span>строк лога</span>
                  <input class="srv-input" type="number" id="srv-logs-newbuf" min="50" max="5000">
                </div>
              </div>
              <div class="srv-grid logs-colors-grid" style="gap:1px 10px;">
                <div class="with-help">Цвет времени <i class="bi bi-question-circle-fill server-help" data-help="Цвет таймстампа в строке лога."></i></div> 
                <input class="srv-input" type="color" id="srv-logc-ts" style="height:28px; padding:0;">
                <div class="with-help">Цвет IP <i class="bi bi-question-circle-fill server-help" data-help="Цвет подсветки IP-адресов в тексте лога."></i></div>
                <input class="srv-input" type="color" id="srv-logc-ip" style="height:28px; padding:0;">
                <div class="with-help">DEBUG <i class="bi bi-question-circle-fill server-help" data-help="Цвет сообщений DEBUG."></i></div>
                <input class="srv-input" type="color" id="srv-logc-debug" style="height:28px; padding:0;">
                <div class="with-help">INFO <i class="bi bi-question-circle-fill server-help" data-help="Цвет сообщений INFO."></i></div>
                <input class="srv-input" type="color" id="srv-logc-info" style="height:28px; padding:0;">
                <div class="with-help">WARNING <i class="bi bi-question-circle-fill server-help" data-help="Цвет сообщений WARNING."></i></div>
                <input class="srv-input" type="color" id="srv-logc-warning" style="height:28px; padding:0;">
                <div class="with-help">ERROR <i class="bi bi-question-circle-fill server-help" data-help="Цвет сообщений ERROR."></i></div>
                <input class="srv-input" type="color" id="srv-logc-error" style="height:28px; padding:0;">
                <div class="with-help">CRITICAL <i class="bi bi-question-circle-fill server-help" data-help="Цвет сообщений CRITICAL."></i></div>
                <input class="srv-input" type="color" id="srv-logc-critical" style="height:28px; padding:0;">
                <div class="srv-log-adv" style="grid-column: span 2;">
                  <div class="srv-reg-row">
                    <input class="srv-input" type="text" id="srv-logc-err-re" placeholder="RegExp для ошибок (например: Exception|Traceback|Ошибка)" style="height:28px;">
                    <i class="bi bi-question-circle-fill server-help" data-help="RegExp для подсветки ошибок в сообщении.\nПримеры:\n- Exception|Traceback|Ошибка\n- (Timeout|ConnectionRefused|ECONNRESET)"></i>
                  </div>
                  <div class="srv-controls-row">
                    <label class="srv-setting-item with-help" style="gap:6px; white-space:nowrap;"><input type="checkbox" id="srv-logc-enable-http" checked> HTTP <i class="bi bi-question-circle-fill server-help" data-help="Подсветка HTTP‑метода/пути/кода."></i></label>
                    <label class="srv-setting-item with-help" style="gap:6px; white-space:nowrap;"><input type="checkbox" id="srv-logc-enable-uuid" checked> UUID <i class="bi bi-question-circle-fill server-help" data-help="Подсветка UUID/hex идентификаторов."></i></label>
                    <label class="srv-setting-item with-help" style="gap:6px; white-space:nowrap;"><input type="checkbox" id="srv-logc-enable-err" checked> Ошибки <i class="bi bi-question-circle-fill server-help" data-help="Подсветка совпадений по RegExp выше."></i></label>
                  <button class="srv-btn" id="srv-logc-reset">Сбросить</button>
                  </div>
                </div>
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
              <div class="srv-appearance-grid">
                <div class="ap-label">Секция "Метрики" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию 'Метрики'."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="metrics"></div>

                <div class="ap-label">Секция "Диск I/O" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию дискового ввода/вывода."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="disk"></div>

                <div class="ap-label">Секция "Очереди / Воркеры" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию очередей и воркеров."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="queues"></div>

                <div class="ap-label">Секция "База данных" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию метрик базы данных."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="db"></div>

                <div class="ap-label">Секция "Память / GC / Темп" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию памяти/сборок мусора/температур."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="runtime"></div>

                <div class="ap-label">Секция "Инфо о системе" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию статической системной информации."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="system"></div>

                <div class="ap-label">Секция "WebSocket" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию метрик WebSocket."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="ws"></div>

                <div class="ap-label">Секция "Клиент" <i class="bi bi-question-circle-fill server-help" data-help="Показывать секцию метрик клиента (DOM/JS)."></i></div>
                <div class="ap-ctrl"><input type="checkbox" class="srv-view-toggle" data-key="client"></div>
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
          <div class="server-metric"><span class="server-metric-label"><i class="bi bi-speedometer"></i> Скорость (msgs/sec) <i class="bi bi-question-circle-fill server-help" data-help="Среднее число сообщений в секунду за последние 10 секунд на стороне клиента (оценка по событиям Socket.IO)."></i></span><span class="server-metric-value" id="srv-ws-mps">-</span></div>
          <div class="server-metric"><span class="server-metric-label"><i class="bi bi-hdd-network"></i> Трафик (bytes/sec) <i class="bi bi-question-circle-fill server-help" data-help="Оценка байтов в секунду по последним 10 секундам (на клиенте не всегда точна для бинарных/сжатых пакетов)."></i></span><span class="server-metric-value" id="srv-ws-bps">-</span></div>
          <div class="server-metric"><span class="server-metric-label"><i class="bi bi-clock-history"></i> Интервал между сообщениями <i class="bi bi-question-circle-fill server-help" data-help="Средний промежуток времени между приходом WS-сообщений за последнюю минуту."></i></span><span class="server-metric-value" id="srv-ws-avgint">-</span></div>
          <div class="server-metric"><span class="server-metric-label"><i class="bi bi-broadcast"></i> Сетевой RTT <i class="bi bi-question-circle-fill server-help" data-help="Оценка задержки. WS RTT: round-trip при пинге события. HTTP RTT: запрос к /api/health. Цвета: зелёный <80мс, оранжевый <200мс, красный ≥200мс."></i></span><span class="server-metric-value" id="srv-net-rtt">-</span></div>
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
      wsMps: panel.querySelector('#srv-ws-mps'),
      wsBps: panel.querySelector('#srv-ws-bps'),
      wsAvgInt: panel.querySelector('#srv-ws-avgint'),
      netRtt: panel.querySelector('#srv-net-rtt'),

      sysUptime: panel.querySelector('#srv-sys-uptime'),
      sysOs: panel.querySelector('#srv-sys-os'),
      sysCpu: panel.querySelector('#srv-sys-cpu'),
      sysBoard: panel.querySelector('#srv-sys-board'),
      sysRam: panel.querySelector('#srv-sys-ram'),

      intervalSel: panel.querySelector('#srv-interval'),
      realtimeChk: panel.querySelector('#srv-realtime'),
      closeBtn: panel.querySelector('#srv-close-btn'),
      memoryCleanupBtn: panel.querySelector('#srv-memory-cleanup'),
      restartBtn: panel.querySelector('#srv-restart-btn'),
      logsBtn: panel.querySelector('#srv-logs-btn'),
      logsPanel: panel.querySelector('#srv-log-panel'),
      logsClose: panel.querySelector('#srv-logs-close'),
      logsRefresh: panel.querySelector('#srv-logs-refresh'),
      logsClear: panel.querySelector('#srv-logs-clear'),
      logsDownload: panel.querySelector('#srv-logs-download'),
      logsBody: panel.querySelector('#srv-log-body'),
      logsLevel: panel.querySelector('#srv-log-level'),
      logsGrep: panel.querySelector('#srv-log-grep'),
      logsLive: panel.querySelector('#srv-logs-live'),
      logsAutoscroll: panel.querySelector('#srv-logs-autoscroll'),
      logsToggleNew: panel.querySelector('#srv-logs-toggle-new'),
      notifyToggleBtn: panel.querySelector('#srv-notify-toggle'),
      componentsBar: panel.querySelector('#srv-components-bar'),
      clDomTotal: panel.querySelector('#cl-dom-total'),
      clDomApp: panel.querySelector('#cl-dom-app'),
      clJsCount: panel.querySelector('#cl-js-count'),
              clJsBytes: panel.querySelector('#cl-js-bytes'),
              clDcl: panel.querySelector('#cl-dcl'),
      clLoad: panel.querySelector('#cl-load'),
      clJsMem: panel.querySelector('#cl-js-mem'),
      clGc: panel.querySelector('#cl-gc'),
      clGcTypes: panel.querySelector('#cl-gc-types'),
      clLongTasksCount: panel.querySelector('#cl-longtasks-count'),
      clLongTasksRecent: panel.querySelector('#cl-longtasks-recent')
    };
    // hand over to log subsystem
    try { this.logs.captureElements(this.els); this.logs.initializeAfterBuild(); } catch(_) {}
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
    // Перезапуск сервера
    if (this.els.restartBtn) {
      this.els.restartBtn.addEventListener('click', async () => {
        try {
          if (!confirm('Перезапустить сервер? Текущая сессия будет перезапущена.')) return;
          this.els.restartBtn.disabled = true;
          try { this.els.restartBtn.title = 'Перезапуск...'; } catch(_) {}
          const resp = await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Confirm-Restart':'yes' } });
          if (resp.ok) {
            this._restartInProgress = true;
            this._showRestartOverlay();
            this._waitForServerReborn().catch(()=>{});
          } else {
            if (!this.disableAllNotifications) {
              try { showError('Перезапуск не принят сервером'); } catch(_) {}
            }
          }
        } catch (e) {
          if (!this.disableAllNotifications) {
            try { showError('Ошибка запроса перезапуска'); } catch(_) {}
          }
        } finally {
          try { this.els.restartBtn.disabled = false; this.els.restartBtn.title = 'Перезапуск сервера'; } catch(_) {}
        }
      });
    }
    // Глобальный переключатель уведомлений в шапке
    if (this.els.notifyToggleBtn) {
      const applyIcon = () => {
        const iconEl = this.els.notifyToggleBtn.querySelector('i');
        if (!iconEl) return;
        if (this.disableAllNotifications) {
          iconEl.className = 'bi bi-bell-slash-fill';
          this.els.notifyToggleBtn.title = 'Уведомления выключены';
          this.els.notifyToggleBtn.classList.add('notify-off');
        } else {
          iconEl.className = 'bi bi-bell-fill';
          this.els.notifyToggleBtn.title = 'Уведомления включены';
          this.els.notifyToggleBtn.classList.remove('notify-off');
        }
      };
      applyIcon();
      this.els.notifyToggleBtn.addEventListener('click', () => {
        this.disableAllNotifications = !this.disableAllNotifications;
        this._saveSetting('disableAll', this.disableAllNotifications);
        applyIcon();
        // Визуально и логически блокируем/разблокируем секцию уведомлений
        try { this._applyDisableNotificationsUI(); } catch(_) {}
      });
    }
    
    // Кнопка очистки памяти
    const memoryCleanupBtn = panel.querySelector('#srv-memory-cleanup');
    if (memoryCleanupBtn) {
      memoryCleanupBtn.addEventListener('click', () => {
        this._forceMemoryCleanup();
        if (!this.disableAllNotifications) {
          showInfo('Память очищена');
        }
      });
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
    this._startLatencyMonitoring();
    this._startWsStatsCollection();
    this._updateClientMetrics();

    // Логи: биндинг
    this._bindLogsPanel();
  }

  _showRestartOverlay() {
    try {
      let ov = document.getElementById('srv-restart-overlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'srv-restart-overlay';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center;z-index:99999;font:14px/1.4 system-ui;';
        ov.innerHTML = '<div style="text-align:center"><div class="spinner" style="margin:auto;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;width:28px;height:28px;animation:spin 1s linear infinite"></div><div style="margin-top:10px">Идёт перезапуск сервера…</div></div>';
        const style = document.createElement('style');
        style.textContent='@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
        document.body.appendChild(ov);
      }
    } catch(_) {}
  }

  async _waitForServerReborn() {
    const startTs = performance.now();
    const maxMs = 30000;
    // Снимем текущий boot_id
    try {
      const r0 = await fetch('/api/health', { cache: 'no-store', credentials: 'include' });
      const j0 = await r0.json();
      if (j0 && j0.boot_id) this._serverBootId = this._serverBootId || j0.boot_id;
    } catch(_){ }
    let ok = false;
    while (performance.now() - startTs < maxMs) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store', credentials: 'include' });
        if (r.ok) {
          const j = await r.json();
          if (j && j.boot_id && this._serverBootId && j.boot_id !== this._serverBootId) { ok = true; break; }
        }
      } catch(_) {}
      await new Promise(rs=>setTimeout(rs, 700));
    }
    try { window.location.reload(); } catch(_) {}
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
        // Событие о перезапуске от сервера
        this._onRestarting = () => { this._restartInProgress = true; this._showRestartOverlay(); };
        window.socket.on('server_restarting', this._onRestarting);

        this._onConnect = () => { this._requestOnce(); this.realtimeEnabled ? (this._startRealtimeFallback()) : (this._restartPolling()); this._stopHttpFallback(); this._setupSocketPingPong(); this._ensureLogsBackgroundSubscription(); };
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
      set('srv-desktop-notify', this.desktopNotify, true);
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
    const blockIds = ['srv-toasts-enabled','srv-notify-interval','srv-cpu-warn','srv-cpu-crit','srv-mem-warn','srv-mem-crit','srv-tcpu-warn','srv-tcpu-crit','srv-tgpu-warn','srv-tgpu-crit','srv-desktop-notify'];
    this._applyDisableNotificationsUI = () => {
      const off = !!this.disableAllNotifications;
      blockIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = off;
        const wrap = el && el.closest('.srv-setting-item');
        if (wrap) wrap.classList.toggle('disabled', off);
      });
      // Подпишем шапочную иконку (если есть)
      try {
        const btn = document.getElementById('srv-notify-toggle');
        if (btn) {
          const iconEl = btn.querySelector('i');
          if (iconEl) iconEl.className = off ? 'bi bi-bell-slash-fill' : 'bi bi-bell-fill';
          btn.title = off ? 'Уведомления выключены' : 'Уведомления включены';
        }
      } catch(_) {}
      // Серая заливка для визуального блокирования сетки параметров
      const grid = document.querySelector('#server-settings-drawer .srv-setting-group[data-key="notifications"] .srv-grid');
      if (grid) grid.classList.toggle('disabled', off);
    };
    this._applyDisableNotificationsUI();
    bindChange('srv-mem-warn', 'memWarn'); bindChange('srv-mem-crit', 'memCrit');
    bindChange('srv-tcpu-warn', 'tempCpuWarn'); bindChange('srv-tcpu-crit', 'tempCpuCrit');
    bindChange('srv-tgpu-warn', 'tempGpuWarn'); bindChange('srv-tgpu-crit', 'tempGpuCrit');
    // Desktop Notifications permission flow
    const desk = document.getElementById('srv-desktop-notify');
    if (desk) {
      desk.addEventListener('change', async () => {
        const on = !!desk.checked;
        this.desktopNotify = on;
        this._saveSetting('desktopNotify', on);
        if (on && ('Notification' in window)) {
          try {
            if (Notification.permission === 'default') {
              await Notification.requestPermission();
            }
            if (Notification.permission !== 'granted') {
              showWarning('Разрешение на уведомления не выдано');
              desk.checked = false; this.desktopNotify = false; this._saveSetting('desktopNotify', false);
            }
          } catch(_) {}
        }
      });
    }
    
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

    // Инициализация селекта уровня бэйджа логов
    const badgeSel = document.getElementById('srv-badge-level');
    if (badgeSel) {
      const applySavedBadgeLevel = () => {
        try {
          let saved = this._loadSetting('badgeLevel', this.logsBadgeLevel || 'INFO');
          saved = String(saved || 'INFO').toUpperCase().trim();
          this.logsBadgeLevel = saved;
          // Установка выбранного пункта надёжно
          const opt = badgeSel.querySelector(`option[value="${saved}"]`);
          if (opt) { opt.selected = true; badgeSel.value = saved; }
          else { badgeSel.value = 'INFO'; }
        } catch(_) {}
      };
      applySavedBadgeLevel();
      // На случай гонки со стилями/рендером — повтор через тик
      setTimeout(applySavedBadgeLevel, 0);
      // И ещё один повтор через rAF, если браузер отложил отрисовку селекта
      try { requestAnimationFrame(()=>applySavedBadgeLevel()); } catch(_) {}
      badgeSel.addEventListener('change', () => {
        const val = badgeSel.value || 'INFO';
        this.logsBadgeLevel = val;
        this._saveSetting('badgeLevel', val);
        // Перезапустить фоновую подписку с новым уровнем
        this._ensureLogsBackgroundSubscription();
        // Сброс старого бэйджа и буфера при смене уровня
        this._logsNewCounter = 0;
        this._newLogsBuffer = [];
        this._updateLogsNewBadge();
        try { this.els?.logsToggleNew?.removeAttribute('data-badge'); } catch(_) {}
      });
      // Применим подписку при первичной инициализации, чтобы UI и поведение совпадали
      try { this._ensureLogsBackgroundSubscription(); } catch(_) {}
      // При открытии настроек синхронизируем селект ещё раз
      try {
        const btn = document.getElementById('srv-settings-btn');
        if (btn) btn.addEventListener('click', () => { try { applySavedBadgeLevel(); } catch(_) {} });
      } catch(_) {}
      // Наблюдатель: если какой-то код поменяет value на другое, вернём сохранённое
      try {
        const mo = new MutationObserver(()=>{
          const saved = String(this._loadSetting('badgeLevel', 'INFO')||'INFO').toUpperCase().trim();
          if ((badgeSel.value||'').toUpperCase() !== saved) {
            const opt = badgeSel.querySelector(`option[value="${saved}"]`);
            if (opt) { opt.selected = true; badgeSel.value = saved; }
          }
        });
        mo.observe(badgeSel, { attributes: true, attributeFilter: ['value'] });
      } catch(_) {}
    }
    // removed 'Уровень логов при открытии' — всегда ALL
    const logsLimitInp = document.getElementById('srv-logs-limit');
    if (logsLimitInp) {
      try { logsLimitInp.value = String(this.logsHttpLimit); } catch(_) {}
      logsLimitInp.addEventListener('change', () => {
        let v = Number(logsLimitInp.value);
        if (!Number.isFinite(v)) return;
        v = Math.max(100, Math.min(5000, Math.round(v)));
        logsLimitInp.value = String(v);
        this.logsHttpLimit = v;
        this._saveSetting('logsLimit', v);
      });
    }
    const logsNewBufInp = document.getElementById('srv-logs-newbuf');
    if (logsNewBufInp) {
      try { logsNewBufInp.value = String(this._newLogsMax); } catch(_) {}
      logsNewBufInp.addEventListener('change', () => {
        let v = Number(logsNewBufInp.value);
        if (!Number.isFinite(v)) return;
        v = Math.max(50, Math.min(5000, Math.round(v)));
        logsNewBufInp.value = String(v);
        this._newLogsMax = v;
        this._saveSetting('logsNewBuf', v);
        // Обрезать текущий буфер при необходимости
        if (Array.isArray(this._newLogsBuffer) && this._newLogsBuffer.length > v) {
          this._newLogsBuffer.splice(0, this._newLogsBuffer.length - v);
        }
      });
    }

    // Color pickers for logs
    const applyLogColors = () => {
      try {
        const root = document.getElementById('srv-log-panel');
        if (!root) return;
        const cssMap = {
          '--log-ts': this.logColors.ts,
          '--log-ip': this.logColors.ip,
          '--log-debug': this.logColors.debug,
          '--log-info': this.logColors.info,
          '--log-warning': this.logColors.warning,
          '--log-error': this.logColors.error,
          '--log-critical': this.logColors.critical,
        };
        Object.entries(cssMap).forEach(([k, v]) => { try { root.style.setProperty(k, v); } catch(_) {} });
      } catch(_) {}
    };
    const bindColor = (id, key) => {
      const el = document.getElementById(id); if (!el) return;
      try { el.value = String(this.logColors[key] || '#ffffff'); } catch(_) {}
      el.addEventListener('input', () => {
        this.logColors[key] = el.value;
        this._saveJsonSetting('logColors', this.logColors);
        applyLogColors();
      });
    };
    bindColor('srv-logc-ts', 'ts');
    bindColor('srv-logc-ip', 'ip');
    bindColor('srv-logc-debug', 'debug');
    bindColor('srv-logc-info', 'info');
    bindColor('srv-logc-warning', 'warning');
    bindColor('srv-logc-error', 'error');
    bindColor('srv-logc-critical', 'critical');
    const resetBtn = document.getElementById('srv-logc-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.logColors = { ts:'#9aa0a6', ip:'#8ab4f8', debug:'#9aa0a6', info:'#c3e88d', warning:'#ffcb6b', error:'#ff6e6e', critical:'#ff5555' };
        this._saveJsonSetting('logColors', this.logColors);
        ['srv-logc-ts','srv-logc-ip','srv-logc-debug','srv-logc-info','srv-logc-warning','srv-logc-error','srv-logc-critical'].forEach(id=>{ const el=document.getElementById(id); if (el) el.value = this.logColors[id.replace('srv-logc-','')]; });
        applyLogColors();
      });
    }
    // Feature toggles and RegExp
    const errReEl = document.getElementById('srv-logc-err-re');
    const httpEnEl = document.getElementById('srv-logc-enable-http');
    const uuidEnEl = document.getElementById('srv-logc-enable-uuid');
    const errEnEl = document.getElementById('srv-logc-enable-err');
    const logFx = this._loadJsonSetting('logFx', { http:true, uuid:true, err:true, errRe:'(Exception|Traceback|Error:|Ошибка)' });
    if (errReEl) { errReEl.value = String(logFx.errRe || ''); errReEl.addEventListener('input', ()=>{ logFx.errRe = errReEl.value; this._saveJsonSetting('logFx', logFx); }); }
    if (httpEnEl) { httpEnEl.checked = !!logFx.http; httpEnEl.addEventListener('change', ()=>{ logFx.http = !!httpEnEl.checked; this._saveJsonSetting('logFx', logFx); }); }
    if (uuidEnEl) { uuidEnEl.checked = !!logFx.uuid; uuidEnEl.addEventListener('change', ()=>{ logFx.uuid = !!uuidEnEl.checked; this._saveJsonSetting('logFx', logFx); }); }
    if (errEnEl) { errEnEl.checked = !!logFx.err; errEnEl.addEventListener('change', ()=>{ logFx.err = !!errEnEl.checked; this._saveJsonSetting('logFx', logFx); }); }
    this._logFx = logFx;
    // apply on open
    applyLogColors();

    btn() && btn().addEventListener('click', toggle);
    btnClose() && btnClose().addEventListener('click', close);
  }

  _bindLogsPanel() { try { this.logs.bindPanel(); } catch(_) {} }

  _ensureLogsHandler() { try { this.logs.ensureHandler(); } catch(_) {} }

  _subscribeLogs(level='INFO', grep='') { try { this.logs.subscribe(level, grep); } catch(_) {} }
  _unsubscribeLogs() { try { this.logs.unsubscribe(); } catch(_) {} }

  _ensureLogsBackgroundSubscription() { try { this.logs.ensureBackgroundSubscription(); } catch(_) {} }

  _updateLogsNewBadge() { try { this.logs.updateBadge(); } catch(_) {} }

  async _fetchLogsOnce() { try { await this.logs.fetchOnce(); } catch(_) {} }

  _startLogsLive() { try { this.logs.startLive(); } catch(_) {} }

  _unbindSocket() {
    try {
      const s = window.socket;
      if (!s || typeof s.off !== 'function') return;
      if (this._onServerInfo) s.off('server_info', this._onServerInfo);
      if (this._onConnect) s.off('connect', this._onConnect);
      if (this._onDisconnect) s.off('disconnect', this._onDisconnect);
      if (this._onAnyListener) { try { s.offAny(this._onAnyListener); } catch(_) {} }
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
    // Переносим на setTimeout с джиттером и паузой при скрытии вкладки
    if (this._httpPollTimeout) return;
    const loop = () => {
      try {
        if (!this.isVisible || document.hidden) {
          // при скрытии вкладки делаем редкий «тихий» пинг раз в 30с
          this._httpPollTimeout = setTimeout(loop, 30000);
          return;
        }
        this._fetchHealthOnce();
      } catch(_) {}
      // базовый интервал = max(checkInterval, 4000) + джиттер до 500мс
      const base = Math.max(4000, this.checkInterval);
      const jitter = Math.floor(Math.random() * 500);
      this._httpPollTimeout = setTimeout(loop, base + jitter);
    };
    // стартуем сразу
    loop();
  }
  _stopHttpFallback() {
    if (this._httpPollTimeout) { clearTimeout(this._httpPollTimeout); this._httpPollTimeout = null; }
  }

  async _fetchHealthOnce() {
    try {
      // Guard: если панель скрыта, не дергаем health
      if (!this.isVisible || !this.root || document.hidden) return;
      if (this._healthFetchInflight) return; // не допускаем наложения запросов
      this._healthFetchInflight = true;
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.components) this._renderComponents(data.components);
      if (data) this._scheduleUpdateUI(data); // UI backpressure
    } catch(_) {}
    finally { this._healthFetchInflight = false; }
  }

  // --- Latency monitoring (HTTP and WS) ---
  _setupSocketPingPong() {
    try {
      const s = window.socket;
      if (!s) return;
      // встроенный ping у Socket.IO есть, но воспользуемся пользовательским событием
      if (!this._onPong) {
        this._onPong = (payload) => {
          if (this._pendingRttAt) {
            const rtt = Date.now() - this._pendingRttAt;
            this._latencyRttMs = rtt;
            this._pendingRttAt = null;
            this._renderLatency();
          }
        };
        try { s.off('si_pong', this._onPong); } catch(_) {}
        s.on('si_pong', this._onPong);
      }
    } catch(_) {}
  }
  _startLatencyMonitoring() {
    try { if (this._latencyTimerId) { clearInterval(this._latencyTimerId); this._latencyTimerId = null; } } catch(_) {}
    // Каждые 5 сек пингуем WS и HTTP
    this._latencyTimerId = setInterval(async () => {
      try {
        if (!this.isVisible) return;
        // WS ping
        if (window.socket && window.socket.connected) {
          this._pendingRttAt = Date.now();
          try { window.socket.emit('si_ping', { t: this._pendingRttAt }); } catch(_) { this._pendingRttAt = null; }
        }
        // HTTP ping
        if (!this.isVisible) return;
        const start = performance && performance.now ? performance.now() : Date.now();
        try {
          const resp = await fetch('/api/health', { cache: 'no-store' });
          const end = performance && performance.now ? performance.now() : Date.now();
          if (resp.ok) {
            const ms = Math.max(0, Math.round((end - start)));
            this._latencyHttpMs = ms;
          }
        } catch(_) {}
        this._renderLatency();
      } catch(_) {}
    }, 5000);
  }
  _stopLatencyMonitoring() { try { if (this._latencyTimerId) { clearInterval(this._latencyTimerId); this._latencyTimerId = null; } } catch(_) {} }
  _renderLatency() {
    try {
      if (!this.els || !this.els.netRtt) return;
      const ws = this._latencyRttMs;
      const http = this._latencyHttpMs;
      const parts = [];
      const fmt = (v) => (Number.isFinite(v) ? `${v} мс` : '—');
      const colorFor = (v) => v == null ? 'default' : (v < 80 ? 'ok' : (v < 200 ? 'warn' : 'crit'));
      const set = (el, level, text) => this._setIconValue(el, level, text);
      if (ws != null) parts.push(`WS ${fmt(ws)}`);
      if (http != null) parts.push(`HTTP ${fmt(http)}`);
      const text = parts.length ? parts.join(' · ') : '—';
      const maxV = Math.max(ws ?? 0, http ?? 0);
      const level = colorFor(isFinite(maxV) && maxV > 0 ? maxV : null);
      set(this.els.netRtt, level, text);
    } catch(_) {}
  }

  // --- WS throughput/stats collection ---
  _startWsStatsCollection() {
    try {
      if (!window.socket) return;
      // Так как теперь используем серверные значения, локальный сбор отключаем,
      // но оставляем интервалы для среднего интервала как вспомогательную метрику.
      if (this._onAnyListener) { try { window.socket.offAny(this._onAnyListener); } catch(_) {} }
      this._onAnyListener = (event, ...args) => {
        try {
          const now = Date.now();
          if (event === 'si_ping' || event === 'si_pong') return;
          if (this._wsLastEventTs) this._wsIntervals.push({ ts: now, d: now - this._wsLastEventTs });
          this._wsLastEventTs = now;
          if (this._wsIntervals.length > 600) this._wsIntervals.splice(0, this._wsIntervals.length - 600);
        } catch(_) {}
      };
      try { window.socket.onAny(this._onAnyListener); } catch(_) {}
      if (this._wsStatsTimer) { clearInterval(this._wsStatsTimer); this._wsStatsTimer = null; }
      this._wsStatsTimer = setInterval(() => this._renderWsStats(), 2000);
    } catch(_) {}
  }
  _renderWsStats() {
    try {
      if (!this.els) return;
      const now = Date.now();
      // msgs/sec и bytes/sec теперь приходят с сервера в _updateUI, здесь только интервал
      if (this.els.wsAvgInt) {
        const oneMinAgo = now - 60000;
        const ints = this._wsIntervals.filter(x => x && x.d > 0 && x.ts >= oneMinAgo);
        const avgInt = ints.length ? (ints.reduce((a, x) => a + x.d, 0) / ints.length) : null;
        if (avgInt != null) {
          this.els.wsAvgInt.textContent = this._formatMs(avgInt);
        } else {
          this.els.wsAvgInt.textContent = '-';
        }
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
    
    // Сбрасываем счетчики GC при каждом открытии
    this._gcCount = 0;
    this._minorGcCount = 0;
    this._majorGcCount = 0;
    this._lastGcTime = null;
    this._lastMemForGc = null;
    this._lastGcFreed = null;
    
    // Привязываем сокеты только при показе
    this._bindSocket();

    // Подписаться на DEBUG (ALL) для логов по умолчанию при открытии
    try { if (window.socket) { if (this.logs) { this.logs.unsubscribe(); this.logs.subscribe('DEBUG',''); } } } catch(_) {}

    this._applyHeaderOffset();
    this.root.classList.add('open');
    this.isVisible = true;
    this._startSkeleton();
    this._applyViewSettings(); // Применяем видимость секций
    if (!this._resizeHandler) { this._resizeHandler = () => this._applyHeaderOffset(); window.addEventListener('resize', this._resizeHandler); }
    // Пауза при скрытии вкладки: останавливаем активные опросы и метрики
    if (!this._visHandler) {
      this._visHandler = () => {
        try {
          if (document.hidden) {
            this._stopPolling();
            this._stopRealtimeFallback();
          } else {
            if (this.realtimeEnabled) this._startRealtimeFallback(); else this._restartPolling();
          }
        } catch(_) {}
      };
      try { document.addEventListener('visibilitychange', this._visHandler); } catch(_) {}
    }
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
    // Если панель закрыта — прекращаем HTTP health fallback, чтобы не дергать /api/health
    this._stopHttpFallback();
    this._stopLatencyMonitoring();
    this._unbindSocket();
    // Отписка от live логов и очистка обработчиков
    try { if (this.logs) { this.logs.unsubscribe(); this.logs.cleanup(); } } catch(_) {}

    // Полностью удаляем панель из DOM при закрытии
    try { if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root); } catch(_) {}
    this.root = null; this.els = null;
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if (this._visHandler) { try { document.removeEventListener('visibilitychange', this._visHandler); } catch(_) {} this._visHandler = null; }
    
    // Очищаем GC таймер
    try { 
      if (this._gcDetectionTimer) { 
        clearInterval(this._gcDetectionTimer); 
        this._gcDetectionTimer = null; 
      } 
    } catch(_) {}
    
    // Очищаем клиентские метрики
    try {
      if (this._clientMetricsTimer) {
        clearInterval(this._clientMetricsTimer);
        this._clientMetricsTimer = null;
      }
      if (this._clientDomObserver) {
        this._clientDomObserver.disconnect();
        this._clientDomObserver = null;
      }
    } catch(_) {}
    
    // Сбрасываем счетчики GC при закрытии
    this._gcCount = 0;
    this._minorGcCount = 0;
    this._majorGcCount = 0;
    this._lastGcTime = null;
    this._lastMemForGc = null;
    this._lastGcFreed = null;
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
          this._saveJsonSetting('viewSettings', this._viewSettings);
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
    if (Date.now() >= this._skeletonUntil) this._scheduleUpdateUI(data);
    this._maybeNotify(data);
  }

  _updateUI(d) {
    if (!this.els) return;

    // Сохраняем последние данные для health checks (не чаще раза в 15 секунд)
    try {
      const nowTs = Date.now();
      if (!this._lastLsSaveTs || (nowTs - this._lastLsSaveTs) > 15000) {
        localStorage.setItem('lastServerDataTime', String(nowTs));
        this._lastLsSaveTs = nowTs;
      }
    } catch(_) {}

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
        // Убираем иконку — только текст
        this.els.workers.textContent = `${a} / ${t}`;
        // Цвет статуса воркеров отображаем в статусе компонентов (ниже)
      } else {
        this.els.workers.textContent = '-';
      }
    }
    if (this.els.workersActiveNames) {
        const names = d.queues?.active_worker_names;
        this.els.workersActiveNames.textContent = (names && Array.isArray(names) && names.length > 0) ? names.join(', ') : '-';
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
    // WS speed/throughput from server (preferred)
    if (this.els.wsMps) {
      const mps = d.websocket?.messages_per_sec;
      if (mps != null) {
        const lvl = mps < 5 ? 'ok' : (mps < 20 ? 'warn' : 'crit');
        // Без иконки — только текст
        this.els.wsMps.textContent = Number(mps).toFixed(2);
      } else {
        this.els.wsMps.textContent = '-';
      }
    }
    if (this.els.wsBps) {
      const bps = d.websocket?.bytes_per_sec;
      if (bps != null) {
        this.els.wsBps.textContent = this._formatBytes(bps) + '/с';
      } else {
        this.els.wsBps.textContent = '-';
      }
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

  _scheduleUpdateUI(d) {
    try {
      this._lastData = d;
      const now = Date.now();
      if (this._uiUpdateScheduled) return;
      const due = Math.max(0, this._uiUpdateMinIntervalMs - (now - this._lastUiUpdateAt));
      this._uiUpdateScheduled = true;
      setTimeout(() => {
        try {
          this._uiUpdateScheduled = false;
          this._lastUiUpdateAt = Date.now();
          if (this._lastData) this._updateUI(this._lastData);
        } catch(_) { this._uiUpdateScheduled = false; }
      }, due);
    } catch(_) {}
  }



  _maybeNotify(d) {
    try {
      if ((!this.toastsEnabled && !this.desktopNotify) || this.disableAllNotifications) return;
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
      const maybeDesktop = (title, body) => {
        try {
          if (!this.desktopNotify) return;
          if (!('Notification' in window)) return;
          if (Notification.permission === 'granted') new Notification(title, { body });
        } catch(_) {}
      };

      if (d.cpu_percent >= this.cpuCrit) {
        if (canNotify('cpuCrit')) { showError(`Сервер CPU критично: ${d.cpu_percent}%`); maybeDesktop('CPU критично', `CPU: ${d.cpu_percent}%`); }
      } else if (!onlyCrit && d.cpu_percent >= this.cpuWarn) {
        if (canNotify('cpuWarn')) { showWarning(`Сервер CPU высоко: ${d.cpu_percent}%`); }
      }

      if (d.memory_percent >= this.memCrit) {
        if (canNotify('memCrit')) { showError(`Сервер память критично: ${d.memory_percent}%`); maybeDesktop('Память критично', `RAM: ${d.memory_percent}%`); }
      } else if (!onlyCrit && d.memory_percent >= this.memWarn) {
        if (canNotify('memWarn')) { showWarning(`Сервер память высоко: ${d.memory_percent}%`); }
      }

      const tCpu = d.temps?.cpu_max;
      if (Number.isFinite(tCpu)) {
        if (tCpu >= this.tempCpuCrit) {
          if (canNotify('tCpuCrit')) { showError(`CPU температура критично: ${Math.round(tCpu)}°C`); maybeDesktop('CPU перегрев', `${Math.round(tCpu)}°C`); }
        } else if (!onlyCrit && tCpu >= this.tempCpuWarn) {
          if (canNotify('tCpuWarn')) showWarning(`CPU температура высокая: ${Math.round(tCpu)}°C`);
        }
      }
      const tGpu = d.temps?.gpu_max;
      if (Number.isFinite(tGpu)) {
        if (tGpu >= this.tempGpuCrit) {
          if (canNotify('tGpuCrit')) { showError(`GPU температура критично: ${Math.round(tGpu)}°C`); maybeDesktop('GPU перегрев', `${Math.round(tGpu)}°C`); }
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