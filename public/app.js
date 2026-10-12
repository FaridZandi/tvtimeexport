import { mountMediaSearch } from './show-search.js';
const app = document.querySelector('#app');
const nav = document.querySelector('#nav');
const dialog = document.querySelector('#dialog');
const routes = ['dashboard', 'shows', 'upcoming', 'movies', 'history'];
let current = location.hash.slice(1) || 'dashboard';
let activeShowKey = null;
let syncNotice = '';

const get = async path => { const response = await fetch(path); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; };
const send = async (path, method, data) => { const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); return body; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.replace(' ', 'T')}Z`)) : 'Date TBA';
const image = (url, title, className = '') => url ? `<img class="${className}" src="${escape(url)}" alt="${escape(title)}" loading="lazy" />` : `<div class="art-fallback ${className}" aria-label="${escape(title)}">${escape(title.slice(0, 1))}</div>`;
const episode = row => row.season_number === '' ? '' : `S${row.season_number} · E${row.episode_number}`;
const year = value => value && /^\d{4}/.test(value) ? value.slice(0, 4) : '';
const colorTone = value => [...String(value)].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 7) % 4;
const syncNoticeMarkup = () => syncNotice ? `<div class="sync-notice ${syncNotice.startsWith('Sync failed') ? 'sync-error' : ''}" role="status">${escape(syncNotice)}</div>` : '';

function renderNav() { nav.innerHTML = routes.map(route => `<a href="#${route}" class="${current === route ? 'active' : ''}">${route[0].toUpperCase() + route.slice(1)}</a>`).join(''); }
function setPage(name) { const same = current === name; location.hash = name; if (same) render(); }
function showCard(show) { return `<button class="show-card" data-episodes="${escape(show.show_key)}"><div class="poster">${image(show.poster_url, show.title, 'poster-image')}<span class="poster-shade"></span>${year(show.first_aired) ? `<span class="poster-year">${year(show.first_aired)}</span>` : ''}<span class="poster-title">${escape(show.title)}</span>${show.next_aired ? `<span class="next-badge">Next ${date(show.next_aired)}</span>` : ''}</div><div class="show-card-info"><b>${show.logged_episodes || show.episodes_seen_reported || 0} episodes logged</b><span>${show.archived === '1' ? 'Archived' : show.followed === '1' ? 'Following' : 'Not following'}</span></div></button>`; }

async function dashboard() {
  const data = await get('/api/dashboard'); const stats = data.stats;
  app.innerHTML = `<section class="welcome"><div><p class="eyebrow">Your private watch log</p><h1>Tonight’s queue.</h1><p>Track what you watch. Keep ahead of what comes next.</p></div><button class="secondary" data-sync>↻ Sync episode guides</button></section>
  ${syncNoticeMarkup()}<section class="stats"><div><strong>${stats.shows}</strong><span>shows in library</span></div><div><strong>${stats.following}</strong><span>currently following</span></div><div><strong>${stats.episodes.toLocaleString()}</strong><span>episode watches</span></div><div><strong>${stats.moviesWatched}</strong><span>movies watched</span></div></section>
  <section><div class="section-head"><div><p class="eyebrow">Pick up where you left off</p><h2>Continue watching</h2></div><button class="link" data-page="shows">See library →</button></div><div class="continue-grid">${data.continueWatching.map(show => `<button class="continue-card" data-episodes="${escape(show.show_key)}">${image(show.poster_url, show.title, 'continue-art')}<div><b>${escape(show.title)}${year(show.first_aired) ? ` — ${year(show.first_aired)}` : ''}</b><span>${escape(show.latest_episode)} · last logged ${date(show.last_watched)}</span></div><i>→</i></button>`).join('') || '<p class="empty">Log an episode to start a continue-watching list.</p>'}</div></section>
  <section class="split"><div><div class="section-head"><div><p class="eyebrow">Release radar</p><h2>Upcoming</h2></div><button class="link" data-page="upcoming">Calendar →</button></div><div id="dashboardUpcoming" class="mini-list"></div></div><div><div class="section-head"><div><p class="eyebrow">Just watched</p><h2>Recent activity</h2></div><button class="link" data-page="history">History →</button></div><div class="mini-list">${data.recent.slice(0, 5).map(item => `<div class="mini-row"><span class="dot">${item.kind === 'Movie' ? '◆' : '▶'}</span><div>${item.show_key ? `<button class="activity-link" data-episodes="${escape(item.show_key)}">${escape(item.title)}${year(item.first_aired) ? ` — ${year(item.first_aired)}` : ''}</button>` : `<b>${escape(item.title)}</b>`}<small>${item.kind}${episode(item) ? ' · ' + episode(item) : ''}</small></div><time>${date(item.occurred_at)}</time></div>`).join('')}</div></div></section>`;
  const upcoming = await get('/api/upcoming'); document.querySelector('#dashboardUpcoming').innerHTML = upcoming.slice(0, 5).map(item => `<button class="mini-row upcoming-row" data-episodes="${escape(item.show_key)}"><span class="date-chip">${new Date(`${item.aired_at}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><div><b>${escape(item.show_title)}</b><small>S${item.season_number} · E${item.episode_number} · ${escape(item.title || 'TBA')}</small></div></button>`).join('') || '<p class="empty">Nothing upcoming yet.</p>';
}

