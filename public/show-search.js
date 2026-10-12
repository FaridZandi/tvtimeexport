// Each modal owns its search generation; changing the query invalidates every older response.
export function mountShowSearch(dialog, { get, send, escape, onMovie, onAdded }) {
  dialog.innerHTML = `<form class="modal show-search" id="showSearchForm"><h2>Add a show</h2><div class="tabs"><button type="button" class="selected" aria-pressed="true">Show</button><button type="button" id="movieTab">Movie</button></div><label for="providerQuery">Search TheTVDB</label><input id="providerQuery" autocomplete="off" autofocus placeholder="e.g. The Bear" maxlength="200" /><p class="search-status" id="searchStatus" role="status" aria-live="polite">Type a title to find a show.</p><div id="showMatches" role="group" aria-label="Show matches"></div><p id="showSelection" role="status"></p><div class="form-actions"><button type="button" class="secondary" id="cancelSearch">Cancel</button><button type="button" class="secondary" id="retrySearch" hidden>Retry search</button><button type="submit" class="primary" id="confirmShow" disabled>Confirm and add</button></div></form>`;
  const query = dialog.querySelector('#providerQuery');
  const status = dialog.querySelector('#searchStatus');
  const matches = dialog.querySelector('#showMatches');
  const selection = dialog.querySelector('#showSelection');
  const confirm = dialog.querySelector('#confirmShow');
  const retry = dialog.querySelector('#retrySearch');
  const cancel = dialog.querySelector('#cancelSearch');
  const movie = dialog.querySelector('#movieTab');
  let generation = 0, timer, selected = null, pending = false, disposed = false;
  const preventPendingCancel = event => { if (pending) event.preventDefault(); };
  dialog.addEventListener('cancel', preventPendingCancel);
  const dispose = () => { dialog.removeEventListener('cancel', preventPendingCancel); disposed = true; generation++; clearTimeout(timer); dialog.removeEventListener('close', dispose); };
  dialog.addEventListener('close', dispose);
  cancel.onclick = () => { dispose(); dialog.close(); };
  movie.onclick = onMovie;
  const search = async version => {
    try {
      const results = await get(`/api/shows/search?q=${encodeURIComponent(query.value.trim())}`);
      if (disposed || version !== generation) return;
      status.textContent = results.length ? 'Select a match, then confirm to add and sync it. Counts exclude specials.' : 'No shows found. Try another title.';
      matches.innerHTML = results.map((item, index) => `<button type="button" class="show-match" data-match="${index}" aria-pressed="false"><span class="match-art">${item.poster_url ? `<img src="${escape(item.poster_url)}" alt="" loading="lazy" />` : '<span aria-label="No artwork">TV</span>'}</span><span class="match-copy"><strong>${escape(item.title)}</strong><span>${escape([item.year, item.country, item.network].filter(Boolean).join(' · ') || 'Year / country unavailable')} · TheTVDB ${escape(item.provider_id)}</span><span>${item.season_count == null ? 'Seasons unknown' : `${item.season_count} seasons`} · ${item.episode_count == null ? 'Episodes unknown' : `${item.episode_count} episodes`}</span><span>${escape(item.overview || 'No summary available.')}</span>${item.count_error ? `<span>${escape(item.count_error)}</span>` : ''}</span></button>`).join('');
      matches.querySelectorAll('img').forEach(img => img.onerror = () => { img.parentElement.innerHTML = '<span aria-label="No artwork">TV</span>'; });
      matches.querySelectorAll('[data-match]').forEach(button => button.onclick = () => {
        if (pending) return;
        selected = results[Number(button.dataset.match)];
        matches.querySelectorAll('[data-match]').forEach(card => card.setAttribute('aria-pressed', String(card === button)));
        selection.textContent = `Selected: ${selected.title}. Confirm to add and sync its episode guide.`;
        confirm.disabled = false;
      });
    } catch (error) {
      if (disposed || version !== generation) return;
      status.textContent = `Search failed: ${error.message}`;
      retry.hidden = false;
    }
  };
  const changed = () => {
    const version = ++generation;
    clearTimeout(timer);
    selected = null; confirm.disabled = true; retry.hidden = true;
    matches.innerHTML = ''; selection.textContent = '';
    if (!query.value.trim()) { status.textContent = 'Type a title to find a show.'; return; }
    status.textContent = 'Searching TheTVDB…';
    timer = setTimeout(() => search(version), 300);
  };
  query.oninput = changed;
  retry.onclick = changed;
  dialog.querySelector('#showSearchForm').onsubmit = async event => {
    event.preventDefault();
    if (!selected || pending || disposed) return;
    pending = true;
    confirm.disabled = true; query.disabled = true; cancel.disabled = true; movie.disabled = true;
    confirm.textContent = 'Adding and syncing…';
    status.textContent = `Loading the complete episode guide for ${selected.title}…`;
    try {
      const result = await send('/api/shows', 'POST', { provider_id: selected.provider_id });
      if (disposed) return;
      dispose(); dialog.close(); onAdded(result.show_key);
    } catch (error) {
      if (disposed) return;
      status.textContent = `Could not add and sync: ${error.message} Your library was preserved. Retry this match.`;
      confirm.textContent = 'Retry add and sync';
    } finally {
      pending = false;
      confirm.disabled = false; query.disabled = false; cancel.disabled = false; movie.disabled = false;
    }
  };
  return dispose;
}
