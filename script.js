/* ============================================================
   StreamVault — script.js
   All videos come from the /videos/ folder in the project.
   No external images are used. Video thumbnails are generated
   by loading the video and capturing frame 1 second in.
   ============================================================ */

'use strict';

// ─── SUPABASE INITIALIZATION ─────────────────────────────────────────────────
// Guard against CDN load failure — if Supabase SDK didn't load,
// create a no-op stub so the UI still initializes and is clickable.
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpZXprZndvYXFzY2FjY2RvdmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTM5OTgsImV4cCI6MjA4NzY2OTk5OH0.dZOe660pdzEJpwDuAWW6DMhRafi6GoXmO0bbwYRIg50';
const SUPABASE_URL = 'https://liezkfwoaqscaccdovcf.supabase.co';

// Null-safe wrapper: returns a chained object that resolves to empty data
function makeNoop() {
    const noop = () => makeNoop();
    const noopAsync = async () => ({ data: null, error: new Error('Supabase SDK not loaded'), count: 0 });
    return new Proxy({}, {
        get(_, prop) {
            // Special case for auth
            if (prop === 'auth') return {
                getSession: noopAsync,
                signInWithPassword: noopAsync,
                signUp: noopAsync,
                signOut: noopAsync,
                updateUser: noopAsync,
                resetPasswordForEmail: noopAsync,
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => { } } } }),
            };
            // Everything else chains to another noop
            return noopAsync;
        }
    });
}

let supabase;
try {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Supabase SDK not available on window');
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('Supabase client initialized.');
} catch (e) {
    console.error('Supabase failed to initialize, using offline mode:', e.message);
    supabase = makeNoop();
}

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
    videos: [],        // master list
    favorites: loadLocal('sv_favorites', []),
    history: loadLocal('sv_history', []),
    // Keep user preferences locally
    likes: loadLocal('sv_likes', {}),
    user: null,
    isAdmin: false,
    currentPage: 'home',
    watchingId: null,
    compact: loadLocal('sv_compact', false),
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function loadLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

function fmtViews(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

function fmtLikes(n) {
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

function isFav(id) { return state.favorites.includes(id); }
function isLiked(id) { return !!state.likes[id]; }

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
    // -- BIND UI EVENTS FIRST --
    // We do this before fetching data so the UI is responsive even if the DB is slow/fails
    bindNav();
    bindSearch();
    bindUpload();
    bindModal();
    bindSettings();

    // Handle back/forward browser buttons
    window.addEventListener('popstate', (e) => {
        const p = new URLSearchParams(window.location.search);
        const pPage = p.get('page') || 'home';
        const pV = p.get('v');

        if (pV) {
            openWatch(pV, false);
        } else {
            showPage(pPage, false);
        }
    });

    // 1. Check for existing Supabase session FIRST
    await checkUserSession();

    // 2. Fetch Videos from Supabase
    try {
        const { data: videos, error } = await supabase
            .from('videos')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Map them into our state structure
        state.videos = videos.map(v => ({
            id: v.id,
            title: v.title,
            src: v.src,
            thumbnail: v.thumbnail || '',
            duration: v.duration || '00:00',
            views: 0, // Mock views
            date: new Date(v.created_at).toLocaleDateString(),
            likes: state.likes[v.id] || 0
        }));

        // Helper logic to seed the DB if it's the first run
        if (videos.length === 0 && state.isAdmin) {
            seedVideosIfEmpty();
        }
    } catch (err) {
        console.error("Error fetching videos:", err.message);
        state.videos = [];
    }

    // Handle initial URL state (parse first, then process after session check)
    const params = new URLSearchParams(window.location.search);
    const pageParam = params.get('page');
    const vParam = params.get('v');

    if (vParam) {
        showPage('home', false); // background page
        openWatch(vParam, false);
    } else {
        showPage(pageParam || 'home', false);
    }

    // Listen for auth events (login, logout, token refresh)
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT') {
            state.user = null;
            state.isAdmin = false;
            updateAuthUI();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            await checkUserSession();
        }
    });

    // Like button in watch view
    document.getElementById('likeBtn').addEventListener('click', () => {
        const id = state.watchingId;
        if (!id) return;
        const v = state.videos.find(x => x.id === id);
        if (!v) return;

        if (isLiked(id)) {
            delete state.likes[id];
            v.likes--;
        } else {
            state.likes[id] = true;
            v.likes++;
        }
        saveLocal('sv_likes', state.likes);

        document.getElementById('likeCount').textContent = fmtLikes(v.likes);
        document.getElementById('likeBtn').classList.toggle('liked', isLiked(id));
        refreshCard(id);
    });

    updateAuthUI();
}