async function shows() {
  const [data, removed] = await Promise.all([get('/api/shows'), get('/api/shows/removed')]);
  app.innerHTML = `<div class="page-top"><div><p class="eyebrow">Your collection</p><h1>Shows</h1><p class="sub">Arranged around your actual viewing progress.</p></div><div class="page-actions"><input class="search" id="showSearch" placeholder="Search your library" /><button class="secondary" data-sync>↻ Sync</button></div></div>${syncNoticeMarkup()}<section id="showList"></section>`;
  const draw = list => {
    const groups = [
      ['Currently watching', 'Shows with an aired episode still to watch.', show => show.archived !== '1' && show.followed === '1' && Number(show.catalog_watched_episodes || 0) > 0 && Number(show.catalog_watched_episodes || 0) < Number(show.available_episodes || Infinity)],
      ['Up to date', 'You’re caught up on every aired episode.', show => show.archived !== '1' && show.followed === '1' && Number(show.available_episodes) > 0 && Number(show.catalog_watched_episodes) >= Number(show.available_episodes) && show.status !== 'Ended'],
      ['Plan to watch', 'Followed, but not started yet.', show => show.archived !== '1' && show.followed === '1' && Number(show.catalog_watched_episodes || show.logged_episodes || 0) === 0],
      ['Paused', 'No longer followed, but kept in your library.', show => show.archived !== '1' && show.followed !== '1'],
      ['Finished', 'Completed series you’ve fully watched.', show => show.archived !== '1' && show.followed === '1' && show.status === 'Ended' && Number(show.available_episodes) > 0 && Number(show.catalog_watched_episodes) >= Number(show.available_episodes)],
    ];
    const assigned = new Set(); const sections = groups.map(([title, description, matches]) => { const shows = list.filter(show => !assigned.has(show.show_key) && matches(show)); shows.forEach(show => assigned.add(show.show_key)); return shows.length ? `<section class="library-section"><div class="section-head"><div><p class="eyebrow">${shows.length} show${shows.length === 1 ? '' : 's'}</p><h2>${title}</h2><p class="section-copy">${description}</p></div></div><div class="gallery">${shows.map(showCard).join('')}</div></section>` : ''; });
    const archived = list.filter(show => show.archived === '1'); archived.forEach(show => assigned.add(show.show_key));
    const remaining = list.filter(show => !assigned.has(show.show_key)); if (remaining.length) sections.splice(3, 0, `<section class="library-section"><div class="section-head"><div><p class="eyebrow">${remaining.length} show${remaining.length === 1 ? '' : 's'}</p><h2>Needs attention</h2><p class="section-copy">Sync these shows to categorize their episode progress.</p></div></div><div class="gallery">${remaining.map(showCard).join('')}</div></section>`);
    sections.push(`<details class="archived-library"><summary>Archived shows <span>${archived.length}</span></summary>${archived.length ? `<p class="section-copy">Kept out of your active library, with their history intact.</p><div class="gallery">${archived.map(showCard).join('')}</div>` : '<p class="section-copy">No shows are archived.</p>'}</details>`);
    if (removed.length) sections.push(`<details class="removed-library"><summary>Removed shows <span>${removed.length}</span></summary><p class="section-copy">Removed from your library. Watch history is kept. Restore an entry to bring it back.</p>${removed.map(item => `<div class="removed-show"><div><b>${escape(item.title)}</b><small>${escape(showIdentity(item))} · ${item.watch_count} watch event${item.watch_count === 1 ? '' : 's'} kept</small></div><button class="secondary" data-restore-show="${escape(item.show_key)}">Restore</button></div>`).join('')}<p id="restoreStatus" role="status"></p></details>`);
    document.querySelector('#showList').innerHTML = sections.filter(Boolean).join('') || '<p class="empty">No shows match that search.</p>';
  };
  draw(data); document.querySelector('#showSearch').oninput = event => draw(data.filter(show => show.title.toLowerCase().includes(event.target.value.toLowerCase())));
}

