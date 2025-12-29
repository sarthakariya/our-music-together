// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// --- GLOBAL VARIABLES ---
let player;
let currentQueue = [];
let currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 
let lastQueueSignature = ""; 
let isPlayerReady = false;
let pendingPlayRequest = false; 
let userIntentionallyPaused = false; 
let wasInAd = false; 
let currentLyrics = null;
let lastLyricsIndex = -1;
let lyricsInterval = null;
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 
let smartIntervals = [];

// --- FIREBASE INIT ---
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = (typeof firebase !== 'undefined') ? firebase.database() : null;
const syncRef = db ? db.ref('sync') : null;
const queueRef = db ? db.ref('queue') : null;
const chatRef = db ? db.ref('chat') : null; 
const presenceRef = db ? db.ref('presence') : null;

// --- DOM & UI INITIALIZATION ---
let UI = {}; // Will be populated when DOM is ready

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize UI Elements
    UI = {
        player: document.getElementById('player'),
        playPauseBtn: document.getElementById('play-pause-btn'),
        syncStatusMsg: document.getElementById('sync-status-msg'),
        equalizer: document.getElementById('equalizer'),
        queueList: document.getElementById('queue-list'),
        queueBadge: document.getElementById('queue-badge'),
        mobileQueueBadge: document.getElementById('mobile-queue-badge'),
        chatMessages: document.getElementById('chat-messages'),
        chatBadge: document.getElementById('chat-badge'),
        mobileChatBadge: document.getElementById('mobile-chat-badge'),
        toastContainer: document.getElementById('toast-container'),
        songTitle: document.getElementById('current-song-title'),
        lyricsContent: document.getElementById('lyrics-content-area'),
        lyricsOverlay: document.getElementById('lyricsOverlay'),
        infoOverlay: document.getElementById('infoOverlay'), 
        syncOverlay: document.getElementById('syncOverlay'),
        welcomeOverlay: document.getElementById('welcomeOverlay'),
        mobileSheet: document.getElementById('mobileSheet'),
        mobileSheetTitle: document.getElementById('mobile-sheet-title'),
        searchInput: document.getElementById('searchInput'),
        resultsList: document.getElementById('results-list'),
        startSessionBtn: document.getElementById('startSessionBtn')
    };

    // 2. Attach Listeners
    if (UI.startSessionBtn) {
        UI.startSessionBtn.addEventListener('click', () => {
            hasUserInteracted = true;
            if (UI.welcomeOverlay) UI.welcomeOverlay.style.display = 'none';

            if (isPlayerReady && player && typeof player.playVideo === 'function') {
                if(currentVideoId) {
                    player.playVideo();
                } else if (currentQueue.length > 0) {
                    initiateSongLoad(currentQueue[0]);
                } else {
                    showToast("System", "Welcome! Add a song.");
                }
            } else {
                pendingPlayRequest = true;
                showToast("System", "Player initializing...");
            }
        });
    }

    if(UI.searchInput) UI.searchInput.addEventListener('keydown', e => { if(e.key==='Enter') handleSearch(); });
    if(document.getElementById('search-btn')) document.getElementById('search-btn').addEventListener('click', handleSearch);
    if(document.getElementById('prev-btn')) document.getElementById('prev-btn').addEventListener('click', initiatePrevSong);
    if(document.getElementById('next-btn')) document.getElementById('next-btn').addEventListener('click', initiateNextSong);
    if(UI.playPauseBtn) UI.playPauseBtn.addEventListener('click', togglePlayPause);
    
    // Lyrics & Mobile Nav
    if(document.getElementById('lyrics-btn')) document.getElementById('lyrics-btn').addEventListener('click', () => { if(UI.lyricsOverlay) UI.lyricsOverlay.classList.add('active'); fetchLyrics(); });
    if(document.getElementById('closeLyricsBtn')) document.getElementById('closeLyricsBtn').addEventListener('click', () => { if(UI.lyricsOverlay) UI.lyricsOverlay.classList.remove('active'); stopLyricsSync(); });
    if(document.getElementById('mobileSheetClose')) document.getElementById('mobileSheetClose').addEventListener('click', () => { if(UI.mobileSheet) UI.mobileSheet.classList.remove('active'); });
    
    // Mobile Tab Buttons
    ['queue', 'results', 'chat'].forEach(tab => {
        const btn = document.getElementById('tab-btn-' + tab);
        if(btn) btn.addEventListener('click', () => switchTab(tab));
    });
});