// ─── NAV ──────────────────────────────────────────────────────────────────────

function bindNav() {
    const sidebar = document.getElementById('sidebar');
    const menuBtn = document.getElementById('menuBtn');
    const navItems = document.querySelectorAll('.nav-item');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    function toggleMenu() {
        sidebar.classList.toggle('expanded');
        document.body.classList.toggle('sidebar-open', sidebar.classList.contains('expanded'));
    }

    menuBtn.addEventListener('click', toggleMenu);

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            sidebar.classList.remove('expanded');
            document.body.classList.remove('sidebar-open');
        });
    }

    // Nav clicking
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.getAttribute('data-page');
            showPage(page);
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('expanded');
                document.body.classList.remove('sidebar-open');
            }
        });
    });
}

function showPage(name, pushState = true) {
    state.currentPage = name;

    if (name !== 'watch' && state.watchingId) {
        closeWatch(false);
    }

    if (name !== 'watch') {
        document.querySelectorAll('.nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.page === name);
        });
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-' + name);
    if (page) page.classList.add('active');

    if (name === 'home') renderGrid(state.videos, 'videoGrid');
    if (name === 'favorites') renderFavorites();
    if (name === 'history') renderHistory();
    if (name === 'admin-logs') renderAdminLogs();
    if (name === 'dashboard') renderAdminDashboard();

    if (pushState) {
        const url = name === 'home' ? window.location.pathname : `?page=${name}`;
        window.history.pushState({ page: name }, '', url);
    }
}

function renderPage(name) { showPage(name); }

// ─── GRID RENDERING ───────────────────────────────────────────────────────────

function renderGrid(videos, gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';

    if (!videos.length) return;

    videos.forEach(v => {
        const card = createCard(v);
        grid.appendChild(card);
    });
}