async function showEpisodes(key, navigate = true) {
  const route = `#show/${encodeURIComponent(key)}`;
  if (navigate && location.hash !== route) { location.hash = route; return; }
  activeShowKey = key;
  const data = await get(`/api/shows/${encodeURIComponent(key)}/episodes`); const { show, metadata, episodes } = data; activeShow = data;
  if (!episodes.length) { app.innerHTML = `<button class="link" data-page="shows">← Shows</button><h1>${escape(show.title)}</h1><div class="empty-state"><p>No episode guide has been synced for this show.</p><button class="secondary" data-sync>Sync episode guides</button></div>${showManagement(show)}`; return; }
  const seasons = {}; episodes.filter(item => !item.is_special).forEach(item => (seasons[item.season_number] ||= []).push(item));
  const ordered = Object.entries(seasons).map(([number, list]) => ({ number, list, complete: list.every(item => Number(item.watch_count) > 0), started: list.some(item => Number(item.watch_count) > 0) }));
  const active = [...ordered].reverse().find(season => season.started && !season.complete) || ordered.find(season => !season.complete) || ordered.at(-1);
  const renderSeason = season => `<section class="season ${season.number === active.number ? 'active-season' : ''}"><div class="season-heading"><div><p class="eyebrow">${season.number === active.number ? 'Current focus' : ''}</p><h2>Season ${season.number}</h2></div><span>${season.list.filter(item => Number(item.watch_count) > 0).length}/${season.list.length} watched</span></div><div class="episode-list">${season.list.map(item => { const watched = Number(item.watch_count) > 0; const future = item.aired_at && new Date(`${item.aired_at}T23:59:59`) > new Date(); return `<div class="episode-row ${watched ? 'watched' : ''}"><span class="episode-number">${watched ? '✓' : item.episode_number}</span><div class="episode-title"><b>${escape(item.title || 'TBA')}</b><small>Episode ${item.episode_number}${item.runtime ? ` · ${item.runtime} min` : ''}</small></div><time>${date(item.aired_at)}</time><div class="episode-actions">${future ? '<span class="not-aired">Not aired</span>' : `<button class="${watched ? 'rewatch-btn' : 'watch-btn'}" data-log-episode="${item.tvdb_episode_id}" data-rewatch="${watched}">${watched ? `↻ Rewatch${item.watch_count > 1 ? ` · ${item.watch_count}` : ''}` : '✓ Watch'}</button>`}</div></div>`; }).join('')}</div></section>`;
  const renderCollapsedSeason = season => `<details class="completed-seasons"><summary><span>Season ${season.number}</span><em>${season.list.length}/${season.list.length} watched</em></summary>${renderSeason(season)}</details>`;
  app.innerHTML = `<section class="show-hero">${metadata?.backdrop_url ? `<img src="${escape(metadata.backdrop_url)}" alt="" class="backdrop" />` : ''}<div class="hero-overlay"></div><button class="back-link" data-page="shows">← All shows</button><div class="hero-content">${image(metadata?.poster_url, show.title, 'hero-poster')}<div><p class="eyebrow">${escape(metadata?.status || 'Show')}</p><h1>${escape(show.title)}</h1><p class="hero-copy">${escape(metadata?.overview || 'Your episode guide and personal watch progress.')}</p><div class="hero-meta">${metadata?.first_aired ? `<span>First aired ${date(metadata.first_aired)}</span>` : ''}${metadata?.next_aired ? `<span>Next: ${date(metadata.next_aired)}</span>` : ''}</div><button class="hero-action" data-toggle="${escape(show.show_key)}" data-field="archived" data-value="${show.archived !== '1'}">${show.archived === '1' ? '↗ Unarchive show' : '⌑ Archive show'}</button></div></div></section><section class="episodes-wrap"><div class="section-head"><div><p class="eyebrow">Episode guide</p><h2>${episodes.filter(item => !item.is_special).length} aired episodes</h2></div><span class="sync-note">Synced ${metadata?.last_synced_at ? date(metadata.last_synced_at) : 'recently'}</span></div>${ordered.map(season => season.complete ? renderCollapsedSeason(season) : renderSeason(season)).join('')}</section>${showManagement(show)}`;
}

