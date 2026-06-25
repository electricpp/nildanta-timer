// ============================================================
//  NILDANTA-TIMER — script.js
//  Vanilla JS · Firebase Realtime Database (compat SDK v9)
// ============================================================

// ── Firebase init ──────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

// ── Refs ───────────────────────────────────────────────────
const usersRef    = () => db.ref('users');
const userRef     = u  => db.ref(`users/${u}`);
const subjectsRef = u  => db.ref(`subjects/${u}`);
const statsRef    = u  => db.ref(`stats/${u}`);
const statsDayRef = (u, d) => db.ref(`stats/${u}/${d}`);

// ── App State ──────────────────────────────────────────────
let currentUser   = null;   // logged-in username string
let subjects      = [];     // user's subject list
let allUsers      = {};     // live snapshot of all users node
let usersListener = null;   // firebase listener ref for cleanup

// Active timer state per subject (in memory only while running)
// { [subjectName]: { type:'stopwatch'|'countdown', startEpoch, targetSecs } }
let runningTimers = {};

// All-time totals derived from stats node (synced source of truth for timer rows)
// { [subjectName]: totalSeconds }
let allTimeStatsCache = {};

// ── Utility ────────────────────────────────────────────────
function secsToHMS(s) {
  s = Math.max(0, Math.floor(s));
  const h   = String(Math.floor(s / 3600)).padStart(2, '0');
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function HMSToSecs(hms) {
  const parts = hms.split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 3600) + (parts[1] * 60);
  return 0;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Returns Monday of the week at `offset` weeks from current
function weekStart(offset = 0) {
  const d   = new Date();
  const day = d.getDay(); // 0=Sun
  const diffToMon = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMon + offset * 7);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function weekEnd(offset = 0) {
  const d = new Date(weekStart(offset));
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function monthKey(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function monthLabel(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleString('default', { month: 'long' }) + ' - ' + d.getFullYear();
}

function getTodayOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function weekLabel(offset) {
  return `Week of ${formatDate(weekStart(offset))}`;
}

function slugify(s) {
  return s.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// ── All-Time Stats Cache ───────────────────────────────────
// Computes all-time totals per subject by summing the entire stats node.
// This keeps timer row totals perfectly in sync with manually edited stats.
async function refreshAllTimeStats() {
  const snap = await statsRef(currentUser).get();
  const agg  = {};
  const data = snap.val() || {};
  Object.values(data).forEach(dayData => {
    Object.entries(dayData).forEach(([subj, secs]) => {
      agg[subj] = (agg[subj] || 0) + secs;
    });
  });
  allTimeStatsCache = agg;
  refreshTimerRowsFromCloud();
}


function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); el.scrollTop = 0; }
}

function showNavbar(active) {
  const nb = document.getElementById('navbar');
  nb.classList.add('visible');
  nb.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === active);
  });
}

function hideNavbar() {
  document.getElementById('navbar').classList.remove('visible');
}