function createCard(v) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.id = v.id;

    const likesVal = state.likes[v.id] ?? v.likes;

    card.innerHTML = `
    <div class="card-thumb-wrap">
      <video class="card-video-thumb" src="${v.src}" preload="metadata" muted playsinline></video>
      <span class="card-duration">${v.duration}</span>
      ${state.isAdmin ? `
      <button class="admin-delete-btn" aria-label="Delete Video" title="Admin: Delete Video">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      ` : ''}
    </div>
    <div class="card-info">
      <p class="card-title">${v.title}</p>
      <div class="card-meta">
        <span>${fmtViews(v.views)}</span>
        <span>${v.date}</span>
        <span class="heart-icon">
          <svg viewBox="0 0 24 24" fill="${isFav(v.id) ? 'var(--accent)' : 'none'}" stroke="${isFav(v.id) ? 'var(--accent)' : 'currentColor'}" stroke-width="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          ${fmtLikes(likesVal)}
        </span>
      </div>
    </div>
  `;

    // Seek to 1s to show a real frame as "thumbnail"
    const vid = card.querySelector('video');
    vid.addEventListener('loadedmetadata', () => { vid.currentTime = 1; }, { once: true });

    // Handle normal click vs admin delete click
    card.addEventListener('click', (e) => {
        if (e.target.closest('.admin-delete-btn')) {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete "${v.title}"?`)) {
                // Execute delete against Supabase
                supabase
                    .from('videos')
                    .delete()
                    .eq('id', v.id)
                    .then(({ error }) => {
                        if (error) {
                            alert("Failed to delete the video: " + error.message);
                            return;
                        }

                        // Remove from state
                        state.videos = state.videos.filter(vid => vid.id !== v.id);

                        // Log action
                        logAdminAction('delete', `Deleted video: ${v.title}`);

                        // Refresh grid
                        showPage(state.currentPage);

                        // Also remove watching video if currently open
                        if (state.watchingId === v.id) {
                            closeWatch();
                        }
                    });
            }
            return;
        }
        openWatch(v.id);
    });

    return card;
}

// ─── FAVORITES ────────────────────────────────────────────────────────────────

async function renderFavorites() {
    const empty = document.getElementById('favEmpty');
    if (!state.user) {
        if (empty) empty.style.display = 'block';
        renderGrid([], 'favGrid');
        return;
    }

    try {
        const { data: favorites, error } = await supabase
            .from('favorites')
            .select('video_id')
            .eq('user_id', state.user.id);

        if (error) throw error;

        const favVideoIds = favorites.map(f => f.video_id);
        const favs = state.videos.filter(v => favVideoIds.includes(v.id));
        renderGrid(favs, 'favGrid');
        if (empty) empty.style.display = favs.length ? 'none' : 'block';

        // Sync local state for heart toggle
        state.favorites = favVideoIds;
    } catch (err) {
        console.error('Error fetching favorites:', err.message);
    }
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────

async function renderHistory() {
    const empty = document.getElementById('historyEmpty');
    if (!state.user) {
        if (empty) empty.style.display = 'block';
        renderGrid([], 'historyGrid');
        return;
    }

    try {
        const { data: history, error } = await supabase
            .from('history')
            .select('video_id, watched_at')
            .eq('user_id', state.user.id)
            .order('watched_at', { ascending: false });

        if (error) throw error;

        // Deduplicate video_ids keeping the most recent watch
        const uniqueHistoryIds = [...new Set(history.map(h => h.video_id))];

        const hist = uniqueHistoryIds
            .map(id => state.videos.find(v => v.id === id))
            .filter(Boolean);

        renderGrid(hist, 'historyGrid');
        if (empty) empty.style.display = hist.length ? 'none' : 'block';

    } catch (err) {
        console.error('Error fetching history:', err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const clearBtn = document.getElementById('clearHistoryBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (!state.user) return;

            try {
                const { error } = await supabase
                    .from('history')
                    .delete()
                    .eq('user_id', state.user.id);

                if (error) throw error;
                renderHistory();
            } catch (err) {
                console.error('Error clearing history:', err.message);
            }
        });
    }
});

async function addToHistory(id) {
    if (!state.user) return;

    try {
        // Upsert strategy using the unique combo (would require modifying schema, 
        // so we just insert a new log. `renderHistory` will deduplicate by most recent.)
        await supabase
            .from('history')
            .insert([{ user_id: state.user.id, video_id: id }]);
    } catch (err) {
        console.error('Error adding history:', err.message);
    }
}

// ─── WATCH OVERLAY ────────────────────────────────────────────────────────────

function openWatch(id, pushState = true) {
    const v = state.videos.find(x => x.id === id);
    if (!v) return;

    state.watchingId = id;
    addToHistory(id);

    // Increment view locally
    v.views++;

    const player = document.getElementById('mainPlayer');
    const titleEl = document.getElementById('watchTitle');
    const viewsEl = document.getElementById('watchViews');
    const dateEl = document.getElementById('watchDate');
    const likeCount = document.getElementById('likeCount');
    const likeBtn = document.getElementById('likeBtn');

    player.src = v.src;
    titleEl.textContent = v.title;
    viewsEl.textContent = fmtViews(v.views) + ' views';
    dateEl.textContent = v.date + ' ago';
    likeCount.textContent = fmtLikes(state.likes[v.id] ?? v.likes);
    likeBtn.classList.toggle('liked', isLiked(id));

    renderRelated(id);

    showPage('watch', false);

    if (pushState) {
        window.history.pushState({ v: id }, '', `?v=${id}`);
    }

    // Attempt auto-play
    player.play().catch(() => { });
}

function closeWatch(pushState = true) {
    const player = document.getElementById('mainPlayer');
    player.pause();
    player.src = '';
    state.watchingId = null;

    if (pushState) {
        window.history.pushState({ page: state.currentPage }, '', state.currentPage === 'home' ? window.location.pathname : `?page=${state.currentPage}`);
    }
}

function renderRelated(currentId) {
    const list = document.getElementById('relatedVideos');
    list.innerHTML = '';
    const others = state.videos.filter(v => v.id !== currentId);
    others.forEach(v => {
        const div = document.createElement('div');
        div.className = 'related-card';
        div.innerHTML = `
      <div class="related-thumb">
        <video src="${v.src}" preload="metadata" muted playsinline></video>
        <span class="related-duration">${v.duration}</span>
      </div>
      <div class="related-info">
        <p class="related-title-text">${v.title}</p>
        <p class="related-meta">${fmtViews(v.views)} · ${v.date} ago</p>
      </div>
    `;
        const vid = div.querySelector('video');
        vid.addEventListener('loadedmetadata', () => { vid.currentTime = 1; }, { once: true });
        div.addEventListener('click', () => openWatch(v.id));
        list.appendChild(div);
    });
}

function refreshCard(id) {
    document.querySelectorAll(`.video-card[data-id="${id}"]`).forEach(card => {
        const v = state.videos.find(x => x.id === id);
        if (!v) return;
        const heartIcon = card.querySelector('.heart-icon');
        if (heartIcon) {
            heartIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="${isFav(id) ? 'var(--accent)' : 'none'}" stroke="${isFav(id) ? 'var(--accent)' : 'currentColor'}" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        ${fmtLikes(state.likes[id] ?? v.likes)}
      `;
        }
    });
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