async function upcoming() {
  const list = await get('/api/upcoming');
  app.innerHTML = `<div class="page-top"><div><p class="eyebrow">Release radar</p><h1>Upcoming episodes</h1><p class="sub">Your next three months of releases.</p></div><button class="secondary" data-sync>↻ Sync</button></div>${syncNoticeMarkup()}<section class="calendar-shell"><div id="releaseCalendar"></div></section>${list.length ? '<p class="calendar-hint">Select an episode to open its show page.</p>' : '<div class="empty-state">No future episodes are currently scheduled.</div>'}`;
  if (!list.length) return;
  if (!window.FullCalendar) { document.querySelector('#releaseCalendar').innerHTML = '<p class="empty">The calendar library could not be loaded. Check your internet connection and refresh.</p>'; return; }
  const calendar = new FullCalendar.Calendar(document.querySelector('#releaseCalendar'), {
    initialView: 'threeMonthGrid', initialDate: new Date(), firstDay: 1, height: 'auto',
    headerToolbar: false, fixedWeekCount: false, showNonCurrentDates: true, dayMaxEvents: false, expandRows: true,
    multiMonthMaxColumns: 1, multiMonthMinWidth: 0,
    views: { threeMonthGrid: { type: 'multiMonth', duration: { months: 3 } } },
    events: list.map(item => ({ title: `${item.show_title} · S${item.season_number}E${item.episode_number}${item.title ? ` — ${item.title}` : ''}`, start: item.aired_at, allDay: true, classNames: [`episode-tone-${colorTone(item.tvdb_show_id)}`], extendedProps: { showKey: item.show_key } })),
    eventClick: event => { event.jsEvent.preventDefault(); showEpisodes(event.event.extendedProps.showKey); },
  });
  calendar.render();
}

