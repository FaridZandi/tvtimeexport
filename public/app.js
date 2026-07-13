const app = document.querySelector('#app');
const nav = document.querySelector('#nav');
const dialog = document.querySelector('#dialog');
const routes = ['dashboard', 'shows', 'movies', 'history'];
let current = location.hash.slice(1) || 'dashboard';

const get = async path => { const r = await fetch(path); if (!r.ok) throw new Error((await r.json()).error); return r.json(); };
const send = async (path, method, data) => { const r = await fetch(path, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); const json=await r.json(); if(!r.ok) throw new Error(json.error); return json; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => value ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(value.replace(' ','T')+'Z')) : 'Unknown date';
const episode = row => row.season_number === '' ? '' : `S${row.season_number} · E${row.episode_number}`;

function renderNav(){ nav.innerHTML=routes.map(r=>`<a href="#${r}" class="${current===r?'active':''}">${r[0].toUpperCase()+r.slice(1)}</a>`).join(''); }
function setPage(name){ location.hash=name; }

async function dashboard(){
 const data=await get('/api/dashboard'); const s=data.stats;
 app.innerHTML=`<p class="eyebrow">Your private watch log</p><h1>Good to see you.</h1><p class="sub">Everything you’ve watched, in one calm place.</p>
 <section class="stats"><div class="stat"><strong>${s.shows}</strong><span>shows in library</span></div><div class="stat"><strong>${s.following}</strong><span>currently following</span></div><div class="stat"><strong>${s.episodes.toLocaleString()}</strong><span>episode watches</span></div><div class="stat"><strong>${s.moviesWatched}</strong><span>movies watched</span></div><div class="stat"><strong>${s.watchlistMovies}</strong><span>movies to watch</span></div></section>
 <section class="grid"><div class="panel"><div class="panel-head"><h2>Continue watching</h2><a class="link" href="#shows">Library →</a></div><div class="rows">${data.continueWatching.map(x=>`<div class="row"><div class="glyph">▶</div><div><b>${escape(x.title)}</b><small>Last logged: ${escape(x.latest_episode)} · ${date(x.last_watched)}</small></div></div>`).join('') || '<p class="empty">Log an episode to start a continue-watching list.</p>'}</div></div>
 <div class="panel"><div class="panel-head"><h2>Recent activity</h2><a class="link" href="#history">All history →</a></div><div class="rows">${data.recent.slice(0,6).map(x=>`<div class="row"><div class="glyph">${x.kind==='Movie'?'◆':'▸'}</div><div><b>${escape(x.title)}</b><small>${x.kind}${episode(x)?' · '+episode(x):''} · ${date(x.occurred_at)}</small></div></div>`).join('')}</div></div></section>`;
}
async function shows(){
 const data=await get('/api/shows');
 app.innerHTML=`<div class="toolbar"><div><p class="eyebrow">Library</p><h1>Shows</h1><p class="sub">Follow what matters; archive what’s finished.</p></div><input class="search" id="showSearch" placeholder="Search your shows" /></div><section class="library" id="showList"></section>`;
 const draw=list=>document.querySelector('#showList').innerHTML=list.map(x=>`<article class="item"><h2>${escape(x.title)}</h2><p>${x.logged_episodes || x.episodes_seen_reported || 0} episodes logged${x.last_watched?' · last '+date(x.last_watched):''}</p><div class="pills">${x.followed==='1'?'<span class="pill on">Following</span>':''}${x.favorited==='1'?'<span class="pill">Favorite</span>':''}${x.archived==='1'?'<span class="pill">Archived</span>':''}</div><div class="item-actions"><button class="secondary" data-watch="${escape(x.show_key)}">Log episode</button><button class="muted-btn" data-toggle="${escape(x.show_key)}" data-field="archived" data-value="${x.archived!=='1'}">${x.archived==='1'?'Unarchive':'Archive'}</button></div></article>`).join('') || '<p class="empty">No shows match that search.</p>';
 draw(data); document.querySelector('#showSearch').oninput=e=>draw(data.filter(x=>x.title.toLowerCase().includes(e.target.value.toLowerCase())));
}
async function movies(){
 const data=await get('/api/movies');
 app.innerHTML=`<div class="toolbar"><div><p class="eyebrow">Film log</p><h1>Movies</h1><p class="sub">Watched films and the ones you mean to get to.</p></div><button class="add" data-add-movie>＋ Add movie</button></div><section class="library">${data.map(x=>`<article class="item"><h2>${escape(x.title)}</h2><p>${x.last_activity ? 'Last activity '+date(x.last_activity) : 'Added manually'}</p><div class="pills">${x.watched?'<span class="pill on">Watched</span>':''}${x.watchlist?'<span class="pill">Watchlist</span>':''}</div></article>`).join('') || '<p class="empty">No movies yet.</p>'}</section>`;
}
async function history(){
 const data=await get('/api/history');
 app.innerHTML=`<p class="eyebrow">Chronological log</p><h1>Watch history</h1><p class="sub">The latest 250 recorded activities.</p><table class="history"><thead><tr><th>Title</th><th>Type</th><th>Details</th><th>Date</th></tr></thead><tbody>${data.map(x=>`<tr><td><b>${escape(x.title)}</b></td><td>${escape(x.type)}</td><td>${escape(x.event_kind)}${episode(x)?' · '+episode(x):''}</td><td>${date(x.occurred_at)}</td></tr>`).join('')}</tbody></table>`;
}
function showAdd(kind='show'){
 dialog.innerHTML=`<form method="dialog" class="modal" id="addForm"><h2>Add to your tracker</h2><div class="tabs"><button type="button" class="${kind==='show'?'selected':''}" data-kind="show">Show</button><button type="button" class="${kind==='movie'?'selected':''}" data-kind="movie">Movie</button></div><div class="field"><label>Title</label><input name="title" required autofocus placeholder="e.g. The Bear" /></div>${kind==='movie'?'<div class="field"><label>Status</label><select name="status"><option value="watchlist">Add to watchlist</option><option value="watched">Already watched</option></select></div>':''}<div class="form-actions"><button type="button" class="muted-btn" data-close>Cancel</button><button class="add">Add ${kind}</button></div></form>`;
 dialog.showModal(); dialog.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>showAdd(b.dataset.kind)); dialog.querySelector('[data-close]').onclick=()=>dialog.close(); dialog.querySelector('#addForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await send(kind==='show'?'/api/shows':'/api/movies','POST',Object.fromEntries(f));dialog.close();setPage(kind==='show'?'shows':'movies');}catch(err){alert(err.message)}};
}
async function showEpisode(key){
 dialog.innerHTML=`<form method="dialog" class="modal" id="episodeForm"><h2>Log an episode</h2><div class="field"><label>Season</label><input name="season" type="number" min="0" value="1" required /></div><div class="field"><label>Episode</label><input name="episode" type="number" min="1" value="1" required /></div><label><input name="rewatch" type="checkbox" /> This is a rewatch</label><div class="form-actions"><button type="button" class="muted-btn" data-close>Cancel</button><button class="add">Log episode</button></div></form>`;
 dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('#episodeForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await send('/api/episodes/watch','POST',{show_key:key,season:f.get('season'),episode:f.get('episode'),rewatch:f.get('rewatch')==='on'});dialog.close();setPage('dashboard');}catch(err){alert(err.message)}};
}
async function render(){ current=location.hash.slice(1)||'dashboard'; if(!routes.includes(current)) current='dashboard'; renderNav(); try{await ({dashboard,shows,movies,history}[current])()}catch(e){app.innerHTML=`<h1>Couldn’t load your tracker</h1><p class="sub">${escape(e.message)}</p>`} }
document.querySelector('#addButton').onclick=()=>showAdd();document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.addMovie)return showAdd('movie');if(b.dataset.watch)return showEpisode(b.dataset.watch);if(b.dataset.toggle){await send('/api/shows/'+encodeURIComponent(b.dataset.toggle),'PATCH',{field:b.dataset.field,value:b.dataset.value==='true'});render();}});window.addEventListener('hashchange',render);render();