// --- USER SETUP ---
let myName = localStorage.getItem('deepSpaceUserName');
if (!myName || myName === "null") {
    myName = prompt("Enter your name:") || "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

if (presenceRef) {
    const sessionKey = presenceRef.push().key;
    presenceRef.child(sessionKey).onDisconnect().remove();
    presenceRef.child(sessionKey).set({ user: myName, online: true, timestamp: firebase.database.ServerValue.TIMESTAMP });
}

// --- SMART TIMERS ---
function setSmartInterval(callback, normalMs, hiddenMs) {
    let intervalId = null;
    const run = () => callback();
    intervalId = setInterval(run, normalMs);
    const handler = {
        id: intervalId,
        restart: function(newMs) {
            clearInterval(this.id);
            this.id = setInterval(run, newMs);
        }
    };
    smartIntervals.push(handler);
    return handler;
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if(UI.equalizer) UI.equalizer.classList.add('paused'); 
        stopLyricsSync(); 
    } else {
        if(UI.equalizer) UI.equalizer.classList.remove('paused');
        if(currentLyrics) startLyricsSync();
        updateSyncStatus();
    }
});

// --- YOUTUBE API ---
window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, 'disablekb': 0, 'rel': 0, 
            'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin,
            'playsinline': 1, 'iv_load_policy': 3 
        },
        events: { 
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError 
        }
    });
};

function onPlayerReady(event) {
    isPlayerReady = true;
    if (player && player.setVolume) player.setVolume(100);
    
    // Handle Pending Start
    if (pendingPlayRequest) {
        pendingPlayRequest = false;
        if (currentVideoId) {
            player.playVideo();
        } else if (currentQueue.length > 0) {
            initiateSongLoad(currentQueue[0]);
        }
    }

    // Start Sync Loops
    setSmartInterval(monitorSyncHealth, 1000, 1000); // Check sync every 1s
    setSmartInterval(heartbeatSync, 1000, 2000); // Broadcast state
    setSmartInterval(monitorAdStatus, 1000, 3000); // Ad check

    if (syncRef) {
        syncRef.once('value').then(snapshot => {
            const state = snapshot.val();
            if(state) applyRemoteCommand(state);
        });
    }
    setupMediaSession();
}

function onPlayerError(event) {
    console.error("Player Error:", event.data);
    isSwitchingSong = false; 
    setTimeout(initiateNextSong, 1000);
}

// --- SYNC & LOGIC ---
function heartbeatSync() {
    if (isSwitchingSong || detectAd()) return;
    if (player && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            const curr = player.getCurrentTime();
            // Auto Next if ended
            if (player.getDuration() > 0 && player.getDuration() - curr < 1) initiateNextSong();
            else broadcastState('play', curr, currentVideoId);
        } else if (state === YT.PlayerState.PAUSED && userIntentionallyPaused) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
        if(!document.hidden) updatePlayPauseButton(state);
    }
}