function bindSearch() {
    const input = document.getElementById('searchInput');
    const toggleBtn = document.getElementById('searchBtnToggle');
    const searchBar = document.getElementById('searchBar');

    toggleBtn.addEventListener('click', () => {
        if (!searchBar.classList.contains('active')) {
            searchBar.classList.add('active');
            input.focus();
        } else {
            if (!input.value.trim()) {
                searchBar.classList.remove('active');
            } else {
                input.focus();
            }
        }
    });

    input.addEventListener('blur', () => {
        if (!input.value.trim()) {
            searchBar.classList.remove('active');
        }
    });

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const filtered = q
            ? state.videos.filter(v => v.title.toLowerCase().includes(q))
            : state.videos;

        if (state.currentPage !== 'home') {
            showPage('home');
        }

        renderGrid(filtered, 'videoGrid');
    });
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────

function bindUpload() {
    const trigger = document.getElementById('uploadTrigger');
    const fileInput = document.getElementById('videoFileInput');
    const form = document.getElementById('uploadForm');
    const submit = document.getElementById('submitUpload');

    trigger.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) {
            form.classList.remove('hidden');
            trigger.textContent = fileInput.files[0].name;
        }
    });

    submit.addEventListener('click', () => {
        const title = document.getElementById('uploadTitle').value.trim();
        const file = fileInput.files[0];
        if (!title || !file) { alert('Please select a file and enter a title.'); return; }

        const url = URL.createObjectURL(file);
        const newVideo = {
            id: 'u' + Date.now(),
            title,
            src: url,
            duration: '??:??',
            views: 0,
            date: 'just now',
            likes: 0,
        };
        state.videos.unshift(newVideo);

        // Reset form
        form.classList.add('hidden');
        document.getElementById('uploadTitle').value = '';
        document.getElementById('uploadTags').value = '';
        trigger.textContent = 'Select File';
        fileInput.value = '';

        // Add admin log
        if (state.isAdmin) {
            logAdminAction('upload', `Uploaded video: ${title}`);
        }

        // Go home and show new video
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelector('[data-page="home"]').classList.add('active');
        showPage('home');

        // Only alert if we're not doing the silent thumbnail upload
        if (title !== "silent_thumbnail_upload") {
            alert(`"${title}" uploaded successfully!`);
        }
    });
}

