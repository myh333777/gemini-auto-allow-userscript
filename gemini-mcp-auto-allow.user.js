// ==UserScript==
// @name         Gemini MCP & Task Auto Always Allow (+ Prompt Queue & Multi-Tab)
// @namespace    https://github.com/myh333777/gemini-auto-allow-userscript
// @version      3.4.0
// @description  自动放行 Gemini 工具/任务权限审批卡片；精准监测侧边栏 remy-goal-status-badge 小旗并后台打开/完工自动关闭；支持接入 vLLM Decision 模型智能判断“自动继续”还是“人工选择”（离线自动回退正则）；支持回车消息排队、紧凑窄窗主题与可拖动浮窗。
// @author       myh333777
// @match        https://gemini.google.com/*
// @homepageURL  https://github.com/myh333777/gemini-auto-allow-userscript
// @supportURL   https://github.com/myh333777/gemini-auto-allow-userscript/issues
// @updateURL    https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @downloadURL  https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @run-at       document-idle
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '3.4.0';
  const STORAGE_SETTINGS_KEY = 'gemini_aa_settings_v3';
  const STORAGE_QUEUE_PREFIX = 'gemini_aa_queue_v3:';
  const STORAGE_OPENED_FLAGS_KEY = 'gemini_aa_opened_flags_v3';
  const STORAGE_UI_POS_KEY = 'gemini_aa_ui_pos_v3';
  const TAB_CHANNEL_NAME = 'gemini-auto-allow-v3-tabs';
  const TAB_ID = `tab_${Math.random().toString(36).slice(2, 9)}`;

  // ==================== 基础参数 ====================
  const CLICK_DELAY_MS = 180; // 前台点击轻微防抖；后台立即点击
  const RETRY_COOLDOWN_MS = 1500;
  const MAX_RETRIES = 5;
  const FALLBACK_POLL_MS = 1800;
  const CONTINUE_TEXT = '继续';
  const CONTINUE_STABLE_MS = 2000;
  const MAX_CONSECUTIVE_CONTINUES = 10;
  const QUEUE_DISPATCH_STABLE_MS = 1300;
  const POST_DISPATCH_COOLDOWN_MS = 3200;
  const STUCK_APPROVAL_SEND_DELAY_MS = 600;
  const SIDEBAR_OPEN_COOLDOWN_MS = 90000; // 同一待审批会话 90 秒内不重复后台打开
  const SIDEBAR_OPEN_GLOBAL_GAP_MS = 2500; // 两次自动打开标签之间至少间隔 2.5 秒
  const AUTO_CLOSE_IDLE_MS = 15000; // 自动打开的任务标签在完工后持续空闲 15 秒即自动关闭
  const AUTO_CLOSE_NO_ACTION_GRACE_MS = 28000; // 若打开后一直无审批也无生成，28 秒后自动关闭
  const DECISION_TIMEOUT_MS = 4500; // Decision API 超时即回退默认正则
  const DECISION_BACKOFF_MS = 60000; // Decision API 不可达时 60 秒熔断直走正则
  const DECISION_MIN_CONTINUE_PROB = 0.75; // 达到该置信度才自动回复“继续”
  // ================================================

  const DEFAULT_SETTINGS = {
    autoApprove: true,
    fallbackToChatOrOnce: true,
    autoContinue: true,
    decisionEnabled: false, // 开启后调用 vLLM Decision System One 判断是否可无人值守继续；不可达自动回退正则
    decisionApiUrl: '', // 填入 /v1/systemone 接口地址（仅保存在本机浏览器 localStorage）
    decisionModel: 'vllm-sr/d3-flash',
    decisionApiKey: '', // 免 Key 网关留空即可
    queueEnabled: true,
    queueMergeByDefault: false, // false = 默认逐条独立发；true = 默认合并到上一条
    sidebarFlagWatch: true, // 监测侧边栏带小旗子/待审批图标的会话并后台自动打开
    autoCloseHandledTab: true, // 自动打开的待审批标签在任务彻底跑完后自动关闭
    compactNarrowTheme: true, // 紧凑窄窗主题：收紧留白并在窄窗下保持侧边栏并排不收缩
    titleStatusEnabled: true,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch (_) {
      // 忽略隐私模式或存储异常
    }
    return { ...DEFAULT_SETTINGS };
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      // 忽略存储异常
    }
  }

  const settings = loadSettings();

  // ==================== 审批选择器与文案规则 ====================
  const PRIMARY_CARD_SELECTOR =
    'remy-confirmation-card, remy-confirmation-card-v2, spark-waiting-for-user-banner';
  const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

  // 危险弹窗黑名单：对通用 dialog 生效，绝不自动点击
  const DANGEROUS_DIALOG_PATTERN =
    /(?:删除此对话|删除对话|永久删除|删除记录|清空记录|清除历史|退出登录|注销账号|反馈问题|举报|delete\s+(?:this\s+)?chat|delete\s+conversation|permanently\s+delete|clear\s+history|sign\s+out|log\s+out|report\s+legal)/i;

  // 拒绝/取消类按钮（用于确认这是权限审批卡片，同时用于排除误匹配）
  const DENY_PATTERNS = [
    /^(不允许|拒绝|取消|不同意|暂不允许|禁止)(?:\s|$|[（(@·\-:：])/i,
    /^(deny|don['’]t\s+allow|disallow|decline|cancel|reject)\b/i,
  ];

  // 优先级 1：始终允许（放宽前缀匹配，兼容“始终允许 @mac3”等带工具名/角标的按钮）
  const ALWAYS_ALLOW_PATTERNS = [
    /^(始终允许|总是允许|永久允许)(?:\s|$|[（(@·\-:：])/i,
    /^(always\s+allow|allow\s+always)\b/i,
  ];

  // 优先级 2：本对话允许 / 允许一次 / 允许
  const FALLBACK_ALLOW_PATTERNS = [
    /^(在此对话中允许|本对话允许|本次对话允许)(?:\s|$|[（(@·\-:：])/i,
    /^allow\s+for\s+this\s+(?:chat|conversation)\b/i,
    /^(允许一次|允许|同意|批准|继续运行)(?:\s|$|[（(@·\-:：])/i,
    /^(allow\s+once|allow|approve)\b/i,
  ];

  // 识别“请求回复继续 / 确认进入下一步”的规则（收紧到最后 800 字内明确提问句）
  const CONTINUE_SENTENCE_RULES = [
    {
      a: /(?:回复|输入|发送|告诉|说一声|回个|确认|告知|reply|type|say|send|confirm)/i,
      b: /(?:继续|下一步|往下|接着|proceed|continue)/i,
    },
    {
      a: /(?:是否|要我|需要我|要不要|能否|准备好|shall\s+i|should\s+i|would\s+you\s+like|want\s+me\s+to)/i,
      b: /(?:继续|下一步|往下|接着|proceed|continue)/i,
    },
    {
      a: /(?:继续|下一步|proceed|continue)\s*[吗？?]\s*$/i,
      b: /(?:继续|下一步|proceed|continue)/i,
    },
  ];

  const CONTINUE_NEGATIVE_PATTERN =
    /(?:无法|不能|不再|暂停|停止|不要|不必|无需|别|勿|don['’]t|cannot|can['’]t|unable\s+to)\s*(?:继续|proceed|continue)/i;
  // ==============================================================

  // ==================== 运行时状态 ====================
  const buttonState = new WeakMap();
  const stuckSendState = new WeakMap();
  let currentPath = location.pathname;
  let scanScheduled = false;
  let clickCount = 0;

  // 自动继续状态（切会话自动重置）
  let consecutiveContinues = 0;
  let lastHandledResponseKey = '';
  let pendingContinueTimer = null;
  let pendingContinueCandidateKey = '';
  let decisionInFlightKey = '';
  let decisionBackoffUntil = 0;
  let needsHumanChoice = false;
  let lastDecisionStatus = ''; // 用于控制台展示最近一次判定结果

  // 消息排队状态（按会话路径隔离并持久化）
  let queue = [];
  let queuePaused = false;
  let isScriptSubmitting = false;
  let queueDispatchTimer = null;
  let lastDispatchAt = 0;
  let lastDispatchUserQueryCount = 0;
  let editingItemId = null;

  // 多标签状态同步
  const peerTabs = new Map();
  let tabChannel = null;
  let basePageTitle = document.title || 'Gemini';
  let lastSidebarOpenAt = 0;
  let autoOpenedCount = 0;
  let sidebarCollapsedHint = false;
  let autoExpandedSidebarOnce = false;
  let userClosedSidebar = false;

  // 状态跳变锁：记录当前已处理的小旗会话；只有当侧边栏里该会话的小旗消失后再重新出现，才会再次打开（防止缓存残留小旗反复重开）
  const latchedFlaggedConvIds = new Set();
  // 父标签保存 GM_openInTab 返回的句柄，子标签完工广播时双保险关闭
  const openedTabHandles = new Map();

  // 当前标签是否由侧边栏监测自动打开（#gaa_auto=1）
  const isAutoOpenedTab = location.hash.includes('gaa_auto=1');
  const tabLoadedAt = Date.now();
  let sawActivityInAutoTab = false;
  let autoTabIdleSince = 0;
  let autoTabCloseSent = false;

  // UI 节点引用
  let uiRoot = null;
  let badgeBtn = null;
  let popoverEl = null;
  let popoverOpen = false;
  let queueDockEl = null;
  let lastQueueRenderKey = '';
  // ==================================================

  // ==================== 通用工具函数 ====================
  function normalizeText(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
  }

  function getConversationKey() {
    return location.pathname || '/app';
  }

  function loadQueueForCurrentChat() {
    try {
      const raw = sessionStorage.getItem(STORAGE_QUEUE_PREFIX + getConversationKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          queue = parsed
            .filter((item) => item && typeof item.text === 'string' && item.text.trim())
            .map((item, idx) => ({
              id: item.id || `q_${Date.now()}_${idx}`,
              text: item.text,
              mergeWithPrev: idx === 0 ? false : Boolean(item.mergeWithPrev),
              createdAt: item.createdAt || Date.now(),
            }));
          return;
        }
      }
    } catch (_) {
      // 忽略存储异常
    }
    queue = [];
  }

  function saveQueueForCurrentChat() {
    normalizeQueueFlags();
    try {
      const key = STORAGE_QUEUE_PREFIX + getConversationKey();
      if (queue.length === 0) {
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, JSON.stringify(queue));
      }
    } catch (_) {
      // 忽略存储异常
    }
  }

  function normalizeQueueFlags() {
    if (queue.length > 0 && queue[0].mergeWithPrev) {
      queue[0].mergeWithPrev = false;
    }
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    if (!document.hidden) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
    }
    return true;
  }

  function isButtonEnabled(button) {
    if (!button || !button.isConnected) {
      return false;
    }
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    const gemBtn = button.closest('gem-button');
    if (
      gemBtn &&
      (gemBtn.hasAttribute('inert') ||
        gemBtn.classList.contains('gem-button-disabled'))
    ) {
      return false;
    }
    return isElementVisible(button);
  }

  function triggerClick(button) {
    const eventInit = { bubbles: true, cancelable: true, view: window };
    try {
      if (typeof PointerEvent === 'function') {
        button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        button.dispatchEvent(new PointerEvent('pointerup', eventInit));
      }
      button.dispatchEvent(new MouseEvent('mousedown', eventInit));
      button.dispatchEvent(new MouseEvent('mouseup', eventInit));
    } catch (_) {
      // 忽略构造事件异常，继续原生 click()
    }
    button.click();
  }

  function getEditor() {
    return document.querySelector(
      'rich-textarea .ql-editor, [contenteditable="true"][role="textbox"], textarea[aria-label*="prompt" i]'
    );
  }

  function getEditorRawText(editor) {
    if (!editor) {
      return '';
    }
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return (editor.value || '').trim();
    }
    // 保留多行换行结构
    const text = (editor.innerText || editor.textContent || '')
      .replace(/\u200B/g, '')
      .replace(/\r\n/g, '\n');
    return text.trim();
  }

  function clearEditor(editor) {
    if (!editor) {
      return;
    }
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.value = '';
    } else {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      editor.replaceChildren(p);
      editor.classList.add('ql-blank');
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditorText(editor, text) {
    if (!editor) {
      return false;
    }
    if (!document.hidden) {
      try {
        editor.focus();
      } catch (_) {
        // 忽略失焦异常
      }
    }

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.value = text;
    } else {
      const lines = text.split('\n');
      const nodes = lines.map((line) => {
        const p = document.createElement('p');
        if (line.length === 0) {
          p.appendChild(document.createElement('br'));
        } else {
          p.textContent = line;
        }
        return p;
      });
      editor.replaceChildren(...nodes);
      editor.classList.remove('ql-blank');
    }

    try {
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        })
      );
    } catch (_) {
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function getSendButton() {
    const candidates = document.querySelectorAll(
      'button.send-button, button[aria-label*="Send"], button[aria-label*="发送"], button[data-test-id="send-button"]'
    );
    for (const btn of candidates) {
      if (!btn.closest('#gemini-aa-root') && isElementVisible(btn)) {
        return btn;
      }
    }
    return candidates[0] || null;
  }

  function isGenerating() {
    const stopCandidates = document.querySelectorAll(
      'button[aria-label*="Stop"], button[aria-label*="停止"], .stop-icon, button[data-test-id="stop-button"]'
    );
    for (const el of stopCandidates) {
      if (!el.closest('#gemini-aa-root') && isElementVisible(el)) {
        return true;
      }
    }
    if (document.querySelector('model-response[aria-busy="true"], .response-streaming')) {
      return true;
    }
    return false;
  }

  function getUserQueryCount() {
    return document.querySelectorAll('user-query, .user-query-container').length;
  }

  // 稳健填充并提交：等待发送按钮激活 + 滞留自动重试
  function fillAndSubmitPrompt(text, onDone) {
    const editor = getEditor();
    if (!editor) {
      if (onDone) onDone(false);
      return false;
    }
    if (getEditorRawText(editor).length > 0) {
      if (onDone) onDone(false);
      return false;
    }

    isScriptSubmitting = true;
    lastDispatchAt = Date.now();
    lastDispatchUserQueryCount = getUserQueryCount();
    setEditorText(editor, text);

    let attempts = 0;
    const maxAttempts = 6;

    const finish = (ok) => {
      isScriptSubmitting = false;
      if (ok) {
        lastDispatchAt = Date.now();
      }
      if (onDone) onDone(ok);
    };

    const trySubmit = () => {
      attempts += 1;
      const currentEditor = getEditor();
      if (!currentEditor) {
        finish(false);
        return;
      }
      // 如果输入框已经被清空或者已经进入生成态，说明已经成功提交
      if (getEditorRawText(currentEditor).length === 0 || isGenerating()) {
        finish(true);
        return;
      }

      const sendBtn = getSendButton();
      if (sendBtn && isButtonEnabled(sendBtn)) {
        triggerClick(sendBtn);
      } else if (attempts >= 3) {
        currentEditor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          })
        );
      }

      window.setTimeout(() => {
        const afterEditor = getEditor();
        const cleared = !afterEditor || getEditorRawText(afterEditor).length === 0;
        const started = isGenerating() || getUserQueryCount() > lastDispatchUserQueryCount;
        if (cleared || started) {
          finish(true);
        } else if (attempts < maxAttempts) {
          trySubmit();
        } else {
          finish(false);
        }
      }, 360);
    };

    window.setTimeout(trySubmit, 120);
    return true;
  }

  // ==================== 模块 1：自动审批 ====================
  function collectConfirmationContainers() {
    const set = new Set();
    document.querySelectorAll(PRIMARY_CARD_SELECTOR).forEach((el) => {
      if (!el.closest('#gemini-aa-root')) {
        set.add(el);
      }
    });
    document.querySelectorAll(DIALOG_SELECTOR).forEach((el) => {
      if (el.closest('#gemini-aa-root')) {
        return;
      }
      const text = normalizeText(el);
      if (DANGEROUS_DIALOG_PATTERN.test(text)) {
        return;
      }
      set.add(el);
    });
    return [...set];
  }

  function findTargetButton(card) {
    const buttons = [...card.querySelectorAll('button')];
    if (buttons.length === 0) {
      return null;
    }

    const hasDenyButton = buttons.some((btn) =>
      matchesAny(normalizeText(btn), DENY_PATTERNS)
    );
    if (!hasDenyButton) {
      return null;
    }

    const enabledButtons = buttons.filter((btn) => {
      if (!isButtonEnabled(btn)) {
        return false;
      }
      const txt = normalizeText(btn);
      if (!txt || matchesAny(txt, DENY_PATTERNS)) {
        return false;
      }
      return true;
    });

    for (const pattern of ALWAYS_ALLOW_PATTERNS) {
      const match = enabledButtons.find((btn) =>
        pattern.test(normalizeText(btn))
      );
      if (match) {
        return match;
      }
    }

    if (settings.fallbackToChatOrOnce) {
      for (const pattern of FALLBACK_ALLOW_PATTERNS) {
        const match = enabledButtons.find((btn) =>
          pattern.test(normalizeText(btn))
        );
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  function hasPendingConfirmationCard() {
    const cards = collectConfirmationContainers();
    for (const card of cards) {
      if (findTargetButton(card)) {
        return true;
      }
    }
    return false;
  }

  function handleCard(card) {
    if (!settings.autoApprove) {
      return;
    }
    const targetButton = findTargetButton(card);
    if (!targetButton) {
      return;
    }

    const now = Date.now();
    const state = buttonState.get(targetButton) || {
      pending: false,
      attempts: 0,
      lastAttemptAt: 0,
    };

    if (
      state.pending ||
      state.attempts >= MAX_RETRIES ||
      (state.lastAttemptAt > 0 && now - state.lastAttemptAt < RETRY_COOLDOWN_MS)
    ) {
      return;
    }

    state.pending = true;
    buttonState.set(targetButton, state);
    const label = normalizeText(targetButton);

    const doClick = () => {
      state.pending = false;
      if (!settings.autoApprove) {
        return;
      }
      if (isButtonEnabled(targetButton) && findTargetButton(card) === targetButton) {
        state.attempts += 1;
        state.lastAttemptAt = Date.now();
        buttonState.set(targetButton, state);

        triggerClick(targetButton);
        clickCount += 1;
        markInjected();
        console.info(
          `[Gemini Auto Allow] 已自动点击「${label}」（第 ${state.attempts} 次尝试，${document.hidden ? '后台' : '前台'}）`
        );
      }
    };

    if (document.hidden) {
      doClick();
    } else {
      window.setTimeout(doClick, CLICK_DELAY_MS);
    }
  }

  // 滞留审批文本自动补发（点击允许后偶发卡在输入框未提交）
  function flushStuckApprovalInput() {
    if (!settings.autoApprove || isScriptSubmitting || isGenerating() || hasPendingConfirmationCard()) {
      return;
    }

    const responses = [...document.querySelectorAll('model-response')];
    if (responses.length === 0) {
      return;
    }
    const lastResp = responses[responses.length - 1];
    const card = lastResp.querySelector(PRIMARY_CARD_SELECTOR);
    if (!card) {
      return;
    }

    const editor = getEditor();
    if (!editor) {
      return;
    }
    const editorText = getEditorRawText(editor);
    if (
      !editorText ||
      matchesAny(editorText, DENY_PATTERNS) ||
      (!matchesAny(editorText, ALWAYS_ALLOW_PATTERNS) &&
        !matchesAny(editorText, FALLBACK_ALLOW_PATTERNS))
    ) {
      return;
    }

    const sendBtn = getSendButton();
    if (!sendBtn || !isButtonEnabled(sendBtn)) {
      return;
    }

    const now = Date.now();
    const state = stuckSendState.get(card) || {
      pending: false,
      attempts: 0,
      lastAttemptAt: 0,
    };
    if (
      state.pending ||
      state.attempts >= MAX_RETRIES ||
      (state.lastAttemptAt > 0 && now - state.lastAttemptAt < RETRY_COOLDOWN_MS)
    ) {
      return;
    }

    state.pending = true;
    stuckSendState.set(card, state);

    const doSend = () => {
      state.pending = false;
      if (isGenerating() || hasPendingConfirmationCard() || isScriptSubmitting) {
        return;
      }
      const currentText = getEditorRawText(editor);
      if (currentText !== editorText) {
        return;
      }
      const currentSendBtn = getSendButton();
      if (!currentSendBtn || !isButtonEnabled(currentSendBtn)) {
        return;
      }
      state.attempts += 1;
      state.lastAttemptAt = Date.now();
      stuckSendState.set(card, state);

      triggerClick(currentSendBtn);
      console.info(
        `[Gemini Auto Allow] 检测到滞留审批文本「${editorText}」，已自动补发（第 ${state.attempts} 次）`
      );
    };

    if (document.hidden) {
      doSend();
    } else {
      window.setTimeout(doSend, STUCK_APPROVAL_SEND_DELAY_MS);
    }
  }

  // ==================== 模块 2：消息排队（Prompt Queue） ====================
  function getNextDispatchBatch(items) {
    if (!items || items.length === 0) {
      return null;
    }
    let endIdx = 1;
    while (endIdx < items.length && items[endIdx].mergeWithPrev) {
      endIdx += 1;
    }
    const batchItems = items.slice(0, endIdx);
    const combinedText = batchItems.map((it) => it.text).join('\n\n');
    return {
      items: batchItems,
      count: endIdx,
      combinedText,
    };
  }

  function enqueuePrompt(text, forceMerge) {
    const cleaned = (text || '').trim();
    if (!cleaned) {
      return false;
    }
    const shouldMerge =
      queue.length > 0 &&
      (typeof forceMerge === 'boolean' ? forceMerge : settings.queueMergeByDefault);

    queue.push({
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: cleaned,
      mergeWithPrev: shouldMerge,
      createdAt: Date.now(),
    });
    saveQueueForCurrentChat();
    renderQueueDock();
    markInjected();
    scheduleScan();
    return true;
  }

  function shouldInterceptForQueue(forceQueue) {
    if (!settings.queueEnabled) {
      return false;
    }
    if (isScriptSubmitting) {
      return false;
    }
    if (forceQueue) {
      return true;
    }
    // 正在生成、存在未审批卡片、已有排队项、或队列暂停时，回车直接入队
    return (
      isGenerating() ||
      hasPendingConfirmationCard() ||
      queue.length > 0 ||
      queuePaused
    );
  }

  function interceptEditorSubmit(event, forceQueue) {
    if (!shouldInterceptForQueue(forceQueue)) {
      return false;
    }
    const editor = getEditor();
    if (!editor) {
      return false;
    }
    const text = getEditorRawText(editor);
    if (!text) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    clearEditor(editor);
    enqueuePrompt(text);
    console.info(`[Gemini Auto Allow] 已加入发送队列（当前共 ${queue.length} 条）`);
    return true;
  }

  function setupQueueInputInterception() {
    // 捕获阶段拦截回车
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.isComposing || e.keyCode === 229) {
          return;
        }
        if (e.key !== 'Enter') {
          return;
        }
        const editor = getEditor();
        if (!editor) {
          return;
        }
        const target = e.target;
        if (!target || (target !== editor && !editor.contains(target))) {
          return;
        }
        // Shift+Enter 保留原生换行
        if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          return;
        }
        // Alt+Enter：无论空闲与否强制入队
        const forceQueue = Boolean(e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey);
        if (forceQueue || (!e.ctrlKey && !e.metaKey && !e.altKey)) {
          interceptEditorSubmit(e, forceQueue);
        }
      },
      true
    );

    // 捕获阶段拦截点击发送按钮（防止生成中/有队列时原生误吞或插队）
    document.addEventListener(
      'click',
      (e) => {
        if (isScriptSubmitting || !e.isTrusted) {
          return;
        }
        const sendBtn = getSendButton();
        if (!sendBtn) {
          return;
        }
        if (e.target === sendBtn || sendBtn.contains(e.target)) {
          interceptEditorSubmit(e, false);
        }
      },
      true
    );
  }

  function dispatchNextQueueBatchNow(ignorePaused) {
    if (queue.length === 0 || isScriptSubmitting) {
      return false;
    }
    if (!ignorePaused && queuePaused) {
      return false;
    }
    if (isGenerating() || hasPendingConfirmationCard()) {
      return false;
    }
    const editor = getEditor();
    if (!editor || getEditorRawText(editor).length > 0) {
      // 用户正在输入框里打字，等用户打完/入队后再发
      return false;
    }

    const batch = getNextDispatchBatch(queue);
    if (!batch) {
      return false;
    }

    // 正在编辑该批次内条目时不自动发出
    if (editingItemId && batch.items.some((it) => it.id === editingItemId)) {
      return false;
    }

    const batchIds = new Set(batch.items.map((it) => it.id));
    console.info(
      `[Gemini Auto Allow] 正在派发队列消息（合并 ${batch.count} 条，剩余 ${queue.length - batch.count} 条）`
    );

    return fillAndSubmitPrompt(batch.combinedText, (ok) => {
      if (ok) {
        queue = queue.filter((it) => !batchIds.has(it.id));
        saveQueueForCurrentChat();
        consecutiveContinues = 0; // 新任务发出，重置自动继续计数
        renderQueueDock();
        markInjected();
      } else {
        console.warn('[Gemini Auto Allow] 队列派发未成功，已保留在队列中等待重试');
        renderQueueDock();
      }
    });
  }

  function checkQueueDispatch() {
    if (!settings.queueEnabled || queuePaused || queue.length === 0 || isScriptSubmitting) {
      if (queueDispatchTimer) {
        clearTimeout(queueDispatchTimer);
        queueDispatchTimer = null;
      }
      return;
    }

    if (isGenerating() || hasPendingConfirmationCard()) {
      if (queueDispatchTimer) {
        clearTimeout(queueDispatchTimer);
        queueDispatchTimer = null;
      }
      return;
    }

    // 刚派发完给 Gemini 一段缓冲期，避免在 Stop 按钮出现前连续连发两条
    const sinceLastDispatch = Date.now() - lastDispatchAt;
    if (sinceLastDispatch < POST_DISPATCH_COOLDOWN_MS) {
      if (!queueDispatchTimer) {
        queueDispatchTimer = window.setTimeout(() => {
          queueDispatchTimer = null;
          checkQueueDispatch();
        }, POST_DISPATCH_COOLDOWN_MS - sinceLastDispatch + 100);
      }
      return;
    }

    if (queueDispatchTimer) {
      return;
    }

    const waitMs = document.hidden ? 200 : QUEUE_DISPATCH_STABLE_MS;
    queueDispatchTimer = window.setTimeout(() => {
      queueDispatchTimer = null;
      dispatchNextQueueBatchNow(false);
    }, waitMs);
  }

  // ==================== 模块 3：自动回复“继续” ====================
  function getLastModelResponseInfo() {
    const responses = [...document.querySelectorAll('model-response')];
    if (responses.length === 0) {
      return null;
    }
    const last = responses[responses.length - 1];
    if (last.querySelector(PRIMARY_CARD_SELECTOR) && hasPendingConfirmationCard()) {
      return null;
    }
    const contentEl = last.querySelector('message-content') || last;
    const fullText = normalizeText(contentEl);
    if (!fullText) {
      return null;
    }
    const tail = fullText.slice(-800);
    const key = `${responses.length}:${fullText.length}:${tail.slice(-80)}`;
    return { key, tail };
  }

  function matchesContinueTail(tail) {
    const sentences = tail
      .split(/[\n。！？!?；;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    return sentences.some((sentence) => {
      if (CONTINUE_NEGATIVE_PATTERN.test(sentence)) {
        return false;
      }
      return CONTINUE_SENTENCE_RULES.some(
        (rule) => rule.a.test(sentence) && rule.b.test(sentence)
      );
    });
  }

  function buildDecisionPayload(text, model) {
    return {
      model: (model || 'vllm-sr/d3-flash').trim(),
      state: text.slice(-1200),
      questions: {
        reply_action: {
          type: 'choice',
          instructions:
            '判断模型最后这段回复是否可以直接由无人值守脚本自动回复“继续”推进，还是需要人工做实质选择/补充信息，或者任务已经完成无需回复。',
          criteria: {
            auto_continue:
              '模型只是在阶段性汇报后询问是否继续下一步、确认按原计划推进，没有要求用户做多选决策或补充新信息，直接回复继续即可',
            need_human:
              '模型给出了多个实质性方案让用户二选一/多选一、询问业务偏好/参数/路径/凭据、或遇到报错需要人工拍板',
            done_no_reply:
              '任务已经完整结束或只是普通回答/总结，不需要回复继续',
          },
        },
      },
    };
  }

  function parseDecisionResponse(data) {
    const ans = data?.answers?.reply_action;
    if (!ans || typeof ans.choice !== 'string') {
      return null;
    }
    const prob =
      typeof ans.probabilities?.[ans.choice] === 'number'
        ? ans.probabilities[ans.choice]
        : typeof ans.confidence === 'number'
          ? ans.confidence
          : 0;
    return { choice: ans.choice, prob };
  }

  function queryDecisionModel(text) {
    return new Promise((resolve) => {
      const url = (settings.decisionApiUrl || '').trim();
      if (!settings.decisionEnabled || !url || Date.now() < decisionBackoffUntil) {
        resolve(null);
        return;
      }
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve(null);
        return;
      }

      const headers = { 'Content-Type': 'application/json' };
      const key = (settings.decisionApiKey || '').trim();
      if (key) {
        headers.Authorization = `Bearer ${key}`;
      }

      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          timeout: DECISION_TIMEOUT_MS,
          data: JSON.stringify(buildDecisionPayload(text, settings.decisionModel)),
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              try {
                const parsed = parseDecisionResponse(JSON.parse(res.responseText));
                if (parsed) {
                  resolve(parsed);
                  return;
                }
              } catch (_) {}
            }
            decisionBackoffUntil = Date.now() + DECISION_BACKOFF_MS;
            resolve(null);
          },
          onerror: () => {
            decisionBackoffUntil = Date.now() + DECISION_BACKOFF_MS;
            resolve(null);
          },
          ontimeout: () => {
            decisionBackoffUntil = Date.now() + DECISION_BACKOFF_MS;
            resolve(null);
          },
        });
      } catch (_) {
        decisionBackoffUntil = Date.now() + DECISION_BACKOFF_MS;
        resolve(null);
      }
    });
  }

  function checkAutoContinue() {
    // 队列里有待发消息时，优先发队列，不插队回复“继续”
    if (
      !settings.autoContinue ||
      queue.length > 0 ||
      isScriptSubmitting ||
      consecutiveContinues >= MAX_CONSECUTIVE_CONTINUES
    ) {
      if (pendingContinueTimer) {
        clearTimeout(pendingContinueTimer);
        pendingContinueTimer = null;
      }
      return;
    }

    if (isGenerating() || hasPendingConfirmationCard()) {
      if (needsHumanChoice) {
        needsHumanChoice = false;
        updateTabTitle();
      }
      if (pendingContinueTimer) {
        clearTimeout(pendingContinueTimer);
        pendingContinueTimer = null;
      }
      return;
    }

    if (Date.now() - lastDispatchAt < POST_DISPATCH_COOLDOWN_MS) {
      return;
    }

    const info = getLastModelResponseInfo();
    if (!info || info.key === lastHandledResponseKey || info.key === decisionInFlightKey) {
      return;
    }

    const canUseDecision =
      settings.decisionEnabled &&
      Boolean((settings.decisionApiUrl || '').trim()) &&
      Date.now() >= decisionBackoffUntil &&
      typeof GM_xmlhttpRequest === 'function';

    // 未启用 Decision 或处于熔断期时，直接走原有正则预检
    if (!canUseDecision && !matchesContinueTail(info.tail)) {
      return;
    }

    if (pendingContinueCandidateKey === info.key && pendingContinueTimer) {
      return;
    }

    if (pendingContinueTimer) {
      clearTimeout(pendingContinueTimer);
    }
    pendingContinueCandidateKey = info.key;

    const doSendContinue = (sourceTag) => {
      fillAndSubmitPrompt(CONTINUE_TEXT, (ok) => {
        if (ok) {
          lastHandledResponseKey = info.key;
          needsHumanChoice = false;
          consecutiveContinues += 1;
          lastDecisionStatus = `${sourceTag}→已自动继续`;
          markInjected();
          console.info(
            `[Gemini Auto Allow] ${sourceTag}判定可继续，已自动回复「${CONTINUE_TEXT}」（${consecutiveContinues}/${MAX_CONSECUTIVE_CONTINUES}）`
          );
        }
      });
    };

    const executeContinue = async () => {
      pendingContinueTimer = null;
      if (
        !settings.autoContinue ||
        queue.length > 0 ||
        isScriptSubmitting ||
        isGenerating() ||
        hasPendingConfirmationCard()
      ) {
        return;
      }
      const latest = getLastModelResponseInfo();
      if (!latest || latest.key !== info.key || latest.key === lastHandledResponseKey) {
        return;
      }

      if (canUseDecision) {
        decisionInFlightKey = info.key;
        const verdict = await queryDecisionModel(latest.tail);
        decisionInFlightKey = '';

        // 异步返回后再次校验状态
        if (
          !settings.autoContinue ||
          queue.length > 0 ||
          isScriptSubmitting ||
          isGenerating() ||
          hasPendingConfirmationCard()
        ) {
          return;
        }
        const afterLatest = getLastModelResponseInfo();
        if (!afterLatest || afterLatest.key !== info.key || afterLatest.key === lastHandledResponseKey) {
          return;
        }

        if (verdict) {
          const pct = Math.round(verdict.prob * 100);
          if (verdict.choice === 'auto_continue' && verdict.prob >= DECISION_MIN_CONTINUE_PROB) {
            doSendContinue(`Decision(${pct}%)`);
            return;
          }
          lastHandledResponseKey = info.key;
          if (verdict.choice === 'need_human') {
            needsHumanChoice = true;
            lastDecisionStatus = `Decision:需人工选择(${pct}%)`;
            console.info(
              `[Gemini Auto Allow] Decision 判定需人工选择（${pct}%），已暂停自动继续并保留标签页`
            );
          } else {
            needsHumanChoice = false;
            lastDecisionStatus = `Decision:已结束无需续(${pct}%)`;
          }
          markInjected();
          return;
        }

        // Decision API 不通/超时 -> 自动静默回退默认正则模式
        lastDecisionStatus = 'Decision离线→回退正则';
        console.warn('[Gemini Auto Allow] Decision API 不可达，已自动回退正则模式');
        if (!matchesContinueTail(afterLatest.tail)) {
          lastHandledResponseKey = info.key;
          return;
        }
        doSendContinue('正则回退');
        return;
      }

      doSendContinue('正则模式');
    };

    if (document.hidden) {
      executeContinue();
    } else {
      pendingContinueTimer = window.setTimeout(executeContinue, CONTINUE_STABLE_MS);
    }
  }

  // ==================== 模块 4：SPA 路由监听与状态重置 ====================
  function onRouteChange() {
    const nextPath = location.pathname;
    if (nextPath === currentPath) {
      return;
    }
    currentPath = nextPath;
    consecutiveContinues = 0;
    lastHandledResponseKey = '';
    pendingContinueCandidateKey = '';
    decisionInFlightKey = '';
    needsHumanChoice = false;
    editingItemId = null;
    if (pendingContinueTimer) {
      clearTimeout(pendingContinueTimer);
      pendingContinueTimer = null;
    }
    if (queueDispatchTimer) {
      clearTimeout(queueDispatchTimer);
      queueDispatchTimer = null;
    }
    loadQueueForCurrentChat();
    renderQueueDock();
    markInjected();
    console.info(`[Gemini Auto Allow] 检测到切换会话 (${currentPath})，已重置自动继续计数并加载对应队列（${queue.length} 条）`);
  }

  function installRouteWatcher() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      onRouteChange();
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      onRouteChange();
      return ret;
    };
    window.addEventListener('popstate', onRouteChange);
  }

  // ==================== 模块 5：多标签 BroadcastChannel 总览 ====================
  function getCurrentTabState() {
    if (hasPendingConfirmationCard()) return 'approval';
    if (isGenerating()) return 'generating';
    if (queue.length > 0) return 'queued';
    return 'idle';
  }

  function cleanTitle(raw) {
    return (raw || 'Gemini')
      .replace(/^\[(?:⏳审批|🙋待选择|⚡运行|📋排队\d+|⏸暂停\d+)\]\s*/, '')
      .trim();
  }

  function updateTabTitle() {
    const currentClean = cleanTitle(document.title);
    if (currentClean) {
      basePageTitle = currentClean;
    }
    if (!settings.titleStatusEnabled) {
      if (document.title !== basePageTitle) {
        document.title = basePageTitle;
      }
      return;
    }
    const state = getCurrentTabState();
    let prefix = '';
    if (state === 'approval') {
      prefix = '[⏳审批] ';
    } else if (needsHumanChoice) {
      prefix = '[🙋待选择] ';
    } else if (queuePaused && queue.length > 0) {
      prefix = `[⏸暂停${queue.length}] `;
    } else if (queue.length > 0) {
      prefix = `[📋排队${queue.length}] `;
    } else if (state === 'generating') {
      prefix = '[⚡运行] ';
    }
    const targetTitle = prefix + basePageTitle;
    if (document.title !== targetTitle) {
      document.title = targetTitle;
    }
  }

  function broadcastTabState() {
    if (!tabChannel) {
      return;
    }
    try {
      tabChannel.postMessage({
        type: 'heartbeat',
        tabId: TAB_ID,
        title: basePageTitle,
        path: currentPath,
        state: getCurrentTabState(),
        queueCount: queue.length,
        paused: queuePaused,
        clickCount,
        hidden: document.hidden,
        ts: Date.now(),
      });
    } catch (_) {
      // 忽略通道关闭异常
    }
  }

  function initTabChannel() {
    if (typeof BroadcastChannel !== 'function') {
      return;
    }
    try {
      tabChannel = new BroadcastChannel(TAB_CHANNEL_NAME);
      tabChannel.onmessage = (ev) => {
        const data = ev.data;
        if (!data || !data.tabId || data.tabId === TAB_ID) {
          return;
        }
        if (data.type === 'bye') {
          peerTabs.delete(data.tabId);
        } else if (data.type === 'heartbeat') {
          peerTabs.set(data.tabId, data);
        } else if (data.type === 'opening-conv' && data.convId) {
          const map = loadOpenedFlagsMap();
          map[data.convId] = Math.max(map[data.convId] || 0, data.ts || Date.now());
          try {
            localStorage.setItem(STORAGE_OPENED_FLAGS_KEY, JSON.stringify(map));
          } catch (_) {}
        } else if (data.type === 'auto-tab-done' && data.convId) {
          const handle = openedTabHandles.get(data.convId);
          if (handle && typeof handle.close === 'function') {
            try {
              handle.close();
            } catch (_) {}
          }
          openedTabHandles.delete(data.convId);
        }
        updateBadge();
        if (popoverOpen) {
          renderPopover();
        }
      };
      window.addEventListener('beforeunload', () => {
        try {
          tabChannel.postMessage({ type: 'bye', tabId: TAB_ID });
        } catch (_) {}
      });
    } catch (_) {
      tabChannel = null;
    }
  }

  function getActivePeerTabs() {
    const now = Date.now();
    const list = [];
    for (const [id, info] of peerTabs.entries()) {
      if (now - info.ts > 60000) {
        peerTabs.delete(id);
        continue;
      }
      list.push({
        ...info,
        maybeFrozen: now - info.ts > 12000,
      });
    }
    return list;
  }

  // ==================== 模块 5.5：侧边栏待审批小旗监测 & 后台自动打开 ====================
  const SIDEBAR_IGNORED_ICONS = new Set([
    'push_pin',
    'keep',
    'more_vert',
    'more_horiz',
    'edit',
    'delete',
    'share',
    'chat',
    'chat_bubble',
    'gemini_chat',
    'lock',
    'public',
  ]);

  const SIDEBAR_FLAG_ICON_PATTERN =
    /(?:^|_)(?:flag|outlined_flag|flag_2|flag_circle|assistant_flag|tour|priority_high|notification_important|notifications_active|approval|pending_actions|action_required|waiting|attention|warning|error_outline)(?:$|_)/i;

  const SIDEBAR_FLAG_ATTR_PATTERN =
    /(?:waiting|action[\s_-]*required|needs?[\s_-]*(?:your[\s_-]*)?(?:input|approval|review|attention)|permission|flag|等待|需要审批|需要操作|待审批|待确认|待处理)/i;

  function extractConversationIdFromPath(pathOrUrl) {
    if (!pathOrUrl) {
      return '';
    }
    const m = String(pathOrUrl).match(/\/(?:app|spark)\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function extractConversationInfo(item) {
    const rawAttrId = (item.getAttribute('data-conversation-id') || '').replace(/^c_/, '');
    const anchor = item.tagName === 'A' ? item : item.querySelector('a[href]');
    const rawHref = anchor ? anchor.getAttribute('href') : '';
    const hrefId = extractConversationIdFromPath(rawHref);
    const convId = rawAttrId || hrefId;
    if (!convId) {
      return null;
    }

    let url = '';
    if (rawHref) {
      try {
        const parsed = new URL(rawHref, location.origin);
        if (parsed.origin === location.origin) {
          url = parsed.href;
        }
      } catch (_) {}
    }
    if (!url) {
      const accountPrefixMatch = location.pathname.match(/^(\/u\/\d+)/);
      const prefix = accountPrefixMatch ? accountPrefixMatch[1] : '';
      url = `${location.origin}${prefix}/app/${convId}`;
    }

    const title = normalizeText(anchor || item).slice(0, 60) || convId;
    return { convId, url, title, rendered: Boolean(anchor) };
  }

  const REMY_BADGE_NON_APPROVAL_ICONS = new Set([
    'progress_activity',
    'check',
    'check_circle',
    'check_circle_outline',
    'done',
    'done_all',
    'task_alt',
  ]);

  function detectSidebarFlagReason(item) {
    // 0. 最高精度：直接检测 Gemini 任务状态徽章 <remy-goal-status-badge>
    // 空徽章=普通会话；in-progress/spinning/progress_activity=后台运行中（在转圈）；
    // completed/check=已完成；其余任意图标（小旗子/等待审批/需要输入等）均视为待审批/待处理！
    const remyBadge = item.querySelector('remy-goal-status-badge');
    if (remyBadge) {
      const badgeIconWrap = remyBadge.querySelector('gem-icon');
      const badgeMatIcon = remyBadge.querySelector('mat-icon');
      if (badgeIconWrap || badgeMatIcon) {
        const wrapCls = typeof badgeIconWrap?.className === 'string' ? badgeIconWrap.className : '';
        const fonticon = (
          badgeMatIcon?.getAttribute('fonticon') ||
          badgeMatIcon?.getAttribute('data-mat-icon-name') ||
          badgeMatIcon?.textContent ||
          ''
        ).trim();
        const isSpinning =
          /\b(?:in-progress|spinning|loading)\b/i.test(wrapCls) ||
          fonticon.toLowerCase() === 'progress_activity';
        const isCompleted =
          /\b(?:completed|success|done)\b/i.test(wrapCls) ||
          REMY_BADGE_NON_APPROVAL_ICONS.has(fonticon.toLowerCase());
        if (!isSpinning && !isCompleted) {
          return `remy-badge:${fonticon || wrapCls.slice(0, 40) || 'waiting'}`;
        }
      }
    }

    // 1. 兜底检查其他位置的 mat-icon（排除置顶 push_pin、更多菜单 more_vert 等常规图标）
    const icons = item.querySelectorAll('mat-icon');
    for (const ic of icons) {
      if (ic.closest('button[aria-label*="More options"], button[aria-label*="更多"]')) {
        continue;
      }
      const fonticon = (ic.getAttribute('fonticon') || '').trim();
      const matName = (ic.getAttribute('data-mat-icon-name') || '').trim();
      const iconText = (ic.textContent || '').trim();
      const aria = (ic.getAttribute('aria-label') || '').trim();
      const cls = typeof ic.className === 'string' ? ic.className : '';

      const primaryName = fonticon || matName || iconText;
      if (primaryName && SIDEBAR_IGNORED_ICONS.has(primaryName.toLowerCase())) {
        continue;
      }
      if (
        (primaryName && SIDEBAR_FLAG_ICON_PATTERN.test(primaryName)) ||
        (aria && SIDEBAR_FLAG_ATTR_PATTERN.test(aria)) ||
        (cls && /\b(?:flag|waiting|attention|needs-input|approval)\b/i.test(cls))
      ) {
        return `icon:${primaryName || aria || 'flag'}`;
      }
    }

    // 2. 检查非操作按钮区域的语义属性 / data-test-id / 可见状态标记
    const taggedNodes = item.querySelectorAll(
      '[aria-label], [title], [data-test-id], [class*="flag"], [class*="waiting"], [class*="attention"], [class*="needs-input"]'
    );
    for (const el of taggedNodes) {
      if (el.closest('button[aria-label*="More options"], button[aria-label*="更多"]')) {
        continue;
      }
      const aria = el.getAttribute('aria-label') || '';
      const titleAttr = el.getAttribute('title') || '';
      const testId = el.getAttribute('data-test-id') || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      if (testId === 'conversation') {
        continue;
      }
      if (
        SIDEBAR_FLAG_ATTR_PATTERN.test(aria) ||
        SIDEBAR_FLAG_ATTR_PATTERN.test(titleAttr) ||
        SIDEBAR_FLAG_ATTR_PATTERN.test(testId) ||
        /\b(?:flag|waiting|attention|needs-input|approval-badge)\b/i.test(cls)
      ) {
        return `attr:${testId || aria || titleAttr || cls.slice(0, 30)}`;
      }
    }

    return null;
  }

  function loadOpenedFlagsMap() {
    try {
      const raw = localStorage.getItem(STORAGE_OPENED_FLAGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const now = Date.now();
          const cleaned = {};
          for (const [k, ts] of Object.entries(parsed)) {
            if (typeof ts === 'number' && now - ts < SIDEBAR_OPEN_COOLDOWN_MS * 4) {
              cleaned[k] = ts;
            }
          }
          return cleaned;
        }
      }
    } catch (_) {}
    return {};
  }

  function markFlagOpened(convId) {
    const map = loadOpenedFlagsMap();
    map[convId] = Date.now();
    try {
      localStorage.setItem(STORAGE_OPENED_FLAGS_KEY, JSON.stringify(map));
    } catch (_) {}
    if (tabChannel) {
      try {
        tabChannel.postMessage({ type: 'opening-conv', tabId: TAB_ID, convId, ts: Date.now() });
      } catch (_) {}
    }
  }

  function isConversationOpenInAnyTab(convId) {
    if (!convId) {
      return false;
    }
    if (extractConversationIdFromPath(location.pathname) === convId) {
      return true;
    }
    const peers = getActivePeerTabs();
    return peers.some(
      (p) => !p.maybeFrozen && extractConversationIdFromPath(p.path) === convId
    );
  }

  function openUrlInBackground(url, convId) {
    const targetUrl = url.includes('#') ? url : `${url}#gaa_auto=1`;
    try {
      if (typeof GM_openInTab === 'function') {
        const handle = GM_openInTab(targetUrl, {
          active: false,
          insert: true,
          setParent: true,
        });
        if (handle && convId) {
          openedTabHandles.set(convId, handle);
        }
        return true;
      }
    } catch (err) {
      console.warn('[Gemini Auto Allow] GM_openInTab 调用失败，尝试回退 window.open:', err);
    }
    try {
      const win = window.open(targetUrl, '_blank', 'noopener');
      if (win && convId) {
        openedTabHandles.set(convId, win);
      }
      return Boolean(win);
    } catch (_) {
      return false;
    }
  }

  function checkAutoCloseHandledTab() {
    if (!isAutoOpenedTab || !settings.autoCloseHandledTab || autoTabCloseSent) {
      return;
    }
    // 如果用户主动切到这个标签页查看或正在输入框打字，暂不关闭，避免打断用户
    const editor = getEditor();
    const userTyping = editor && getEditorRawText(editor).length > 0;
    const busy =
      isGenerating() ||
      hasPendingConfirmationCard() ||
      queue.length > 0 ||
      isScriptSubmitting ||
      Boolean(pendingContinueTimer) ||
      Boolean(decisionInFlightKey) ||
      needsHumanChoice;

    if (clickCount > 0 || isGenerating() || hasPendingConfirmationCard()) {
      sawActivityInAutoTab = true;
    }

    if (busy || userTyping || !document.hidden) {
      autoTabIdleSince = 0;
      return;
    }

    const now = Date.now();
    if (!autoTabIdleSince) {
      autoTabIdleSince = now;
      return;
    }

    const requiredIdle = sawActivityInAutoTab
      ? AUTO_CLOSE_IDLE_MS
      : AUTO_CLOSE_NO_ACTION_GRACE_MS;

    if (now - autoTabIdleSince >= requiredIdle && now - tabLoadedAt >= 8000) {
      autoTabCloseSent = true;
      const convId = extractConversationIdFromPath(location.pathname);
      console.info(
        `[Gemini Auto Allow] 自动打开的任务标签（${convId || location.pathname}）已完工并持续空闲，正在自动关闭`
      );
      if (tabChannel && convId) {
        try {
          tabChannel.postMessage({ type: 'auto-tab-done', tabId: TAB_ID, convId });
        } catch (_) {}
      }
      try {
        window.close();
      } catch (_) {}
    }
  }

  function checkSidebarApprovalFlags() {
    if (!settings.sidebarFlagWatch || !settings.autoApprove) {
      return;
    }
    const items = [
      ...document.querySelectorAll(
        'gem-nav-list-item[data-test-id="conversation"], [data-test-id="conversation"]'
      ),
    ];
    if (items.length === 0) {
      sidebarCollapsedHint = false;
      return;
    }

    const renderedCount = items.filter((el) => Boolean(el.querySelector('a[href]'))).length;
    sidebarCollapsedHint = renderedCount === 0;
    if (sidebarCollapsedHint) {
      return;
    }

    // 先统计当前侧边栏仍带小旗子的会话集合，并释放已消失小旗的状态锁
    const currentFlagged = [];
    const currentFlaggedIds = new Set();
    for (const item of items) {
      const reason = detectSidebarFlagReason(item);
      if (!reason) {
        continue;
      }
      const info = extractConversationInfo(item);
      if (!info) {
        continue;
      }
      currentFlaggedIds.add(info.convId);
      currentFlagged.push({ info, reason });
    }
    for (const latchedId of [...latchedFlaggedConvIds]) {
      if (!currentFlaggedIds.has(latchedId)) {
        latchedFlaggedConvIds.delete(latchedId);
      }
    }

    const now = Date.now();
    if (now - lastSidebarOpenAt < SIDEBAR_OPEN_GLOBAL_GAP_MS) {
      return;
    }

    const openedMap = loadOpenedFlagsMap();

    for (const { info, reason } of currentFlagged) {
      // 如果这个会话的小旗子自上次处理后从未消失（侧边栏缓存未刷新），跳过避免反复重开
      if (latchedFlaggedConvIds.has(info.convId)) {
        continue;
      }
      if (isConversationOpenInAnyTab(info.convId)) {
        latchedFlaggedConvIds.add(info.convId);
        continue;
      }
      const lastOpened = openedMap[info.convId] || 0;
      if (now - lastOpened < SIDEBAR_OPEN_COOLDOWN_MS) {
        latchedFlaggedConvIds.add(info.convId);
        continue;
      }

      // 抢占锁并后台打开
      latchedFlaggedConvIds.add(info.convId);
      markFlagOpened(info.convId);
      lastSidebarOpenAt = now;
      if (openUrlInBackground(info.url, info.convId)) {
        autoOpenedCount += 1;
        console.info(
          `[Gemini Auto Allow] 监测到侧边栏待审批任务「${info.title}」(${reason})，已后台自动打开处理：${info.url}`
        );
        markInjected();
      }
      break; // 每轮最多打开 1 个，避免连弹标签
    }
  }

  function applyCompactTheme() {
    if (!document.documentElement) {
      return;
    }
    const enabled = Boolean(settings.compactNarrowTheme);
    document.documentElement.classList.toggle('gaa-compact-theme', enabled);

    // 窄窗（>= 640px）且开启紧凑主题 + 小旗监测时，自动展开一次侧边栏使其并排常驻
    if (
      enabled &&
      settings.sidebarFlagWatch &&
      !autoExpandedSidebarOnce &&
      !userClosedSidebar &&
      window.innerWidth >= 640
    ) {
      const sidenav = document.querySelector('mat-sidenav, bard-sidenav');
      if (sidenav && !sidenav.classList.contains('mat-drawer-opened')) {
        const menuBtn = document.querySelector(
          'button[aria-label="Main menu"], button[aria-label="Open sidebar"], button[aria-label*="展开侧边栏"], button[aria-label*="主菜单"]'
        );
        if (menuBtn && isButtonEnabled(menuBtn)) {
          autoExpandedSidebarOnce = true;
          menuBtn.click();
          window.setTimeout(positionQueueDock, 260);
        }
      } else if (sidenav && sidenav.classList.contains('mat-drawer-opened')) {
        autoExpandedSidebarOnce = true;
      }
    }
  }

  // ==================== 模块 6：UI（输入框上方队列面板 + 右下角控制台） ====================
  function ensureStyles() {
    if (document.getElementById('gemini-aa-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'gemini-aa-style';
    style.textContent = `
      #gemini-aa-root {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #e8eaed;
      }
      #gemini-aa-badge {
        position: fixed;
        right: 16px;
        bottom: 118px;
        z-index: 99999;
        padding: 5px 11px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(24, 25, 29, 0.88);
        color: #e8eaed;
        font-size: 11px;
        line-height: 16px;
        cursor: grab;
        user-select: none;
        touch-action: none;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 14px rgba(0,0,0,0.28);
        opacity: 0.86;
        transition: opacity 0.15s ease, border-color 0.15s ease;
      }
      #gemini-aa-badge:active { cursor: grabbing; }
      #gemini-aa-badge:hover { opacity: 1; border-color: rgba(138, 180, 248, 0.6); }
      #gemini-aa-popover {
        position: fixed;
        right: 16px;
        bottom: 154px;
        z-index: 99999;
        width: 300px;
        max-height: 70vh;
        overflow-y: auto;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(24, 25, 30, 0.96);
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        backdrop-filter: blur(12px);
        padding: 12px;
        font-size: 12px;
        display: none;
      }
      #gemini-aa-popover.open { display: block; }
      .gaa-section-title {
        font-size: 11px;
        font-weight: 600;
        color: #9aa0a6;
        margin: 8px 0 6px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .gaa-section-title:first-child { margin-top: 0; }
      .gaa-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 0;
        gap: 8px;
      }
      .gaa-switch {
        padding: 2px 9px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.06);
        color: #bdc1c6;
        font-size: 11px;
        cursor: pointer;
      }
      .gaa-switch.on {
        background: rgba(138, 180, 248, 0.22);
        border-color: rgba(138, 180, 248, 0.65);
        color: #8ab4f8;
      }
      .gaa-tab-row {
        padding: 5px 7px;
        border-radius: 7px;
        background: rgba(255,255,255,0.04);
        margin-bottom: 5px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
      }
      .gaa-tab-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 175px;
        color: #e8eaed;
      }
      .gaa-pill {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .gaa-pill.approval { background: rgba(242,139,130,0.22); color: #f28b82; }
      .gaa-pill.generating { background: rgba(138,180,248,0.22); color: #8ab4f8; }
      .gaa-pill.queued { background: rgba(253,214,99,0.2); color: #fdd663; }
      .gaa-pill.idle { background: rgba(129,201,149,0.18); color: #81c995; }
      .gaa-pill.frozen { background: rgba(154,160,166,0.22); color: #9aa0a6; }

      /* 输入框正上方的排队浮层 */
      #gemini-aa-queue-dock {
        position: fixed;
        z-index: 99990;
        left: 50%;
        transform: translateX(-50%);
        bottom: 122px;
        width: min(740px, calc(100vw - 48px));
        border-radius: 14px;
        border: 1px solid rgba(138, 180, 248, 0.28);
        background: rgba(24, 26, 32, 0.94);
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 28px rgba(0,0,0,0.38);
        padding: 8px 10px;
        font-size: 12px;
        display: none;
      }
      #gemini-aa-queue-dock.visible { display: block; }
      #gemini-aa-queue-dock.hint-only {
        padding: 4px 12px;
        border-color: rgba(255,255,255,0.12);
        background: rgba(24, 26, 32, 0.78);
        width: auto;
        max-width: min(680px, calc(100vw - 48px));
      }
      .gaa-q-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        flex-wrap: wrap;
        cursor: grab;
        user-select: none;
      }
      .gaa-q-header:active { cursor: grabbing; }
      #gemini-aa-queue-dock.hint-only { cursor: grab; user-select: none; }
      .gaa-q-title {
        font-weight: 600;
        color: #e8eaed;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .gaa-q-actions {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
      }
      .gaa-btn {
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.06);
        color: #e8eaed;
        border-radius: 7px;
        padding: 2px 8px;
        font-size: 11px;
        line-height: 18px;
        cursor: pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .gaa-btn:hover { background: rgba(255,255,255,0.14); }
      .gaa-btn.active {
        background: rgba(138, 180, 248, 0.22);
        border-color: rgba(138, 180, 248, 0.6);
        color: #8ab4f8;
      }
      .gaa-btn.warn {
        background: rgba(253, 214, 99, 0.18);
        border-color: rgba(253, 214, 99, 0.55);
        color: #fdd663;
      }
      .gaa-btn.danger:hover {
        background: rgba(242, 139, 130, 0.22);
        border-color: rgba(242, 139, 130, 0.6);
        color: #f28b82;
      }
      .gaa-q-list {
        max-height: 220px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .gaa-q-item {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 9px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .gaa-q-item.merged {
        margin-top: -2px;
        margin-left: 16px;
        border-left: 2px solid #8ab4f8;
        background: rgba(138, 180, 248, 0.08);
      }
      .gaa-q-left {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: flex-start;
        gap: 6px;
      }
      .gaa-q-badge {
        flex-shrink: 0;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 5px;
        background: rgba(255,255,255,0.1);
        color: #bdc1c6;
        margin-top: 1px;
      }
      .gaa-q-item.merged .gaa-q-badge {
        background: rgba(138, 180, 248, 0.22);
        color: #8ab4f8;
      }
      .gaa-q-text {
        flex: 1;
        min-width: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: #e8eaed;
        line-height: 1.4;
        max-height: 60px;
        overflow-y: auto;
      }
      .gaa-q-edit-area {
        width: 100%;
        min-height: 44px;
        border-radius: 6px;
        border: 1px solid rgba(138, 180, 248, 0.6);
        background: rgba(16, 17, 22, 0.95);
        color: #e8eaed;
        padding: 4px 6px;
        font-size: 12px;
        font-family: inherit;
        resize: vertical;
      }
      .gaa-q-item-ops {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .gaa-icon-btn {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.05);
        color: #bdc1c6;
        border-radius: 6px;
        padding: 1px 6px;
        font-size: 11px;
        cursor: pointer;
      }
      .gaa-icon-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
      .gaa-icon-btn.merged-on {
        background: rgba(138, 180, 248, 0.24);
        border-color: rgba(138, 180, 248, 0.6);
        color: #8ab4f8;
      }

      /* ===== 紧凑窄窗主题（防止小窗口侧边栏收缩 & 收紧留白） ===== */
      @media (min-width: 640px) {
        html.gaa-compact-theme mat-sidenav.mat-drawer,
        html.gaa-compact-theme bard-sidenav.mat-drawer {
          width: 216px !important;
          min-width: 216px !important;
          max-width: 216px !important;
        }
        html.gaa-compact-theme mat-sidenav.mat-drawer-over.mat-drawer-opened,
        html.gaa-compact-theme bard-sidenav.mat-drawer-over.mat-drawer-opened {
          box-shadow: none !important;
          border-right: 1px solid rgba(128, 128, 128, 0.22) !important;
        }
        html.gaa-compact-theme .mat-drawer-backdrop.mat-drawer-shown {
          display: none !important;
          pointer-events: none !important;
        }
        html.gaa-compact-theme mat-sidenav.mat-drawer-over.mat-drawer-opened ~ mat-sidenav-content,
        html.gaa-compact-theme bard-sidenav.mat-drawer-over.mat-drawer-opened ~ mat-sidenav-content {
          margin-left: 216px !important;
          width: calc(100% - 216px) !important;
        }
        html.gaa-compact-theme gem-nav-list-item[data-test-id="conversation"] a.mat-mdc-list-item {
          padding-left: 8px !important;
          padding-right: 6px !important;
          min-height: 32px !important;
          height: 32px !important;
          font-size: 12.5px !important;
        }
        html.gaa-compact-theme .input-area-container,
        html.gaa-compact-theme chat-window .conversation-container,
        html.gaa-compact-theme chat-window-content {
          padding-left: 10px !important;
          padding-right: 10px !important;
        }
        html.gaa-compact-theme .input-area-container {
          max-width: 100% !important;
          width: 100% !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function loadUiPositions() {
    try {
      const raw = localStorage.getItem(STORAGE_UI_POS_KEY);
      if (raw) {
        return JSON.parse(raw) || {};
      }
    } catch (_) {}
    return {};
  }

  function saveUiPosition(key, pos) {
    try {
      const all = loadUiPositions();
      if (pos === null) {
        delete all[key];
      } else {
        all[key] = pos;
      }
      localStorage.setItem(STORAGE_UI_POS_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  function applySavedFixedPos(el, key) {
    const pos = loadUiPositions()[key];
    if (!el || !pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') {
      return false;
    }
    const w = el.offsetWidth || 160;
    const h = el.offsetHeight || 28;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, pos.left));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, pos.top));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    return true;
  }

  function positionPopover() {
    if (!popoverEl || !badgeBtn || !popoverOpen) {
      return;
    }
    const br = badgeBtn.getBoundingClientRect();
    const popW = 300;
    const popH = Math.min(popoverEl.offsetHeight || 360, window.innerHeight * 0.7);
    let left = br.right - popW;
    left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));
    let top = br.top - popH - 8;
    if (top < 8) {
      top = Math.min(window.innerHeight - popH - 8, br.bottom + 8);
    }
    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(Math.max(8, top))}px`;
    popoverEl.style.right = 'auto';
    popoverEl.style.bottom = 'auto';
  }

  function makeDraggable(el, storageKey, options = {}) {
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let dragging = false;
    let moved = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      if (options.handleSelector) {
        const isHandle =
          e.target.closest(options.handleSelector) ||
          (options.allowWhenClass && el.classList.contains(options.allowWhenClass));
        if (!isHandle || e.target.closest('button, textarea, input')) {
          return;
        }
      }
      const r = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = r.left;
      origTop = r.top;
      dragging = true;
      moved = false;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) {
        return;
      }
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) {
        return;
      }
      moved = true;
      const w = el.offsetWidth || 160;
      const h = el.offsetHeight || 28;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, origLeft + dx));
      const top = Math.max(8, Math.min(window.innerHeight - h - 8, origTop + dy));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
      if (options.onMove) {
        options.onMove();
      }
    });

    const endDrag = (e) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (moved) {
        const r = el.getBoundingClientRect();
        saveUiPosition(storageKey, { left: Math.round(r.left), top: Math.round(r.top) });
        el.dataset.gaaJustDragged = '1';
        window.setTimeout(() => {
          delete el.dataset.gaaJustDragged;
        }, 80);
      }
    };

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }

  function ensureUI() {
    if (!document.body) {
      return;
    }
    ensureStyles();
    if (!uiRoot || !uiRoot.isConnected) {
      uiRoot = document.createElement('div');
      uiRoot.id = 'gemini-aa-root';

      queueDockEl = document.createElement('div');
      queueDockEl.id = 'gemini-aa-queue-dock';

      popoverEl = document.createElement('div');
      popoverEl.id = 'gemini-aa-popover';

      badgeBtn = document.createElement('button');
      badgeBtn.type = 'button';
      badgeBtn.id = 'gemini-aa-badge';
      badgeBtn.title = '点击打开设置与多标签总览（按住可自由拖动位置）';
      badgeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (badgeBtn.dataset.gaaJustDragged) {
          return;
        }
        popoverOpen = !popoverOpen;
        popoverEl.classList.toggle('open', popoverOpen);
        if (popoverOpen) {
          renderPopover();
          positionPopover();
        }
      });

      uiRoot.appendChild(queueDockEl);
      uiRoot.appendChild(popoverEl);
      uiRoot.appendChild(badgeBtn);
      document.body.appendChild(uiRoot);

      makeDraggable(badgeBtn, 'badge', { onMove: positionPopover });
      makeDraggable(queueDockEl, 'dock', {
        handleSelector: '.gaa-q-header',
        allowWhenClass: 'hint-only',
      });
      applySavedFixedPos(badgeBtn, 'badge');
    }
  }

  function positionQueueDock() {
    if (!queueDockEl || !queueDockEl.classList.contains('visible')) {
      return;
    }
    if (applySavedFixedPos(queueDockEl, 'dock')) {
      return;
    }
    const anchor =
      document.querySelector('input-area-v2, .input-area-container, rich-textarea') ||
      getEditor();
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 120 && rect.top > 80 && rect.top < window.innerHeight) {
        const bottomPx = Math.max(96, Math.round(window.innerHeight - rect.top + 18));
        const centerX = Math.round(rect.left + rect.width / 2);
        queueDockEl.style.top = 'auto';
        queueDockEl.style.right = 'auto';
        queueDockEl.style.transform = 'translateX(-50%)';
        queueDockEl.style.bottom = `${bottomPx}px`;
        queueDockEl.style.left = `${centerX}px`;
        if (!queueDockEl.classList.contains('hint-only')) {
          const targetWidth = Math.min(760, Math.max(360, Math.round(rect.width)));
          queueDockEl.style.width = `${targetWidth}px`;
        } else {
          queueDockEl.style.width = 'auto';
        }
        return;
      }
    }
    queueDockEl.style.top = 'auto';
    queueDockEl.style.bottom = '136px';
    queueDockEl.style.left = '50%';
    queueDockEl.style.transform = 'translateX(-50%)';
  }

  function renderQueueDock(force) {
    ensureUI();
    if (!queueDockEl) {
      return;
    }

    const generating = isGenerating();
    const pendingCard = hasPendingConfirmationCard();

    // 正在编辑某条内容且非主动重绘时，不破坏当前输入框焦点
    if (!force && editingItemId) {
      positionQueueDock();
      return;
    }

    const renderKey = [
      settings.queueEnabled,
      settings.queueMergeByDefault,
      queuePaused,
      editingItemId || '',
      generating,
      pendingCard,
      queue.map((it) => `${it.id}:${it.mergeWithPrev ? 1 : 0}:${it.text}`).join('|'),
    ].join('::');

    if (!force && renderKey === lastQueueRenderKey) {
      positionQueueDock();
      return;
    }
    lastQueueRenderKey = renderKey;

    if (!settings.queueEnabled) {
      queueDockEl.classList.remove('visible', 'hint-only');
      return;
    }

    // 队列为空时：仅在模型生成中显示一行轻提示，空闲时彻底隐藏
    if (queue.length === 0) {
      if (generating) {
        queueDockEl.className = 'visible hint-only';
        const span = document.createElement('span');
        span.style.color = '#bdc1c6';
        span.textContent = `📋 回复生成中：直接打字按回车即可加入上方排队（新条默认：${settings.queueMergeByDefault ? '并入上条' : '逐条独立发'}）`;
        queueDockEl.replaceChildren(span);
        positionQueueDock();
      } else {
        queueDockEl.className = '';
      }
      return;
    }

    queueDockEl.className = 'visible';
    queueDockEl.replaceChildren();

    // 计算当前共几轮（合并组算同一轮）
    let batchCount = 0;
    queue.forEach((item, idx) => {
      if (idx === 0 || !item.mergeWithPrev) {
        batchCount += 1;
      }
    });

    // Header
    const header = document.createElement('div');
    header.className = 'gaa-q-header';

    const title = document.createElement('div');
    title.className = 'gaa-q-title';
    title.textContent = `📋 待发队列（${queue.length} 条 → 分 ${batchCount} 轮发送）`;
    if (queuePaused) {
      const pTag = document.createElement('span');
      pTag.className = 'gaa-pill queued';
      pTag.textContent = '已暂停';
      title.appendChild(pTag);
    } else if (isGenerating()) {
      const gTag = document.createElement('span');
      gTag.className = 'gaa-pill generating';
      gTag.textContent = '等待本轮回复结束';
      title.appendChild(gTag);
    }

    const actions = document.createElement('div');
    actions.className = 'gaa-q-actions';

    // 默认合并模式切换按钮
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = `gaa-btn ${settings.queueMergeByDefault ? 'active' : ''}`;
    modeBtn.title = '切换新回车消息的默认行为：并入上一条合并发送 / 独立作为下一轮发送';
    modeBtn.textContent = settings.queueMergeByDefault ? '新条默认: 🔗合并上条' : '新条默认: ✂️逐条发';
    modeBtn.addEventListener('click', () => {
      settings.queueMergeByDefault = !settings.queueMergeByDefault;
      saveSettings();
      renderQueueDock();
      if (popoverOpen) renderPopover();
    });
    actions.appendChild(modeBtn);

    // 暂停/继续派发
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = `gaa-btn ${queuePaused ? 'warn' : ''}`;
    pauseBtn.textContent = queuePaused ? '▶ 继续派发' : '⏸ 暂停';
    pauseBtn.addEventListener('click', () => {
      queuePaused = !queuePaused;
      renderQueueDock();
      markInjected();
      if (!queuePaused) {
        scheduleScan();
      }
    });
    actions.appendChild(pauseBtn);

    // 若空闲，允许立即发下一轮
    if (!isGenerating() && !hasPendingConfirmationCard()) {
      const sendNowBtn = document.createElement('button');
      sendNowBtn.type = 'button';
      sendNowBtn.className = 'gaa-btn active';
      sendNowBtn.textContent = '⚡ 立即发下轮';
      sendNowBtn.addEventListener('click', () => {
        dispatchNextQueueBatchNow(true);
      });
      actions.appendChild(sendNowBtn);
    }

    // 清空队列
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'gaa-btn danger';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      queue = [];
      editingItemId = null;
      saveQueueForCurrentChat();
      renderQueueDock();
      markInjected();
    });
    actions.appendChild(clearBtn);

    header.appendChild(title);
    header.appendChild(actions);
    queueDockEl.appendChild(header);

    // 列表
    const listEl = document.createElement('div');
    listEl.className = 'gaa-q-list';

    let roundIdx = 0;
    queue.forEach((item, idx) => {
      const isMerged = idx > 0 && item.mergeWithPrev;
      if (!isMerged) {
        roundIdx += 1;
      }

      const row = document.createElement('div');
      row.className = `gaa-q-item ${isMerged ? 'merged' : ''}`;

      const left = document.createElement('div');
      left.className = 'gaa-q-left';

      const badge = document.createElement('span');
      badge.className = 'gaa-q-badge';
      badge.textContent = isMerged ? `↳ 并入第${roundIdx}轮` : `第${roundIdx}轮`;
      left.appendChild(badge);

      if (editingItemId === item.id) {
        const ta = document.createElement('textarea');
        ta.className = 'gaa-q-edit-area';
        ta.value = item.text;
        ta.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            item.text = ta.value.trim() || item.text;
            editingItemId = null;
            saveQueueForCurrentChat();
            renderQueueDock(true);
          } else if (e.key === 'Escape') {
            editingItemId = null;
            renderQueueDock(true);
          }
        });
        left.appendChild(ta);

        const ops = document.createElement('div');
        ops.className = 'gaa-q-item-ops';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'gaa-icon-btn merged-on';
        saveBtn.textContent = '保存';
        saveBtn.addEventListener('click', () => {
          item.text = ta.value.trim() || item.text;
          editingItemId = null;
          saveQueueForCurrentChat();
          renderQueueDock(true);
        });
        ops.appendChild(saveBtn);
        row.appendChild(left);
        row.appendChild(ops);
      } else {
        const txt = document.createElement('div');
        txt.className = 'gaa-q-text';
        txt.textContent = item.text;
        txt.title = '双击编辑';
        txt.addEventListener('dblclick', () => {
          editingItemId = item.id;
          renderQueueDock(true);
        });
        left.appendChild(txt);

        const ops = document.createElement('div');
        ops.className = 'gaa-q-item-ops';

        // 单条切换：与上条合并 vs 独立发（第 1 条除外）
        if (idx > 0) {
          const mergeToggle = document.createElement('button');
          mergeToggle.type = 'button';
          mergeToggle.className = `gaa-icon-btn ${item.mergeWithPrev ? 'merged-on' : ''}`;
          mergeToggle.title = item.mergeWithPrev
            ? '当前会与上一条合并成同一轮发送，点击改为单独发'
            : '当前会单独作为下一轮发送，点击改为并入上一条';
          mergeToggle.textContent = item.mergeWithPrev ? '🔗 合并' : '✂️ 独立';
          mergeToggle.addEventListener('click', () => {
            item.mergeWithPrev = !item.mergeWithPrev;
            saveQueueForCurrentChat();
            renderQueueDock();
          });
          ops.appendChild(mergeToggle);
        }

        // 上移
        if (idx > 0) {
          const upBtn = document.createElement('button');
          upBtn.type = 'button';
          upBtn.className = 'gaa-icon-btn';
          upBtn.title = '上移';
          upBtn.textContent = '↑';
          upBtn.addEventListener('click', () => {
            [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
            saveQueueForCurrentChat();
            renderQueueDock();
          });
          ops.appendChild(upBtn);
        }

        // 编辑
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'gaa-icon-btn';
        editBtn.title = '编辑内容';
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', () => {
          editingItemId = item.id;
          renderQueueDock(true);
        });
        ops.appendChild(editBtn);

        // 删除
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'gaa-icon-btn';
        delBtn.title = '删除此条';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          queue.splice(idx, 1);
          saveQueueForCurrentChat();
          renderQueueDock();
          markInjected();
        });
        ops.appendChild(delBtn);

        row.appendChild(left);
        row.appendChild(ops);
      }

      listEl.appendChild(row);
    });

    queueDockEl.appendChild(listEl);
    positionQueueDock();
  }

  function renderPopover() {
    if (!popoverEl) {
      return;
    }
    popoverEl.replaceChildren();

    const title = document.createElement('div');
    title.className = 'gaa-section-title';
    const titleLeft = document.createElement('span');
    titleLeft.textContent = `Gemini 自动助手 v${SCRIPT_VERSION}`;
    const resetPosBtn = document.createElement('button');
    resetPosBtn.type = 'button';
    resetPosBtn.className = 'gaa-icon-btn';
    resetPosBtn.textContent = '↺ 复位浮窗';
    resetPosBtn.title = '恢复状态浮窗与排队栏的默认位置';
    resetPosBtn.addEventListener('click', () => {
      saveUiPosition('badge', null);
      saveUiPosition('dock', null);
      if (badgeBtn) {
        badgeBtn.style.left = '';
        badgeBtn.style.top = '';
        badgeBtn.style.right = '16px';
        badgeBtn.style.bottom = '118px';
      }
      positionQueueDock();
      positionPopover();
    });
    title.append(titleLeft, resetPosBtn);
    popoverEl.appendChild(title);

    const toggles = [
      {
        label: '自动审批权限卡片',
        key: 'autoApprove',
      },
      {
        label: '无“始终允许”时回退“允许”',
        key: 'fallbackToChatOrOnce',
      },
      {
        label: `监测侧边栏小旗并后台打开${autoOpenedCount > 0 ? `(${autoOpenedCount})` : ''}`,
        key: 'sidebarFlagWatch',
      },
      {
        label: '自动打开的标签完工后自动关闭',
        key: 'autoCloseHandledTab',
      },
      {
        label: '紧凑窄窗主题（防侧边栏收缩）',
        key: 'compactNarrowTheme',
      },
      {
        label: '回车消息排队（Prompt Queue）',
        key: 'queueEnabled',
      },
      {
        label: '排队新条默认并入上一条',
        key: 'queueMergeByDefault',
      },
      {
        label: `自动回复「继续」(${consecutiveContinues}/${MAX_CONSECUTIVE_CONTINUES})`,
        key: 'autoContinue',
      },
      {
        label: 'Decision 模型智能判断（离线回退正则）',
        key: 'decisionEnabled',
      },
      {
        label: '标签页标题显示运行状态',
        key: 'titleStatusEnabled',
      },
    ];

    for (const item of toggles) {
      const row = document.createElement('div');
      row.className = 'gaa-toggle-row';
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      const isOn = Boolean(settings[item.key]);
      btn.className = `gaa-switch ${isOn ? 'on' : ''}`;
      btn.textContent = isOn ? '已开启' : '已关闭';
      btn.addEventListener('click', () => {
        settings[item.key] = !settings[item.key];
        if (item.key === 'autoContinue' && settings.autoContinue) {
          consecutiveContinues = 0;
        }
        if (item.key === 'compactNarrowTheme') {
          autoExpandedSidebarOnce = false;
          userClosedSidebar = false;
          applyCompactTheme();
          window.setTimeout(positionQueueDock, 200);
        }
        saveSettings();
        renderQueueDock();
        markInjected();
        renderPopover();
        scheduleScan();
      });
      row.appendChild(lbl);
      row.appendChild(btn);
      popoverEl.appendChild(row);
    }

    // Decision 模型配置区（仅开启时展开，配置仅存本机 localStorage）
    if (settings.decisionEnabled) {
      const box = document.createElement('div');
      box.style.cssText =
        'margin:6px 0 8px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:6px;';

      const mkInput = (placeholder, value, onSave, isSecret) => {
        const inp = document.createElement('input');
        inp.type = isSecret ? 'password' : 'text';
        inp.placeholder = placeholder;
        inp.value = value || '';
        inp.style.cssText =
          'width:100%;box-sizing:border-box;padding:4px 7px;border-radius:6px;border:1px solid rgba(255,255,255,0.16);background:rgba(16,17,22,0.9);color:#e8eaed;font-size:11px;';
        inp.addEventListener('change', () => {
          onSave(inp.value.trim());
          decisionBackoffUntil = 0;
          saveSettings();
        });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        return inp;
      };

      box.appendChild(
        mkInput(
          'Decision API 地址（.../v1/systemone）',
          settings.decisionApiUrl,
          (v) => {
            settings.decisionApiUrl = v;
          },
          false
        )
      );
      box.appendChild(
        mkInput(
          '模型（默认 vllm-sr/d3-flash）',
          settings.decisionModel,
          (v) => {
            settings.decisionModel = v || 'vllm-sr/d3-flash';
          },
          false
        )
      );
      box.appendChild(
        mkInput(
          'API Key（免 Key 网关留空即可）',
          settings.decisionApiKey,
          (v) => {
            settings.decisionApiKey = v;
          },
          true
        )
      );

      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';
      const statusSpan = document.createElement('span');
      statusSpan.style.cssText = 'font-size:10px;color:#9aa0a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      statusSpan.textContent =
        lastDecisionStatus ||
        (settings.decisionApiUrl ? '已配置（离线自动回退正则）' : '未填地址（当前走正则）');

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'gaa-icon-btn';
      testBtn.textContent = '测试连通';
      testBtn.addEventListener('click', async () => {
        decisionBackoffUntil = 0;
        statusSpan.textContent = '测试中...';
        const res = await queryDecisionModel(
          '第一步已完成，接下来将执行第二步，请回复继续。'
        );
        if (res) {
          lastDecisionStatus = `✅ ${res.choice}(${Math.round(res.prob * 100)}%)`;
        } else {
          lastDecisionStatus = '⚠️ 不可达(自动回退正则)';
        }
        statusSpan.textContent = lastDecisionStatus;
      });

      foot.append(statusSpan, testBtn);
      box.appendChild(foot);
      popoverEl.appendChild(box);
    }

    if (settings.sidebarFlagWatch && sidebarCollapsedHint) {
      const tip = document.createElement('div');
      tip.style.cssText = 'font-size:11px;color:#fdd663;margin:4px 0 6px;line-height:1.4;';
      tip.textContent = '⚠️ 侧边栏当前已收起：请保持左侧对话栏展开，脚本才能看到远端任务的小旗子图标。';
      popoverEl.appendChild(tip);
    }

    // 多标签总览
    const peers = getActivePeerTabs();
    const tabHeader = document.createElement('div');
    tabHeader.className = 'gaa-section-title';
    const tabHeaderSpan = document.createElement('span');
    tabHeaderSpan.textContent = `多标签状态总览（共 ${peers.length + 1} 个）`;
    tabHeader.appendChild(tabHeaderSpan);
    popoverEl.appendChild(tabHeader);

    const stateLabelMap = {
      approval: ['卡审批', 'approval'],
      generating: ['运行中', 'generating'],
      queued: ['排队中', 'queued'],
      idle: ['空闲', 'idle'],
    };

    const allTabs = [
      {
        title: `${basePageTitle}（当前）`,
        state: getCurrentTabState(),
        queueCount: queue.length,
        maybeFrozen: false,
      },
      ...peers,
    ];

    for (const t of allTabs) {
      const row = document.createElement('div');
      row.className = 'gaa-tab-row';
      const name = document.createElement('span');
      name.className = 'gaa-tab-name';
      name.textContent = t.title || t.path || 'Gemini';
      name.title = t.title || t.path || 'Gemini';

      const pill = document.createElement('span');
      if (t.maybeFrozen) {
        pill.className = 'gaa-pill frozen';
        pill.textContent = '可能已冻结';
      } else {
        const [label, cls] = stateLabelMap[t.state] || ['空闲', 'idle'];
        pill.className = `gaa-pill ${cls}`;
        pill.textContent = t.queueCount > 0 ? `${label}·队${t.queueCount}` : label;
      }
      row.appendChild(name);
      row.appendChild(pill);
      popoverEl.appendChild(row);
    }
  }

  function updateBadge() {
    ensureUI();
    if (!badgeBtn) {
      return;
    }
    const peers = getActivePeerTabs();
    const approvalPeers = peers.filter((p) => p.state === 'approval').length;
    const parts = [
      `审批:${settings.autoApprove ? clickCount : '关'}`,
      `排队:${settings.queueEnabled ? queue.length : '关'}`,
      `续:${settings.autoContinue ? `${consecutiveContinues}/${MAX_CONSECUTIVE_CONTINUES}` : '关'}`,
    ];
    if (peers.length > 0) {
      parts.push(
        approvalPeers > 0
          ? `标签:${peers.length + 1}(⚠️${approvalPeers})`
          : `标签:${peers.length + 1}`
      );
    }
    const nextText = parts.join(' | ');
    if (badgeBtn.textContent !== nextText) {
      badgeBtn.textContent = nextText;
    }
  }

  function markInjected() {
    if (document.documentElement) {
      document.documentElement.dataset.geminiAutoAllow = SCRIPT_VERSION;
      document.documentElement.dataset.geminiAutoAllowClicks = String(clickCount);
      document.documentElement.dataset.geminiAutoContinue = String(settings.autoContinue);
      document.documentElement.dataset.geminiQueueLength = String(queue.length);
    }
    updateBadge();
    updateTabTitle();
    broadcastTabState();
  }

  // ==================== 主扫描循环 ====================
  function scan() {
    scanScheduled = false;
    onRouteChange();
    applyCompactTheme();
    collectConfirmationContainers().forEach(handleCard);
    flushStuckApprovalInput();
    checkSidebarApprovalFlags();
    checkQueueDispatch();
    checkAutoContinue();
    checkAutoCloseHandledTab();
    renderQueueDock();
    updateBadge();
    updateTabTitle();
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    queueMicrotask(scan);
  }

  function startBackgroundHeartbeat() {
    let fallbackTimer = null;
    const startFallback = () => {
      if (!fallbackTimer) {
        fallbackTimer = window.setInterval(() => {
          scan();
          broadcastTabState();
        }, FALLBACK_POLL_MS);
      }
    };
    try {
      const workerCode = `setInterval(() => postMessage('tick'), ${FALLBACK_POLL_MS});`;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = () => {
        scan();
        broadcastTabState();
      };
      worker.onerror = startFallback;
    } catch (_) {
      startFallback();
    }
  }

  // ==================== 启动入口 ====================
  loadQueueForCurrentChat();
  installRouteWatcher();
  setupQueueInputInterception();
  initTabChannel();
  markInjected();

  document.addEventListener('click', (e) => {
    const closeBtn = e.target?.closest?.('button[aria-label="Close sidebar"], button[aria-label*="收起侧边栏"]');
    if (closeBtn) {
      userClosedSidebar = true;
    }
    if (popoverOpen && popoverEl && badgeBtn && !popoverEl.contains(e.target) && !badgeBtn.contains(e.target)) {
      popoverOpen = false;
      popoverEl.classList.remove('open');
    }
  });
  window.addEventListener('resize', () => {
    applySavedFixedPos(badgeBtn, 'badge');
    positionQueueDock();
    positionPopover();
  });

  const observer = new MutationObserver((mutations) => {
    const hasExternalMutation = mutations.some(
      (m) => !uiRoot || !uiRoot.contains(m.target)
    );
    if (hasExternalMutation) {
      scheduleScan();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'inert', 'class', 'style', 'aria-busy'],
  });

  startBackgroundHeartbeat();
  document.addEventListener('visibilitychange', scan);
  document.addEventListener('resume', scan);
  window.addEventListener('focus', scan);
  window.addEventListener('pageshow', scan);
  scan();

  console.info(`[Gemini Auto Allow] v${SCRIPT_VERSION} 已启动（自动审批 + 消息排队 + 多标签总览）`);
})();
