/* 두근 트레이딩 통합 대시보드 - 클라이언트 로직 v1.3
 *
 * 3가지 모드 자동 감지:
 *   1. file://             → 직접 API 호출 (같은 Mac, 개발)
 *   2. http://127.x        → system_api 프록시 (같은 Mac)
 *   3. http://192.x        → system_api 프록시 (같은 LAN)
 *   4. https://*.io 등     → Firebase Firestore 모드 (외부, 어디서든)
 *
 * 시스템: :9000  코인봇: :9001  주식봇: :9002
 * Firebase: datemap-759bf, 컬렉션 trading_status / trading_commands
 */

const APP_VERSION = 'v1.3';
const IS_FILE = location.protocol === 'file:';
const ORIGIN = IS_FILE ? '' : location.origin;

// 외부 호스트면 Firebase 모드 (LAN/localhost가 아닌 경우)
const IS_LOCAL = IS_FILE
  || /^(127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01]))/.test(location.hostname);
const FIREBASE_MODE = !IS_LOCAL;

const APIS = IS_FILE
  ? {
      system: 'http://127.0.0.1:9000',
      coin:   'http://127.0.0.1:9001',
      stock:  'http://127.0.0.1:9002',
    }
  : {
      system: ORIGIN,
      coin:   `${ORIGIN}/api/coin`,
      stock:  `${ORIGIN}/api/stock`,
    };

/* ─── Firebase 초기화 (외부 모드) ──────────────────── */
let firestore = null;
let _fbConfig = null;

async function initFirebase() {
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK 로드 실패');
    return false;
  }
  try {
    if (!_fbConfig) {
      const r = await fetch('firebase-config.json', { cache:'no-store' });
      _fbConfig = await r.json();
    }
    if (!firebase.apps.length) firebase.initializeApp(_fbConfig);
    firestore = firebase.firestore();
    console.log('[Firebase] 초기화 OK', _fbConfig.projectId);
    return true;
  } catch (e) {
    console.warn('[Firebase] 초기화 실패:', e);
    return false;
  }
}

if (FIREBASE_MODE) {
  initFirebase().then(ok => {
    if (ok) {
      subscribeFirestore();
      // 외부 모드는 폴링 안 함 (Firestore 실시간)
    } else {
      toast('⚠️ Firebase 연결 실패. 봇 호스트와 같은 네트워크에 있어야 컨트롤 가능');
    }
  });
}

/* ─── Firestore 실시간 구독 (외부 모드 전용) ──────── */
function subscribeFirestore() {
  ['coin', 'stock'].forEach(bot => {
    firestore.collection('trading_status').doc(bot).onSnapshot(snap => {
      if (!snap.exists) {
        console.log(`[FS] ${bot} 데이터 없음 (Bridge 안 켜짐?)`);
        return;
      }
      const data = snap.data();
      // health/status 형태로 분리해서 기존 렌더 함수 재사용
      const health = data.online ? {bot_mode: data.bot_mode, trade_mode: data.trade_mode} : null;
      const status = data.online ? {
        balance: data.balance, today_pnl: data.today_pnl, today_pct: data.today_pct,
        total_pnl: data.total_pnl, total_pct: data.total_pct, initial_balance: data.balance - data.total_pnl,
        positions: data.positions || [], recent_trades: data.recent_trades || [],
        tune_log: data.tune_log || [], daily_pnl_7d: data.daily_pnl_7d || [],
      } : null;
      applyHealthUI(bot, health);
      applyStatusUI(bot, status);
      renderHomeOverview();

      const upd = data.updated_at;
      if (upd) {
        document.getElementById('upd-time').textContent =
          '🌐 ' + new Date(upd).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
      }
    }, err => console.warn(`[FS] ${bot} 구독 오류:`, err));
  });

  // 시장 / 인사이트 / 토큰 사용량
  firestore.collection('trading_status').doc('market').onSnapshot(snap => {
    if (snap.exists) renderMarket(snap.data());
  });
  firestore.collection('trading_status').doc('insights').onSnapshot(snap => {
    if (snap.exists) renderInsights(snap.data());
  });
  firestore.collection('trading_status').doc('tokens').onSnapshot(snap => {
    if (snap.exists) renderTokens(snap.data());
  });

  // 명령 처리 결과 모니터
  firestore.collection('trading_commands')
    .orderBy('created_at', 'desc').limit(5)
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'modified') {
          const d = ch.doc.data();
          if (d.status === 'processed') toast(`✅ ${d.bot} ${d.action}`);
          else if (d.status === 'failed') toast(`❌ ${d.bot} ${d.action} 실패`);
        }
      });
    });
}

/* Firebase 모드: 명령 발행 */
async function fbCommand(bot, action) {
  if (!firestore) {
    toast('❌ Firebase 미연결');
    return false;
  }
  try {
    await firestore.collection('trading_commands').add({
      bot, action,
      status: 'pending',
      created_at: new Date().toISOString(),
      origin: 'web',
    });
    toast(`📤 ${bot} ${action} 발행 (대기 중)`);
    return true;
  } catch (e) {
    toast(`❌ Firebase 발행 실패: ${e.message}`);
    return false;
  }
}

const STATE = {
  coin:  {bot_mode:null, trade_mode:null, online:false, status:null},
  stock: {bot_mode:null, trade_mode:null, online:false, status:null},
  system:{processes:[], autoload:false},
  cal:   {bot:'coin', year:null, month:null, selectedDay:null},
};

let chart7d = null;