async function movies() {
  const list = await get('/api/movies');
  app.innerHTML = `<div class="page-top"><div><p class="eyebrow">Film log</p><h1>Movies</h1><p class="sub">Watched films and the ones you mean to get to.</p></div><div class="page-actions"><button class="secondary" data-page="movie-links">Review movie links</button><button class="primary" data-add-movie="true">＋ Add movie</button></div></div>${syncNoticeMarkup()}<section class="movie-grid">${list.map(item => `<article class="movie-card">${item.movie_key ? image(item.poster_url, item.title, 'movie-poster') : ''}<h2>${escape(item.title)}</h2>${item.movie_key ? `<p>${escape([item.year, item.country].filter(Boolean).join(' · ') || 'Year / country unavailable')} · ${item.runtime == null ? 'Runtime unknown' : `${item.runtime} min`}</p><p class="movie-overview">${escape(item.overview || 'No summary available.')}</p><small>TheTVDB ${escape(item.tvdb_movie_id)}</small>` : `<small>Existing title-only entry${item.source_years?.length ? ` · Source years: ${escape(item.source_years.join(', '))}` : ''}</small>`}<p>${item.last_activity ? `Last activity ${date(item.last_activity)}` : 'Added manually'}</p><div>${item.watched ? '<span class="tag good">Watched</span>' : ''}${item.watchlist ? '<span class="tag">Watchlist</span>' : ''}</div>${movieLinkActions(item.legacy_titles || [])}</article>`).join('')}</section>`;
}
const movieLinkActions = entries => entries.map(entry => `<div class="movie-link-actions"><small>Original title: ${escape(entry.legacy_title)}</small><button class="secondary" data-link-legacy="${escape(entry.legacy_title)}">${entry.provider_id ? 'Change movie link' : 'Link movie data'}</button>${entry.provider_id ? `<button class="link" data-unlink-legacy="${escape(entry.legacy_title)}" data-unlink-provider="${escape(entry.provider_id)}">Undo link</button>` : ''}</div>`).join('');
let linkPreparation = false, linkPreparationVersion = 0;
const skippedMovieLinks = new Set();
async function movieLinks() {
  const entries = await get('/api/movies/legacy');
  const unresolved = entries.filter(entry => !entry.linked_provider_id);
  app.innerHTML = `<button class="link" data-page="movies">← Movies</button><h1>Review movie links</h1><p>Prepare suggestions, then confirm each match. History stays intact; suggestions never link movies automatically.</p>${syncNoticeMarkup()}<div class="page-actions"><button class="secondary" id="prepareMovieLinks" data-prepare-links="true" ${linkPreparation ? 'disabled' : ''}>Prepare suggestions for ${unresolved.length} unlinked movies</button><button class="secondary" data-stop-links="true" ${linkPreparation ? '' : 'hidden'}>Stop preparation</button></div><p id="linkPrepareStatus" role="status">${unresolved.length} unlinked · ${entries.length - unresolved.length} linked</p><section class="movie-link-queue">${entries.map(entry => `<article class="movie-link-review"><h2>${escape(entry.title)}</h2><p>${entry.event_count} existing events · ${entry.watched ? 'Watched' : 'Not marked watched'}${entry.watchlist ? ' · Watchlist' : ''}</p><p>${entry.source_years.length ? `Source release years: ${escape(entry.source_years.join(', '))}` : 'Release year unavailable'}${entry.source_years.length > 1 ? ' · Multiple years: review carefully' : ''}</p><p>${entry.linked_provider_id ? `Linked to ${escape(entry.provider_title)} (${escape(entry.year || 'year unknown')}) · TheTVDB ${escape(entry.linked_provider_id)}` : skippedMovieLinks.has(entry.title) ? 'Skipped for now; you can revisit this entry.' : entry.suggestions_error ? `Preparation failed: ${escape(entry.suggestions_error)}` : entry.suggestions_at ? `${entry.suggestions_count} suggestions ready` : 'Suggestions not prepared yet'}</p>${movieLinkActions([{legacy_title:entry.title, provider_id:entry.linked_provider_id}])}</article>`).join('') || '<p class="empty">No older movie entries need linking.</p>'}</section>`;
}
async function prepareMovieLinks() {
  if (linkPreparation) return;
  linkPreparation = true;
  const version = ++linkPreparationVersion;
  try {
    const entries = (await get('/api/movies/legacy')).filter(entry => !entry.linked_provider_id);
    await movieLinks();
    let prepared = 0, failures = 0;
    for (const entry of entries) {
      if (version !== linkPreparationVersion || location.hash !== '#movie-links') break;
      document.querySelector('#linkPrepareStatus').textContent = `Preparing ${prepared + failures + 1}/${entries.length}: ${entry.title}…`;
      try { await get(`/api/movies/link-suggestions?title=${encodeURIComponent(entry.title)}`); prepared++; }
      catch { failures++; }
    }
    if (version === linkPreparationVersion && location.hash === '#movie-links') syncNotice = `Prepared ${prepared} movie suggestions. ${failures ? `${failures} failed; open those entries to retry.` : 'Review each match before linking.'}`;
  } catch (error) { syncNotice = `Suggestion preparation failed: ${error.message}`; }
  finally {
    if (version === linkPreparationVersion) { linkPreparation = false; if (location.hash === '#movie-links') await movieLinks(); }
  }
}
async function stopMovieLinkPreparation() {
  linkPreparationVersion++; linkPreparation = false;
  syncNotice = 'Preparation stopped. Completed suggestions were kept.';
  await movieLinks();
}
async function reviewMovieLink(title) {
  try {
    const entries = await get('/api/movies/legacy');
    const entry = entries.find(item => item.title === title);
    if (!entry) throw new Error('Original movie entry not found');
    disposeSearch();
    disposeSearch = mountMediaSearch(dialog, { kind:'movie', linkEntry:entry, get, send, escape,
      onAdded: async () => { skippedMovieLinks.delete(title); syncNotice = `${title} linked. Watch history and status preserved.`; if (location.hash === '#movie-links') await movieLinks(); else await movies(); },
      onSkipped: async () => { if (location.hash === '#movie-links') { skippedMovieLinks.add(title); await movieLinks(); } }
    });
    if (!dialog.open) dialog.showModal();
  } catch (error) { alert(error.message); }
}
async function undoMovieLink(title, providerId, button) {
  if (!confirm(`Undo the metadata link for “${title}”? Its watch history and status will stay intact.`)) return;
  button.disabled = true;
  try {
    await send('/api/movies/unlink','POST',{legacy_title:title,expected_provider_id:providerId});
    syncNotice = `${title}: movie link undone. Original history kept.`;
    if (location.hash === '#movie-links') await movieLinks(); else await movies();
  } catch (error) { alert(error.message); button.disabled = false; }
}