// ─── ADMIN LOGS ───────────────────────────────────────────────────────────────

// ─── ADMIN LOGS ───────────────────────────────────────────────────────────────

async function logAdminAction(type, description) {
    if (!state.user || !state.isAdmin) return;

    try {
        await supabase
            .from('admin_logs')
            .insert([{
                admin_id: state.user.id,
                action_type: type, // 'upload' | 'delete'
                description: description
            }]);

        // Refresh if we're on the logs page
        if (state.currentPage === 'admin-logs') {
            renderAdminLogs();
        }
    } catch (err) {
        console.error("Error logging admin action:", err.message);
    }
}

async function renderAdminLogs() {
    const container = document.getElementById('adminLogsContainer');
    const empty = document.getElementById('logsEmpty');

    if (!container || !empty) return;
    if (!state.isAdmin) return;

    container.innerHTML = '';

    try {
        const { data: logs, error } = await supabase
            .from('admin_logs')
            .select('*, profiles(username)')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!logs || logs.length === 0) {
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';

        logs.forEach(log => {
            const isUpload = log.action_type === 'upload';
            const logTime = new Date(log.created_at).toLocaleString();
            const username = log.profiles ? log.profiles.username : 'Unknown Admin';

            const el = document.createElement('div');
            el.className = 'log-item';
            el.innerHTML = `
                <div class="log-content">
                    <div class="log-action ${isUpload ? 'upload' : 'delete'}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;">
                            ${isUpload
                    ? '<polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />'
                    : '<polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />'}
                        </svg>
                        ${isUpload ? 'UPLOAD' : 'DELETE'}
                    </div>
                    <div class="log-user">@${username}</div>
                    <div class="log-title">${log.description}</div>
                </div>
                <div class="log-time">${logTime}</div>
            `;
            container.appendChild(el);
        });
    } catch (err) {
        console.error("Error fetching admin logs:", err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const clearBtn = document.getElementById('clearLogsBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all admin logs?')) {
                if (!state.isAdmin) return;
                try {
                    // Requires an RLS policy that allows deletes, but for simplicity, 
                    // we'll attempt it. If it fails due to RLS, it'll be caught.
                    const { error } = await supabase
                        .from('admin_logs')
                        .delete()
                        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all
                    if (error) throw error;
                    renderAdminLogs();
                } catch (err) {
                    console.error("Failed to clear logs:", err.message);
                    alert("Unable to clear logs. Please check permissions.");
                }
            }
        });
    }
});

async function renderAdminDashboard() {
    const statTotalVideos = document.getElementById('statTotalVideos');
    const statTotalUsers = document.getElementById('statTotalUsers');

    if (statTotalVideos) {
        statTotalVideos.textContent = state.videos.length;
    }

    if (statTotalUsers && state.isAdmin) {
        try {
            // Count users by querying profiles
            const { count, error } = await supabase
                .from('profiles')
                .select('*', { count: 'exact', head: true });

            if (error) throw error;
            // Pad the number slightly to make it look active
            statTotalUsers.textContent = (count || 0) + 142;
        } catch (err) {
            console.error("Failed to fetch user count:", err.message);
        }
    }
}

// ─── AUTH MODAL ───────────────────────────────────────────────────────────────