function monitorSyncHealth() {
    if (!hasUserInteracted || lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState) return;
    if (Date.now() - lastLocalInteractionTime < 2000) return;

    if (currentRemoteState.action === 'switching_pause') return;
    if (currentRemoteState.action === 'ad_pause') {
         if(player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo();
         return;
    }

    const myState = player.getPlayerState();
    
    if (currentRemoteState.action === 'play') {
        // Force Play if stopped
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (!detectAd()) {
                userIntentionallyPaused = false;
                player.playVideo();
            }
        }
        // Smooth Sync
        if (myState === YT.PlayerState.PLAYING) {
            const now = Date.now();
            const latency = (now - currentRemoteState.timestamp) / 1000;
            const targetTime = currentRemoteState.time + latency;
            const drift = player.getCurrentTime() - targetTime;

            if (Math.abs(drift) > 2.0) {
                // Large drift: Seek
                player.seekTo(targetTime, true);
            } else if (Math.abs(drift) > 0.15) {
                // Small drift: Adjust Speed
                const newRate = drift < 0 ? 1.05 : 0.95;
                if(player.getPlaybackRate() !== newRate) player.setPlaybackRate(newRate);
            } else {
                // In sync: Normal Speed
                if(player.getPlaybackRate() !== 1) player.setPlaybackRate(1);
            }
        }
    } else if (currentRemoteState.action === 'pause') {
        if (myState === YT.PlayerState.PLAYING) {
            userIntentionallyPaused = true;
            player.pauseVideo();
            if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 0.5) {
                player.seekTo(currentRemoteState.time, true);
            }
        }
    }
}

function detectAd() {
    if (!player || typeof player.getPlayerState !== 'function') return false;
    try {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) return false;
        const data = player.getVideoData();
        if (currentVideoId && data.video_id && data.video_id !== currentVideoId) return true;
        if (data.title === "Advertisement" || data.author === "") return true;
    } catch(e) {}
    return false;
}

function monitorAdStatus() {
    if (document.hidden && userIntentionallyPaused) return; 
    const isAd = detectAd();
    if (isAd) {
        if (!wasInAd) {
            wasInAd = true;
            // Mute and Speed Up Ad
            if(player.mute) player.mute();
            if(player.setPlaybackRate) player.setPlaybackRate(2);
            updateSyncStatus();
        }
    } else {
        if (wasInAd) {
            wasInAd = false;
            // Restore
            if(player.unMute) player.unMute();
            if(player.setPlaybackRate) player.setPlaybackRate(1);
            if(player.playVideo) player.playVideo();
        }
    }
}

function broadcastState(action, time, videoId) {
    if (ignoreSystemEvents || !syncRef) return;
    syncRef.set({ action, time, videoId, lastUpdater: myName, timestamp: firebase.database.ServerValue.TIMESTAMP });
}

function applyRemoteCommand(state) {
    if (!player) return;
    if (Date.now() - lastLocalInteractionTime < 1000) return;

    if (state.action === 'switching_pause') {
        isSwitchingSong = true;
        showToast("System", "Loading next song...");
        if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        updateSyncStatus();
        return;
    }

    lastBroadcaster = state.lastUpdater;

    if (state.videoId !== currentVideoId) {
        isSwitchingSong = false;
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        loadAndPlayVideo(state.videoId, songInQueue ? songInQueue.title : "Syncing...", "", state.time, false);
    } 

    if (state.action === 'play') {
        const now = Date.now();
        const latency = (now - state.timestamp) / 1000;
        const target = state.time + latency;
        if (Math.abs(player.getCurrentTime() - target) > 1.5) player.seekTo(target, true);
        userIntentionallyPaused = false;
        player.playVideo();
    } else if (state.action === 'pause') {
        userIntentionallyPaused = true;
        player.pauseVideo();
    }
    updateSyncStatus();
}

function onPlayerStateChange(event) {
    if (detectAd()) { updateSyncStatus(); return; }
    const state = event.data;
    if (state === YT.PlayerState.ENDED) initiateNextSong(); 
    if (state === YT.PlayerState.PLAYING) {
        isSwitchingSong = false;
        updateSyncStatus();
    }
    if(!document.hidden) updatePlayPauseButton(state);
}

