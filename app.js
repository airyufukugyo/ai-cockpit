/* Secretary Cockpit PWA - Google直結クライアント.
   - GIS でログイン → Google Tasks(6リスト) を読み書き / Google Sheets(KPI) へ追記
   - ゲーム数値(XP/Lv/連続/クエスト/ボス/進捗) は defs.json のルールで「その場で」再計算
     → 外出先でもチェックするとバー・レベル・ボスHPがライブに動く（PC不要）
   秘密は持たない: CLIENT_ID と KPIシートID は端末の localStorage のみ（公開コードに含めない）。 */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = 'https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/spreadsheets';

let CFG = loadCfg();
let DEFS = null;
let TASKS = [];          // パース済みタスク
let G = null;            // gamify スナップショット
let REV = { month: 0, total: 0 };
let viewDate = null;
let todoMode = 'day';   // 'day'=この日 / 'all'=未完了すべて
let sortMode = 'date';  // 'date'=日付順 / 'prio'=優先度順
let accessToken = null, tokenClient = null, waiters = [], busy = false;
const PRIORITY_RANK = { '高': 0, '通常': 1, '低': 2, '': 3 };

function loadCfg() { try { return JSON.parse(localStorage.getItem('cockpit_cfg') || '{}'); } catch (e) { return {}; } }
function saveCfg(c) { CFG = c; localStorage.setItem('cockpit_cfg', JSON.stringify(c)); }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmt(n) { return '¥' + (n || 0).toLocaleString('ja-JP'); }