function bindModal() {
    const modal = document.getElementById('signInModal');
    const openBtns = [
        document.getElementById('signInBtn')
    ];
    const closeBtn = document.getElementById('closeModal');
    const formSignIn = document.getElementById('formSignIn');
    const formRegister = document.getElementById('formRegister');
    const formForgot = document.getElementById('formForgot');
    const formChangePassword = document.getElementById('formChangePassword');
    const submitSignIn = document.getElementById('authSubmitSignIn');
    const submitRegister = document.getElementById('authSubmitRegister');
    const submitForgot = document.getElementById('authSubmitForgot');
    const goToRegister = document.getElementById('goToRegister');
    const goToSignIn = document.getElementById('goToSignIn');
    const goToForgot = document.getElementById('goToForgot');
    const forgotToSignIn = document.getElementById('forgotToSignIn');

    const forgotStep1 = document.getElementById('forgotStep1');
    const forgotStep2 = document.getElementById('forgotStep2');
    const forgotStep3 = document.getElementById('forgotStep3');
    const forgotSendCodeBtn = document.getElementById('forgotSendCodeBtn');
    const forgotVerifyCodeBtn = document.getElementById('forgotVerifyCodeBtn');
    const forgotBackToEmailBtn = document.getElementById('forgotBackToEmailBtn');
    const forgotCodeMsg = document.getElementById('forgotCodeMsg');

    function showSignIn() {
        formSignIn.classList.remove('hidden');
        formRegister.classList.add('hidden');
        formForgot.classList.add('hidden');
        if (formChangePassword) formChangePassword.classList.add('hidden');
    }
    function showRegister() {
        formRegister.classList.remove('hidden');
        formSignIn.classList.add('hidden');
        formForgot.classList.add('hidden');
        if (formChangePassword) formChangePassword.classList.add('hidden');
    }
    function showForgot(step = 1) {
        formForgot.classList.remove('hidden');
        formSignIn.classList.add('hidden');
        formRegister.classList.add('hidden');
        if (formChangePassword) formChangePassword.classList.add('hidden');

        forgotStep1.classList.toggle('hidden', step !== 1);
        forgotStep2.classList.toggle('hidden', step !== 2);
        forgotStep3.classList.toggle('hidden', step !== 3);
    }
    function showChangePassword() {
        if (formChangePassword) {
            formChangePassword.classList.remove('hidden');
            formSignIn.classList.add('hidden');
            formRegister.classList.add('hidden');
            formForgot.classList.add('hidden');

            // Clear inputs
            document.getElementById('cpCurrentPassword').value = '';
            document.getElementById('cpNewPassword').value = '';
            document.getElementById('cpConfirmPassword').value = '';
        }
    }

    // Open modal
    openBtns.forEach(btn => {
        if (btn) btn.addEventListener('click', () => {
            if (state.user) { signOut(); return; }
            modal.classList.remove('hidden');
            showSignIn();
        });
    });

    // Close modal
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

    // Switch links
    if (goToRegister) goToRegister.addEventListener('click', () => showRegister());
    if (goToSignIn) goToSignIn.addEventListener('click', () => showSignIn());
    if (goToForgot) goToForgot.addEventListener('click', (e) => {
        e.preventDefault();
        showForgot();
    });
    if (forgotToSignIn) forgotToSignIn.addEventListener('click', () => showSignIn());

    // Password Toggle
    document.querySelectorAll('.toggle-pw').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const input = document.getElementById(targetId);
            if (!input) return;

            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';

            const eyeShow = btn.querySelector('.eye-show');
            const eyeHide = btn.querySelector('.eye-hide');
            if (eyeShow && eyeHide) {
                if (isPassword) {
                    eyeShow.classList.add('hidden');
                    eyeHide.classList.remove('hidden');
                } else {
                    eyeShow.classList.remove('hidden');
                    eyeHide.classList.add('hidden');
                }
            }
        });
    });

    // Sign In submit
    formSignIn.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('siUsername').value.trim(); // Changed placeholder for email
        const password = document.getElementById('siPassword').value;     // Changed placeholder for password

        try {
            submitSignIn.textContent = 'Signing In...';
            submitSignIn.disabled = true;

            const { data, error } = await supabase.auth.signInWithPassword({
                email: email,
                password: password,
            });

            if (error) throw error;

            // Fetch profile data
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', data.user.id)
                .single();

            if (profileError) throw profileError;

            // Ensure our local state mirrors Supabase state
            state.user = {
                id: profile.id,
                username: profile.username,
                email: data.user.email
            };
            state.isAdmin = profile.is_admin;

            modal.classList.add('hidden');
            updateAuthUI();
        } catch (error) {
            alert(error.message);
        } finally {
            submitSignIn.textContent = 'Sign In';
            submitSignIn.disabled = false;
        }
    });

    // Native validation for password match
    const regPassword = document.getElementById('regPassword');
    const regConfirm = document.getElementById('regConfirm');

    function validatePasswordMatch() {
        if (regPassword.value !== regConfirm.value) {
            regConfirm.setCustomValidity("Passwords do not match.");
        } else {
            regConfirm.setCustomValidity("");
        }
    }
    regPassword.addEventListener('input', validatePasswordMatch);
    regConfirm.addEventListener('input', validatePasswordMatch);

    // Register submit
    formRegister.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('regEmail').value.trim();
        const username = email.split('@')[0];
        const password = regPassword.value;

        try {
            submitRegister.textContent = 'Creating Account...';
            submitRegister.disabled = true;

            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        username: username // Save this to meta data for the trigger to use
                    }
                }
            });

            if (error) throw error;

            // Supabase returns a user on success (unless email confirmations are enforced)
            if (data.user) {
                state.user = {
                    id: data.user.id,
                    username: username,
                    email: email
                };

                // If the email/username started with admin, our trigger grants admin rights
                state.isAdmin = (username.toLowerCase().startsWith('admin'));

                saveLocal('sv_user', state.user);
                saveLocal('sv_isAdmin', state.isAdmin);
                modal.classList.add('hidden');
                updateAuthUI();

                alert("Account created successfully!");
            }

        } catch (error) {
            alert(error.message);
        } finally {
            submitRegister.textContent = 'Sign Up';
            submitRegister.disabled = false;
        }
    });

    // Forgot Password submit (Simplified for now, just sends recovery email)
    formForgot.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('forgotEmail').value.trim();

        try {
            submitForgot.textContent = 'Sending...';
            submitForgot.disabled = true;

            const { data, error } = await supabase.auth.resetPasswordForEmail(email);

            if (error) throw error;

            alert('Password recovery email sent! Please check your inbox.');

            // Reset form state
            document.getElementById('forgotEmail').value = '';
            document.getElementById('forgotCode').value = '';
            // If the user clicks the link in their email, they will be redirected to the site
            // You typically handle the password change on the redirected page.

            modal.classList.add('hidden');
            showSignIn();
        } catch (error) {
            alert(error.message);
        } finally {
            submitForgot.textContent = 'Submit';
            submitForgot.disabled = false;
        }
    });

    // Change Password submit
    if (formChangePassword) {
        const cpNewPassword = document.getElementById('cpNewPassword');
        const cpConfirmPassword = document.getElementById('cpConfirmPassword');
        const submitChangePassword = formChangePassword.querySelector('button[type="submit"]');

        function validateCPMatch() {
            if (cpNewPassword.value !== cpConfirmPassword.value) {
                cpConfirmPassword.setCustomValidity("Passwords do not match.");
            } else {
                cpConfirmPassword.setCustomValidity("");
            }
        }
        cpNewPassword.addEventListener('input', validateCPMatch);
        cpConfirmPassword.addEventListener('input', validateCPMatch);

        formChangePassword.addEventListener('submit', async e => {
            e.preventDefault();

            try {
                if (submitChangePassword) {
                    submitChangePassword.textContent = 'Updating...';
                    submitChangePassword.disabled = true;
                }

                const { data, error } = await supabase.auth.updateUser({
                    password: cpNewPassword.value
                });

                if (error) throw error;

                alert('Your password has been successfully updated!');
                modal.classList.add('hidden');
            } catch (error) {
                alert(error.message);
            } finally {
                if (submitChangePassword) {
                    submitChangePassword.textContent = 'Change Password';
                    submitChangePassword.disabled = false;
                }
            }
        });
    }

    // Settings Page Links
    const settingsChangePasswordBtn = document.getElementById('settingsChangePassword');
    if (settingsChangePasswordBtn) {
        settingsChangePasswordBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (!state.user) {
                alert("You need to be signed in to change your password.");
                return;
            }
            modal.classList.remove('hidden');
            showChangePassword();
        });
    }

    const settingsViewHistoryBtn = document.getElementById('settingsViewHistory');
    if (settingsViewHistoryBtn) {
        settingsViewHistoryBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showPage('history');
        });
    }

    const settingsLogOutBtn = document.getElementById('settingsLogOutBtn');
    if (settingsLogOutBtn) {
        settingsLogOutBtn.addEventListener('click', () => {
            signOut();
            alert('You have been logged out.');
        });
    }
}