// --- QUEUE & LOAD ---
function loadInitialData() {
    if(!queueRef) return;
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const data = snapshot.val();
        let list = [];
        if (data) Object.keys(data).forEach(k => list.push({ ...data[k], key: k }));
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = list;
        
        const sig = JSON.stringify(list.map(s => s.key));
        if (sig !== lastQueueSignature) {
            lastQueueSignature = sig;
            renderQueue(currentQueue, currentVideoId);
        }
    });

    if(syncRef) syncRef.on('value', snap => {
        const val = snap.val();
        if(val) {
            currentRemoteState = val;
            if (val.lastUpdater !== myName) applyRemoteCommand(val);
            else lastBroadcaster = myName;
        }
        updateSyncStatus();
    });
}
loadInitialData();

function togglePlayPause() {
    if (!isPlayerReady || !player) return;
    lastLocalInteractionTime = Date.now();
    lastBroadcaster = myName; 

    if (player.getPlayerState() === YT.PlayerState.PLAYING) {
        userIntentionallyPaused = true;
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    } else {
        if (!currentVideoId && currentQueue.length === 0) return;
        if (!currentVideoId && currentQueue.length > 0) initiateSongLoad(currentQueue[0]);
        else {
            userIntentionallyPaused = false;
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
}

function initiateNextSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length]; 
    if (next) initiateSongLoad(next);
}

function initiatePrevSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) initiateSongLoad(currentQueue[idx-1]);
}

function initiateSongLoad(songObj) {
    if (!songObj || !syncRef) return;
    isSwitchingSong = true;
    lastBroadcaster = myName;
    userIntentionallyPaused = false;

    // 1. Tell everyone to Pause & Buffer
    syncRef.set({ 
        action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: firebase.database.ServerValue.TIMESTAMP 
    });

    // 2. Load locally
    loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, false, false); 
    if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    // 3. Wait 3 seconds then Play
    setTimeout(() => {
        isSwitchingSong = false;
        if (player) {
            player.playVideo();
            broadcastState('play', 0, songObj.videoId);
        }
    }, 3000); 
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true, shouldPlay = true) {
    if (!player) return;
    if (shouldBroadcast) suppressBroadcast(2000);

    if(currentVideoId !== videoId || !player.cueVideoById) {
        player.loadVideoById({videoId: videoId, startSeconds: startTime});
    } else {
        if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
    }

    if (!shouldPlay) setTimeout(() => player.pauseVideo(), 200); 
    else player.playVideo();

    currentVideoId = videoId;
    if(UI.songTitle) UI.songTitle.textContent = decodeHTMLEntities(title);
    updateMediaSessionMetadata(title, uploader, null);
    renderQueue(currentQueue, currentVideoId);
}