/* ---------- 認証 (GIS token client) ---------- */
function initToken() {
  if (tokenClient) return true;
  if (!window.google || !window.google.accounts || !CFG.client_id) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.client_id, scope: SCOPES,
    callback: r => { if (r && r.access_token) { accessToken = r.access_token; waiters.forEach(w => w(true)); } else { waiters.forEach(w => w(false)); } waiters = []; }
  });
  return true;
}
function login(interactive) {
  return new Promise(resolve => {
    if (!initToken()) { resolve(false); return; }
    waiters.push(resolve);
    try { tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' }); }
    catch (e) { resolve(false); }
  });
}
async function api(url, opts = {}) {
  if (!accessToken) { if (!await login(true)) throw new Error('ログインが必要です'); }
  opts.headers = Object.assign({ 'Authorization': 'Bearer ' + accessToken }, opts.headers || {});
  let r = await fetch(url, opts);
  if (r.status === 401) { accessToken = null; if (!await login(false)) throw new Error('認証切れ'); opts.headers.Authorization = 'Bearer ' + accessToken; r = await fetch(url, opts); }
  if (!r.ok) throw new Error('API ' + r.status);
  return r;
}

/* ---------- Google Tasks 読み込み ---------- */
async function fetchAllTasks() {
  const lists = (await (await api(TASKS_API + '/users/@me/lists?maxResults=100')).json()).items || [];
  const out = [];
  for (const l of lists) {
    let pageToken = '';
    do {
      const u = TASKS_API + '/lists/' + l.id + '/tasks?showCompleted=true&showHidden=true&maxResults=100' + (pageToken ? '&pageToken=' + pageToken : '');
      const res = await (await api(u)).json();
      (res.items || []).forEach(t => { const p = parseTask(t, l.id, l.title); if (p) out.push(p); });
      pageToken = res.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}
function parseTask(t, listId, listTitle) {
  const notes = t.notes || '';
  const sid = (notes.match(/\[sid:([0-9a-f]+)\]/) || [])[1] || t.id;
  const date = (notes.match(/日付:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || (t.completed ? t.completed.slice(0, 10) : '');
  const section = (notes.match(/セクション:\s*([^\n]+)/) || [])[1] || 'その他';
  const text = (t.title || '') + ' ' + notes;
  const priority = (notes.match(/優先度?:\s*(高|通常|低)/) || [])[1] || '';
  const due = (notes.match(/期限:\s*([^\n|]+)/) || [])[1] || '';
  const tags = (text.match(/#([A-Z]{2,3}-\d+|M\d+)/g) || []).map(x => x.slice(1));
  const body = notes.split('\n').filter(ln => !/^(セクション:|日付:|\[sid:)/.test(ln.trim())).join('\n').trim();
  return {
    sid, listId, taskId: t.id, title: t.title || '(無題)', notes, body,
    date, section, priority, due: due.trim().replace(/\|$/, '').trim(), tags,
    done: t.status === 'completed', text
  };
}

/* ---------- ゲーム化（gamify.py と同一ルール: defs.scoring） ---------- */
function taskXp(t) {
  const sc = DEFS.scoring;
  let xp = (t.priority && sc.by_priority[t.priority] != null) ? sc.by_priority[t.priority] : sc.default;
  if (t.tags.length) xp += sc.bonus;
  return xp;
}
function levelForXp(total) {
  let lvl = 1, rem = Math.max(0, total | 0), need = 100;
  while (rem >= need) { rem -= need; lvl++; need = 100 * lvl; }
  return { level: lvl, into: rem, need, pct: need ? Math.round(rem * 100 / need) : 0 };
}
function computeGamify() {
  const perDay = {}, perXp = {};
  let totalXp = 0, totalDone = 0;
  for (const t of TASKS) {
    if (!t.done || !t.date) continue;
    perDay[t.date] = (perDay[t.date] || 0) + 1;
    const xp = taskXp(t); perXp[t.date] = (perXp[t.date] || 0) + xp;
    totalXp += xp; totalDone++;
  }
  const today = todayStr();
  // streak
  let streak = 0, cur = new Date(today);
  if (!(perDay[today] > 0)) cur.setDate(cur.getDate() - 1);
  while (perDay[cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0')] > 0) { streak++; cur.setDate(cur.getDate() - 1); }
  const lvl = levelForXp(totalXp);
  const tq = DEFS.scoring.quest_target || 3, td = perDay[today] || 0;
  const stats = {
    total_xp: totalXp, total_done: totalDone, today_done: td, today_xp: perXp[today] || 0,
    streak, level: lvl.level, level_into: lvl.into, level_need: lvl.need, level_pct: lvl.pct,
    quest_target: tq, quest_pct: Math.min(100, Math.round(td * 100 / tq)), quest_done: td >= tq,
    heatmap: perDay, revenue_total: REV.total, revenue_month: REV.month
  };
  stats.badges = computeBadges(stats);
  return stats;
}
function computeBadges(s) {
  return [
    ['first', '🎯', '初完了', s.total_done >= 1], ['streak3', '🔥', '3日連続', s.streak >= 3],
    ['streak7', '🔥', '7日連続', s.streak >= 7], ['streak30', '🏆', '30日連続', s.streak >= 30],
    ['tasks100', '💯', '累計100', s.total_done >= 100], ['tasks500', '⚡', '累計500', s.total_done >= 500],
    ['lv5', '⭐', 'Lv5', s.level >= 5], ['lv10', '🌟', 'Lv10', s.level >= 10],
    ['lv20', '👑', 'Lv20', s.level >= 20], ['revenue', '💰', '初収益', (s.revenue_total || 0) >= 1]
  ].map(([id, e, n, g]) => ({ id, emoji: e, name: n, got: !!g }));
}

/* ---------- 進捗（roadmap.py と同一ロジックを Tasks の#IDから） ---------- */
function progressLive() {
  const done = new Set(), pending = new Set();
  for (const t of TASKS) { const set = t.done ? done : pending; t.tags.forEach(x => set.add(x)); }
  const statusOf = id => done.has(id) ? 'done' : (pending.has(id) ? 'doing' : 'todo');
  const roadmaps = (DEFS.roadmaps || []).map(r => {
    let rd = 0, rt = 0;
    const phases = r.phases.map(ph => {
      let pd = 0; const tasks = ph.tasks.map(t => { const stt = statusOf(t.id); if (stt === 'done') pd++; return { id: t.id, text: t.text, status: stt }; });
      rd += pd; rt += ph.tasks.length;
      return { name: ph.name, done: pd, total: ph.tasks.length, pct: ph.tasks.length ? Math.round(pd * 100 / ph.tasks.length) : 0, tasks };
    });
    return { title: r.title, color: r.color, tagline: r.tagline, done: rd, total: rt, pct: rt ? Math.round(rd * 100 / rt) : 0, phases };
  });
  const doneIds = new Set(); roadmaps.forEach(r => r.phases.forEach(ph => ph.tasks.forEach(t => { if (t.status === 'done') doneIds.add(t.id); })));
  let ms = null;
  if (DEFS.milestones) {
    const items = DEFS.milestones.items.map(m => {
      let stt;
      if (done.has(m.id)) stt = 'done';
      else if (m.cond && m.cond.length && m.cond.every(c => doneIds.has(c))) stt = 'done';
      else if (pending.has(m.id) || (m.cond && m.cond.some(c => doneIds.has(c)))) stt = 'doing';
      else stt = 'todo';
      return { id: m.id, label: m.label, status: stt };
    });
    const dn = items.filter(i => i.status === 'done').length;
    ms = { tagline: DEFS.milestones.tagline, items, done: dn, total: items.length, pct: items.length ? Math.round(dn * 100 / items.length) : 0 };
  }
  return { roadmaps, milestones: ms };
}

/* ---------- レンダリング ---------- */
function countUp(el, to) { const from = +(el.dataset.v || 0); if (from === to) { el.textContent = to; return; } const t0 = performance.now(); function st(t) { const k = Math.min(1, (t - t0) / 600); el.textContent = Math.round(from + (to - from) * (1 - (1 - k) * (1 - k))); if (k < 1) requestAnimationFrame(st); else { el.textContent = to; el.dataset.v = to; } } el.dataset.v = from; requestAnimationFrame(st); }
function toast(txt) { const t = document.createElement('div'); t.className = 'xptoast'; t.textContent = txt; $('#toast').appendChild(t); setTimeout(() => t.remove(), 2000); }
function levelup(n) { $('#lvlupN').textContent = 'Lv.' + n; const m = $('#lvlup'); m.classList.add('show'); setTimeout(() => m.classList.remove('show'), 1900); }
function renderHero() {
  if (!G) return;
  $('#lvlN').textContent = G.level; $('#lvlRing').style.setProperty('--p', G.level_pct + '%');
  $('#xpInto').textContent = G.level_into; $('#xpNeed').textContent = G.level_need; $('#xpFill').style.width = G.level_pct + '%';
  countUp($('#totXp'), G.total_xp);
  const s = $('#streakN'); s.textContent = G.streak; s.className = 'n' + (G.streak > 0 ? '' : ' cold');
  $('#streakIco').textContent = G.streak > 0 ? '🔥' : '·';
  $('#questQ').textContent = '今日 ' + G.today_done + '/' + G.quest_target;
}
function taskCard(t, showDate) {
  const tags = t.tags.map(x => `<span class="chip tag">#${esc(x)}</span>`).join('');
  const pr = t.priority ? `<span class="chip">優先度:${t.priority}</span>` : '';
  const due = t.due ? `<span class="chip due">⏰${esc(t.due)}</span>` : '';
  const dchip = showDate ? `<span class="chip dt">📅${esc(t.date || '')}</span>` : '';
  const body = t.body ? `<div class="tbody"><pre>${esc(t.body)}</pre></div>` : '';
  return `<div class="task${t.done ? ' done' : ''}" data-sid="${t.sid}" data-date="${esc(t.date || '')}">
    <div class="trow"><div class="cb${t.done ? ' on' : ''}" data-act="check">
      <svg viewBox="0 0 18 18"><path d="M3 9l4 4 8-9"/></svg></div>
      <div class="tmain" data-act="toggle"><div class="tt">${esc(t.title)}</div>
      <div class="badges">${dchip}${pr}${due}${tags}<span class="chip xp">+${taskXp(t)}XP</span></div></div></div>${body}</div>`;
}
function todoToolbar() {
  return `<div class="todobar">
    <div class="seg" id="modeSeg">
      <button data-m="day"${todoMode === 'day' ? ' class="on"' : ''}>📅 この日</button>
      <button data-m="all"${todoMode === 'all' ? ' class="on"' : ''}>📋 未完了すべて</button>
    </div>
    <div class="seg" id="sortSeg">
      <button data-s="date"${sortMode === 'date' ? ' class="on"' : ''}>日付順</button>
      <button data-s="prio"${sortMode === 'prio' ? ' class="on"' : ''}>優先度順</button>
    </div>
  </div>`;
}
function sortTasks(ts) {
  const a = ts.slice();
  if (sortMode === 'prio') a.sort((x, y) => (PRIORITY_RANK[x.priority] ?? 3) - (PRIORITY_RANK[y.priority] ?? 3));
  return a;
}
function bindTodoBar() {
  $$('#modeSeg button').forEach(b => b.onclick = () => { todoMode = b.dataset.m; renderToday(); });
  $$('#sortSeg button').forEach(b => b.onclick = () => { sortMode = b.dataset.s; renderToday(); });
}
function bindTodayCards() {
  $$('#today .task').forEach(card => {
    const sid = card.dataset.sid;
    const cdate = card.dataset.date || viewDate;
    card.querySelectorAll('[data-act]').forEach(el => el.onclick = e => {
      if (el.dataset.act === 'check') { e.stopPropagation(); doCheck(sid, !card.classList.contains('done'), card, cdate); }
      else card.classList.toggle('open');
    });
  });
}
function renderToday() {
  const w = $('#today');
  if (!accessToken) {
    w.innerHTML = `<div class="empty"><p>Google にログインすると、今日のタスクを読み込みます。<br>外出先でもチェックでき、進捗がその場で更新されます。</p>
      <button class="btn" id="loginBtn">Google でログイン</button></div>`;
    $('#loginBtn').onclick = () => login(true).then(ok => { if (ok) loadAll(); });
    return;
  }
  if (todoMode === 'all') { renderTodayAll(w); return; }
  const dates = [...new Set(TASKS.map(t => t.date).filter(Boolean))].sort().reverse();
  const today = todayStr();
  if (!viewDate) viewDate = dates.includes(today) ? today : (dates.find(d => d <= today) || dates[0] || today);
  const day = TASKS.filter(t => t.date === viewDate);
  let html = todoToolbar();
  if (viewDate !== today) html += `<div class="banner">表示中: <b>${viewDate}</b>（今日 ${today} のタスクは未同期。PCで「Google送信」すると出ます）</div>`;
  if (!day.length) { html += `<div class="empty"><p>表示できるタスクがありません。<br>PC側で日次ファイルを作成し「Google送信(push)」してください。</p></div>`; w.innerHTML = html; bindTodoBar(); return; }
  const order = ['最優先', '通常', '余裕があれば', '完了', 'その他'];
  const secs = [...new Set(day.map(t => t.section))].sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0)));
  for (const sec of secs) {
    const ts = day.filter(t => t.section === sec);
    html += `<div class="sec">${esc(sec)} <span class="cnt">${ts.filter(t => t.done).length}/${ts.length}</span></div>` + sortTasks(ts).map(t => taskCard(t)).join('');
  }
  w.innerHTML = html;
  bindTodoBar();
  bindTodayCards();
}
function renderTodayAll(w) {
  const open = TASKS.filter(t => !t.done && t.date);
  const dates = [...new Set(open.map(t => t.date))].sort().reverse();
  let html = todoToolbar();
  html += `<div class="allhdr">未完了 ${open.length} 件 ・ 全 ${dates.length} 日</div>`;
  if (!open.length) { html += `<div class="empty"><p>未完了タスクはありません 🎉</p></div>`; w.innerHTML = html; bindTodoBar(); return; }
  if (sortMode === 'prio') {
    const flat = open.slice().sort((x, y) => (PRIORITY_RANK[x.priority] ?? 3) - (PRIORITY_RANK[y.priority] ?? 3) || (x.date < y.date ? 1 : -1));
    html += flat.map(t => taskCard(t, true)).join('');
  } else {
    for (const d of dates) {
      const ts = open.filter(t => t.date === d);
      html += `<div class="sec">📅 ${esc(d)} <span class="cnt">${ts.length}</span></div>` + ts.map(t => taskCard(t)).join('');
    }
  }
  w.innerHTML = html;
  bindTodoBar();
  bindTodayCards();
}
async function doCheck(sid, done, card, cdate) {
  if (busy) return; busy = true;
  cdate = cdate || viewDate;
  card.classList.toggle('done', done); card.querySelector('.cb').classList.toggle('on', done);
  const t = TASKS.find(x => x.sid === sid && x.date === cdate) || TASKS.find(x => x.sid === sid);
  const oldXp = G.total_xp, oldLv = G.level;
  try {
    await api(TASKS_API + '/lists/' + t.listId + '/tasks/' + t.taskId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: done ? 'completed' : 'needsAction' })
    });
    t.done = done;
    G = computeGamify();
    const dx = G.total_xp - oldXp; if (dx > 0) toast('+' + dx + ' XP');
    if (G.level > oldLv) setTimeout(() => levelup(G.level), 300);
    renderHero(); renderProgress(); renderStats();
    if (todoMode === 'all' && done) setTimeout(renderToday, 250); // 完了は未完了一覧から外す
  } catch (e) {
    card.classList.toggle('done', !done); card.querySelector('.cb').classList.toggle('on', !done);
    toast('保存失敗');
  } finally { busy = false; }
}
function bossBar(m) {
  const b = (DEFS.boss || {})[m.id] || {}; const beat = m.status === 'done';
  let cur = 0, thr = b.threshold || 0, sub;
  if (b.basis === 'month') { cur = REV.month; sub = '当月 ' + fmt(cur) + ' / ' + fmt(thr); }
  else if (b.basis === 'total') { cur = REV.total; sub = '累計 ' + fmt(cur) + ' / ' + fmt(thr); }
  else sub = beat ? '撃破' : (m.status === 'doing' ? '交戦中' : '未討伐');
  const pct = beat ? 100 : (thr ? Math.min(100, Math.round(cur * 100 / thr)) : (m.status === 'doing' ? 40 : 0));
  const em = beat ? '🏆' : (m.status === 'doing' ? '⚔️' : '👾');
  return `<div class="boss${beat ? ' beat' : ''}"><div class="em">${em}</div><div class="bi">
    <div class="bn">${m.id} ${esc(m.label)} <small>${sub}</small></div>
    <div class="hpbar"><i style="width:${pct}%"></i></div></div><div>${beat ? '✓' : (m.status === 'doing' ? '◐' : '○')}</div></div>`;
}
function renderProgress() {
  const w = $('#progress'); if (!w || !DEFS) return;
  const P = progressLive(); let html = '';
  if (P.milestones) {
    const ms = P.milestones;
    html += `<div class="card2"><div class="hd"><h2>👑 KPIボス戦</h2><span class="pct" style="color:var(--gold)">${ms.pct}%</span></div>
      <div class="tag2">${esc(ms.tagline)}</div><div class="bar"><i style="width:${ms.pct}%;background:linear-gradient(90deg,var(--gold),#fbbf24)"></i></div>
      ${ms.items.map(bossBar).join('')}
      ${CFG.kpi_sheet_id ? '<button class="btn ghost" id="revBtn" style="margin-top:8px">💰 売上を取得してHPに反映</button><div class="msg" id="revMsg"></div>' : '<div class="tag2" style="margin-top:8px">⚙️設定でKPIシートIDを入れると売上が反映されます</div>'}</div>`;
  }
  for (const r of P.roadmaps) {
    const phs = r.phases.map(ph => `<details${ph.pct < 100 ? ' open' : ''} style="margin-top:6px"><summary style="cursor:pointer;font-size:.8rem;color:var(--dim);display:flex;justify-content:space-between">
      <span>${esc(ph.name)}</span><span>${ph.done}/${ph.total}・${ph.pct}%</span></summary>
      <ul style="list-style:none;margin:5px 0">${ph.tasks.map(t => `<li style="display:flex;gap:7px;font-size:.78rem;padding:3px 0;color:${t.status === 'done' ? '#5b6b87' : t.status === 'doing' ? 'var(--txt)' : 'var(--dim)'}">
        <span>${({ done: '✓', doing: '◐', todo: '○' })[t.status]}</span><span style="${t.status === 'done' ? 'text-decoration:line-through' : ''}">${esc(t.id)} ${esc(t.text)}</span></li>`).join('')}</ul></details>`).join('');
    html += `<div class="card2" style="border-left:4px solid ${r.color}"><div class="hd"><h2>${esc(r.title)}</h2><span class="pct" style="color:${r.color}">${r.pct}%</span></div>
      <div class="tag2">${esc(r.tagline)}</div><div class="bar"><i style="width:${r.pct}%;background:${r.color}"></i></div>${phs}</div>`;
  }
  w.innerHTML = html;
  const rb = $('#revBtn'); if (rb) rb.onclick = () => { rb.disabled = true; $('#revMsg').textContent = '取得中…'; loadRevenue().then(() => { $('#revMsg').textContent = '当月 ' + fmt(REV.month) + ' / 累計 ' + fmt(REV.total); G = computeGamify(); renderProgress(); renderStats(); renderHero(); }).catch(e => { rb.disabled = false; $('#revMsg').textContent = '失敗: ' + e.message; }); };
}
function renderStats() {
  const w = $('#stats'); if (!w || !G) return;
  let heat = '';
  const weeks = 16, today = new Date(todayStr());
  const end = new Date(today); end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
  const start = new Date(end); start.setDate(start.getDate() - weeks * 7 + 1);
  let cur = new Date(start);
  for (let wk = 0; wk < weeks; wk++) { heat += '<div class="col">'; for (let dd = 0; dd < 7; dd++) { const ds = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0'); const c = G.heatmap[ds] || 0; const lv = c === 0 ? 0 : c <= 1 ? 1 : c <= 3 ? 2 : c <= 5 ? 3 : 4; const fut = cur > today; heat += `<div class="cell l${lv}${fut ? ' future' : ''}" title="${ds}: ${c}"></div>`; cur.setDate(cur.getDate() + 1); } heat += '</div>'; }
  const goal = 100000000, gp = Math.min(100, REV.total * 100 / goal);
  w.innerHTML = `<div class="card2"><div class="hd"><h2>📊 実績バッジ</h2></div><div class="bgrid">
    ${G.badges.map(b => `<div class="bd${b.got ? ' got' : ''}"><div class="e">${b.emoji}</div><div class="n">${esc(b.name)}</div></div>`).join('')}</div></div>
    <div class="card2"><div class="hd"><h2>🔥 連続日数ヒートマップ</h2></div><div class="heat">${heat}</div>
      <div class="tag2" style="margin-top:8px">累計 ${G.total_done} タスク ・ 総 ${G.total_xp} XP ・ Lv.${G.level}</div></div>
    <div class="card2"><div class="hd"><h2>💰 ¥1億への道</h2></div>
      <div class="tag2" style="display:flex;justify-content:space-between"><span>${fmt(REV.total)}</span><span>目標 ¥100,000,000</span></div>
      <div class="bar"><i style="width:${gp}%;background:linear-gradient(90deg,var(--grn),var(--gold))"></i></div></div>`;
}

/* ---------- KPI / 売上 ---------- */
async function loadRevenue() {
  if (!CFG.kpi_sheet_id) return;
  const res = await (await api(SHEETS_API + '/' + CFG.kpi_sheet_id + '/values/A2:G')).json();
  const ym = todayStr().slice(0, 7); let m = 0, tot = 0;
  (res.values || []).forEach(r => { if (r.length < 7) return; const v = parseInt(String(r[6]).replace(/[,¥\s]/g, '') || '0', 10); if (isNaN(v)) return; tot += v; if (String(r[0]).startsWith(ym)) m += v; });
  REV = { month: m, total: tot };
}

/* ---------- 設定モーダル ---------- */
function openSettings(force) {
  const m = $('#modal');
  $('#modalBox').innerHTML = `<h2>⚙️ 設定（この端末のみ保存）</h2>
    <p>初回だけ入力します。値は端末内(localStorage)に保存され、公開サーバには送られません。<br>
    取得方法は cockpit-dashboard.md を参照。</p>
    <label>Google OAuth クライアントID (Web)</label>
    <input id="cfgClient" placeholder="xxxxx.apps.googleusercontent.com" value="${esc(CFG.client_id || '')}">
    <label>KPI計測シートID（任意・売上ボスHP用）</label>
    <input id="cfgSheet" placeholder="1AbC...（シートURLの /d/ と /edit の間）" value="${esc(CFG.kpi_sheet_id || '')}">
    <button class="btn" id="cfgSave" style="margin-top:16px">保存して読み込む</button>
    ${force ? '' : '<button class="btn ghost" id="cfgClose" style="margin-top:8px">閉じる</button>'}`;
  m.classList.add('show');
  $('#cfgSave').onclick = () => {
    saveCfg({ client_id: $('#cfgClient').value.trim(), kpi_sheet_id: $('#cfgSheet').value.trim() });
    m.classList.remove('show'); tokenClient = null; accessToken = null;
    if (CFG.client_id) login(true).then(ok => { if (ok) loadAll(); else renderToday(); });
  };
  const cc = $('#cfgClose'); if (cc) cc.onclick = () => m.classList.remove('show');
}

/* ---------- ロード / 起動 ---------- */
async function loadAll() {
  try {
    TASKS = await fetchAllTasks();
    if (CFG.kpi_sheet_id) { try { await loadRevenue(); } catch (e) { } }
    viewDate = null;
    G = computeGamify();
    renderHero(); renderToday(); renderProgress(); renderStats();
  } catch (e) { toast('読込失敗: ' + e.message); renderToday(); }
}
function switchTab(name) { $$('.view').forEach(v => v.classList.toggle('on', v.id === name)); $$('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === name)); }
async function boot() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  try { DEFS = await (await fetch('defs.json', { cache: 'no-store' })).json(); } catch (e) { DEFS = { scoring: { by_priority: { '高': 30, '通常': 20, '低': 10 }, default: 15, bonus: 5, quest_target: 3 }, roadmaps: [], milestones: null, boss: {} }; }
  $$('nav.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.t));
  $('#gearBtn').onclick = () => openSettings(false);
  G = { level: 1, level_pct: 0, level_into: 0, level_need: 100, total_xp: 0, streak: 0, today_done: 0, quest_target: DEFS.scoring.quest_target || 3, total_done: 0, heatmap: {}, badges: [] };
  renderHero();
  if (!CFG.client_id) { renderToday(); openSettings(true); return; }
  initToken();
  // 既存セッションがあれば静かにログインを試みる
  const ok = await login(false);
  if (ok) loadAll(); else renderToday();
}
window.addEventListener('DOMContentLoaded', boot);