// ── Authentication ─────────────────────────────────────────
function initAuth() {
  // Tab switching between Sign Up / Log In
  document.querySelectorAll('.auth-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
      document.getElementById(`form-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Live username availability check (sign-up form)
  const signUser = document.getElementById('sign-username');
  let checkTimeout;
  signUser.addEventListener('input', () => {
    clearTimeout(checkTimeout);
    const avail = document.getElementById('avail-status');
    const val   = signUser.value.trim();
    if (!val) { avail.className = 'availability hidden'; return; }
    checkTimeout = setTimeout(async () => {
      const snap = await userRef(val).child('password').get();
      if (snap.exists()) {
        avail.innerHTML = '<span class="avail-icon">&#x2612;</span> Username Taken';
        avail.className = 'availability taken';
      } else {
        avail.innerHTML = '<span class="avail-icon">&#x2611;</span> Username Available';
        avail.className = 'availability available';
      }
    }, 400);
  });

  // Sign Up
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const u = document.getElementById('sign-username').value.trim();
    const p = document.getElementById('sign-password').value.trim();
    if (!u || !p) { showToast('Enter a username and password'); return; }
    const snap = await userRef(u).child('password').get();
    if (snap.exists()) { showToast('Username already taken'); return; }
    await userRef(u).set({ password: p, online: false, activeSubject: '', activeStartTime: 0, timers: {} });
    const defaults = ['Bangla','English','ICT','Physics','Chemistry','Math','Biology'];
    await subjectsRef(u).set(defaults);
    handleLogin(u, document.getElementById('sign-remember').checked);
  });

  // Log In
  document.getElementById('btn-login').addEventListener('click', async () => {
    const u = document.getElementById('log-username').value.trim();
    const p = document.getElementById('log-password').value.trim();
    if (!u || !p) { showToast('Enter your username and password'); return; }
    const snap = await userRef(u).child('password').get();
    if (!snap.exists() || snap.val() !== p) { showToast('Invalid username or password'); return; }
    handleLogin(u, document.getElementById('log-remember').checked);
  });
}

function handleLogin(username, remember) {
  currentUser = username;
  if (remember) localStorage.setItem('nt_user', username);
  else          localStorage.removeItem('nt_user');
  startApp();
}

async function logout() {
  if (currentUser) {
    await stopAllTimers();
    await userRef(currentUser).update({ online: false, activeSubject: '', activeStartTime: 0 });
  }
  // Detach firebase listener
  if (usersListener) { usersRef().off('value', usersListener); usersListener = null; }
  // Clear intervals
  ['_rowTickInterval','_timerScreenInterval','_peopleTickInterval'].forEach(k => {
    if (window[k]) { clearInterval(window[k]); window[k] = null; }
  });
  localStorage.removeItem('nt_user');
  currentUser   = null;
  subjects      = [];
  allUsers      = {};
  runningTimers = {};
  allTimeStatsCache = {};
  myStatsPeriods    = { today: 0, week: 0, month: 0 };
  otherStatsPeriods = { today: 0, week: 0, month: 0 };
  editDateOffset    = 0;
  lbTab             = 'this';
  hideNavbar();
  // Reset auth form to Sign Up tab
  document.querySelectorAll('.auth-tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  document.querySelectorAll('.auth-form').forEach((f,i) => f.classList.toggle('hidden', i!==0));
  ['log-username','log-password','sign-username','sign-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('avail-status').className = 'availability hidden';
  showView('view-auth');
}

// ── App Boot ───────────────────────────────────────────────
async function startApp() {
  // Attach live listener for all users (drives People screen + online dots)
  usersListener = usersRef().on('value', snap => {
    allUsers = snap.val() || {};
    refreshPeopleIfVisible();
    // Timer rows now use stats cache, not allUsers.timers — no refresh needed here
  });
  await loadSubjects();
  await refreshAllTimeStats();   // populate all-time cache from stats before first render
  renderTimersView();
  navigateTo('timers');
}

async function loadSubjects() {
  const snap = await subjectsRef(currentUser).get();
  subjects = snap.val() || [];
}

function navigateTo(tab) {
  if (tab === 'timers') {
    renderTimersView();
    showView('view-timers');
    showNavbar('timers');
    startRowTicks();
  } else if (tab === 'home') {
    myStatsPeriods = { today: 0, week: 0, month: 0 };
    renderMyStats();
    showView('view-mystats');
    showNavbar('home');
  } else if (tab === 'people') {
    renderPeople();
    showView('view-people');
    showNavbar('people');
    startPeopleTick();
  }
}

// ── Timers View ────────────────────────────────────────────
function renderTimersView() {
  document.getElementById('timers-username').textContent = currentUser;
  const list = document.getElementById('subjects-list');
  list.innerHTML = '';
  subjects.forEach(subj => {
    const row = document.createElement('div');
    row.className = 'subject-row';
    row.innerHTML = `
      <span class="subj-name">${subj}</span>
      <span class="subj-time" id="trow-${slugify(subj)}">${secsToHMS(getRunningDisplay(subj))}</span>
    `;
    row.addEventListener('click', () => openTimerScreen(subj));
    list.appendChild(row);
  });
}

// All-time stored seconds for a subject — reads from stats-derived cache
function getAllTimeSecs(subj) {
  return allTimeStatsCache[subj] || 0;
}

// Current display value (stored + live elapsed if running stopwatch)
function getRunningDisplay(subj) {
  const stored = getAllTimeSecs(subj);
  if (runningTimers[subj] && runningTimers[subj].type === 'stopwatch') {
    return stored + (Date.now() - runningTimers[subj].startEpoch) / 1000;
  }
  return stored;
}

function refreshTimerRowsFromCloud() {
  subjects.forEach(subj => {
    const el = document.getElementById(`trow-${slugify(subj)}`);
    if (el) el.textContent = secsToHMS(getRunningDisplay(subj));
  });
}

function startRowTicks() {
  if (window._rowTickInterval) clearInterval(window._rowTickInterval);
  window._rowTickInterval = setInterval(() => {
    subjects.forEach(subj => {
      const el = document.getElementById(`trow-${slugify(subj)}`);
      if (el) el.textContent = secsToHMS(getRunningDisplay(subj));
    });
  }, 1000);
}

// ── Customize Timers ───────────────────────────────────────
function openCustomize() {
  renderCustomize();
  showView('view-customize');
  hideNavbar();
}

function renderCustomize() {
  document.getElementById('customize-username').textContent = currentUser;
  const list = document.getElementById('customize-list');
  list.innerHTML = '';
  subjects.forEach((subj, idx) => {
    const row = document.createElement('div');
    row.className = 'subject-row';
    row.innerHTML = `
      <span class="subj-name">${subj}</span>
      <div class="subj-actions">
        <button class="btn-icon" title="Rename" data-idx="${idx}">&#x270E;</button>
        <button class="btn-icon red" title="Delete" data-idx="${idx}">&#x1F5D1;</button>
      </div>
    `;
    const [renameBtn, deleteBtn] = row.querySelectorAll('.btn-icon');
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); openRenameSubjectModal(idx); });
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSubject(idx); });
    list.appendChild(row);
  });
}

async function addSubject() {
  const input = document.getElementById('new-subject-input');
  const name  = input.value.trim();
  if (!name) return;
  if (subjects.includes(name)) { showToast('Subject already exists'); return; }
  subjects.push(name);
  await subjectsRef(currentUser).set(subjects);
  input.value = '';
  renderCustomize();
  showToast(`${name} added`);
}

async function deleteSubject(idx) {
  if (runningTimers[subjects[idx]]) { showToast('Stop the timer before deleting'); return; }
  const removed = subjects.splice(idx, 1)[0];
  await subjectsRef(currentUser).set(subjects);
  renderCustomize();
  showToast(`${removed} removed`);
}

function openRenameSubjectModal(idx) {
  const modal = document.getElementById('modal-rename-subject');
  const input = document.getElementById('rename-subject-input');
  input.value = subjects[idx];
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  document.getElementById('btn-rename-subject-confirm').onclick = async () => {
    const newName = input.value.trim();
    if (!newName) { showToast('Enter a name'); return; }
    if (newName === subjects[idx]) { modal.classList.add('hidden'); return; }
    if (subjects.includes(newName)) { showToast('Subject already exists'); return; }
    const old = subjects[idx];
    subjects[idx] = newName;
    await subjectsRef(currentUser).set(subjects);
    // Move all-time timer value to new key
    const snap = await userRef(currentUser).child(`timers/${old}`).get();
    if (snap.exists()) {
      await userRef(currentUser).child(`timers/${newName}`).set(snap.val());
      await userRef(currentUser).child(`timers/${old}`).remove();
    }
    modal.classList.add('hidden');
    renderCustomize();
    showToast('Subject renamed');
  };
  document.getElementById('btn-rename-subject-cancel').onclick = () => modal.classList.add('hidden');
}

// ── Timer Screen ───────────────────────────────────────────
let currentTimerSubject = null;

function openTimerScreen(subj) {
  currentTimerSubject = subj;
  document.getElementById('timer-subject-label').textContent = subj;
  renderTimerScreen();
  showView('view-timer');
  hideNavbar();
  startTimerScreenTick();
}

function renderTimerScreen() {
  const subj        = currentTimerSubject;
  const swDisplay   = document.getElementById('sw-display');
  const cdDisplay   = document.getElementById('cd-display');
  const isSwRunning = runningTimers[subj] && runningTimers[subj].type === 'stopwatch';
  const isCdRunning = runningTimers[subj] && runningTimers[subj].type === 'countdown';

  if (isSwRunning) {
    swDisplay.classList.add('running');
    const elapsed = (Date.now() - runningTimers[subj].startEpoch) / 1000;
    document.getElementById('sw-time').textContent = secsToHMS(elapsed);
  } else {
    swDisplay.classList.remove('running');
    document.getElementById('sw-time').textContent = '00:00:00';
  }

  if (isCdRunning) {
    cdDisplay.classList.add('running');
    const remaining = runningTimers[subj].targetSecs - (Date.now() - runningTimers[subj].startEpoch) / 1000;
    document.getElementById('cd-time').textContent = secsToHMS(remaining);
  } else {
    cdDisplay.classList.remove('running');
    document.getElementById('cd-time').textContent = '00:00:00';
  }
}

function startTimerScreenTick() {
  if (window._timerScreenInterval) clearInterval(window._timerScreenInterval);
  window._timerScreenInterval = setInterval(() => {
    const subj = currentTimerSubject;
    if (!subj || !runningTimers[subj]) return;
    if (runningTimers[subj].type === 'stopwatch') {
      const elapsed = (Date.now() - runningTimers[subj].startEpoch) / 1000;
      document.getElementById('sw-time').textContent = secsToHMS(elapsed);
    } else if (runningTimers[subj].type === 'countdown') {
      const remaining = runningTimers[subj].targetSecs - (Date.now() - runningTimers[subj].startEpoch) / 1000;
      if (remaining <= 0) {
        document.getElementById('cd-time').textContent = '00:00:00';
        document.getElementById('cd-display').classList.remove('running');
        cdAutoFinish(subj);
      } else {
        document.getElementById('cd-time').textContent = secsToHMS(remaining);
      }
    }
  }, 500);
}

// Stopwatch controls
function swStart() {
  const subj = currentTimerSubject;
  if (runningTimers[subj]) { showToast('Stop the running timer first'); return; }
  runningTimers[subj] = { type: 'stopwatch', startEpoch: Date.now() };
  setOnline(subj);
  document.getElementById('sw-display').classList.add('running');
}

async function swStop() {
  const subj = currentTimerSubject;
  if (!runningTimers[subj] || runningTimers[subj].type !== 'stopwatch') return;
  const elapsed = Math.floor((Date.now() - runningTimers[subj].startEpoch) / 1000);
  delete runningTimers[subj];
  document.getElementById('sw-display').classList.remove('running');
  document.getElementById('sw-time').textContent = '00:00:00';
  setOfflineIfIdle();
  await saveElapsedToStats(subj, elapsed);
  showToast(`Saved ${secsToHMS(elapsed)} to ${subj}`);
}

function swReset() {
  const subj = currentTimerSubject;
  if (runningTimers[subj] && runningTimers[subj].type === 'stopwatch') {
    showToast('Stop the stopwatch before resetting');
    return;
  }
  document.getElementById('sw-time').textContent = '00:00:00';
}

// Countdown controls
function cdStart() {
  const subj = currentTimerSubject;
  if (runningTimers[subj]) { showToast('Stop the running timer first'); return; }
  const h = parseInt(document.getElementById('cd-hours').value)   || 0;
  const m = parseInt(document.getElementById('cd-minutes').value)  || 0;
  const targetSecs = h * 3600 + m * 60;
  if (targetSecs === 0) { showToast('Set hours or minutes first'); return; }
  runningTimers[subj] = { type: 'countdown', startEpoch: Date.now(), targetSecs };
  setOnline(subj);
  document.getElementById('cd-display').classList.add('running');
  document.getElementById('cd-time').textContent = secsToHMS(targetSecs);
}

async function cdStop() {
  const subj = currentTimerSubject;
  if (!runningTimers[subj] || runningTimers[subj].type !== 'countdown') return;
  const elapsed = Math.floor((Date.now() - runningTimers[subj].startEpoch) / 1000);
  delete runningTimers[subj];
  document.getElementById('cd-display').classList.remove('running');
  document.getElementById('cd-time').textContent = '00:00:00';
  setOfflineIfIdle();
  if (elapsed > 0) await saveElapsedToStats(subj, elapsed);
  showToast(`Saved ${secsToHMS(elapsed)} to ${subj}`);
}

async function cdAutoFinish(subj) {
  if (!runningTimers[subj]) return;
  const elapsed = runningTimers[subj].targetSecs;
  delete runningTimers[subj];
  setOfflineIfIdle();
  await saveElapsedToStats(subj, elapsed);
  showToast(`Countdown done! Saved ${secsToHMS(elapsed)} to ${subj}`);
}

function cdReset() {
  const subj = currentTimerSubject;
  if (runningTimers[subj] && runningTimers[subj].type === 'countdown') {
    showToast('Stop the countdown before resetting');
    return;
  }
  document.getElementById('cd-time').textContent = '00:00:00';
  document.getElementById('cd-hours').value   = '00';
  document.getElementById('cd-minutes').value = '00';
}

// ── Save & Online Status ───────────────────────────────────
async function saveElapsedToStats(subj, secs) {
  if (secs <= 0) return;
  const day = todayKey();
  // Stats (daily breakdown) — single source of truth
  const daySnap = await statsDayRef(currentUser, day).child(subj).get();
  const prevDay = daySnap.exists() ? daySnap.val() : 0;
  await statsDayRef(currentUser, day).child(subj).set(prevDay + secs);
  // Update local all-time cache immediately so timer rows refresh instantly
  allTimeStatsCache[subj] = (allTimeStatsCache[subj] || 0) + secs;
}

function setOnline(subj) {
  userRef(currentUser).update({ online: true, activeSubject: subj, activeStartTime: Date.now() });
}

function setOfflineIfIdle() {
  if (Object.keys(runningTimers).length === 0) {
    userRef(currentUser).update({ online: false, activeSubject: '', activeStartTime: 0 });
  }
}

async function stopAllTimers() {
  const keys = Object.keys(runningTimers);
  for (const subj of keys) {
    const elapsed = Math.floor((Date.now() - runningTimers[subj].startEpoch) / 1000);
    if (elapsed > 0) await saveElapsedToStats(subj, elapsed);
  }
  runningTimers = {};
}

// ── People Screen ──────────────────────────────────────────
function renderPeople() {
  const container = document.getElementById('people-list');
  container.innerHTML = '';
  if (!allUsers || Object.keys(allUsers).length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--muted);padding:24px 0">No other users yet</p>';
    return;
  }

  const onlineUsers  = [];
  const offlineUsers = [];
  Object.entries(allUsers).forEach(([uname, data]) => {
    if (uname === currentUser) return;
    if (data.online) onlineUsers.push([uname, data]);
    else             offlineUsers.push([uname, data]);
  });

  if (onlineUsers.length === 0 && offlineUsers.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--muted);padding:24px 0">No other users yet</p>';
    return;
  }

  onlineUsers.forEach(([uname, data]) => container.appendChild(buildPersonCard(uname, data, true)));

  if (offlineUsers.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'divider-label';
    divider.textContent = 'Offline';
    container.appendChild(divider);
    offlineUsers.forEach(([uname, data]) => container.appendChild(buildPersonCard(uname, data, false)));
  }
}

function buildPersonCard(uname, data, isOnline) {
  const card = document.createElement('div');
  card.className = 'person-card';

  let activeInfo = '';
  if (isOnline && data.activeSubject) {
    const elapsed = data.activeStartTime
      ? Math.floor((Date.now() - data.activeStartTime) / 1000)
      : 0;
    activeInfo = `
      <div class="person-active-info">
        <div class="active-subj">${data.activeSubject}</div>
        <div class="active-time" id="pelapsed-${slugify(uname)}">${secsToHMS(elapsed)}</div>
      </div>`;
  }

  card.innerHTML = `
    <div class="person-header">
      <span class="person-name">${uname}</span>
      ${activeInfo}
      <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
    </div>
    <div class="person-stats-panel" id="ppanel-${slugify(uname)}"></div>
  `;

  // Single tap: toggle today's mini stats panel
  card.querySelector('.person-header').addEventListener('click', () => {
    const panel = document.getElementById(`ppanel-${slugify(uname)}`);
    if (panel.classList.contains('open')) {
      panel.classList.remove('open');
    } else {
      loadPersonPanel(uname, panel);
      panel.classList.add('open');
    }
  });

  // Double-tap: open full stats page
  let lastTap = 0;
  card.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 350) openOtherUserStats(uname);
    lastTap = now;
  });

  return card;
}

async function loadPersonPanel(uname, panel) {
  panel.innerHTML = '<div style="color:#888;font-size:.8rem;padding:4px 0">Loading…</div>';
  const snap    = await statsDayRef(uname, todayKey()).get();
  const data    = snap.val() || {};
  const entries = Object.entries(data);

  if (entries.length === 0) {
    panel.innerHTML = '<div class="stats-panel-row" style="color:#888;font-size:.82rem;padding:4px 0">No study data today</div>';
    return;
  }
  let total = 0;
  let html  = '<div class="stats-panel-row"><span>Timers</span><span>(h/m/s)</span></div>';
  entries.forEach(([subj, secs]) => {
    total += secs;
    html  += `<div class="stats-panel-row"><span>${subj}:</span><span>${secsToHMS(secs)}</span></div>`;
  });
  html += `<div class="stats-panel-row total"><span>Total:</span><span>${secsToHMS(total)}</span></div>`;
  panel.innerHTML = html;
}

function refreshPeopleIfVisible() {
  if (document.getElementById('view-people').classList.contains('active')) {
    renderPeople();
  }
}

function startPeopleTick() {
  if (window._peopleTickInterval) clearInterval(window._peopleTickInterval);
  window._peopleTickInterval = setInterval(() => {
    Object.entries(allUsers).forEach(([uname, data]) => {
      if (data.online && data.activeStartTime) {
        const el = document.getElementById(`pelapsed-${slugify(uname)}`);
        if (el) el.textContent = secsToHMS(Math.floor((Date.now() - data.activeStartTime) / 1000));
      }
    });
  }, 1000);
}

// ── Other User Stats ───────────────────────────────────────
let otherStatsUser    = null;
let otherStatsPeriods = { today: 0, week: 0, month: 0 };

function openOtherUserStats(uname) {
  otherStatsUser    = uname;
  otherStatsPeriods = { today: 0, week: 0, month: 0 };
  const udata = allUsers[uname] || {};
  document.getElementById('other-stats-title').textContent = `${uname}'s Stats`;
  document.getElementById('other-stats-dot').className = `status-dot ${udata.online ? 'online' : 'offline'}`;
  renderOtherStats();
  showView('view-other-stats');
  hideNavbar();
}

async function renderOtherStats() {
  await Promise.all([
    renderStatsPeriod('other-today', otherStatsUser, 'today', otherStatsPeriods.today),
    renderStatsPeriod('other-week',  otherStatsUser, 'week',  otherStatsPeriods.week),
    renderStatsPeriod('other-month', otherStatsUser, 'month', otherStatsPeriods.month),
  ]);
}

// ── My Stats ───────────────────────────────────────────────
let myStatsPeriods = { today: 0, week: 0, month: 0 };

async function renderMyStats() {
  document.getElementById('mystats-title').textContent = `${currentUser}'s Stats`;
  await Promise.all([
    renderStatsPeriod('my-today', currentUser, 'today', myStatsPeriods.today),
    renderStatsPeriod('my-week',  currentUser, 'week',  myStatsPeriods.week),
    renderStatsPeriod('my-month', currentUser, 'month', myStatsPeriods.month),
  ]);
}

// Shared stats renderer used by both My Stats and Other User Stats
async function renderStatsPeriod(prefix, username, periodType, offset) {
  const labelEl = document.getElementById(`${prefix}-label`);
  const panelEl = document.getElementById(`${prefix}-panel`);
  if (!labelEl || !panelEl) return;

  // Period label
  let label = '';
  if (periodType === 'today') {
    label = offset === 0 ? 'Today' : formatDate(getTodayOffset(offset));
  } else if (periodType === 'week') {
    label = offset === 0 ? 'This Week' : weekLabel(offset);
  } else if (periodType === 'month') {
    label = offset === 0 ? `This Month<br>${monthLabel(0)}` : monthLabel(offset);
  }
  labelEl.innerHTML = label;

  // Fetch and aggregate data
  let entries = [];
  if (periodType === 'today') {
    const snap = await statsDayRef(username, getTodayOffset(offset)).get();
    entries = Object.entries(snap.val() || {});
  } else if (periodType === 'week') {
    const ws   = weekStart(offset);
    const we   = weekEnd(offset);
    const snap = await statsRef(username).get();
    const agg  = {};
    Object.entries(snap.val() || {}).forEach(([day, subs]) => {
      if (day >= ws && day <= we) {
        Object.entries(subs).forEach(([s, v]) => { agg[s] = (agg[s] || 0) + v; });
      }
    });
    entries = Object.entries(agg);
  } else if (periodType === 'month') {
    const mk   = monthKey(offset);
    const snap = await statsRef(username).get();
    const agg  = {};
    Object.entries(snap.val() || {}).forEach(([day, subs]) => {
      if (day.startsWith(mk)) {
        Object.entries(subs).forEach(([s, v]) => { agg[s] = (agg[s] || 0) + v; });
      }
    });
    entries = Object.entries(agg);
  }

  // Render
  if (entries.length === 0) {
    panelEl.innerHTML = '<div class="empty-msg">No data</div>';
    return;
  }
  let total = 0;
  let html  = '<div class="stats-header-row"><span>Timers</span><span>(h/m/s)</span></div>';
  entries.forEach(([subj, secs]) => {
    total += secs;
    html  += `<div class="stats-row"><span>${subj}:</span><span>${secsToHMS(secs)}</span></div>`;
  });
  html += `<div class="stats-total-row"><span>Total:</span><span>${secsToHMS(total)}</span></div>`;
  panelEl.innerHTML = html;
}

// ── Edit Stats ─────────────────────────────────────────────
let editDateOffset = 0;

async function openEditStats() {
  editDateOffset = 0;
  await renderEditStats();
  showView('view-edit-stats');
  hideNavbar();
}

async function renderEditStats() {
  const dateKey = getTodayOffset(editDateOffset);
  document.getElementById('edit-date-label').textContent = formatDate(dateKey);

  const snap    = await statsDayRef(currentUser, dateKey).get();
  const data    = snap.val() || {};
  const entries = Object.entries(data);
  const panel   = document.getElementById('edit-entries-panel');

  let total = 0;
  let html  = `<div class="stats-header-row" style="display:flex;justify-content:space-between;
    font-size:.78rem;opacity:.7;margin-bottom:4px;color:var(--panel-txt)">
    <span>Timers</span><span>(h/m/s)</span></div>`;

  entries.forEach(([subj, secs]) => {
    total += secs;
    const slug = slugify(subj);
    html += `
      <div class="edit-entry-row" id="erow-${slug}">
        <span class="edit-entry-name">${subj}</span>
        <span class="edit-entry-time">${secsToHMS(secs)}</span>
        <button class="btn-icon" onclick="openInlineEdit('${subj}',${secs})" title="Edit">&#x270E;</button>
        <button class="btn-icon red" onclick="deleteEditEntry('${subj}')" title="Delete">&#x1F5D1;</button>
      </div>
      <div class="inline-edit-form" id="iedit-${slug}">
        <div class="row">
          <input class="input-field" id="ie-subj-${slug}" value="${subj}" placeholder="Subject">
          <input class="input-field" id="ie-hms-${slug}"  value="${secsToHMS(secs)}" placeholder="hh:mm:ss" style="width:110px">
        </div>
        <div class="row">
          <button class="btn btn-primary" onclick="saveInlineEdit('${subj}')">Save</button>
          <button class="btn btn-surface" onclick="closeInlineEdit('${slug}')">Cancel</button>
        </div>
      </div>`;
  });

  if (entries.length > 0) {
    html += `<div class="edit-total-row"><span>Total:</span><span>${secsToHMS(total)}</span></div>`;
  }

  const subjectOptions = subjects.map(s => `<option value="${s}">${s}</option>`).join('');

  html += `
    <div class="add-entry-row">
      <span class="add-link" onclick="toggleAddForm()">+ Add</span>
      <div class="add-entry-form" id="add-entry-form">
        <select class="input-field" id="add-subj">
          <option value="" disabled selected>Select subject…</option>
          ${subjectOptions}
        </select>
        <input class="input-field" id="add-hms"  placeholder="hh:mm:ss  e.g. 01:30:00">
        <div class="add-row-btns">
          <button class="btn btn-primary" onclick="confirmAddEntry()">Add</button>
          <button class="btn btn-surface" onclick="toggleAddForm()">Cancel</button>
        </div>
      </div>
    </div>`;

  panel.innerHTML = html;
}

function toggleAddForm() {
  document.getElementById('add-entry-form').classList.toggle('open');
}

async function confirmAddEntry() {
  const subjEl = document.getElementById('add-subj');
  const subj   = subjEl.value;
  const hms    = document.getElementById('add-hms').value.trim();
  if (!subj || !hms) { showToast('Select a subject and enter time'); return; }
  const secs    = HMSToSecs(hms);
  const dateKey = getTodayOffset(editDateOffset);
  const snap    = await statsDayRef(currentUser, dateKey).child(subj).get();
  const prev    = snap.exists() ? snap.val() : 0;
  await statsDayRef(currentUser, dateKey).child(subj).set(prev + secs);
  allTimeStatsCache[subj] = (allTimeStatsCache[subj] || 0) + secs;
  showToast(`${subj} added`);
  await renderEditStats();
}

function openInlineEdit(subj) {
  document.querySelectorAll('.inline-edit-form').forEach(f => f.classList.remove('open'));
  document.getElementById(`iedit-${slugify(subj)}`).classList.add('open');
}

function closeInlineEdit(slug) {
  document.getElementById(`iedit-${slug}`).classList.remove('open');
}

async function saveInlineEdit(oldSubj) {
  const slug    = slugify(oldSubj);
  const newSubj = document.getElementById(`ie-subj-${slug}`).value.trim();
  const newHMS  = document.getElementById(`ie-hms-${slug}`).value.trim();
  if (!newSubj || !newHMS) { showToast('Fill in all fields'); return; }
  const newSecs = HMSToSecs(newHMS);
  const dateKey = getTodayOffset(editDateOffset);
  // If subject name changed, remove the old key
  if (newSubj !== oldSubj) {
    await statsDayRef(currentUser, dateKey).child(oldSubj).remove();
    const snap = await statsDayRef(currentUser, dateKey).child(newSubj).get();
    const prev = snap.exists() ? snap.val() : 0;
    await statsDayRef(currentUser, dateKey).child(newSubj).set(prev + newSecs);
  } else {
    // Same subject — replace value entirely (not add)
    await statsDayRef(currentUser, dateKey).child(newSubj).set(newSecs);
  }
  showToast('Entry updated');
  await refreshAllTimeStats();
  await renderEditStats();
}

async function deleteEditEntry(subj) {
  const dateKey = getTodayOffset(editDateOffset);
  await statsDayRef(currentUser, dateKey).child(subj).remove();
  showToast(`${subj} removed`);
  await refreshAllTimeStats();
  await renderEditStats();
}

// ── Leaderboard ────────────────────────────────────────────
let lbTab = 'this';

async function renderLeaderboard() {
  const rows = document.getElementById('lb-rows');
  rows.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px 0">Loading…</div>';

  const offset       = lbTab === 'this' ? 0 : -1;
  const ws           = weekStart(offset);
  const we           = weekEnd(offset);
  const allStatsSnap = await db.ref('stats').get();
  const allStats     = allStatsSnap.val() || {};

  // Start everyone at 0
  const totals = {};
  Object.keys(allUsers).forEach(u => { totals[u] = 0; });

  Object.entries(allStats).forEach(([uname, days]) => {
    Object.entries(days).forEach(([day, subs]) => {
      if (day >= ws && day <= we) {
        Object.values(subs).forEach(secs => {
          totals[uname] = (totals[uname] || 0) + secs;
        });
      }
    });
  });

  const sorted     = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const rankEmoji  = ['🥇','🥈','🥉'];
  const rankClass  = ['gold','silver','bronze'];

  rows.innerHTML = '';
  if (sorted.length === 0) {
    rows.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px 0">No data yet</div>';
    return;
  }
  sorted.forEach(([uname, total], idx) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    row.innerHTML = `
      <span class="lb-rank ${rankClass[idx] || ''}">${idx < 3 ? rankEmoji[idx] : idx + 1}</span>
      <span class="lb-name">${uname}</span>
      <span class="lb-time">${secsToHMS(total)}</span>
    `;
    rows.appendChild(row);
  });
}

// ── Username Rename ────────────────────────────────────────
function openRenameModal() {
  const modal = document.getElementById('modal-rename-user');
  const input = document.getElementById('rename-user-input');
  const avail = document.getElementById('rename-avail');
  input.value = currentUser;
  avail.className = 'availability hidden';
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  let t;
  input.oninput = () => {
    clearTimeout(t);
    const v = input.value.trim();
    if (!v || v === currentUser) { avail.className = 'availability hidden'; return; }
    t = setTimeout(async () => {
      const snap = await userRef(v).child('password').get();
      if (snap.exists()) {
        avail.innerHTML = '<span class="avail-icon">&#x2612;</span> Username Taken';
        avail.className = 'availability taken';
      } else {
        avail.innerHTML = '<span class="avail-icon">&#x2611;</span> Username Available';
        avail.className = 'availability available';
      }
    }, 400);
  };

  document.getElementById('btn-rename-user-confirm').onclick = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentUser) { modal.classList.add('hidden'); return; }
    if (avail.classList.contains('taken')) { showToast('Username is taken'); return; }
    const snap = await userRef(newName).child('password').get();
    if (snap.exists()) { showToast('Username is taken'); return; }
    await renameUser(currentUser, newName);
    modal.classList.add('hidden');
  };
  document.getElementById('btn-rename-user-cancel').onclick = () => {
    modal.classList.add('hidden');
    input.oninput = null;
  };
}