// --- UTILS & UI ---
function renderQueue(queueArray, curVidId) {
    if (!UI.queueList) return;
    if (UI.queueBadge) UI.queueBadge.textContent = queueArray.length;
    if (UI.mobileQueueBadge) UI.mobileQueueBadge.textContent = queueArray.length;

    if (queueArray.length === 0) {
        UI.queueList.innerHTML = '<div class="empty-state"><p>Queue is empty.</p></div>';
        return;
    }
    
    const fragment = document.createDocumentFragment();
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === curVidId ? 'playing' : ''}`;
        item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        
        const isMe = song.addedBy === myName;
        item.innerHTML = `
            <div class="song-index">${index + 1}</div>
            <img src="${song.thumbnail}" class="song-thumb" loading="lazy"> 
            <div class="song-details">
                <h4>${song.title}</h4>
                <span class="added-by-badge ${isMe ? 'is-me' : 'is-other'}">${isMe ? 'You' : song.addedBy}</span>
            </div>
            ${song.videoId === curVidId ? '<div class="mini-eq-container"><div class="mini-eq-bar"></div><div class="mini-eq-bar"></div><div class="mini-eq-bar"></div></div>' : ''}
        `;
        fragment.appendChild(item);
    });
    
    UI.queueList.innerHTML = '';
    UI.queueList.appendChild(fragment);
}

function updateSyncStatus() {
    if (document.hidden) return; 
    const msgEl = UI.syncStatusMsg;
    if (!msgEl) return;

    let icon = 'fa-heart-pulse', text = 'Vibing', className = 'sync-status-3d status-playing';
    
    if (detectAd()) {
        icon = 'fa-rectangle-ad'; text = 'Ad (Muted)'; className = 'sync-status-3d status-ad';
    } else if (isSwitchingSong) {
        icon = 'fa-spinner fa-spin'; text = 'Buffering...'; className = 'sync-status-3d status-switching';
    } else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
         icon = 'fa-hourglass'; text = 'Waiting for Sync...'; className = 'sync-status-3d status-switching';
    } else if (player && player.getPlayerState() === YT.PlayerState.PAUSED) {
        const pauser = (lastBroadcaster === myName) ? "You" : lastBroadcaster;
        icon = 'fa-pause'; text = `Paused by ${pauser}`; className = 'sync-status-3d status-paused';
    }

    const html = `<i class="fa-solid ${icon}"></i> ${text}`;
    if (msgEl.innerHTML !== html) msgEl.innerHTML = html;
    if (msgEl.className !== className) msgEl.className = className;
}

function updatePlayPauseButton(state) {
    if (!UI.playPauseBtn) return;
    const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
    const icon = isPlaying ? 'fa-pause' : 'fa-play';
    if (!UI.playPauseBtn.innerHTML.includes(icon)) {
        UI.playPauseBtn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    }
    if(navigator.mediaSession) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const target = document.getElementById('view-' + tabName);
    if(target) target.classList.add('active');
    
    if(window.innerWidth <= 1100 && UI.mobileSheet) {
        UI.mobileSheet.classList.add('active');
        if(UI.mobileSheetTitle) UI.mobileSheetTitle.textContent = tabName.charAt(0).toUpperCase() + tabName.slice(1);
    }
}

async function handleSearch() {
    const query = UI.searchInput ? UI.searchInput.value.trim() : "";
    if (!query) return;

    switchTab('results');
    UI.resultsList.innerHTML = '<p style="padding:20px; text-align:center;">Searching...</p>';

    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        
        UI.resultsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        
        if(data.items) {
            data.items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'song-item';
                div.innerHTML = `
                    <img src="${item.snippet.thumbnails.default.url}" class="song-thumb" loading="lazy">
                    <div class="song-details">
                        <h4>${decodeHTMLEntities(item.snippet.title)}</h4>
                        <p>${item.snippet.channelTitle}</p>
                    </div>
                `;
                div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
                fragment.appendChild(div);
            });
        }
        UI.resultsList.appendChild(fragment);
    } catch(e) { console.error(e); }
}

function addToQueue(videoId, title, uploader, thumbnail) {
    if(!queueRef) return;
    const clean = decodeHTMLEntities(title);
    queueRef.push({ videoId, title: clean, uploader, thumbnail, addedBy: myName, order: Date.now() });
    showToast("System", `Added: ${clean}`);
    if(!currentVideoId) initiateSongLoad({videoId, title: clean, uploader});
}

function showToast(user, text) {
    if(!UI.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<div class="toast-body"><b>${user}</b>: ${text.substring(0,30)}</div>`;
    UI.toastContainer.prepend(toast);
    setTimeout(() => toast.remove(), 3000);
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => { userIntentionallyPaused = false; if(player) player.playVideo(); });
        navigator.mediaSession.setActionHandler('pause', () => { userIntentionallyPaused = true; if(player) player.pauseVideo(); });
        navigator.mediaSession.setActionHandler('nexttrack', initiateNextSong);
        navigator.mediaSession.setActionHandler('previoustrack', initiatePrevSong);
    }
}
function updateMediaSessionMetadata(title, artist, artworkUrl) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title || "Music",
            artist: artist || "Our Player",
            artwork: [ { src: artworkUrl || 'https://via.placeholder.com/512', sizes: '512x512', type: 'image/png' } ]
        });
    }
}
function decodeHTMLEntities(text) {
    if(!text) return "";
    const txt = document.createElement("textarea");
    txt.innerHTML = text;
    return txt.value;
}
function startLyricsSync() {
    if(lyricsInterval) clearInterval(lyricsInterval);
    if(UI.lyricsOverlay && UI.lyricsOverlay.classList.contains('active')) {
        lyricsInterval = setInterval(syncLyricsDisplay, 1000); 
    }
}
function stopLyricsSync() { if(lyricsInterval) clearInterval(lyricsInterval); }
function syncLyricsDisplay() {
    if (document.hidden || !currentLyrics || !player) return;
    const time = player.getCurrentTime();
    let activeIndex = -1;
    let startIdx = 0;
    if (lastLyricsIndex !== -1 && currentLyrics[lastLyricsIndex] && currentLyrics[lastLyricsIndex].time < time) startIdx = lastLyricsIndex;
    
    for(let i = startIdx; i < currentLyrics.length; i++) {
        if(currentLyrics[i].time <= time) activeIndex = i;
        else break;
    }
    
    if(activeIndex !== -1 && activeIndex !== lastLyricsIndex) {
        lastLyricsIndex = activeIndex;
        const prevActive = document.querySelector('.lyrics-line.active');
        if (prevActive) prevActive.classList.remove('active');
        const activeLine = document.getElementById('lyric-line-' + activeIndex);
        if(activeLine) {
            activeLine.classList.add('active');
            activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}
async function fetchLyrics(manualQuery = null) {
    const titleEl = UI.songTitle;
    let searchWords = manualQuery ? manualQuery : (titleEl ? titleEl.textContent : "Heart's Rhythm");
    if(UI.lyricsContent) UI.lyricsContent.innerHTML = '<div style="margin-top:20px; width:40px; height:40px; border:4px solid rgba(245,0,87,0.2); border-top:4px solid #f50057; border-radius:50%; animation: spin 1s infinite linear;"></div>';

    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(searchWords)}`);
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            const song = data.find(s => s.syncedLyrics) || data[0];
            if (song.syncedLyrics) {
                currentLyrics = parseSyncedLyrics(song.syncedLyrics);
                renderSyncedLyrics(currentLyrics);
                startLyricsSync();
            } else {
                currentLyrics = null;
                UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${(song.plainLyrics || "Instrumental").replace(/\n/g, "<br>")}</div>`;
            }
        } else {
            throw new Error("No lyrics");
        }
    } catch (e) {
        if(UI.lyricsContent) UI.lyricsContent.innerHTML = '<p style="opacity:0.7;">Lyrics not found.</p>';
    }
}
function parseSyncedLyrics(lrc) {
    const lines = lrc.split('\n');
    const result = [];
    const timeReg = /\[(\d{2}):(\d{2}(?:\.\d+)?)\]/;
    lines.forEach(line => {
        const match = line.match(timeReg);
        if (match) {
            const time = parseFloat(match[1]) * 60 + parseFloat(match[2]);
            const text = line.replace(timeReg, '').trim();
            if(text) result.push({ time, text });
        }
    });
    return result;
}
function renderSyncedLyrics(lyrics) {
    if (!UI.lyricsContent) return;
    UI.lyricsContent.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'synced-lyrics-wrapper';
    lyrics.forEach((line, index) => {
        const p = document.createElement('p');
        p.className = 'lyrics-line';
        p.id = 'lyric-line-' + index;
        p.textContent = line.text;
        wrapper.appendChild(p);
    });
    UI.lyricsContent.appendChild(wrapper);
}
function suppressBroadcast(duration = 1000) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => { ignoreSystemEvents = false; }, duration);
}
function triggerHaptic() { if (navigator.vibrate) navigator.vibrate(60); }
document.addEventListener('click', (e) => { if (e.target.closest('button')) triggerHaptic(); });
