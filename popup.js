/**
 * Hot-Swapper v1.0 — Chuyển đổi nhanh tài khoản
 * - Tree UI: profiles grouped by site
 * - Support ANY website (not just FB/CT)
 * - Cross-site swap: navigate + inject
 * - Export/Import profiles
 */
; (async () => {
  'use strict';

  // ============================================================
  //  CONSTANTS & CONFIG
  // ============================================================

  /** Map base domain → tất cả origins cần nuke */
  const RELATED_ORIGINS = {
    'facebook.com': [
      'https://www.facebook.com',
      'https://m.facebook.com',
      'https://web.facebook.com',
      'https://facebook.com',
    ],
    'chotot.com': [
      'https://www.chotot.com',
      'https://chotot.com',
      'https://gateway.chotot.com',
      'https://chat.chotot.com',
    ],
  };

  /** URL mặc định khi chuyển sang site */
  const DEFAULT_URL = {
    'facebook.com': 'https://www.facebook.com',
    'chotot.com': 'https://www.chotot.com',
  };

  /** Site config: icon + label */
  const SITE_CONFIG = {
    'facebook.com': { icon: '🔵', label: 'Facebook' },
    'chotot.com': { icon: '🟠', label: 'Chợ Tốt' },
  };

  const STORAGE_PREFIX = 'session_';
  const WARN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

  // ============================================================
  //  DOM REFS
  // ============================================================

  const $originDisplay = document.getElementById('originDisplay');
  const $currentAccount = document.getElementById('currentAccount');
  const $currentAccName = document.getElementById('currentAccName');
  const $actionSection = document.getElementById('actionSection');
  const $profileInput = document.getElementById('profileNameInput');
  const $saveBtn = document.getElementById('saveBtn');
  const $addNewBtn = document.getElementById('addNewBtn');
  const $profileTree = document.getElementById('profileTree');
  const $toast = document.getElementById('toast');
  const $exportBtn = document.getElementById('exportBtn');
  const $importBtn = document.getElementById('importBtn');
  const $importFileInput = document.getElementById('importFileInput');

  // ============================================================
  //  STATE
  // ============================================================

  let currentTab = null;
  let currentOrigin = '';
  let currentDomain = '';
  let baseDomain = '';
  let siteGroup = '';
  let currentAccountId = null;
  let isBusy = false;

  // ============================================================
  //  UTILS
  // ============================================================

  function getBaseDomain(hostname) {
    const parts = hostname.replace(/^www\./, '').split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  }

  function detectSiteGroup(hostname) {
    if (hostname.includes('facebook.com')) return 'facebook';
    if (hostname.includes('chotot.com')) return 'chotot';
    return 'other';
  }

  function decodeJwtPayload(token) {
    try {
      const base64 = token.split('.')[1];
      return JSON.parse(atob(base64.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return null;
    }
  }

  function getInitial(name) {
    return (name || '?').charAt(0).toUpperCase();
  }

  function showToast(message, type = 'success', duration = 2500) {
    $toast.textContent = message;
    $toast.className = `toast toast--${type} toast--visible`;
    if (duration > 0) {
      setTimeout(() => $toast.classList.remove('toast--visible'), duration);
    }
  }

  function setBusy(busy) {
    isBusy = busy;
    $saveBtn.disabled = busy;
    $addNewBtn.disabled = busy;
    $exportBtn.disabled = busy;
    $importBtn.disabled = busy;
    document.querySelectorAll('.btn--use, .btn--delete').forEach(b => {
      b.disabled = busy;
    });
  }

  function waitForTabLoad(tabId) {
    return new Promise(resolve => {
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });
  }

  function getAgeInfo(savedAt) {
    if (!savedAt || typeof savedAt !== 'number' || isNaN(savedAt)) {
      return { text: 'chưa rõ', isOld: false };
    }
    const diff = Date.now() - savedAt;
    if (diff < 0 || isNaN(diff)) return { text: 'chưa rõ', isOld: false };

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    let text;
    if (minutes < 1) text = 'vừa lưu';
    else if (minutes < 60) text = `${minutes} phút trước`;
    else if (hours < 24) text = `${hours} giờ trước`;
    else text = `${days} ngày trước`;

    return { text, isOld: diff > WARN_AGE_MS };
  }

  // ============================================================
  //  COOKIE FINGERPRINT — So khớp session cookies
  // ============================================================

  /** Cookie names thường mang session/auth, dùng để fingerprint */
  const SESSION_COOKIE_PATTERNS = [
    'session', 'sess', 'sid', 'token', 'auth', 'login', 'user',
    'account', 'jwt', 'access', 'refresh', 'csrf', 'xsrf', '_id',
    'credential', 'identity', 'remember', 'logged', 'uid',
  ];

  /**
   * Tạo fingerprint từ cookies — chỉ lấy cookies liên quan đến session
   * Trả về Map<cookieName, cookieValue>
   */
  function getSessionFingerprint(cookies) {
    const fp = new Map();
    for (const c of cookies) {
      const nameLower = c.name.toLowerCase();
      const isSession = SESSION_COOKIE_PATTERNS.some(p => nameLower.includes(p));
      // Cookie httpOnly hoặc secure thường là session cookie
      const likelySession = c.httpOnly || (isSession && c.value.length > 10);
      if (likelySession) {
        fp.set(c.name, c.value);
      }
    }
    // Nếu quá ít session cookies, lấy tất cả cookies có value dài
    if (fp.size < 3) {
      for (const c of cookies) {
        if (c.value && c.value.length > 20) {
          fp.set(c.name, c.value);
        }
      }
    }
    return fp;
  }

  /**
   * So khớp 2 fingerprints, trả về tỷ lệ match (0-1)
   */
  function matchFingerprints(fpCurrent, fpSaved) {
    if (fpSaved.size === 0) return 0;
    let matched = 0;
    for (const [name, value] of fpSaved) {
      if (fpCurrent.get(name) === value) matched++;
    }
    return matched / fpSaved.size;
  }

  // ============================================================
  //  ACCOUNT DETECTION
  // ============================================================

  /** Lữu trữ cookies hiện tại để tái sử dụng */
  let currentCookies = [];

  async function detectCurrentAccount() {
    try {
      // Lấy cookies hiện tại 1 lần
      currentCookies = await chrome.cookies.getAll({ domain: baseDomain });

      // === FACEBOOK: dùng c_user ===
      if (siteGroup === 'facebook') {
        const cUser = currentCookies.find(c => c.name === 'c_user');
        if (cUser?.value) {
          currentAccountId = cUser.value;
          return { id: cUser.value, displayName: `UID: ${cUser.value}` };
        }
      }

      // === CHỢ TỐT: scan JWT ===
      if (siteGroup === 'chotot') {
        for (const cookie of currentCookies) {
          if (cookie.value && cookie.value.length > 50 && cookie.value.includes('.')) {
            const payload = decodeJwtPayload(cookie.value);
            if (payload && (payload.sub || payload.user_id || payload.account_id)) {
              const id = String(payload.sub || payload.user_id || payload.account_id);
              const name = payload.name || payload.email || payload.fullname || `ID: ${id}`;
              currentAccountId = id;
              return { id, displayName: name };
            }
          }
        }
      }

      // === GENERIC: cookie fingerprint matching ===
      // So sánh cookies hiện tại với tất cả profiles đã lưu cùng baseDomain
      const currentFP = getSessionFingerprint(currentCookies);
      if (currentFP.size === 0) return null; // Chưa có session cookies → chưa login

      const allData = await chrome.storage.local.get(null);
      const prefix = `${STORAGE_PREFIX}${baseDomain}_`;
      let bestMatch = null;
      let bestScore = 0;

      for (const [key, pkg] of Object.entries(allData)) {
        if (!key.startsWith(prefix) || !pkg?.cookies) continue;
        const savedFP = getSessionFingerprint(pkg.cookies);
        const score = matchFingerprints(currentFP, savedFP);
        if (score > bestScore && score >= 0.5) { // >= 50% match
          bestScore = score;
          bestMatch = { key, pkg, score };
        }
      }

      if (bestMatch) {
        // Tạo ID duy nhất từ profile name + score
        currentAccountId = `fp_${bestMatch.pkg.profileName}`;
        return {
          id: currentAccountId,
          displayName: `${bestMatch.pkg.profileName} (${Math.round(bestMatch.score * 100)}% khớp)`,
        };
      }

      return null;
    } catch (err) {
      console.warn('[DetectAccount] Error:', err);
      return null;
    }
  }

  /**
   * Kiểm tra profile có khớp account đang login không
   * Dùng cookie fingerprint matching cho tất cả sites
   */
  function isProfileActive(sessionPackage) {
    if (!sessionPackage?.cookies || currentCookies.length === 0) return false;
    const profileBaseDomain = sessionPackage.baseDomain || '';
    if (baseDomain !== profileBaseDomain) return false;

    // FB: dùng c_user
    if (siteGroup === 'facebook' && currentAccountId) {
      const cUser = sessionPackage.cookies.find(c => c.name === 'c_user');
      if (cUser?.value === currentAccountId) return true;
    }

    // CT: dùng JWT ID
    if (siteGroup === 'chotot' && currentAccountId) {
      for (const cookie of sessionPackage.cookies) {
        if (cookie.value && cookie.value.length > 50 && cookie.value.includes('.')) {
          const payload = decodeJwtPayload(cookie.value);
          if (payload) {
            const id = String(payload.sub || payload.user_id || payload.account_id || '');
            if (id && id === currentAccountId) return true;
          }
        }
      }
    }

    // GENERIC: cookie fingerprint matching
    const currentFP = getSessionFingerprint(currentCookies);
    const savedFP = getSessionFingerprint(sessionPackage.cookies);
    const score = matchFingerprints(currentFP, savedFP);
    return score >= 0.5; // >= 50% cookies match
  }

  function isSessionExpired(sessionPackage) {
    const now = Date.now() / 1000;
    const group = sessionPackage.siteGroup || detectSiteGroup(sessionPackage.domain || '');

    if (group === 'facebook') {
      const xs = sessionPackage.cookies?.find(c => c.name === 'xs');
      if (xs?.expirationDate && xs.expirationDate < now) return true;
    }
    if (group === 'chotot') {
      const token = sessionPackage.cookies?.find(c => c.name === 'accessToken');
      if (token?.value) {
        const payload = decodeJwtPayload(token.value);
        if (payload?.exp && payload.exp < now) return true;
      }
    }
    return false;
  }

  async function checkIfCurrentAccountSaved() {
    if (!currentAccountId) return false;
    const allData = await chrome.storage.local.get(null);
    for (const [key, pkg] of Object.entries(allData)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      if (isProfileActive(pkg)) return true;
    }
    return false;
  }

  // ============================================================
  //  EXTRACT & SAVE
  // ============================================================

  async function extractAndSave(profileName) {
    const cookies = await chrome.cookies.getAll({ domain: baseDomain });
    console.log(`[Extract] Got ${cookies.length} cookies for ${baseDomain}`);

    let storageData = { localStorage: {}, sessionStorage: {} };
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => {
          const ls = {}, ss = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              ls[k] = localStorage.getItem(k);
            }
          } catch (_) { }
          try {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              ss[k] = sessionStorage.getItem(k);
            }
          } catch (_) { }
          return { localStorage: ls, sessionStorage: ss };
        },
      });
      storageData = result?.result || storageData;
    } catch (err) {
      console.warn('[Extract] Storage access failed:', err.message);
    }

    const sessionPackage = {
      profileName,
      accountId: currentAccountId || null, // UID ngầm
      origin: currentOrigin,
      domain: currentDomain,
      baseDomain,
      siteGroup,
      cookies,
      localStorage: storageData.localStorage,
      sessionStorage: storageData.sessionStorage,
      savedAt: Date.now(),
    };

    // Key dùng unique ID (timestamp) để không phụ thuộc vào tên
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const storageKey = `${STORAGE_PREFIX}${baseDomain}_${uniqueId}`;
    await chrome.storage.local.set({ [storageKey]: sessionPackage });
    console.log(`[Save] Saved "${profileName}" (${currentAccountId || 'generic'}) → ${storageKey}`);
    showToast(`✅ Đã lưu "${profileName}"`, 'success');
  }

  // ============================================================
  //  NUKE
  // ============================================================

  async function nukeAllOrigins(targetBaseDomain) {
    const origins = RELATED_ORIGINS[targetBaseDomain] ||
      [`https://${targetBaseDomain}`, `https://www.${targetBaseDomain}`];

    console.log(`[Nuke] Clearing ${origins.length} origins for ${targetBaseDomain}`);
    await chrome.browsingData.remove(
      { origins },
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        serviceWorkers: true,
        cacheStorage: true,
      }
    );
  }

  // ============================================================
  //  INJECT & SWAP
  // ============================================================

  async function performSwap(storageKey) {
    try {
      setBusy(true);

      const data = await chrome.storage.local.get(storageKey);
      const sessionPackage = data[storageKey];

      if (!sessionPackage) {
        showToast('❌ Không tìm thấy dữ liệu profile!', 'error');
        return;
      }

      const targetBaseDomain = sessionPackage.baseDomain || getBaseDomain(sessionPackage.domain || '');
      const isSameSite = targetBaseDomain === baseDomain;

      // Auto re-save current profile (nếu cùng site)
      if (isSameSite && currentCookies.length > 0) {
        showToast('⏳ Đang lưu phiên hiện tại...', 'loading', 0);
        await autoResaveCurrentProfile();
      }

      // NUKE target site
      showToast('⏳ Đang tẩy trắng dữ liệu cũ...', 'loading', 0);
      await nukeAllOrigins(targetBaseDomain);
      await new Promise(r => setTimeout(r, 300));

      // INJECT cookies
      showToast('⏳ Đang phục dựng phiên...', 'loading', 0);
      const cookiePromises = sessionPackage.cookies.map(cookie => {
        const cleanDomain = cookie.domain.replace(/^\./, '');
        const details = {
          url: `http${cookie.secure ? 's' : ''}://${cleanDomain}${cookie.path}`,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite || 'unspecified',
        };
        if (details.sameSite === 'no_restriction') {
          details.secure = true;
          details.url = details.url.replace('http://', 'https://');
        }
        if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
        if (cookie.domain.startsWith('.')) details.domain = cookie.domain;
        return chrome.cookies.set(details).catch(err => {
          console.warn(`[Inject] Cookie "${cookie.name}" failed:`, err.message);
        });
      });
      await Promise.all(cookiePromises);

      // Navigate or reload
      const targetUrl = DEFAULT_URL[targetBaseDomain] || sessionPackage.origin || `https://www.${targetBaseDomain}`;

      if (!isSameSite) {
        await chrome.tabs.update(currentTab.id, { url: targetUrl });
      } else {
        await chrome.tabs.reload(currentTab.id);
      }
      await waitForTabLoad(currentTab.id);

      // Inject localStorage/sessionStorage
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          func: (lsData, ssData) => {
            try { for (const [k, v] of Object.entries(lsData)) localStorage.setItem(k, v); } catch (_) { }
            try { for (const [k, v] of Object.entries(ssData)) sessionStorage.setItem(k, v); } catch (_) { }
          },
          args: [sessionPackage.localStorage || {}, sessionPackage.sessionStorage || {}],
        });
      } catch (e) {
        console.warn('[Inject] Storage injection failed:', e.message);
      }

      // Update state
      const newUrl = new URL(targetUrl);
      currentOrigin = newUrl.origin;
      currentDomain = newUrl.hostname;
      baseDomain = getBaseDomain(currentDomain);
      siteGroup = detectSiteGroup(currentDomain);

      showToast(`✅ Đã chuyển sang "${sessionPackage.profileName}"`, 'success', 3000);
    } catch (err) {
      console.error('[Swap] Error:', err);
      showToast(`❌ Lỗi chuyển đổi: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  //  AUTO RE-SAVE
  // ============================================================

  async function autoResaveCurrentProfile() {
    if (currentCookies.length === 0) return; // Chưa load cookies
    const allData = await chrome.storage.local.get(null);
    const prefix = `${STORAGE_PREFIX}${baseDomain}_`;

    for (const [key, pkg] of Object.entries(allData)) {
      if (!key.startsWith(prefix)) continue;
      if (isProfileActive(pkg)) {
        console.log(`[AutoReSave] Updating "${pkg.profileName}"...`);
        const freshCookies = await chrome.cookies.getAll({ domain: baseDomain });

        let freshStorage = { localStorage: {}, sessionStorage: {} };
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            func: () => {
              const ls = {}, ss = {};
              try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch (_) { }
              try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); } } catch (_) { }
              return { localStorage: ls, sessionStorage: ss };
            },
          });
          freshStorage = result?.result || freshStorage;
        } catch (_) { }

        const updated = {
          ...pkg,
          cookies: freshCookies,
          localStorage: freshStorage.localStorage,
          sessionStorage: freshStorage.sessionStorage,
          savedAt: Date.now(),
        };
        await chrome.storage.local.set({ [key]: updated });
        break;
      }
    }
  }

  // ============================================================
  //  DELETE
  // ============================================================

  async function deleteProfile(storageKey, profileName) {
    await chrome.storage.local.remove(storageKey);
    showToast(`🗑 Đã xóa "${profileName}"`, 'success');
    await renderProfileTree();
  }

  // ============================================================
  //  RENDER PROFILE TREE
  // ============================================================

  async function renderProfileTree() {
    const allData = await chrome.storage.local.get(null);

    // Collect ALL profiles
    const allProfiles = Object.keys(allData)
      .filter(key => key.startsWith(STORAGE_PREFIX))
      .map(key => ({ key, data: allData[key] }))
      .filter(({ data }) => data && data.profileName);

    $profileTree.innerHTML = '';

    if (allProfiles.length === 0) {
      $profileTree.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📭</div>
          <div class="empty-state__text">
            Chưa có nick nào được lưu.<br>
            Đăng nhập tài khoản → Nhập tên → Bấm "Lưu & Thêm nick mới".
          </div>
        </div>
      `;
      return;
    }

    // Group by baseDomain
    const groups = {};
    allProfiles.forEach(({ key, data }) => {
      const bd = data.baseDomain || getBaseDomain(data.domain || 'unknown');
      if (!groups[bd]) groups[bd] = [];
      groups[bd].push({ key, data });
    });

    // Sort: current site first, then alphabetical
    const sortedDomains = Object.keys(groups).sort((a, b) => {
      if (a === baseDomain) return -1;
      if (b === baseDomain) return 1;
      return a.localeCompare(b);
    });

    sortedDomains.forEach(domain => {
      const profiles = groups[domain];
      const config = SITE_CONFIG[domain] || { icon: '🌐', label: domain };

      // Sort: active first, then by name
      profiles.sort((a, b) => {
        const aActive = isProfileActive(a.data) ? -1 : 0;
        const bActive = isProfileActive(b.data) ? -1 : 0;
        if (aActive !== bActive) return aActive - bActive;
        return (a.data.profileName || '').localeCompare(b.data.profileName || '');
      });

      // Group container
      const group = document.createElement('div');
      group.className = 'site-group';

      // Header
      const header = document.createElement('div');
      header.className = 'site-group__header';
      header.innerHTML = `
        <span class="site-group__icon">${config.icon}</span>
        <span>${config.label}</span>
        <span class="site-group__count">${profiles.length}</span>
      `;
      group.appendChild(header);

      // Profile cards
      profiles.forEach(({ key, data }) => {
        const isActive = isProfileActive(data);
        const isExpired = isSessionExpired(data);
        const ageInfo = getAgeInfo(data.savedAt);

        const card = document.createElement('div');
        card.className = `profile-card${isActive ? ' profile-card--active' : ''}`;

        // Avatar
        const avatar = document.createElement('div');
        avatar.className = `profile-card__avatar${isActive ? ' profile-card__avatar--active' : ''}`;
        avatar.textContent = getInitial(data.profileName);

        // Info
        const info = document.createElement('div');
        info.className = 'profile-card__info';

        const name = document.createElement('div');
        name.className = 'profile-card__name';
        name.textContent = data.profileName;

        const meta = document.createElement('div');
        meta.className = 'profile-card__meta';

        if (isActive) {
          const badge = document.createElement('span');
          badge.className = 'badge badge--active';
          badge.textContent = '● Đang dùng';
          meta.appendChild(badge);
        }

        if (isExpired) {
          const badge = document.createElement('span');
          badge.className = 'badge badge--expired';
          badge.textContent = '⚠ Hết hạn';
          meta.appendChild(badge);
        }

        const ageBadge = document.createElement('span');
        ageBadge.className = `profile-card__age${ageInfo.isOld ? ' profile-card__age--warn' : ''}`;
        ageBadge.textContent = ageInfo.text;
        meta.appendChild(ageBadge);

        info.appendChild(name);
        info.appendChild(meta);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'profile-card__actions';

        if (!isActive) {
          const useBtn = document.createElement('button');
          useBtn.className = 'btn btn--use';
          useBtn.innerHTML = '▶ Dùng';
          useBtn.title = `Chuyển sang "${data.profileName}"`;
          useBtn.disabled = isBusy;
          useBtn.addEventListener('click', async () => {
            useBtn.innerHTML = '<span class="spinner"></span>';
            useBtn.disabled = true;
            await performSwap(key);
            await refreshPopupState();
          });
          actions.appendChild(useBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn--delete';
        delBtn.innerHTML = '✕';
        delBtn.title = `Xóa "${data.profileName}"`;
        delBtn.disabled = isBusy;
        delBtn.addEventListener('click', async () => {
          if (confirm(`Xóa nick "${data.profileName}"?`)) {
            await deleteProfile(key, data.profileName);
          }
        });
        actions.appendChild(delBtn);

        card.appendChild(avatar);
        card.appendChild(info);
        card.appendChild(actions);
        group.appendChild(card);
      });

      $profileTree.appendChild(group);
    });
  }

  // ============================================================
  //  EXPORT / IMPORT
  // ============================================================

  async function exportProfiles() {
    const allData = await chrome.storage.local.get(null);
    const exportData = {};
    let count = 0;

    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith(STORAGE_PREFIX)) {
        exportData[key] = value;
        count++;
      }
    }

    if (count === 0) {
      showToast('⚠️ Không có profile nào để xuất!', 'error');
      return;
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);

    const a = document.createElement('a');
    a.href = url;
    a.download = `hotswapper_backup_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`📤 Đã xuất ${count} profile!`, 'success');
  }

  async function importProfiles(file) {
    try {
      const text = await file.text();
      const importData = JSON.parse(text);

      // Lọc profiles hợp lệ
      const allImported = {};
      for (const [key, value] of Object.entries(importData)) {
        if (key.startsWith(STORAGE_PREFIX) && value?.profileName) {
          allImported[key] = value;
        }
      }

      const importEntries = Object.entries(allImported);
      if (importEntries.length === 0) {
        showToast('⚠️ Không tìm thấy profile hợp lệ!', 'error');
        return;
      }

      // Lấy profiles hiện có
      const existingData = await chrome.storage.local.get(null);
      const existingProfiles = {}; // "name|domain" → { key, pkg }
      for (const [key, pkg] of Object.entries(existingData)) {
        if (!key.startsWith(STORAGE_PREFIX) || !pkg?.profileName) continue;
        const uid = `${pkg.profileName}|${pkg.baseDomain}`;
        existingProfiles[uid] = { key, pkg };
      }

      // Phân loại: mới / trùng (cần merge)
      let added = 0, updated = 0, skipped = 0;
      const toSet = {};
      const toRemove = [];

      for (const [importKey, imported] of importEntries) {
        const uid = `${imported.profileName}|${imported.baseDomain}`;
        const existing = existingProfiles[uid];

        if (!existing) {
          // Profile mới → thêm luôn
          toSet[importKey] = imported;
          added++;
        } else {
          // Trùng → so sánh savedAt, mới hơn thắng
          const importedAt = imported.savedAt || 0;
          const existingAt = existing.pkg.savedAt || 0;
          if (importedAt > existingAt) {
            // Import mới hơn → xóa cũ, thêm mới
            toRemove.push(existing.key);
            toSet[importKey] = imported;
            updated++;
          } else {
            // Existing mới hơn → giữ nguyên
            skipped++;
          }
        }
      }

      if (added === 0 && updated === 0) {
        showToast(`ℹ️ Tất cả ${skipped} profile đã tồn tại (mới hơn hoặc bằng).`, 'success');
        return;
      }

      // Confirm nếu có overwrite
      if (updated > 0) {
        if (!confirm(`Merge: +${added} mới, ↻${updated} cập nhật, =${skipped} giữ nguyên. Tiếp tục?`)) {
          return;
        }
      }

      // Thực hiện merge
      if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
      await chrome.storage.local.set(toSet);

      showToast(`📥 +${added} mới, ↻${updated} cập nhật, =${skipped} giữ nguyên`, 'success', 3500);
      await renderProfileTree();
    } catch (err) {
      console.error('[Import] Error:', err);
      showToast(`❌ Lỗi nhập: ${err.message}`, 'error');
    }
  }

  // ============================================================
  //  REFRESH STATE (after swap/nuke/reload)
  // ============================================================

  async function refreshPopupState() {
    currentAccountId = null;
    const account = await detectCurrentAccount();

    if (account) {
      $currentAccount.style.display = 'flex';
      $currentAccName.textContent = account.displayName;
      $currentAccName.style.opacity = '1';
    } else {
      $currentAccount.style.display = 'none';
    }

    $originDisplay.textContent = currentDomain;

    await renderProfileTree();

    // Luôn hiện action section
    $actionSection.style.display = 'block';
    // KHÔNG auto-fill input với UID — để user tự đặt tên thân thiện
  }

  // ============================================================
  //  INIT
  // ============================================================

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab;

      if (!tab?.url || tab.url.startsWith('chrome://')) {
        $originDisplay.textContent = 'Trang hệ thống';
        $actionSection.style.display = 'none';
        $currentAccount.style.display = 'none';
        await renderProfileTree();
        return;
      }

      const url = new URL(tab.url);
      currentOrigin = url.origin;
      currentDomain = url.hostname;
      baseDomain = getBaseDomain(currentDomain);
      siteGroup = detectSiteGroup(currentDomain);

      $originDisplay.textContent = currentDomain;

      // Detect account
      const account = await detectCurrentAccount();
      if (account) {
        $currentAccount.style.display = 'flex';
        $currentAccName.textContent = account.displayName;
        $currentAccName.style.opacity = '1';
        // KHÔNG auto-fill input với UID
      } else {
        // Không detect được → ẩn section, không hiện "Chưa đăng nhập"
        $currentAccount.style.display = 'none';
      }

      // Render tree
      await renderProfileTree();

      // Luôn hiện action section (2 nút: Lưu + Thêm mới)
      $actionSection.style.display = 'block';

      // Placeholder by site
      const siteConf = SITE_CONFIG[baseDomain];
      if (siteConf) {
        $profileInput.placeholder = `Nhập tên nick ${siteConf.label}...`;
      } else {
        $profileInput.placeholder = `Nhập tên nick ${baseDomain}...`;
      }

      // ======== EVENT: Enter key → trigger Save ========
      $profileInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') $saveBtn.click();
      });

      // ======== EVENT: 💾 Lưu (chỉ save, không nuke) ========
      $saveBtn.addEventListener('click', async () => {
        const name = $profileInput.value.trim();
        if (!name) {
          showToast('⚠️ Nhập tên nick trước!', 'error');
          $profileInput.focus();
          return;
        }
        // Kiểm tra trùng tên (không dùng key, duyệt profileName)
        const allData = await chrome.storage.local.get(null);
        const prefix = `${STORAGE_PREFIX}${baseDomain}_`;
        const duplicate = Object.entries(allData).find(([k, v]) =>
          k.startsWith(prefix) && v.profileName === name
        );
        if (duplicate && !confirm(`Nick "${name}" đã tồn tại. Ghi đè?`)) return;
        // Nếu ghi đè → xóa key cũ
        if (duplicate) await chrome.storage.local.remove(duplicate[0]);

        try {
          setBusy(true);
          $saveBtn.innerHTML = '<span class="spinner"></span>';
          await extractAndSave(name);
          await renderProfileTree();
          showToast(`✅ Đã lưu "${name}"`, 'success');
        } catch (err) {
          console.error('[Save]', err);
          showToast(`❌ Lỗi: ${err.message}`, 'error');
        } finally {
          setBusy(false);
          $saveBtn.innerHTML = '💾 Lưu';
        }
      });

      // ======== EVENT: ➕ Thêm mới (auto-resave → nuke → reload) ========
      $addNewBtn.addEventListener('click', async () => {
        try {
          setBusy(true);
          $addNewBtn.innerHTML = '<span class="spinner"></span>';

          // Auto-resave profile đang active (nếu có)
          showToast('⏳ Đang lưu phiên hiện tại...', 'loading', 0);
          await autoResaveCurrentProfile();

          // Nuke
          showToast('⏳ Đang dọn sạch...', 'loading', 0);
          await nukeAllOrigins(baseDomain);
          await new Promise(r => setTimeout(r, 300));

          // Reload
          showToast('⏳ Đang tải lại trang...', 'loading', 0);
          await chrome.tabs.reload(currentTab.id);
          await waitForTabLoad(currentTab.id);
          await refreshPopupState();
          $profileInput.value = '';
          showToast('✅ Sẵn sàng đăng nhập nick mới!', 'success');
        } catch (err) {
          console.error('[AddNew]', err);
          showToast(`❌ Lỗi: ${err.message}`, 'error');
        } finally {
          setBusy(false);
          $addNewBtn.innerHTML = '➕ Thêm mới';
        }
      });

    } catch (err) {
      console.error('[Init] Error:', err);
      showToast(`❌ Lỗi khởi tạo: ${err.message}`, 'error');
    }
  }

  // ======== EVENT: Export ========
  $exportBtn.addEventListener('click', () => exportProfiles());

  // ======== EVENT: Import ========
  $importBtn.addEventListener('click', () => $importFileInput.click());
  $importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await importProfiles(file);
      $importFileInput.value = '';
    }
  });

  // ======== START ========
  await init();
})();