async function renameUser(oldName, newName) {
  const [userSnap, subjSnap, statsSnap] = await Promise.all([
    userRef(oldName).get(),
    subjectsRef(oldName).get(),
    statsRef(oldName).get(),
  ]);
  const updates = {};
  if (userSnap.exists())  updates[`users/${newName}`]    = userSnap.val();
  if (subjSnap.exists())  updates[`subjects/${newName}`] = subjSnap.val();
  if (statsSnap.exists()) updates[`stats/${newName}`]    = statsSnap.val();
  await db.ref().update(updates);
  await Promise.all([
    userRef(oldName).remove(),
    subjectsRef(oldName).remove(),
    statsRef(oldName).remove(),
  ]);
  if (localStorage.getItem('nt_user') === oldName) localStorage.setItem('nt_user', newName);
  currentUser = newName;
  document.getElementById('timers-username').textContent = newName;
  showToast(`Username changed to ${newName}`);
}

// ── DOM Ready ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initAuth();

  // Navbar
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
  });

  // Timers view
  document.getElementById('btn-rename-user').addEventListener('click', openRenameModal);
  document.getElementById('btn-open-customize').addEventListener('click', openCustomize);

  // Timer screen
  document.getElementById('btn-back-timer').addEventListener('click', () => {
    if (window._timerScreenInterval) { clearInterval(window._timerScreenInterval); window._timerScreenInterval = null; }
    navigateTo('timers');
  });
  document.getElementById('btn-sw-start').addEventListener('click', swStart);
  document.getElementById('btn-sw-stop').addEventListener('click',  swStop);
  document.getElementById('btn-sw-reset').addEventListener('click', swReset);
  document.getElementById('btn-cd-start').addEventListener('click', cdStart);
  document.getElementById('btn-cd-stop').addEventListener('click',  cdStop);
  document.getElementById('btn-cd-reset').addEventListener('click', cdReset);

  // Customize screen
  document.getElementById('btn-back-customize').addEventListener('click', async () => {
    await loadSubjects();
    renderTimersView();
    navigateTo('timers');
  });
  document.getElementById('btn-add-subject').addEventListener('click', addSubject);
  document.getElementById('new-subject-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSubject();
  });

  // My Stats
  document.getElementById('btn-edit-stats').addEventListener('click', openEditStats);
  // Today nav
  document.getElementById('my-today-prev').addEventListener('click', async () => {
    myStatsPeriods.today--;
    await renderStatsPeriod('my-today', currentUser, 'today', myStatsPeriods.today);
  });
  document.getElementById('my-today-next').addEventListener('click', async () => {
    if (myStatsPeriods.today >= 0) return;
    myStatsPeriods.today++;
    await renderStatsPeriod('my-today', currentUser, 'today', myStatsPeriods.today);
  });
  // Week nav
  document.getElementById('my-week-prev').addEventListener('click', async () => {
    myStatsPeriods.week--;
    await renderStatsPeriod('my-week', currentUser, 'week', myStatsPeriods.week);
  });
  document.getElementById('my-week-next').addEventListener('click', async () => {
    if (myStatsPeriods.week >= 0) return;
    myStatsPeriods.week++;
    await renderStatsPeriod('my-week', currentUser, 'week', myStatsPeriods.week);
  });
  // Month nav
  document.getElementById('my-month-prev').addEventListener('click', async () => {
    myStatsPeriods.month--;
    await renderStatsPeriod('my-month', currentUser, 'month', myStatsPeriods.month);
  });
  document.getElementById('my-month-next').addEventListener('click', async () => {
    if (myStatsPeriods.month >= 0) return;
    myStatsPeriods.month++;
    await renderStatsPeriod('my-month', currentUser, 'month', myStatsPeriods.month);
  });

  // Edit Stats
  document.getElementById('btn-back-edit-stats').addEventListener('click', async () => {
    await renderMyStats();
    showView('view-mystats');
    showNavbar('home');
  });
  document.getElementById('edit-date-prev').addEventListener('click', async () => {
    editDateOffset--;
    await renderEditStats();
  });
  document.getElementById('edit-date-next').addEventListener('click', async () => {
    if (editDateOffset >= 0) return;
    editDateOffset++;
    await renderEditStats();
  });

  // People
  document.getElementById('btn-leaderboard').addEventListener('click', async () => {
    await renderLeaderboard();
    showView('view-leaderboard');
    hideNavbar();
  });

  // Leaderboard
  document.getElementById('btn-back-leaderboard').addEventListener('click', () => {
    showView('view-people');
    showNavbar('people');
  });
  document.querySelectorAll('.lb-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      lbTab = btn.dataset.tab;
      document.querySelectorAll('.lb-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await renderLeaderboard();
    });
  });

  // Other User Stats
  document.getElementById('btn-back-other-stats').addEventListener('click', () => {
    showView('view-people');
    showNavbar('people');
    startPeopleTick();
  });
  // Other Today nav
  document.getElementById('other-today-prev').addEventListener('click', async () => {
    otherStatsPeriods.today--;
    await renderStatsPeriod('other-today', otherStatsUser, 'today', otherStatsPeriods.today);
  });
  document.getElementById('other-today-next').addEventListener('click', async () => {
    if (otherStatsPeriods.today >= 0) return;
    otherStatsPeriods.today++;
    await renderStatsPeriod('other-today', otherStatsUser, 'today', otherStatsPeriods.today);
  });
  // Other Week nav
  document.getElementById('other-week-prev').addEventListener('click', async () => {
    otherStatsPeriods.week--;
    await renderStatsPeriod('other-week', otherStatsUser, 'week', otherStatsPeriods.week);
  });
  document.getElementById('other-week-next').addEventListener('click', async () => {
    if (otherStatsPeriods.week >= 0) return;
    otherStatsPeriods.week++;
    await renderStatsPeriod('other-week', otherStatsUser, 'week', otherStatsPeriods.week);
  });
  // Other Month nav
  document.getElementById('other-month-prev').addEventListener('click', async () => {
    otherStatsPeriods.month--;
    await renderStatsPeriod('other-month', otherStatsUser, 'month', otherStatsPeriods.month);
  });
  document.getElementById('other-month-next').addEventListener('click', async () => {
    if (otherStatsPeriods.month >= 0) return;
    otherStatsPeriods.month++;
    await renderStatsPeriod('other-month', otherStatsUser, 'month', otherStatsPeriods.month);
  });

  // Auto-login
  const saved = localStorage.getItem('nt_user');
  if (saved) {
    userRef(saved).child('password').get().then(snap => {
      if (snap.exists()) { currentUser = saved; startApp(); }
      else { localStorage.removeItem('nt_user'); showView('view-auth'); }
    }).catch(() => showView('view-auth'));
  } else {
    showView('view-auth');
  }
});