async function history() { const list = await get('/api/history'); app.innerHTML = `<p class="eyebrow">Chronological log</p><h1>Watch history</h1><p class="sub">The latest 250 recorded activities.</p><div class="history-list">${list.map(item => `<div class="history-row"><div class="dot">${item.type === 'movie' ? '◆' : '▶'}</div><div><b>${escape(item.title)}</b><small>${escape(item.event_kind)}${episode(item) ? ' · ' + episode(item) : ''}</small></div><time>${date(item.occurred_at)}</time></div>`).join('')}</div>`; }

let activeShow = null;
const showIdentity = show => show.tvtime_show_id ? `TheTVDB ${show.tvtime_show_id}` : `Manual entry · Entry ${show.show_key.split(':').at(-1).slice(-8)}`;
const showManagement = show => `<details class="show-management"><summary>Manage show</summary><p>Remove this show from your library while keeping its history.</p><button class="remove-show-button" data-remove-show="${escape(show.show_key)}">Remove from library…</button></details>`;
function showRemoval(key) {
  if (!activeShow || activeShow.show.show_key !== key) return;
  const { show, metadata, watch_count } = activeShow;
  disposeSearch();
  dialog.innerHTML = `<form class="modal" id="removeShowForm"><h2>Remove from library?</h2><p><strong>${escape(show.title)}</strong></p><p class="removal-identity">${escape(showIdentity(show))}${metadata?.first_aired ? ` · ${escape(year(metadata.first_aired))}` : ''}</p><p>This entry will disappear from your library, queue, and upcoming releases. Its ${watch_count} watch event${watch_count === 1 ? '' : 's'} and episode guide will be kept. You can restore it from <b>Removed shows</b>.</p><label for="removeTitle">Type the exact title to confirm: <strong>${escape(show.title)}</strong></label><input id="removeTitle" autocomplete="off" spellcheck="false" /><p id="removeStatus" role="status"></p><div class="form-actions"><button type="button" class="secondary" id="cancelRemoval">Keep show</button><button class="remove-show-button" id="confirmRemoval" disabled>Remove from library</button></div></form>`;
  if (!dialog.open) dialog.showModal();
  const title = dialog.querySelector('#removeTitle');
  const confirm = dialog.querySelector('#confirmRemoval');
  const cancel = dialog.querySelector('#cancelRemoval');
  const status = dialog.querySelector('#removeStatus');
  let pending = false;
  const preventPendingCancel = event => { if (pending) event.preventDefault(); };
  dialog.addEventListener('cancel', preventPendingCancel);
  dialog.addEventListener('close', () => dialog.removeEventListener('cancel', preventPendingCancel), { once: true });
  title.oninput = () => { confirm.disabled = title.value !== show.title; };
  cancel.onclick = () => dialog.close();
  dialog.querySelector('#removeShowForm').onsubmit = async event => {
    event.preventDefault();
    if (pending || title.value !== show.title) return;
    pending = true; confirm.disabled = true; title.disabled = true; cancel.disabled = true;
    status.textContent = 'Removing from library…';
    try {
      await send(`/api/shows/${encodeURIComponent(key)}/remove`, 'POST', { confirm_title: title.value });
      dialog.close(); activeShow = null;
      syncNotice = `${show.title} removed from your library. Watch history kept. Restore it under Removed shows.`;
      setPage('shows');
    } catch (error) {
      status.textContent = `Removal failed: ${error.message}. You can retry.`;
    } finally {
      pending = false; confirm.disabled = title.value !== show.title; title.disabled = false; cancel.disabled = false;
    }
  };
  title.focus();
}
async function restoreShow(key, button) {
  button.disabled = true;
  try { await send(`/api/shows/${encodeURIComponent(key)}/restore`, 'POST', {}); syncNotice = 'Show restored with its history intact.'; await shows(); }
  catch (error) { document.querySelector('#restoreStatus').textContent = `Restore failed: ${error.message}`; button.disabled = false; }
}

