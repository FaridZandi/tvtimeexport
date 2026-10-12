// Each modal owns its search generation; changing the query invalidates every older response.
export function mountMediaSearch(dialog, { kind = 'show', get, send, escape, onKind, onAdded }) {
  const isMovie = kind === 'movie';
  const collection = isMovie ? 'movies' : 'shows';
  const fallback = isMovie ? 'Film' : 'TV';
  const fallbackMarkup = `<span aria-label="No artwork">${fallback}</span>`;
  dialog.innerHTML = `<form class="modal show-search ${isMovie ? 'movie-search' : ''}" id="showSearchForm"><h2>Add a ${kind}</h2><div class="tabs"><button type="button" id="showTab" class="${isMovie ? '' : 'selected'}" aria-pressed="${!isMovie}">Show</button><button type="button" id="movieTab" class="${isMovie ? 'selected' : ''}" aria-pressed="${isMovie}">Movie</button></div><label for="providerQuery">Search TheTVDB</label><input id="providerQuery" autocomplete="off" autofocus placeholder="${isMovie ? 'e.g. Arrival' : 'e.g. The Bear'}" maxlength="200" /><p class="search-status" id="searchStatus" role="status" aria-live="polite">Type a title to find a ${kind}.</p><div id="showMatches" role="group" aria-label="${isMovie ? 'Movie' : 'Show'} matches"></div><p id="showSelection" role="status"></p>${isMovie ? '<label for="movieStatus">Add as</label><select id="movieStatus"><option value="watchlist">Add to watchlist</option><option value="watched">Already watched</option></select>' : ''}<div class="form-actions"><button type="button" class="secondary" id="cancelSearch">Cancel</button><button type="button" class="secondary" id="retrySearch" hidden>Retry search</button><button type="submit" class="primary" id="confirmShow" disabled>Confirm and add</button></div></form>`;
  const query = dialog.querySelector('#providerQuery');
  const status = dialog.querySelector('#searchStatus');
  const matches = dialog.querySelector('#showMatches');
  const selection = dialog.querySelector('#showSelection');
  const confirm = dialog.querySelector('#confirmShow');
  const retry = dialog.querySelector('#retrySearch');
  const cancel = dialog.querySelector('#cancelSearch');
  const movie = dialog.querySelector('#movieTab');
  const show = dialog.querySelector('#showTab');
  const movieStatus = dialog.querySelector('#movieStatus');
  let generation = 0, timer, selected = null, pending = false, disposed = false;
  const preventPendingCancel = event => { if (pending) event.preventDefault(); };
  dialog.addEventListener('cancel', preventPendingCancel);
  const dispose = () => { dialog.removeEventListener('cancel', preventPendingCancel); disposed = true; generation++; clearTimeout(timer); dialog.removeEventListener('close', dispose); };
  dialog.addEventListener('close', dispose);
  cancel.onclick = () => { dispose(); dialog.close(); };
  movie.onclick = () => { if (!isMovie) onKind('movie'); };
  show.onclick = () => { if (isMovie) onKind('show'); };
  const search = async version => {
    try {
      const results = await get(`/api/${collection}/search?q=${encodeURIComponent(query.value.trim())}`);
      if (disposed || version !== generation) return;
      status.textContent = results.length ? (isMovie ? 'Select a match, then confirm to add this movie.' : 'Select a match, then confirm to add and sync it. Counts exclude specials.') : `No ${collection} found. Try another title.`;
      matches.innerHTML = results.map((item, index) => `<button type="button" class="show-match" data-match="${index}" aria-pressed="false"><span class="match-art">${item.poster_url ? `<img src="${escape(item.poster_url)}" alt="" loading="lazy" />` : fallbackMarkup}</span><span class="match-copy"><strong>${escape(item.title)}</strong><span>${escape([item.year, item.country, isMovie ? item.director || item.studio : item.network].filter(Boolean).join(' · ') || 'Year / country unavailable')} · TheTVDB ${escape(item.provider_id)}</span>${isMovie ? `<span>${item.runtime == null ? 'Runtime unknown' : `${item.runtime} min`}</span>` : `<span>${item.season_count == null ? 'Seasons unknown' : `${item.season_count} seasons`} · ${item.episode_count == null ? 'Episodes unknown' : `${item.episode_count} episodes`}</span>`}<span>${escape(item.overview || 'No summary available.')}</span>${item.count_error || item.details_error ? `<span>${escape(item.count_error || item.details_error)}</span>` : ''}</span></button>`).join('');
      matches.querySelectorAll('img').forEach(img => img.onerror = () => { img.parentElement.innerHTML = fallbackMarkup; });
      matches.querySelectorAll('[data-match]').forEach(button => button.onclick = () => {
        if (pending) return;
        selected = results[Number(button.dataset.match)];
        matches.querySelectorAll('[data-match]').forEach(card => card.setAttribute('aria-pressed', String(card === button)));
        selection.textContent = `Selected: ${selected.title}. ${isMovie ? 'Confirm to add this movie with the chosen status.' : 'Confirm to add and sync its episode guide.'}`;
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
    if (!query.value.trim()) { status.textContent = `Type a title to find a ${kind}.`; return; }
    status.textContent = 'Searching TheTVDB…';
    timer = setTimeout(() => search(version), 300);
  };
  query.oninput = changed;
  retry.onclick = changed;
  dialog.querySelector('#showSearchForm').onsubmit = async event => {
    event.preventDefault();
    if (!selected || pending || disposed) return;
    pending = true;
    confirm.disabled = true; query.disabled = true; cancel.disabled = true; movie.disabled = true; show.disabled = true; if (movieStatus) movieStatus.disabled = true;
    confirm.textContent = isMovie ? 'Adding movie…' : 'Adding and syncing…';
    status.textContent = isMovie ? `Loading movie details and adding ${selected.title}…` : `Loading the complete episode guide for ${selected.title}…`;
    try {
      const result = await send(`/api/${collection}`, 'POST', { provider_id: selected.provider_id, ...(isMovie ? { status: movieStatus.value } : {}) });
      if (disposed) return;
      dispose(); dialog.close(); onAdded(result);
    } catch (error) {
      if (disposed) return;
      status.textContent = `Could not ${isMovie ? 'add movie' : 'add and sync'}: ${error.message} Your library was preserved. Retry this match.`;
      confirm.textContent = isMovie ? 'Retry add movie' : 'Retry add and sync';
    } finally {
      pending = false;
      confirm.disabled = false; query.disabled = false; cancel.disabled = false; movie.disabled = false; show.disabled = false; if (movieStatus) movieStatus.disabled = false;
    }
  };
  return dispose;
}