/* ─── 비밀번호 (SHA-256) ─────────────────────────────────── */
const PW_KEY = 'doogeun_trading_pw_hash';
const AUTH_KEY = 'doogeun_trading_auth_until';
const AUTH_DURATION_MS = 5 * 60 * 1000;

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
}
const getStoredHash = () => localStorage.getItem(PW_KEY);
const setStoredHash = h => localStorage.setItem(PW_KEY, h);
const isAuthed = () => Date.now() < parseInt(localStorage.getItem(AUTH_KEY) || '0');
const markAuthed = () => localStorage.setItem(AUTH_KEY, String(Date.now() + AUTH_DURATION_MS));

let pwResolver = null, pwOnSuccess = null;

function openPw(opts = {}) {
  return new Promise(resolve => {
    pwResolver = resolve;
    const stored = getStoredHash();
    document.getElementById('pwTitle').textContent =
      opts.title || (stored ? '관리자 인증' : '비밀번호 첫 설정');
    document.getElementById('pwDesc').textContent = stored
      ? (opts.desc || '위험한 작업입니다. 비밀번호 입력.')
      : '비밀번호를 처음 설정합니다. 4자 이상.';
    document.getElementById('pwErr').textContent = '';
    const input = document.getElementById('pwInput');
    input.value = '';
    document.getElementById('pwModal').classList.add('show');
    setTimeout(() => input.focus(), 100);
  });
}

function closePw() {
  document.getElementById('pwModal').classList.remove('show');
  if (pwResolver) { pwResolver(false); pwResolver = null; }
}

async function submitPw() {
  const pw = document.getElementById('pwInput').value;
  const err = document.getElementById('pwErr');
  if (pw.length < 4) { err.textContent = '4자 이상 입력'; return; }

  const stored = getStoredHash();
  const hash = await sha256(pw);

  if (!stored) {
    setStoredHash(hash);
    markAuthed();
    document.getElementById('pwModal').classList.remove('show');
    toast('🔒 비밀번호 설정 완료');
    if (pwResolver) { pwResolver(true); pwResolver = null; }
    return;
  }
  if (hash === stored) {
    markAuthed();
    document.getElementById('pwModal').classList.remove('show');
    if (pwResolver) { pwResolver(true); pwResolver = null; }
  } else {
    err.textContent = '비밀번호 틀림';
    document.getElementById('pwInput').value = '';
  }
}

document.addEventListener('keydown', e => {
  if (!document.getElementById('pwModal').classList.contains('show')) return;
  if (e.key === 'Enter') submitPw();
  if (e.key === 'Escape') closePw();
});

async function ensureAuth(opts) {
  if (isAuthed()) return true;
  return await openPw(opts);
}

function changePw() {
  localStorage.removeItem(PW_KEY);
  localStorage.removeItem(AUTH_KEY);
  toast('🔓 새 비밀번호 설정 모달이 다음 위험 작업 시 뜸');
}
function resetPw() {
  if (!confirm('비밀번호 초기화? 다음 위험 작업 시 새로 설정.')) return;
  localStorage.removeItem(PW_KEY);
  localStorage.removeItem(AUTH_KEY);
  toast('초기화됨');
}
function logoutAuth() {
  localStorage.removeItem(AUTH_KEY);
  toast('인증 만료. 다음 위험 작업 시 비밀번호 요구.');
}

/* ─── 표시 헬퍼 ──────────────────────────────────────── */
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const fmtSign = n => (n >= 0 ? '+' : '') + fmt(n);
const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';

function colorize(el, val) {
  el.classList.remove('up', 'down');
  if (val > 0) el.classList.add('up');
  else if (val < 0) el.classList.add('down');
}

