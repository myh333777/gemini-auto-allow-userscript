// ==UserScript==
// @name         Gemini MCP & Task Auto Always Allow
// @namespace    https://github.com/myh333777/gemini-auto-allow-userscript
// @version      2.0.2
// @description  Automatically clicks "始终允许" (Always allow) — or fallback Allow — on Gemini confirmation cards across Chat & Task modes.
// @author       myh333777
// @match        https://gemini.google.com/*
// @homepageURL  https://github.com/myh333777/gemini-auto-allow-userscript
// @supportURL   https://github.com/myh333777/gemini-auto-allow-userscript/issues
// @updateURL    https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @downloadURL  https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置项 ====================
  const CLICK_DELAY_MS = 150;
  // 若卡片没有“始终允许”，是否回退点击“在此对话中允许”或“允许 / 允许一次”
  const FALLBACK_TO_CHAT_OR_ONCE = true;
  // ==============================================

  const CARD_SELECTOR = 'remy-confirmation-card, remy-confirmation-card-v2';

  // 确认这是一张工具/权限审批卡片（必须同时存在拒绝类按钮，避免误点普通横幅）
  const DENY_PATTERNS = [
    /^(不允许|拒绝)$/i,
    /^(deny|don['’]t allow|disallow|decline)$/i,
  ];

  // 按钮点击优先级：始终允许 > 本次对话允许 > 允许/允许一次
  const ALWAYS_ALLOW_PATTERNS = [
    /^(始终允许|总是允许)$/i,
    /^(always allow|allow always)$/i,
  ];

  const FALLBACK_ALLOW_PATTERNS = [
    /^(在此对话中允许|本对话允许)$/i,
    /^allow for this chat$/i,
    /^(允许一次|允许)$/i,
    /^(allow once|allow)$/i,
  ];

  const scheduledButtons = new WeakSet();
  let scanScheduled = false;

  function normalizeText(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
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
    const style = window.getComputedStyle(button);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findTargetButton(card) {
    const buttons = [...card.querySelectorAll('button')];
    if (buttons.length === 0) {
      return null;
    }

    // 1. 先确认卡片内存在“不允许 / 拒绝”按钮（确保是权限确认卡片）
    const hasDenyButton = buttons.some((btn) =>
      matchesAny(normalizeText(btn), DENY_PATTERNS)
    );
    if (!hasDenyButton) {
      return null;
    }

    // 2. 优先匹配“始终允许 / Always allow”
    const enabledButtons = buttons.filter(isButtonEnabled);
    for (const pattern of ALWAYS_ALLOW_PATTERNS) {
      const match = enabledButtons.find((btn) =>
        pattern.test(normalizeText(btn))
      );
      if (match) {
        return match;
      }
    }

    // 3. 按需回退匹配“在此对话中允许 / 允许一次 / 允许”
    if (FALLBACK_TO_CHAT_OR_ONCE) {
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

  function handleCard(card) {
    const targetButton = findTargetButton(card);
    if (!targetButton || scheduledButtons.has(targetButton)) {
      return;
    }

    scheduledButtons.add(targetButton);
    const label = normalizeText(targetButton);

    const doClick = () => {
      if (isButtonEnabled(targetButton) && findTargetButton(card) === targetButton) {
        targetButton.click();
        console.info(`[Gemini Auto Allow] 已自动点击「${label}」`);
      }
    };

    // 后台标签页直接点击，绕过浏览器对后台定时器（1s/60s）的节流；前台保留短暂延迟
    if (document.hidden || CLICK_DELAY_MS <= 0) {
      doClick();
    } else {
      window.setTimeout(doClick, CLICK_DELAY_MS);
    }
  }

  function scan() {
    scanScheduled = false;
    document.querySelectorAll(CARD_SELECTOR).forEach(handleCard);
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    // 微任务不受后台标签页定时器节流影响，同时合并同一次 DOM 批量更新
    queueMicrotask(scan);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'inert', 'class', 'style'],
  });

  scheduleScan();
})();