let disposeSearch = () => {};
function showAdd(kind = 'show') {
  disposeSearch();
  disposeSearch = mountMediaSearch(dialog, { kind, get, send, escape, onKind: showAdd, onAdded: result => {
    syncNotice = kind === 'show' ? 'Show added and episode guide synced.' : `${result.title} ${result.existing ? 'confirmed in' : 'added to'} your movies.`;
    if (kind === 'show') showEpisodes(result.show_key); else { if (location.hash === '#movies') movies(); else setPage('movies'); }
  } });
  if (!dialog.open) dialog.showModal();
  else dialog.querySelector('#providerQuery').focus();
}
function showEpisode(key) { dialog.innerHTML = `<form method="dialog" class="modal" id="episodeForm"><h2>Log an episode</h2><label>Season<input name="season" type="number" min="0" value="1" required /></label><label>Episode<input name="episode" type="number" min="1" value="1" required /></label><label class="check"><input name="rewatch" type="checkbox" /> This is a rewatch</label><div class="form-actions"><button type="button" class="secondary" data-close>Cancel</button><button class="primary">Log episode</button></div></form>`; dialog.showModal(); dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.querySelector('#episodeForm').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); try { await send('/api/episodes/watch', 'POST', { show_key: key, season: form.get('season'), episode: form.get('episode'), rewatch: form.get('rewatch') === 'on' }); dialog.close(); showEpisodes(key); } catch (error) { alert(error.message); } }; }
async function logCatalogEpisode(id, rewatch, button) { button.disabled = true; button.textContent = rewatch ? 'Rewatching…' : 'Marking…'; try { await send(`/api/episodes/${encodeURIComponent(id)}/watch`, 'POST', { rewatch }); if (activeShowKey) await showEpisodes(activeShowKey); else await render(); } catch (error) { alert(error.message); button.disabled = false; button.textContent = rewatch ? '↻ Rewatch' : '✓ Watch'; } }
async function sync() { const button = document.querySelector('[data-sync]'); if (button) { button.disabled = true; button.textContent = 'Syncing…'; } syncNotice = 'Syncing every show in your library. This can take a moment…'; if (button) button.insertAdjacentHTML('afterend', syncNoticeMarkup()); try { const result = await send('/api/sync/shows', 'POST', {}); const failures = result.failures?.length ? ` ${result.failures.length} show${result.failures.length === 1 ? '' : 's'} could not be refreshed.` : ''; syncNotice = `Sync complete: ${result.synced} shows and ${result.episodes.toLocaleString()} episodes refreshed.${failures}`; render(); } catch (error) { syncNotice = `Sync failed: ${error.message}`; render(); } }
async function render() { const fragment = location.hash.slice(1) || 'dashboard'; if (fragment !== 'movie-links' && linkPreparation) { linkPreparationVersion++; linkPreparation = false; } if (fragment === 'movie-links') { current = 'movies'; activeShowKey = null; renderNav(); try { await movieLinks(); } catch (error) { app.innerHTML = `<div class="empty-state"><p>${escape(error.message)}</p><button class="secondary" data-page="movies">Back to movies</button></div>`; } return; } if (fragment.startsWith('show/')) { current = 'shows'; renderNav(); return showEpisodes(decodeURIComponent(fragment.slice('show/'.length)), false).catch(error => { activeShow = null; app.innerHTML = `<div class="empty-state"><h1>Show unavailable</h1><p>${escape(error.message)}</p><p>If you removed it, restore it from Removed shows in your library.</p><button class="secondary" data-page="shows">Back to library</button></div>`; }); } current = routes.includes(fragment) ? fragment : 'dashboard'; activeShowKey = null; renderNav(); try { await ({ dashboard, shows, upcoming, movies, history }[current])(); } catch (error) { app.innerHTML = `<div class="empty-state"><h1>Couldn’t load your tracker</h1><p>${escape(error.message)}</p></div>`; } }
document.querySelector('#addButton').onclick = () => showAdd(); document.addEventListener('click', async event => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.linkLegacy) return reviewMovieLink(button.dataset.linkLegacy); if (button.dataset.unlinkLegacy) return undoMovieLink(button.dataset.unlinkLegacy, button.dataset.unlinkProvider, button); if (button.dataset.prepareLinks) return prepareMovieLinks(); if (button.dataset.stopLinks) return stopMovieLinkPreparation(); if (button.dataset.removeShow) return showRemoval(button.dataset.removeShow); if (button.dataset.restoreShow) return restoreShow(button.dataset.restoreShow, button); if (button.dataset.addMovie) return showAdd('movie'); if (button.hasAttribute('data-sync')) return sync(); if (button.dataset.page) return setPage(button.dataset.page); if (button.dataset.episodes) return showEpisodes(button.dataset.episodes); if (button.dataset.logEpisode) return logCatalogEpisode(button.dataset.logEpisode, button.dataset.rewatch === 'true', button); if (button.dataset.toggle) { try { await send(`/api/shows/${encodeURIComponent(button.dataset.toggle)}`, 'PATCH', { field: button.dataset.field, value: button.dataset.value === 'true' }); return showEpisodes(button.dataset.toggle); } catch (error) { alert(error.message); } } if (button.dataset.watch) return showEpisode(button.dataset.watch); }); window.addEventListener('hashchange', render); render();