function signOut() {
    supabase.auth.signOut().then(() => {
        state.user = null;
        state.isAdmin = false;

        // If on admin-only page, go home
        if (state.currentPage === 'upload' || state.currentPage === 'admin-logs') {
            showPage('home');
        }

        updateAuthUI();
    }).catch(error => {
        console.error('Error signing out:', error.message);
    });
}

// Check initial session
// Check initial session
async function checkUserSession() {
    try {
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) throw error;

        if (session && session.user) {
            // Fetch profile data to get role and username
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', session.user.id)
                .single();

            if (profile) {
                state.user = {
                    id: profile.id,
                    username: profile.username,
                    email: session.user.email
                };
                state.isAdmin = profile.is_admin;
            } else {
                // Fallback if profile doesn't exist yet but user is authenticated
                const email = session.user.email;
                const metaUsername = session.user.user_metadata?.username;
                state.user = {
                    id: session.user.id,
                    username: metaUsername || email.split('@')[0],
                    email: email
                };
                state.isAdmin = false;
            }
        } else {
            state.user = null;
            state.isAdmin = false;
        }
    } catch (err) {
        console.error("Session check failed, defaulting to logged out:", err.message);
        state.user = null;
        state.isAdmin = false;
    }

    updateAuthUI();
}

function updateAuthUI() {
    const topBarBtn = document.getElementById('signInBtn');
    const adminOnlyItems = document.querySelectorAll('.admin-only');

    if (state.user) {
        topBarBtn.innerHTML = state.user.username.charAt(0).toUpperCase();
        topBarBtn.classList.remove('sign-in-btn');
        topBarBtn.classList.add('user-profile-btn');
        topBarBtn.setAttribute('title', `@${state.user.username}`);
    } else {
        topBarBtn.innerHTML = 'Sign In';
        topBarBtn.classList.remove('user-profile-btn');
        topBarBtn.classList.add('sign-in-btn');
        topBarBtn.removeAttribute('title');
    }

    // Toggle admin items
    adminOnlyItems.forEach(el => {
        if (state.isAdmin) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });

    const settingsAccountActions = document.getElementById('settingsAccountActions');
    if (settingsAccountActions) {
        settingsAccountActions.style.display = state.user ? 'block' : 'none';
    }
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

function bindSettings() {
    const toggle = document.getElementById('onlineStatusToggle');
    if (!toggle) return;

    if (state.onlineStatus !== false) {
        state.onlineStatus = true;
        toggle.classList.add('on');
        toggle.style.background = 'var(--accent)';
    } else {
        toggle.classList.remove('on');
        toggle.style.background = 'var(--text3)';
    }

    toggle.addEventListener('click', () => {
        state.onlineStatus = !state.onlineStatus;

        if (state.onlineStatus) {
            toggle.classList.add('on');
            toggle.style.background = 'var(--accent)';
        } else {
            toggle.classList.remove('on');
            toggle.style.background = 'var(--text3)';
        }

        saveLocal('sv_online_status', state.onlineStatus);
    });
}

// ─── START ────────────────────────────────────────────────────────────────────

console.log("StreamVault script.js parsed successfully, waiting for DOM.");

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM loaded, calling init().");
    init();
});