function modeBadge(trade_mode, bot_mode) {
  let html = '';
  if (trade_mode === 'real') {
    html += `<span class="badge b-real"><span class="led err"></span>REAL</span>`;
  } else if (trade_mode === 'demo') {
    html += `<span class="badge b-demo"><span class="led on"></span>DEMO</span>`;
  }
  if (bot_mode === 'running') html += `<span class="badge b-running"><span class="led on"></span>RUNNING</span>`;
  else if (bot_mode === 'soft_stop') html += `<span class="badge b-soft"><span class="led warn"></span>SOFT-STOP</span>`;
  else if (bot_mode === 'stopped') html += `<span class="badge b-stopped"><span class="led err"></span>STOPPED</span>`;
  else if (!bot_mode) html += `<span class="badge b-offline"><span class="led off"></span>OFFLINE</span>`;
  return html;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

/* ─── 네비게이션 ────────────────────────────────────── */
function openMenu() {
  document.getElementById('menu').classList.add('show');
  document.getElementById('menuBg').classList.add('show');
}
function closeMenu() {
  document.getElementById('menu').classList.remove('show');
  document.getElementById('menuBg').classList.remove('show');
}

const VIEW_TITLES = {
  home: '📊 두근 트레이딩',
  coin: '🪙 코인봇',
  stock:'📈 주식봇',
  system:'⚙️ 시스템',
  tune: '📅 자가개선',
  settings:'🔐 설정',
};

function goView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
  document.querySelector(`.menu-item[data-view="${view}"]`)?.classList.add('active');
  document.getElementById('topbar-title').textContent = VIEW_TITLES[view] || view;
  closeMenu();
  if (view === 'system') loadSystemView();
  if (view === 'tune') initCalendar();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

/* ─── 봇 컨트롤 ──────────────────────────────────────── */
async function ctrl(bot, path, opts = {}) {
  if (opts.confirm && !confirm(opts.confirm)) return;

  const needAuth = opts.auth || path === 'trade/real' || path === 'mode/stop' || path === 'emergency';
  if (needAuth) {
    const ok = await ensureAuth({desc: opts.confirm || '위험한 작업입니다.'});
    if (!ok) return;
  }

  const msgEl = document.getElementById(`${bot}_msg`);
  if (msgEl) { msgEl.className = 'ctl-msg'; msgEl.textContent = '⏳ 처리 중...'; }

  // Firebase 모드: Firestore에 명령 발행
  if (FIREBASE_MODE) {
    const ok = await fbCommand(bot, path);
    if (msgEl) {
      msgEl.className = ok ? 'ctl-msg ok' : 'ctl-msg err';
      msgEl.textContent = ok ? `📤 ${path} 발행 (Bridge 처리 중)` : '❌ 발행 실패';
    }
    return;
  }

  // 로컬 모드: 직접 API 호출
  try {
    const r = await fetch(`${APIS[bot]}/${path}`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (msgEl) { msgEl.className = 'ctl-msg ok'; msgEl.textContent = `✅ ${data.msg || JSON.stringify(data).slice(0,60)}`; }
    toast(`✅ ${path}`);
    setTimeout(loadAll, 600);
  } catch (e) {
    if (msgEl) { msgEl.className = 'ctl-msg err'; msgEl.textContent = `❌ 실패: ${e.message} — ${APIS[bot]}`; }
    toast(`❌ 실패`);
  }
}

async function toggleTrade(bot) {
  const cur = STATE[bot].trade_mode;
  const next = cur === 'real' ? 'demo' : 'real';
  if (next === 'real') {
    await ctrl(bot, 'trade/real', {confirm:'⚠️ REAL 전환. 다음 매수부터 실제 주문. 진행?'});
  } else {
    await ctrl(bot, 'trade/demo');
  }
}

/* ─── 시스템 뷰 ──────────────────────────────────────── */
async function sysCall(action, label, opts = {}) {
  if (opts.confirm && !confirm(opts.confirm)) return;
  if (opts.auth) {
    const ok = await ensureAuth({desc: opts.confirm || `${label}?`});
    if (!ok) return;
  }
  toast(`⏳ ${label}...`);
  try {
    const r = await fetch(`${APIS.system}/system/${action}`, { method:'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast(`✅ ${label} 완료`);
    setTimeout(loadAll, 1500);
  } catch (e) {
    toast(`❌ ${label} 실패: 시스템 API (:9000) 켜졌는지 확인`);
  }
}

async function restartOne(name) {
  const ok = await ensureAuth({desc: `${name} 재시작?`});
  if (!ok) return;
  toast(`⏳ ${name} 재시작...`);
  try {
    await fetch(`${APIS.system}/system/restart/${name}`, { method:'POST' });
    toast(`✅ ${name} 재시작`);
    setTimeout(loadSystemView, 1500);
  } catch (e) {
    toast(`❌ 실패`);
  }
}

async function loadSystemView() {
  try {
    const r = await fetch(`${APIS.system}/system/status`, { signal:AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error('offline');
    const data = await r.json();
    STATE.system = data;

    // 프로세스 리스트
    const list = document.getElementById('sys_processes');
    list.innerHTML = data.processes.map(p => {
      const led = p.alive ? '<span class="led on"></span>' : '<span class="led off"></span>';
      const meta = p.alive
        ? `PID ${p.pid} · ${p.etime || '-'} · ${p.rss_kb ? Math.round(p.rss_kb/1024) + 'MB' : ''}`
        : '종료됨';
      return `<div class="sys-row">
        <div class="sys-info">
          <div class="sys-name">${led} ${p.name}</div>
          <div class="sys-meta">${meta}</div>
        </div>
        <div class="sys-actions">
          <button class="sys-btn primary" onclick="restartOne('${p.name}')">재시작</button>
        </div>
      </div>`;
    }).join('');

    // 자동시작
    const sw = document.getElementById('autoload_switch');
    const desc = document.getElementById('autoload_desc');
    if (data.autoload) {
      sw.classList.add('on');
      desc.textContent = '✅ Mac 부팅 시 자동 시작';
    } else {
      sw.classList.remove('on');
      desc.textContent = '❌ 수동으로 시작 필요';
    }
  } catch (e) {
    document.getElementById('sys_processes').innerHTML =
      `<div class="empty">⚠️ 시스템 API (:9000) 응답 없음<br>
      <code style="font-size:11px">cd ~/trading-dashboard &amp;&amp; python3 system_api.py &amp;</code></div>`;
    document.getElementById('autoload_desc').textContent = '확인 불가';
  }
}

async function toggleAutoload() {
  const cur = STATE.system.autoload;
  const path = cur ? 'autoload/off' : 'autoload/on';
  const label = cur ? '자동시작 OFF' : '자동시작 ON';
  const ok = await ensureAuth({desc: `${label}?`});
  if (!ok) return;
  try {
    await fetch(`${APIS.system}/system/${path}`, { method:'POST' });
    toast(`✅ ${label}`);
    setTimeout(loadSystemView, 800);
  } catch (e) {
    toast(`❌ 실패`);
  }
}

async function loadLog(name) {
  document.getElementById('log_view').textContent = '로딩...';
  try {
    const r = await fetch(`${APIS.system}/system/log/${name}?tail=80`);
    const data = await r.json();
    document.getElementById('log_view').textContent =
      (data.lines || []).join('\n') || '(빈 로그)';
  } catch (e) {
    document.getElementById('log_view').textContent = `❌ 실패: ${e.message}`;
  }
}

/* ─── 데이터 로드 ────────────────────────────────────── */
async function fetchHealth(bot) {
  try {
    const r = await fetch(`${APIS[bot]}/health`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fetchStatus(bot) {
  try {
    const r = await fetch(`${APIS[bot]}/status?ts=${Date.now()}`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function applyHealthUI(bot, health) {
  STATE[bot].online = !!health;
  STATE[bot].bot_mode = health?.bot_mode || null;
  STATE[bot].trade_mode = health?.trade_mode || null;

  // 메인 카드 메타
  const meta = document.getElementById(`${bot}_card_meta`);
  meta.innerHTML = modeBadge(health?.trade_mode, health?.bot_mode);

  // 메뉴 LED
  const menuLed = document.getElementById(`menu_${bot}_led`);
  if (menuLed) {
    menuLed.className = 'led ' + (health
      ? (health.bot_mode === 'running' ? 'on'
        : health.bot_mode === 'soft_stop' ? 'warn'
        : 'err')
      : 'off');
  }

  // 봇 상세 뷰: 세그먼트
  const seg = document.getElementById(`${bot}_seg`);
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    if (health) {
      const map = {running:'run', soft_stop:'soft', stopped:'stop'};
      const k = map[health.bot_mode];
      if (k) seg.querySelector(`.seg-btn[data-mode="${k}"]`)?.classList.add('active');
    }
  }

  // 거래 토글
  const sw = document.getElementById(`${bot}_switch`);
  const nameEl = document.getElementById(`${bot}_trade_name`);
  const descEl = document.getElementById(`${bot}_trade_desc`);
  if (sw && nameEl && descEl) {
    if (health?.trade_mode === 'real') {
      sw.classList.add('on');
      nameEl.textContent = 'REAL';
      nameEl.style.color = 'var(--danger)';
      descEl.textContent = '⚠️ 실전 주문';
    } else {
      sw.classList.remove('on');
      nameEl.textContent = health ? 'DEMO' : '-';
      nameEl.style.color = '';
      descEl.textContent = health ? '시뮬레이션' : '봇 오프라인';
    }
  }
}

function applyStatusUI(bot, status) {
  STATE[bot].status = status;
  const prefix = bot;

  if (!status) {
    document.getElementById(`${prefix}_card_pnl`).textContent = '-';
    return;
  }

  // 메인 카드 PnL
  const cardPnl = document.getElementById(`${prefix}_card_pnl`);
  cardPnl.textContent = fmtSign(status.today_pnl || 0);
  colorize(cardPnl, status.today_pnl || 0);

  // 상세 통계
  const setStat = (id, val, type) => {
    const el = document.getElementById(`${prefix}_${id}`);
    if (!el) return;
    if (type === 'pct') el.textContent = pct(val || 0);
    else if (type === 'sign') el.textContent = fmtSign(val || 0);
    else el.textContent = fmt(val || 0);
    colorize(el, val || 0);
  };
  setStat('today_pct', status.today_pct, 'pct');
  setStat('today_pnl', status.today_pnl, 'sign');
  setStat('total_pct', status.total_pct, 'pct');
  setStat('balance', status.balance, 'fmt');

  // 포지션
  const posTb = document.getElementById(`${prefix}_positions`);
  if (posTb) {
    const positions = status.positions || [];
    if (positions.length === 0) {
      posTb.innerHTML = '<tr><td colspan="5" class="empty">보유 없음</td></tr>';
    } else if (bot === 'coin') {
      posTb.innerHTML = positions.map(p =>
        `<tr><td>${p.coin}</td><td>${p.persona || '-'}</td>` +
        `<td class="num">${(+p.amount).toFixed(4)}</td>` +
        `<td class="num">${fmt(p.entry_price)}</td>` +
        `<td class="num">${fmt(p.krw_invested)}</td></tr>`
      ).join('');
    } else {
      posTb.innerHTML = positions.map(p =>
        `<tr><td>${p.stock}</td><td>${p.market}</td>` +
        `<td class="num">${p.amount}</td>` +
        `<td class="num">${fmt(p.avg_price)}</td>` +
        `<td>${p.profile || '-'}</td></tr>`
      ).join('');
    }
  }
}

function renderHomeOverview() {
  const c = STATE.coin.status, s = STATE.stock.status;

  const todayPnl = (c?.today_pnl || 0) + (s?.today_pnl || 0);
  const balance = (c?.balance || 0) + (s?.balance || 0);
  const totalPnl = (c?.total_pnl || 0) + (s?.total_pnl || 0);
  const initialBal = (c?.initial_balance || 0) + (s?.initial_balance || 0);
  const todayPct = initialBal > 0 ? todayPnl / initialBal : 0;
  const totalPct = initialBal > 0 ? totalPnl / initialBal : 0;

  const pnlEl = document.getElementById('total_today_pnl');
  pnlEl.textContent = fmtSign(todayPnl) + '원';
  colorize(pnlEl, todayPnl);

  const tpEl = document.getElementById('total_today_pct');
  tpEl.textContent = pct(todayPct);
  colorize(tpEl, todayPct);

  const ttEl = document.getElementById('total_total_pct');
  ttEl.textContent = pct(totalPct);
  colorize(ttEl, totalPct);

  document.getElementById('total_balance').textContent = fmt(balance) + '원';

  // 통합 최근 거래
  const all = [];
  (c?.recent_trades || []).slice(0,10).forEach(t => all.push({...t, _bot:'coin'}));
  (s?.recent_trades || []).slice(0,10).forEach(t => all.push({...t, _bot:'stock'}));
  all.sort((a,b) => (b.created_at || b.ts || '').localeCompare(a.created_at || a.ts || ''));

  const trBody = document.getElementById('all_recent_trades');
  if (all.length === 0) {
    trBody.innerHTML = '<tr><td colspan="5" class="empty">거래 없음</td></tr>';
  } else {
    trBody.innerHTML = all.slice(0,10).map(t => {
      const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
      const ts = (t.created_at || t.ts || '').slice(11, 16);
      const sym = t.coin || t.stock || '-';
      const botBadge = t._bot === 'coin'
        ? '<span style="color:var(--coin)">🪙</span>'
        : '<span style="color:var(--stock)">📈</span>';
      return `<tr><td>${ts}</td><td>${botBadge}</td><td>${sym}</td><td>${t.side}</td>` +
             `<td class="num ${cls}">${t.pnl != null ? fmtSign(t.pnl) : '-'}</td></tr>`;
    }).join('');
  }

  renderChart7d();
}

function renderChart7d() {
  const c = STATE.coin.status?.daily_pnl_7d || [];
  const s = STATE.stock.status?.daily_pnl_7d || [];

  const allDays = new Set();
  c.forEach(d => allDays.add(d.day));
  s.forEach(d => allDays.add(d.day));
  const days = [...allDays].sort();

  const cMap = Object.fromEntries(c.map(d => [d.day, d.pnl]));
  const sMap = Object.fromEntries(s.map(d => [d.day, d.pnl]));

  const total = days.reduce((sum, d) => sum + (cMap[d] || 0) + (sMap[d] || 0), 0);
  document.getElementById('chart_total').textContent = fmtSign(total);

  const ctx = document.getElementById('chart7d').getContext('2d');
  if (chart7d) chart7d.destroy();

  chart7d = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(d => d.slice(5)),
      datasets: [
        {
          label: '코인봇',
          data: days.map(d => cMap[d] || 0),
          backgroundColor: '#f7931a99',
          borderColor: '#f7931a',
          borderWidth: 1,
        },
        {
          label: '주식봇',
          data: days.map(d => sMap[d] || 0),
          backgroundColor: '#3fb95099',
          borderColor: '#3fb950',
          borderWidth: 1,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e6edf3', font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtSign(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: {size:10} }, stacked: true, grid: {display:false} },
        y: { ticks: { color: '#8b949e', font: {size:10}, callback: v => fmt(v) }, stacked: true, grid: {color:'#30363d33'} },
      },
    },
  });
}

async function fetchTokens() {
  try {
    const r = await fetch(`${APIS.system}/system/tokens`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function renderTokens(t) {
  if (!t) {
    ['token_calls','token_denied','token_tokens','token_max_pct',
     'token_coin_calls','token_stock_calls','token_cost','token_pct_label']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '-'; });
    return;
  }
  document.getElementById('token_calls').textContent = t.total_calls.toLocaleString('ko-KR');
  document.getElementById('token_denied').textContent = t.total_denied.toLocaleString('ko-KR');
  document.getElementById('token_tokens').textContent =
    t.est_tokens >= 1000 ? (t.est_tokens/1000).toFixed(1) + 'K' : t.est_tokens;

  const pctEl = document.getElementById('token_max_pct');
  pctEl.textContent = t.max_5x_pct + '%';
  pctEl.classList.remove('up', 'down', 'warn');
  if (t.max_5x_pct >= 80) pctEl.classList.add('down');
  else if (t.max_5x_pct >= 50) pctEl.classList.add('warn');
  else pctEl.classList.add('up');

  document.getElementById('token_pct_label').textContent = `Max 5x ${t.max_5x_pct}%`;
  document.getElementById('token_coin_calls').textContent = t.coin.calls;
  document.getElementById('token_stock_calls').textContent = t.stock.calls;
  document.getElementById('token_cost').textContent = '$' + t.est_cost_usd.toFixed(3);
}

async function fetchMarket() {
  try {
    const r = await fetch(`${APIS.system}/system/market`, { signal:AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fetchInsights() {
  try {
    const r = await fetch(`${APIS.system}/system/insights`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function renderMarket(m) {
  if (!m) return;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const setChg = (id, v) => {
    const el = document.getElementById(id); if (!el) return;
    if (v == null) { el.textContent = '-'; return; }
    el.textContent = pct(v);
    el.classList.remove('up','down');
    if (v > 0) el.classList.add('up'); else if (v < 0) el.classList.add('down');
  };

  setVal('mkt_btc', m.btc ? fmt(m.btc) + '원' : '-');
  setChg('mkt_btc_chg', m.btc_24h);
  // 알트 평균
  setVal('mkt_alt', m.alt_tracked > 0 ? `${m.alt_tracked}종 평균` : '-');
  setChg('mkt_alt_chg', m.alt_avg_24h);

  // 공포탐욕
  const fngEl = document.getElementById('mkt_fng');
  const fngLbl = document.getElementById('mkt_fng_lbl');
  if (m.fear_greed != null) {
    fngEl.textContent = m.fear_greed;
    let lbl, color;
    if (m.fear_greed >= 75) { lbl='과열'; color='var(--up)'; }
    else if (m.fear_greed >= 55) { lbl='탐욕'; color='var(--warn)'; }
    else if (m.fear_greed >= 45) { lbl='중립'; color='var(--text)'; }
    else if (m.fear_greed >= 25) { lbl='공포'; color='var(--info)'; }
    else { lbl='패닉'; color='var(--down)'; }
    fngLbl.textContent = lbl;
    fngLbl.style.color = color;
    fngEl.style.color = color;
  } else {
    fngEl.textContent = '-';
    fngLbl.textContent = '-';
  }

  setVal('mkt_kospi', m.kospi ? m.kospi.toFixed(2) : '-');
  setChg('mkt_kospi_chg', m.kospi_chg);
  setVal('mkt_nasdaq', m.nasdaq ? m.nasdaq.toFixed(0) : '-');
  setChg('mkt_nasdaq_chg', m.nasdaq_chg);
  setVal('mkt_usdkrw', m.usd_krw ? m.usd_krw.toFixed(0) + '원' : '-');
}

function renderInsights(i) {
  if (!i || !i.combined) {
    ['kpi_winrate','kpi_rr','kpi_mdd','kpi_trades'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '-';
    });
    return;
  }

  const c = i.combined;
  const wr = (c.winrate * 100).toFixed(1) + '%';
  const wrEl = document.getElementById('kpi_winrate');
  wrEl.textContent = wr;
  wrEl.classList.remove('up','down','warn');
  if (c.winrate >= 0.5) wrEl.classList.add('up');
  else if (c.winrate >= 0.4) wrEl.classList.add('warn');
  else wrEl.classList.add('down');

  // 평균 RR (양 봇 평균)
  const bots = Object.values(i.by_bot || {});
  const avgRR = bots.length ? bots.reduce((s,b) => s + b.rr, 0) / bots.length : 0;
  const rrEl = document.getElementById('kpi_rr');
  rrEl.textContent = avgRR.toFixed(2);
  rrEl.classList.remove('up','down','warn');
  if (avgRR >= 1.3) rrEl.classList.add('up');
  else if (avgRR >= 1.0) rrEl.classList.add('warn');
  else rrEl.classList.add('down');

  const mddEl = document.getElementById('kpi_mdd');
  mddEl.textContent = (c.max_mdd * 100).toFixed(1) + '%';
  mddEl.classList.add('down');

  document.getElementById('kpi_trades').textContent = c.trades;

  // 시간대 히트맵
  const grid = document.getElementById('hourly_grid');
  if (grid && i.hourly) {
    const max = Math.max(...i.hourly, 1);
    grid.innerHTML = i.hourly.map((cnt, h) => {
      let lvl = 0;
      if (cnt > 0) {
        const ratio = cnt / max;
        lvl = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
      }
      return `<div class="hourly-cell ${lvl ? 'h-'+lvl : ''}" title="${h}시: ${cnt}건"></div>`;
    }).join('');
  }

  // 페르소나
  const personaList = document.getElementById('persona_list');
  if (personaList) {
    const personas = Object.entries(i.personas || {})
      .filter(([k,v]) => v.trades > 0)
      .sort((a,b) => b[1].pnl - a[1].pnl)
      .slice(0, 6);
    if (personas.length === 0) {
      personaList.innerHTML = '<div class="empty" style="padding:8px 0">데이터 없음</div>';
    } else {
      personaList.innerHTML = personas.map(([name, p]) => {
        const wr = p.trades ? (p.wins / p.trades * 100).toFixed(0) : 0;
        const cls = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : '';
        const icon = p.bot === 'coin' ? '🪙' : '📈';
        return `<div class="persona-row">
          <div class="persona-name">${icon} ${name}</div>
          <div style="display:flex; align-items:center; gap:6px">
            <span class="persona-stats">${p.trades}건 · ${wr}%</span>
            <span class="persona-pnl ${cls}">${fmtSign(p.pnl)}</span>
          </div>
        </div>`;
      }).join('');
    }
  }
}

let _marketCache = {data: null, ts: 0};
async function fetchMarketCached() {
  // 60초 캐시 (외부 API 호출 보호)
  if (Date.now() - _marketCache.ts < 60000 && _marketCache.data) return _marketCache.data;
  const m = await fetchMarket();
  if (m) _marketCache = {data:m, ts:Date.now()};
  return m;
}

async function loadAll(force = false) {
  if (force) _marketCache.ts = 0;  // 강제 새로고침 시 캐시 무효
  const [coinH, coinS, stockH, stockS, tokens, market, insights] = await Promise.all([
    fetchHealth('coin'), fetchStatus('coin'),
    fetchHealth('stock'), fetchStatus('stock'),
    fetchTokens(), fetchMarketCached(), fetchInsights(),
  ]);
  applyHealthUI('coin', coinH);
  applyHealthUI('stock', stockH);
  applyStatusUI('coin', coinS);
  applyStatusUI('stock', stockS);
  renderHomeOverview();
  renderTokens(tokens);
  renderMarket(market);
  renderInsights(insights);

  if (document.getElementById('view-system').classList.contains('active')) {
    loadSystemView();
  }

  document.getElementById('upd-time').textContent =
    new Date().toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});

  if (force) toast('🔄 새로고침 완료');
}

/* ─── Pull-to-Refresh (모바일) ───────────────────────── */
(function setupPTR() {
  let startY = 0, currentY = 0, pulling = false;
  const ptr = document.getElementById('ptr');
  const ptrText = document.getElementById('ptr-text');
  const ptrIcon = document.getElementById('ptr-icon');
  const THRESHOLD = 70;

  if (!ptr) return;

  document.addEventListener('touchstart', e => {
    if (window.scrollY > 5) return;
    if (document.querySelector('.modal-bg.show')) return;
    if (document.querySelector('.menu.show')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, {passive:true});

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy <= 0) { ptr.style.transform = 'translate(-50%, -100%)'; return; }
    const pct = Math.min(dy / THRESHOLD, 1.5);
    ptr.style.transform = `translate(-50%, ${Math.min(dy * 0.5, 50)}px)`;
    ptr.style.opacity = Math.min(pct, 1);
    if (dy >= THRESHOLD) { ptrText.textContent = '놓으면 새로고침'; ptrIcon.style.transform = 'rotate(180deg)'; }
    else { ptrText.textContent = '당겨서 새로고침'; ptrIcon.style.transform = 'rotate(0)'; }
  }, {passive:true});

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    const dy = currentY - startY;
    pulling = false;
    if (dy >= THRESHOLD) {
      ptrText.textContent = '새로고침 중...';
      ptrIcon.style.animation = 'spin 0.8s linear infinite';
      loadAll(true).finally(() => {
        ptr.style.transform = 'translate(-50%, -100%)';
        ptrIcon.style.animation = '';
        ptrIcon.style.transform = 'rotate(0)';
      });
    } else {
      ptr.style.transform = 'translate(-50%, -100%)';
      ptrIcon.style.transform = 'rotate(0)';
    }
  }, {passive:true});

  // CSS keyframe 동적 주입
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
})();

/* ─── 캐시 버스트 (앱 버전 변경시 강제 갱신) ──────────── */
(function checkVersion() {
  const stored = localStorage.getItem('trading_dash_version');
  if (stored && stored !== APP_VERSION) {
    // 버전 바뀜 → SW 캐시 + localStorage 클린 (인증/PW 유지)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
    }
    if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
    console.log(`[버전 갱신] ${stored} → ${APP_VERSION}`);
  }
  localStorage.setItem('trading_dash_version', APP_VERSION);
})();

/* ─── 자가개선 캘린더 + What-If ──────────────────────── */
function initCalendar() {
  const now = new Date();
  if (STATE.cal.year === null) {
    STATE.cal.year = now.getFullYear();
    STATE.cal.month = now.getMonth();
  }
  document.getElementById(`calbtn_coin`).style.background = STATE.cal.bot === 'coin' ? '#f7931a33' : '#0d1117';
  document.getElementById(`calbtn_stock`).style.background = STATE.cal.bot === 'stock' ? '#3fb95033' : '#0d1117';
  renderCalendar();
}

function calNav(dir) {
  if (dir === 0) {
    const now = new Date();
    STATE.cal.year = now.getFullYear();
    STATE.cal.month = now.getMonth();
  } else {
    STATE.cal.month += dir;
    if (STATE.cal.month < 0) { STATE.cal.month = 11; STATE.cal.year--; }
    if (STATE.cal.month > 11) { STATE.cal.month = 0; STATE.cal.year++; }
  }
  renderCalendar();
}

function calBot(bot) {
  STATE.cal.bot = bot;
  document.getElementById(`calbtn_coin`).style.background = bot === 'coin' ? '#f7931a33' : '#0d1117';
  document.getElementById(`calbtn_stock`).style.background = bot === 'stock' ? '#3fb95033' : '#0d1117';
  renderCalendar();
}

async function fetchCalendarData(bot, year, month) {
  // 봇 status에서 최근 거래만 받아와서 일별 집계
  // (전체 히스토리가 필요하면 별도 API 필요 - MVP는 최근 거래로)
  const status = STATE[bot].status;
  if (!status) return {trades:{}, tunes:{}};

  const trades = {};
  (status.recent_trades || []).forEach(t => {
    const d = (t.created_at || t.ts || '').slice(0, 10);
    if (!d) return;
    if (!trades[d]) trades[d] = {pnl:0, count:0};
    trades[d].pnl += (t.pnl || 0);
    trades[d].count++;
  });

  // 튜닝 데이터는 별도 status 필드 'tune_log' 가 있으면 사용
  const tunes = {};
  (status.tune_log || []).forEach(t => {
    const d = (t.created_at || t.ts || '').slice(0, 10);
    if (!d) return;
    if (!tunes[d]) tunes[d] = [];
    tunes[d].push(t);
  });

  return {trades, tunes};
}

async function renderCalendar() {
  const {year, month, bot} = STATE.cal;
  const monthName = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'][month];
  document.getElementById('cal_month').textContent = `${year}년 ${monthName}`;

  const data = await fetchCalendarData(bot, year, month);
  const grid = document.getElementById('cal_grid');

  const dows = ['일','월','화','수','목','금','토'];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  for (let i = 0; i < firstDow; i++) html += `<div class="cal-cell empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const tradeData = data.trades[dateStr];
    const tuneData = data.tunes[dateStr];
    const isToday = isCurrentMonth && today.getDate() === d;

    const classes = ['cal-cell'];
    if (tradeData) classes.push('has-trade');
    if (tuneData) classes.push('has-tune');
    if (isToday) classes.push('today');

    const pnlHtml = tradeData
      ? `<div class="cal-pnl ${tradeData.pnl > 0 ? 'up' : tradeData.pnl < 0 ? 'down' : ''}">${fmtSign(tradeData.pnl)}</div>`
      : '';
    const dotHtml = tuneData ? `<span class="cal-dot"></span>` : '';

    html += `<div class="${classes.join(' ')}" onclick="selectDay('${dateStr}')">
      <div class="cal-day">${d}</div>
      ${pnlHtml}
      ${dotHtml}
    </div>`;
  }

  grid.innerHTML = html;
}

async function selectDay(dateStr) {
  STATE.cal.selectedDay = dateStr;
  const detail = document.getElementById('cal_detail');
  const bot = STATE.cal.bot;
  const data = await fetchCalendarData(bot, STATE.cal.year, STATE.cal.month);

  const trade = data.trades[dateStr];
  const tunes = data.tunes[dateStr] || [];

  let html = `<h4><svg class="ic ic-sm"><use href="#i-cal"/></svg>${dateStr} (${bot === 'coin' ? '🪙 코인봇' : '📈 주식봇'})</h4>`;

  if (trade) {
    html += `<div class="tune-item">📊 거래 ${trade.count}건 · P&L <b class="${trade.pnl > 0 ? 'up' : 'down'}">${fmtSign(trade.pnl)}</b></div>`;
  } else {
    html += `<div class="tune-item" style="color:var(--muted)">거래 데이터 없음</div>`;
  }

  if (tunes.length === 0) {
    html += `<div class="tune-item" style="color:var(--muted)">자가개선 튜닝 없음</div>`;
  } else {
    tunes.forEach(t => {
      html += `<div class="tune-item">
        🔧 <b>${t.param || t.variable}</b>: ${t.old_value} → ${t.new_value}
        <div style="font-size:11px; color:var(--muted); margin-top:2px">사유: ${t.pattern || t.reason || '-'}</div>
      </div>`;
      // What-If 시뮬레이션
      const sim = simulateWhatIf(t, bot);
      html += `<div class="whatif">
        <div class="whatif-title"><svg class="ic ic-xs"><use href="#i-bolt"/></svg>What-If: 이 튜닝을 30일 전부터 적용했다면</div>
        <div class="whatif-row"><span>예상 누적 P&L 변동</span><b class="${sim.pnl_diff >= 0 ? 'up' : 'down'}">${fmtSign(sim.pnl_diff)}</b></div>
        <div class="whatif-row"><span>예상 승률 변동</span><b>${(sim.winrate_diff*100).toFixed(1)}%p</b></div>
        <div class="whatif-row"><span>예상 거래수 변동</span><b>${sim.trades_diff > 0 ? '+' : ''}${sim.trades_diff}건</b></div>
        <div class="whatif-row"><span>예상 MDD 변동</span><b class="${sim.mdd_diff <= 0 ? 'up' : 'down'}">${(sim.mdd_diff*100).toFixed(2)}%p</b></div>
      </div>`;
    });
  }

  detail.innerHTML = html;
}

function simulateWhatIf(tune, bot) {
  /* 휴리스틱 시뮬레이터 - 튜닝 종류별로 효과 추정.
   * 실제 백테스트는 봇 측 backtest 스크립트를 호출해야 함.
   * MVP: 변수별 경험적 추정.
   */
  const param = (tune.param || tune.variable || '').toLowerCase();
  const oldV = parseFloat(tune.old_value) || 0;
  const newV = parseFloat(tune.new_value) || 0;
  const delta = newV - oldV;

  // 지난 30일 거래 데이터 (status에서)
  const recent = (STATE[bot].status?.recent_trades || []);
  const totalTrades = recent.length || 1;
  const wins = recent.filter(t => (t.pnl || 0) > 0).length;
  const baseWinrate = wins / totalTrades;
  const baseTotalPnl = recent.reduce((s,t) => s + (t.pnl || 0), 0);

  let pnlMult = 1.0, winrateDelta = 0, tradesDelta = 0, mddDelta = 0;

  if (param.includes('threshold')) {
    // 임계값 ↑ → 거래수 ↓, 승률 ↑, P&L 안정화
    const factor = delta / 5;
    tradesDelta = Math.round(-totalTrades * 0.10 * factor);
    winrateDelta = 0.03 * factor;
    pnlMult = 1 + 0.05 * factor;
    mddDelta = -0.005 * factor;
  } else if (param.includes('vol')) {
    // 거래량 임계값 ↑ → 거래수 ↓, 위양성 ↓
    const factor = delta / 0.2;
    tradesDelta = Math.round(-totalTrades * 0.08 * factor);
    winrateDelta = 0.02 * factor;
    pnlMult = 1 + 0.03 * factor;
    mddDelta = -0.003 * factor;
  } else if (param.includes('trailing')) {
    // 트레일링 오프셋 ↓ (더 타이트) → 익절 빨라짐, 큰 수익 놓침
    const factor = delta / 0.005;
    tradesDelta = 0;
    winrateDelta = 0.04 * Math.abs(factor);
    pnlMult = 1 - 0.02 * Math.abs(factor);
    mddDelta = -0.002;
  } else if (param.includes('blacklist')) {
    // 블랙리스트 추가 → 거래수 ↓, 손실 회피
    tradesDelta = -3;
    winrateDelta = 0.01;
    pnlMult = 1.02;
    mddDelta = -0.005;
  } else {
    pnlMult = 1.01;
  }

  return {
    pnl_diff: Math.round(baseTotalPnl * (pnlMult - 1)),
    winrate_diff: winrateDelta,
    trades_diff: tradesDelta,
    mdd_diff: mddDelta,
  };
}

/* ─── 시작 ────────────────────────────────────────── */
if (!FIREBASE_MODE) {
  loadAll();
  setInterval(loadAll, 30000);
} else {
  // Firebase 모드: Firestore 실시간 구독으로 status 자동 업데이트
  // 시장/인사이트는 system_api 없으면 빈 값 (혹은 별도 API 추가 가능)
  console.log('[모드] Firebase Firestore (외부)');
  toast('🌐 Firebase 모드 - 실시간 동기화');
}
