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

if (typeof firebase !== 'undefined' && !firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const syncRef = db.ref('sync');
const queueRef = db.ref('queue');
const chatRef = db.ref('chat'); 
const presenceRef = db.ref('presence');

// --- DOM CACHE (Performance Optimization) ---
const UI = {
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
    tabBtnQueue: document.getElementById('tab-btn-queue'),
    tabBtnResults: document.getElementById('tab-btn-results'),
    tabBtnChat: document.getElementById('tab-btn-chat'),
    viewQueue: document.getElementById('view-queue'),
    viewResults: document.getElementById('view-results'),
    viewChat: document.getElementById('view-chat'),
    searchInput: document.getElementById('searchInput'),
    resultsList: document.getElementById('results-list'),
    infoBtn: document.getElementById('infoBtn'),
    closeInfoBtn: document.getElementById('closeInfoBtn')
};

// --- STATE VARIABLES ---
let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 
let lastQueueSignature = ""; 

// --- PLAYBACK FLAGS ---
let userIntentionallyPaused = false; 
let wasInAd = false; 
let lastSeekTime = 0; // ANTI-THRASH: Prevents rapid-fire seeking

// --- LYRICS SYNC VARIABLES ---
let currentLyrics = null;
let currentPlainLyrics = "";
let lyricsInterval = null;
let lastLyricsIndex = -1;

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 
let syncHealthInterval = null;

// --- BATTERY SAVER / VISIBILITY LOGIC ---
let smartIntervals = [];

function setSmartInterval(callback, normalMs, hiddenMs) {
    let intervalId = null;
    let currentMs = document.hidden ? hiddenMs : normalMs;
    
    const run = () => {
        if(document.hidden && hiddenMs === Infinity) {
            // Do not run at all if hidden and Ms is Infinity
        } else {
             callback();
        }
    };

    intervalId = setInterval(run, currentMs);

    const handler = {
        id: intervalId,
        normalMs,
        hiddenMs,
        callback,
        restart: function() {
            clearInterval(this.id);
            const ms = document.hidden ? this.hiddenMs : this.normalMs;
            if (ms !== Infinity) {
                 this.id = setInterval(this.callback, ms);
            }
        }
    };
    smartIntervals.push(handler);
    return handler;
}

document.addEventListener('visibilitychange', () => {
    // 1. Re-adjust all smart timers
    smartIntervals.forEach(h => h.restart());
    
    // 2. Pause/Resume Visuals
    if (document.hidden) {
        // Paused visual updates save GPU
        UI.equalizer.classList.add('paused'); 
        stopLyricsSync(); 
    } else {
        // Resume visual updates
        UI.equalizer.classList.remove('paused');
        if (currentVideoId) {
             const song = currentQueue.find(s => s.videoId === currentVideoId);
             if(song) updateMediaSessionMetadata(song.title, song.uploader, song.thumbnail);
        }
        if(currentLyrics) startLyricsSync();
        updateSyncStatus();
    }
});

// --- HAPTIC FEEDBACK HELPER ---
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(60); 
    }
}

document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.tagName === 'BUTTON' || t.closest('button') || 
        t.closest('.song-item') || t.closest('.nav-tab')) {
        triggerHaptic();
    }
});

// --- USER IDENTIFICATION ---
let myName = localStorage.getItem('deepSpaceUserName');
if (!myName || myName === "null") {
    // If we have a welcome overlay, we might not want to prompt immediately,
    // but the original code did. We'll keep it for now.
    // Ideally, the welcome screen handles the name input, but we'll stick to the requested structure.
    myName = prompt("Enter your name (Sarthak or Reechita):");
    if(!myName) myName = "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

const sessionKey = presenceRef.push().key;
presenceRef.child(sessionKey).onDisconnect().remove();
presenceRef.child(sessionKey).set({ user: myName, online: true, timestamp: firebase.database.ServerValue.TIMESTAMP });

// --- UTILS ---
function suppressBroadcast(duration = 1000) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
        ignoreSystemEvents = false;
    }, duration);
}

function showToast(sender, message) {
    if(!UI.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<strong>${sender}</strong>: ${message}`;
    UI.toastContainer.appendChild(toast);
    
    // Trigger reflow
    void toast.offsetWidth;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- NETWORK RECOVERY LISTENERS ---
window.addEventListener('online', () => {
    showToast("System", "Back online! Resyncing...");
    if (currentVideoId && player) {
        syncRef.once('value').then(snapshot => {
            const state = snapshot.val();
            if(state) applyRemoteCommand(state);
        });
    }
});

window.addEventListener('offline', () => {
    showToast("System", "Connection lost. Trying to keep playing...");
});

// --- YOUTUBE PLAYER CONFIG ---
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin,
            'playsinline': 1 
        },
        events: { 
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError 
        }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(100);
    
    // SMART TIMER: Heartbeat sync (0.8s active, 5s hidden)
    setSmartInterval(heartbeatSync, 800, 5000);
    
    // SMART TIMER: Monitor Sync Health (1.5s active, 5s hidden)
    setSmartInterval(monitorSyncHealth, 1500, 5000);
    
    // SMART TIMER: Ad Check (1s active, 3s hidden)
    setSmartInterval(monitorAdStatus, 1000, 3000);

    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
    setupMediaSession();
}

function onPlayerError(event) {
    console.error("YouTube Player Error:", event.data);
    isSwitchingSong = false; 
    
    let errorMsg = "Error playing video.";
    if(event.data === 100 || event.data === 101 || event.data === 150) {
        errorMsg = "Song blocked by owner. Skipping...";
    }
    
    showToast("System", errorMsg);
    updateSyncStatus(); 

    setTimeout(() => {
        initiateNextSong();
    }, 1000);
}

// --- ROBUST AD DETECTION ---
function detectAd() {
    if (!player) return false;
    try {
        const data = player.getVideoData();
        if (!data) return false;
        if (currentVideoId && data.video_id && data.video_id !== currentVideoId) return true;
        if (data.author === "") return true;
        if (data.title && (data.title === "Advertisement" || data.title.toLowerCase().startsWith("ad "))) return true;
    } catch(e) {}
    return false;
}

// --- AD MONITOR LOOP ---
function monitorAdStatus() {
    if (document.hidden && userIntentionallyPaused) return;
    if (!player || !currentVideoId) return;

    const isAd = detectAd();
    
    if (isAd) {
        if (!wasInAd) {
            wasInAd = true;
            lastBroadcaster = myName; 
            broadcastState('ad_pause', 0, currentVideoId, true); 
            updateSyncStatus();
        }
    } else {
        if (wasInAd) {
            wasInAd = false;
            if(player.getPlayerState() !== YT.PlayerState.PLAYING) {
                try { player.playVideo(); } catch(e){}
            }
            setTimeout(() => {
                 lastBroadcaster = myName;
                 try { broadcastState('play', player.getCurrentTime(), currentVideoId, true); } catch(e) {}
            }, 500);
        }
    }
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', function() {
            if(player && player.playVideo) { 
                userIntentionallyPaused = false;
                try { player.playVideo(); } catch(e){} 
                togglePlayPause(); 
            }
        });
        navigator.mediaSession.setActionHandler('pause', function() {
            if(player && player.pauseVideo) { 
                userIntentionallyPaused = true;
                try { player.pauseVideo(); } catch(e){}
                togglePlayPause(); 
            }
        });
        navigator.mediaSession.setActionHandler('previoustrack', function() { initiatePrevSong(); });
        navigator.mediaSession.setActionHandler('nexttrack', function() { initiateNextSong(); });
    }
}

function updateMediaSessionMetadata(title, artist, artworkUrl) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title || "Heart's Rhythm",
            artist: artist || "Sarthak & Reechita",
            album: "Our Sync",
            artwork: [ { src: artworkUrl || 'https://via.placeholder.com/512', sizes: '512x512', type: 'image/png' } ]
        });
    }
}

setInterval(() => {
    if (document.hidden && player && player.getPlayerState) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PAUSED && !userIntentionallyPaused && !detectAd()) {
            try { player.playVideo(); } catch(e){}
        }
    }
}, 4000); 

// --- CORE SYNC LOGIC ---

function heartbeatSync() {
    if (isSwitchingSong) return;

    if (detectAd()) {
        if (lastBroadcaster === myName) updateSyncStatus();
        return;
    }

    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            userIntentionallyPaused = false; 
            
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) initiateNextSong(); 
            else broadcastState('play', current, currentVideoId);
        }
        else if (state === YT.PlayerState.PAUSED) {
            if(userIntentionallyPaused) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId);
            }
        }
        
        if(!document.hidden && Date.now() - lastLocalInteractionTime > 1000) {
            updatePlayPauseButton(state);
        }
    }
}

function monitorSyncHealth() {
    if (!hasUserInteracted) return;
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;
    if (Date.now() - lastLocalInteractionTime < 2000) return;

    if (currentRemoteState.action === 'ad_pause') {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            try { player.pauseVideo(); } catch(e){}
        }
        updateSyncStatus(); 
        return; 
    }
    
    if (currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 1500) {
            updateSyncStatus(); 
        }
        return;
    }

    const myState = player.getPlayerState();
    
    // --- SMOOTHING LOGIC START ---
    
    // 1. Buffering Guard: If we are buffering, assume we are catching up. 
    // Do NOT force a seek, or we will enter a buffering loop.
    if (myState === YT.PlayerState.BUFFERING) return;
    
    // 2. Anti-Thrash: If we sought recently (< 3s), let playback stabilize before correcting again.
    if (Date.now() - lastSeekTime < 3000) return;

    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        let needsFix = false;
        
        // Fix Paused State
        if (myState !== YT.PlayerState.PLAYING) {
            if (detectAd()) return; 
            userIntentionallyPaused = false;
            try { player.playVideo(); } catch(e){}
            needsFix = true;
        }
        
        // Latency Compensation (Clamped)
        let latency = 0;
        if (currentRemoteState.timestamp) {
            latency = (Date.now() - currentRemoteState.timestamp) / 1000;
            if (latency < 0) latency = 0;
            if (latency > 2) latency = 2; // Limit compensation to 2s max
        }
        
        const expectedTime = currentRemoteState.time + latency;
        
        // 3. Tolerance: Increased to 1.2s to handle unstable networks smoothly.
        if (Math.abs(player.getCurrentTime() - expectedTime) > 1.2) {
            if (!detectAd()) { 
                try { 
                    player.seekTo(expectedTime, true); 
                    lastSeekTime = Date.now(); // Record seek time
                } catch(e){}
                needsFix = true; 
            }
        }
        if (needsFix) suppressBroadcast(2000); 
    }
    // --- SMOOTHING LOGIC END ---
    
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             userIntentionallyPaused = true;
             try { player.pauseVideo(); } catch(e){}
             suppressBroadcast(800);
         }
    }
}

function updatePlayPauseButton(state) {
    if (!UI.playPauseBtn) return;
    if (isSwitchingSong) return;

    const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
    const iconClass = isPlaying ? 'fa-pause' : 'fa-play';
    if (!UI.playPauseBtn.innerHTML.includes(iconClass)) {
        UI.playPauseBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    }
    if(navigator.mediaSession) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function onPlayerStateChange(event) {
    const state = event.data;

    if (detectAd()) {
        updateSyncStatus();
        return;
    }

    if (state === YT.PlayerState.BUFFERING) {
        updateSyncStatus();
        return; 
    }

    if (state === YT.PlayerState.PLAYING) {
         userIntentionallyPaused = false;
         if (isSwitchingSong) {
             isSwitchingSong = false;
             updateSyncStatus();
         }
    }

    if (state === YT.PlayerState.PAUSED && document.hidden && !userIntentionallyPaused) {
        try { player.playVideo(); } catch(e){}
        return; 
    }

    if(Date.now() - lastLocalInteractionTime > 500) {
        updatePlayPauseButton(state);
    }

    if (isSwitchingSong || ignoreSystemEvents) return;

    if (state === YT.PlayerState.PLAYING) {
        if(player && player.setVolume) player.setVolume(100);
        if (Date.now() - lastLocalInteractionTime > 500) {
             lastBroadcaster = myName; 
             broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.PAUSED) {
        if (Date.now() - lastLocalInteractionTime > 500) {
            if (!document.hidden || userIntentionallyPaused) {
                lastBroadcaster = myName; 
                broadcastState('pause', player.getCurrentTime(), currentVideoId);
            }
        }
    }
    else if (state === YT.PlayerState.ENDED) initiateNextSong();
    
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || isSwitchingSong) return;
    
    lastLocalInteractionTime = Date.now();
    ignoreSystemEvents = false;
    clearTimeout(ignoreTimer);
    lastBroadcaster = myName; 

    const state = player.getPlayerState();

    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; 
        userIntentionallyPaused = true; 
        try { player.pauseVideo(); } catch(e){}
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>'; 
        userIntentionallyPaused = false; 
        if (!currentVideoId && currentQueue.length > 0) initiateSongLoad(currentQueue[0]);
        else if (currentVideoId) {
            player.setVolume(100);
            try { player.playVideo(); } catch(e){}
            broadcastState('play', player.getCurrentTime(), currentVideoId, true);
        }
    }
}

function initiateNextSong() {
    if (isSwitchingSong) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length];
    if (next) initiateSongLoad(next);
}

function initiatePrevSong() {
    if (isSwitchingSong) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) initiateSongLoad(currentQueue[idx-1]);
}

function initiateSongLoad(songObj) {
    if (!songObj) return;

    isSwitchingSong = true;
    userIntentionallyPaused = false; 
    lastBroadcaster = myName;
    
    showToast("System", "Switching track...");
    UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    syncRef.set({ 
        action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: Date.now() 
    });

    setTimeout(() => {
        if (isSwitchingSong) {
            isSwitchingSong = false;
            try { if(player) player.playVideo(); } catch(e){}
        }
    }, 1200);

    loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
    updateMediaSessionMetadata(songObj.title, songObj.uploader, songObj.thumbnail);
    setTimeout(() => { isSwitchingSong = false; }, 100); 
}

// --- DATA & CHAT LOGIC ---

function loadInitialData() {
    // Queue Listener
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const data = snapshot.val();
        let list = [];
        if (data) Object.keys(data).forEach(k => list.push({ ...data[k], key: k }));
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = list;
        const signature = JSON.stringify(list.map(s => s.key));
        if (signature !== lastQueueSignature) {
            lastQueueSignature = signature;
            renderQueue(currentQueue, currentVideoId);
        }
    });

    // Sync Listener
    syncRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (state) {
            currentRemoteState = state; 
            if (state.lastUpdater !== myName) applyRemoteCommand(state);
            else lastBroadcaster = myName;
        }
        updateSyncStatus();
    });

    // Chat Added Listener
    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        const key = snapshot.key;
        displayChatMessage(key, msg.user, msg.text, msg.timestamp, msg.image, msg.seen);
        if (msg.user !== myName && isChatActive() && !msg.seen) {
             chatRef.child(key).update({ seen: true });
        }
        calculateUnreadCount();
        if (msg.user !== myName && !isChatActive()) {
            const isRecent = (Date.now() - msg.timestamp) < 30000; 
            if(isRecent) showToast(msg.user, msg.text);
        }
    });
    
    // Chat Changed Listener (Read Receipts)
    chatRef.limitToLast(50).on('child_changed', (snapshot) => {
        const msg = snapshot.val();
        const key = snapshot.key;
        const tickEl = document.getElementById(`tick-${key}`);
        if(tickEl) {
             tickEl.innerHTML = msg.seen ? '<i class="fa-solid fa-check-double"></i>' : '<i class="fa-solid fa-check"></i>';
             tickEl.className = msg.seen ? 'msg-tick seen' : 'msg-tick';
        }
        calculateUnreadCount();
    });
}
loadInitialData();

// --- RESTORED: CHAT DISPLAY FUNCTION ---
function displayChatMessage(key, user, text, timestamp, image, seen) {
    if (!UI.chatMessages) return;

    const isMe = user === myName;
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isMe ? 'me' : 'other'}`;
    msgDiv.id = `msg-${key}`;
    
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const tickIcon = seen ? '<i class="fa-solid fa-check-double"></i>' : '<i class="fa-solid fa-check"></i>';
    const tickClass = seen ? 'msg-tick seen' : 'msg-tick';

    let contentHtml = `<div class="msg-text">${text}</div>`;
    if (image) {
        contentHtml = `<img src="${image}" class="msg-image" alt="Shared image">`;
    }

    msgDiv.innerHTML = `
        <div class="msg-bubble">
            ${!isMe ? `<div class="msg-user">${user}</div>` : ''}
            ${contentHtml}
            <div class="msg-meta">
                <span class="msg-time">${timeStr}</span>
                ${isMe ? `<span id="tick-${key}" class="${tickClass}">${tickIcon}</span>` : ''}
            </div>
        </div>
    `;

    UI.chatMessages.appendChild(msgDiv);
    forceChatScroll();
}

function calculateUnreadCount() {
    chatRef.limitToLast(50).once('value', (snapshot) => {
        let count = 0;
        snapshot.forEach((child) => {
            const msg = child.val();
            if (msg.user !== myName && !msg.seen) count++;
        });
        updateChatBadges(count);
    });
}

function updateChatBadges(count) {
    if (count > 0) {
        if(UI.chatBadge) {
            UI.chatBadge.textContent = count;
            UI.chatBadge.style.display = 'inline-block';
        }
        if(UI.mobileChatBadge) {
            UI.mobileChatBadge.textContent = count;
            UI.mobileChatBadge.style.display = 'block';
        }
    } else {
        if(UI.chatBadge) UI.chatBadge.style.display = 'none';
        if(UI.mobileChatBadge) UI.mobileChatBadge.style.display = 'none';
    }
}

function markMessagesAsSeen() {
    chatRef.limitToLast(50).once('value', (snapshot) => {
        const updates = {};
        snapshot.forEach((child) => {
            const msg = child.val();
            if (msg.user !== myName && !msg.seen) {
                updates[`${child.key}/seen`] = true;
            }
        });
        if(Object.keys(updates).length > 0) chatRef.update(updates);
    });
}

function isChatActive() {
    const isMobile = window.innerWidth <= 1100;
    if (isMobile) return activeTab === 'chat' && UI.mobileSheet.classList.contains('active');
    return activeTab === 'chat';
}

function forceChatScroll() {
    if(UI.chatMessages) {
        UI.chatMessages.scrollTop = UI.chatMessages.scrollHeight;
        requestAnimationFrame(() => {
            UI.chatMessages.scrollTop = UI.chatMessages.scrollHeight;
        });
    }
}

function broadcastState(action, time, videoId, force = false) {
    if (ignoreSystemEvents && !force) return; 
    syncRef.set({ action, time, videoId, lastUpdater: myName, timestamp: Date.now() });
}

function applyRemoteCommand(state) {
    if (!player) return;
    if (Date.now() - lastLocalInteractionTime < 1500) return;
    
    if (state.action === 'ad_pause') {
        suppressBroadcast(2000);
        lastBroadcaster = state.lastUpdater;
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            try { player.pauseVideo(); } catch(e){}
        }
        updateSyncStatus();
        return;
    }

    if (!hasUserInteracted && (state.action === 'play' || state.action === 'restart')) {
        if (state.videoId !== currentVideoId) {
             const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
             const title = songInQueue ? songInQueue.title : "Syncing...";
             const uploader = songInQueue ? songInQueue.uploader : "";
             loadAndPlayVideo(state.videoId, title, uploader, state.time, false, false); 
        }
        return; 
    }
    
    suppressBroadcast(1000); 
    lastBroadcaster = state.lastUpdater;
    
    UI.syncOverlay.classList.remove('active');

    if (state.action === 'switching_pause') {
        if (Date.now() - (state.timestamp || 0) > 1500) {
            return;
        }
        showToast("System", "Partner is changing track...");
        UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        updateSyncStatus();
        return;
    }

    // --- LATENCY COMPENSATION ---
    let latency = 0;
    if (state.timestamp) {
         latency = (Date.now() - state.timestamp) / 1000;
         if (latency < 0) latency = 0;
         if (latency > 2) latency = 2; 
    }
    const targetTime = (state.time || 0) + latency;

    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, targetTime, false); 
        if(state.action === 'play' || state.action === 'restart') {
            userIntentionallyPaused = false;
            player.setVolume(100);
            try { player.playVideo(); } catch(e){}
        }
    } 
    else {
        const playerState = player.getPlayerState();
        if (state.action === 'restart') {
            try { player.seekTo(targetTime, true); } catch(e){}
            userIntentionallyPaused = false;
            player.setVolume(100);
            try { player.playVideo(); } catch(e){}
            lastSeekTime = Date.now();
        }
        else if (state.action === 'play') {
            // Check drift against 1.2s tolerance
            if (Math.abs(player.getCurrentTime() - targetTime) > 1.2) {
                try { 
                    player.seekTo(targetTime, true); 
                    lastSeekTime = Date.now();
                } catch(e){}
            }
            if (playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) {
                userIntentionallyPaused = false;
                player.setVolume(100);
                try { player.playVideo(); } catch(e){}
            }
        }
        else if (state.action === 'pause') {
            if (playerState !== YT.PlayerState.PAUSED) {
                userIntentionallyPaused = true; 
                try { player.pauseVideo(); } catch(e){}
            }
        } 
    }
    updateSyncStatus();
}

function updateSyncStatus() {
    if (document.hidden) return;

    const msgEl = UI.syncStatusMsg;
    const eq = UI.equalizer;
    
    let icon = '', text = '', className = '';
    let eqActive = false;

    if (detectAd()) {
        icon = 'fa-rectangle-ad'; text = 'Ad Playing'; className = 'sync-status-3d status-ad';
    }
    else if (isSwitchingSong) {
        icon = 'fa-spinner fa-spin'; text = 'Switching...'; className = 'sync-status-3d status-switching';
    }
    else if (currentRemoteState && currentRemoteState.action === 'ad_pause') {
        icon = 'fa-eye-slash'; text = `${currentRemoteState.lastUpdater} having Ad...`; className = 'sync-status-3d status-ad-remote';
    }
    else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 1500) {
            icon = 'fa-pause'; text = 'Ready'; className = 'sync-status-3d status-paused';
        } else {
            icon = 'fa-music'; text = `${currentRemoteState.lastUpdater} picking song...`; className = 'sync-status-3d status-switching';
        }
    }
    else {
        const playerState = player ? player.getPlayerState() : -1;
        if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
            icon = 'fa-heart-pulse'; text = 'Vibing Together'; className = 'sync-status-3d status-playing';
            eqActive = true;
        } else {
            let pauser = lastBroadcaster;
            if (currentRemoteState && currentRemoteState.action === 'pause') pauser = currentRemoteState.lastUpdater;
            const nameDisplay = (pauser === myName) ? "You" : pauser;
            icon = 'fa-pause'; text = `Paused by ${nameDisplay}`; className = 'sync-status-3d status-paused';
        }
    }

    const newHTML = `<i class="fa-solid ${icon}"></i> ${text}`;
    if (msgEl.innerHTML !== newHTML) msgEl.innerHTML = newHTML;
    if (msgEl.className !== className) {
        msgEl.className = className;
        msgEl.classList.remove('pop-anim');
        void msgEl.offsetWidth; // Trigger reflow for animation reset
        msgEl.classList.add('pop-anim');
    }

    if (eqActive && !eq.classList.contains('active')) eq.classList.add('active');
    if (!eqActive && eq.classList.contains('active')) eq.classList.remove('active');
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true, shouldPlay = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(1000); 

        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
            player.setVolume(100); 
        } else {
             if(Math.abs(player.getCurrentTime() - startTime) > 4.0) try { player.seekTo(startTime, true); } catch(e){}
             if(shouldPlay) {
                 player.setVolume(100);
                 try { player.playVideo(); } catch(e){}
             }
        }
        
        if(!shouldPlay) {
            setTimeout(() => { try { player.pauseVideo(); } catch(e){} }, 500);
        }

        currentVideoId = videoId;
        const decodedTitle = decodeHTMLEntities(title);
        UI.songTitle.textContent = decodedTitle;
        
        let artwork = 'https://via.placeholder.com/512';
        const currentSong = currentQueue.find(s => s.videoId === videoId);
        if(currentSong && currentSong.thumbnail) artwork = currentSong.thumbnail;
        updateMediaSessionMetadata(decodedTitle, uploader, artwork);

        renderQueue(currentQueue, currentVideoId);
        
        isSwitchingSong = false;
        userIntentionallyPaused = false; 

        if (shouldBroadcast) {
            lastBroadcaster = myName;
            setTimeout(() => {
                broadcastState('restart', 0, videoId, true); 
            }, 100);
        }
    }
}

// --- TAB SWITCHING ---
function switchTab(tabName, forceOpen = false) {
    if(window.innerWidth <= 1100) {
        if (!forceOpen && activeTab === tabName && UI.mobileSheet.classList.contains('active')) {
             UI.mobileSheet.classList.remove('active');
             document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
             return; 
        }
        if(tabName === 'queue') UI.mobileSheetTitle.textContent = "Queue";
        else if(tabName === 'results') UI.mobileSheetTitle.textContent = "Search Music";
        else if(tabName === 'chat') UI.mobileSheetTitle.textContent = "Chat";
        UI.mobileSheet.classList.add('active');
    }

    activeTab = tabName;
    
    if (tabName === 'chat') {
        markMessagesAsSeen();
        forceChatScroll();
        setTimeout(forceChatScroll, 300);
    }
    
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    const dBtn = document.getElementById('tab-btn-' + tabName);
    if(dBtn) dBtn.classList.add('active');

    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
    const mobileIndex = ['queue', 'results', 'chat'].indexOf(tabName);
    const mobileItems = document.querySelectorAll('.mobile-nav-item');
    if(mobileItems[mobileIndex]) mobileItems[mobileIndex].classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById('view-' + tabName).classList.add('active');
}

if(window.innerWidth <= 1100) {
    UI.mobileSheet.classList.remove('active');
}

document.getElementById('mobileSheetClose').addEventListener('click', () => {
    UI.mobileSheet.classList.remove('active');
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
});

// --- RESTORED: SEARCH LOGIC ---
async function handleSearch() {
    const query = UI.searchInput.value.trim();
    if (!query) return;

    UI.resultsList.innerHTML = '<div style="display:flex; justify-content:center; padding:20px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div>';
    
    // Switch to results tab automatically
    switchTab('results', true);

    try {
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=20&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`);
        const data = await response.json();

        if (data.items) {
            renderSearchResults(data.items);
        } else {
            UI.resultsList.innerHTML = '<div class="empty-state"><p>No results found.</p></div>';
        }
    } catch (error) {
        console.error("Search Error:", error);
        UI.resultsList.innerHTML = '<div class="empty-state"><p>Error searching. Please try again.</p></div>';
    }
}

function renderSearchResults(items) {
    UI.resultsList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    items.forEach(item => {
        const videoId = item.id.videoId;
        const title = item.snippet.title;
        const channel = item.snippet.channelTitle;
        const thumb = item.snippet.thumbnails.medium.url;

        const el = document.createElement('div');
        el.className = 'search-result-item';
        el.innerHTML = `
            <img src="${thumb}" alt="Thumbnail">
            <div class="result-info">
                <h4>${title}</h4>
                <p>${channel}</p>
            </div>
            <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
        `;

        el.onclick = () => {
            addToQueue(videoId, title, channel, thumb);
            triggerHaptic();
            showToast("System", "Added to queue");
        };

        fragment.appendChild(el);
    });

    UI.resultsList.appendChild(fragment);
}

// --- QUEUE LOGIC ---
function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    const cleanTitle = smartCleanTitle(title);
    queueRef.child(newKey).set({ videoId, title: cleanTitle, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            showToast("System", `Added ${cleanTitle}`);
            if (!currentVideoId && currentQueue.length === 0) initiateSongLoad({videoId, title: cleanTitle, uploader});
        });
}

function addBatchToQueue(songs) {
    if (!songs.length) return;
    showToast("System", `Adding ${songs.length} songs to queue...`); 
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, addedBy: myName, order: Date.now() + i * 100 };
    });
    queueRef.update(updates);
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    const song = currentQueue.find(s => s.key === key);
    if (song) {
        queueRef.child(key).remove();
        if (song.videoId === currentVideoId) initiateNextSong();
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => { updates[`${song.key}/order`] = index; });
    queueRef.update(updates);
}

function scrollToCurrentSong() {
    if (window.innerWidth <= 1100) {
        if (!UI.mobileSheet || !UI.mobileSheet.classList.contains('active')) return;
    }

    setTimeout(() => {
        const activeItem = document.querySelector('.song-item.playing');
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 100);
}

function renderQueue(queueArray, currentVideoId) {
    const list = UI.queueList;
    
    UI.queueBadge.textContent = queueArray.length;
    if(UI.mobileQueueBadge) UI.mobileQueueBadge.textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Queue is empty.</p></div>';
        return;
    }
    
    const fragment = document.createDocumentFragment();

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        
        const user = song.addedBy || 'System';
        const isMe = user === myName;
        const badgeClass = isMe ? 'is-me' : 'is-other';
        const displayText = isMe ? 'You' : `${user}`;
        const number = index + 1;
        
        let statusIndicator = '';
        if (song.videoId === currentVideoId) {
            statusIndicator = `
                <div class="mini-eq-container">
                    <div class="mini-eq-bar"></div>
                    <div class="mini-eq-bar"></div>
                    <div class="mini-eq-bar"></div>
                </div>`;
        }
        
        item.innerHTML = `
            <i class="fa-solid fa-bars drag-handle" title="Drag to order"></i>
            <div class="song-index">${number}</div>
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-details">
                <h4>${song.title}</h4>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="added-by-badge ${badgeClass}">Added by ${displayText}</span>
                    ${statusIndicator}
                </div>
            </div>
            <button class="emoji-trigger" onclick="removeFromQueue('${song.key}', event)"><i class="fa-solid fa-trash"></i></button>
        `;
        fragment.appendChild(item);
    });

    list.innerHTML = '';
    list.appendChild(fragment);

    initDragAndDrop(list);
    scrollToCurrentSong();
}

function initDragAndDrop(list) {
    let draggedItem = null;
    list.querySelectorAll('.song-item').forEach(item => {
        item.addEventListener('dragstart', () => { draggedItem = item; item.classList.add('dragging'); });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedItem = null;
            const newOrderKeys = Array.from(list.querySelectorAll('.song-item')).map(el => el.dataset.key);
            const newOrder = newOrderKeys.map(key => currentQueue.find(s => s.key === key));
            updateQueueOrder(newOrder);
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement == null) list.appendChild(draggedItem);
            else list.insertBefore(draggedItem, afterElement);
        });
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.song-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
        else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// --- LYRICS LOGIC ---
document.getElementById('lyrics-btn').addEventListener('click', () => {
    UI.lyricsOverlay.classList.add('active');
    fetchLyrics();
});
document.getElementById('closeLyricsBtn').addEventListener('click', () => {
    UI.lyricsOverlay.classList.remove('active');
    stopLyricsSync(); 
});

document.getElementById('manualLyricsBtn').addEventListener('click', () => {
    const input = document.getElementById('manualLyricsInput');
    const query = input.value.trim();
    if(query) fetchLyrics(query);
});
document.getElementById('manualLyricsInput').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') document.getElementById('manualLyricsBtn').click();
});

const dedicateBtn = document.getElementById('dedicateBtn');
if (dedicateBtn) {
    dedicateBtn.addEventListener('click', () => {
        const title = UI.songTitle.textContent;
        if(title && title !== "Heart's Rhythm") {
            const msg = `🎵 Dedicated to you: ${title} ❤️`;
            chatRef.push({ user: myName, text: msg, timestamp: Date.now(), seen: false });
            showToast("System", "Dedication sent!");
            switchTab('chat');
        } else {
            showToast("System", "Play a song to dedicate it!");
        }
    });
}

function sendVibe(emoji) {
    const msgs = [
        `Vibing with ${emoji}`,
        `Sending ${emoji}`,
        `${emoji} ${emoji} ${emoji}`
    ];
    const text = msgs[Math.floor(Math.random() * msgs.length)];
    chatRef.push({ user: myName, text: text, timestamp: Date.now(), seen: false });
    triggerHaptic();
}

function decodeHTMLEntities(text) {
    if (!text) return "";
    const txt = document.createElement("textarea");
    txt.innerHTML = text;
    return txt.value;
}

function smartCleanTitle(title) {
    let processed = decodeHTMLEntities(title);
    processed = processed.replace(/\s*[\(\[].*?[\)\]]/g, '');
    processed = processed.replace(/\s(ft\.|feat\.|featuring)\s.*/gi, '');
    const artifacts = [
        "official video", "official audio", "official music video", 
        "official lyric video", "music video", "lyric video", "visualizer",
        "official", "video", "audio", "lyrics", "lyric",
        "hq", "hd", "4k", "remastered", "live", "performance", "mv",
        "with", "prod\\.", "dir\\."
    ];
    const artifactRegex = new RegExp(`\\b(${artifacts.join('|')})\\b`, 'gi');
    processed = processed.replace(artifactRegex, '');
    processed = processed.replace(/\|/g, ' '); 
    processed = processed.replace(/-/g, ' '); 
    processed = processed.replace(/\s+/g, ' ').trim();
    return processed;
}

function parseSyncedLyrics(lrc) {
    const lines = lrc.split('\n');
    const result = [];
    const timeReg = /\[(\d{2}):(\d{2}(?:\.\d+)?)\]/;
    lines.forEach(line => {
        const match = line.match(timeReg);
        if (match) {
            const min = parseFloat(match[1]);
            const sec = parseFloat(match[2]);
            const time = min * 60 + sec;
            const text = line.replace(timeReg, '').trim();
            if(text) result.push({ time, text });
        }
    });
    return result;
}

function renderSyncedLyrics(lyrics) {
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

function startLyricsSync() {
    if(lyricsInterval) clearInterval(lyricsInterval);
    if(UI.lyricsOverlay.classList.contains('active')) {
        lyricsInterval = setInterval(syncLyricsDisplay, 1000); 
    }
}

function stopLyricsSync() {
    if(lyricsInterval) clearInterval(lyricsInterval);
}

function syncLyricsDisplay() {
    if (document.hidden) return;
    if (!player || !player.getCurrentTime || !currentLyrics) return;
    
    const time = player.getCurrentTime();
    let activeIndex = -1;

    let startIdx = 0;
    if (lastLyricsIndex !== -1 && currentLyrics[lastLyricsIndex] && currentLyrics[lastLyricsIndex].time < time) {
        startIdx = lastLyricsIndex;
    }

    for(let i = startIdx; i < currentLyrics.length; i++) {
        if(currentLyrics[i].time <= time) {
            activeIndex = i;
        } else {
            break;
        }
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
    const searchBar = document.getElementById('lyricsSearchBar');
    const lyricsTitle = document.getElementById('lyrics-title');
    const unsyncBtn = document.getElementById('unsyncLyricsBtn');
    
    let searchWords = "";
    searchBar.classList.remove('visible');
    searchBar.style.display = 'none'; 
    unsyncBtn.style.display = 'none';
    lastLyricsIndex = -1; 
    currentPlainLyrics = ""; 
    
    if(manualQuery) {
        searchWords = manualQuery;
        lyricsTitle.textContent = "Search: " + manualQuery;
    } else {
        const titleEl = UI.songTitle;
        let rawTitle = "Heart's Rhythm";
        if(titleEl && titleEl.textContent !== "Heart's Rhythm") {
            rawTitle = titleEl.textContent;
        }
        const cleanTitle = smartCleanTitle(rawTitle);
        searchWords = cleanTitle.split(/\s+/).slice(0, 5).join(" ");
        lyricsTitle.textContent = "Lyrics: " + cleanTitle;
    }

    UI.lyricsContent.innerHTML = '<div style="margin-top:20px; width:40px; height:40px; border:4px solid rgba(245,0,87,0.2); border-top:4px solid #f50057; border-radius:50%; animation: spin 1s infinite linear;"></div>';

    try {
        const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchWords)}`;
        const res = await fetch(searchUrl);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const song = data.find(s => s.syncedLyrics) || data[0];
            
            if (song.syncedLyrics) {
                currentPlainLyrics = song.plainLyrics || song.syncedLyrics.replace(/\[.*?\]/g, '');
                currentLyrics = parseSyncedLyrics(song.syncedLyrics);
                renderSyncedLyrics(currentLyrics);
                startLyricsSync();
                unsyncBtn.style.display = 'grid';
            } else {
                currentLyrics = null;
                stopLyricsSync();
                const text = song.plainLyrics || "Instrumental";
                UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${text.replace(/\n/g, "<br>")}</div>`;
            }
            searchBar.classList.remove('visible');
            setTimeout(() => { if(!searchBar.classList.contains('visible')) searchBar.style.display = 'none'; }, 500);

        } else {
            throw new Error("No lyrics found");
        }
    } catch (e) {
        if(!manualQuery) {
            try {
                const titleText = UI.songTitle.textContent;
                if(titleText.includes('-')) {
                   const parts = titleText.split('-');
                   const p1 = parts[0].trim();
                   const p2 = parts[1].trim();
                   let fallbackUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(p1)}/${encodeURIComponent(p2)}`;
                   let fRes = await fetch(fallbackUrl);
                   let fData = await fRes.json();
                   if(fData.lyrics) {
                        currentLyrics = null;
                        stopLyricsSync();
                        UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${fData.lyrics.replace(/\n/g, "<br>")}</div>`;
                        return; 
                   }
                   fallbackUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(p2)}/${encodeURIComponent(p1)}`;
                   fRes = await fetch(fallbackUrl);
                   fData = await fRes.json();
                   if(fData.lyrics) {
                        currentLyrics = null;
                        stopLyricsSync();
                        UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${fData.lyrics.replace(/\n/g, "<br>")}</div>`;
                        return;
                   }
                }
            } catch(err) { console.log("Fallback lyrics failed"); }
        }
        stopLyricsSync();
        searchBar.style.display = 'block';
        setTimeout(() => searchBar.classList.add('visible'), 10);
        
        UI.lyricsContent.innerHTML = `
            <p style="opacity:0.7; margin-bottom: 5px;">Lyrics not found via API.</p>
            <p style="font-size:0.9rem; color:#aaa; margin-bottom:20px;">Use the search bar above to try manually.</p>
        `;
    }
}

// --- GLOBAL EVENT LISTENERS ---
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', initiatePrevSong);
document.getElementById('next-btn').addEventListener('click', initiateNextSong);

document.getElementById('search-btn').addEventListener('click', handleSearch);
UI.searchInput.addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

document.getElementById('chatSendBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { 
        chatRef.push({ user: myName, text: val, timestamp: Date.now(), seen: false }); 
        document.getElementById('chatInput').value=''; 
    }
});
document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') document.getElementById('chatSendBtn').click();
});

document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear the entire queue?")) queueRef.remove(); });

document.getElementById('shuffleQueueBtn').addEventListener('click', () => {
    if (currentQueue.length < 2) {
        showToast("System", "Not enough songs to shuffle.");
        return;
    }
    let playingSong = null;
    let songsToShuffle = [];

    if (currentVideoId) {
        playingSong = currentQueue.find(s => s.videoId === currentVideoId);
        songsToShuffle = currentQueue.filter(s => s.videoId !== currentVideoId);
    } else {
        songsToShuffle = [...currentQueue];
    }

    if (songsToShuffle.length === 0) return;

    for (let i = songsToShuffle.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [songsToShuffle[i], songsToShuffle[j]] = [songsToShuffle[j], songsToShuffle[i]];
    }

    const newOrderList = playingSong ? [playingSong, ...songsToShuffle] : songsToShuffle;

    updateQueueOrder(newOrderList);
    showToast("System", "Queue shuffled!");
    triggerHaptic();
});

document.getElementById('forceSyncBtn').addEventListener('click', () => {
    UI.syncOverlay.classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId);
});

// Fixed Info/About Button Logic
if(UI.infoBtn && UI.infoOverlay) {
    UI.infoBtn.addEventListener('click', () => UI.infoOverlay.classList.add('active'));
}
if(UI.closeInfoBtn && UI.infoOverlay) {
    UI.closeInfoBtn.addEventListener('click', () => UI.infoOverlay.classList.remove('active'));
}

// Fixed Mobile Nav Buttons
document.querySelectorAll('.mobile-nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
         const target = e.currentTarget.dataset.target;
         if(target) switchTab(target);
    });
});

document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
         const target = e.currentTarget.dataset.target;
         if(target) switchTab(target);
    });
});

// --- WELCOME SCREEN LOGIC (ROBUST FIX) ---
// Uses event delegation to handle cases where DOM elements aren't ready or IDs vary
document.addEventListener('click', (e) => {
    const overlay = UI.welcomeOverlay || document.getElementById('welcomeOverlay');
    if (!overlay) return;

    // Check if the overlay is actually visible/blocking
    const isVisible = overlay.style.display !== 'none' && overlay.style.opacity !== '0';
    if (!isVisible) return;

    // Check if click was on the Start Button (or any button inside the overlay)
    const target = e.target;
    const isStartBtn = target.closest('#start-btn') || target.closest('.start-btn') || (overlay.contains(target) && target.closest('button'));

    if (isStartBtn) {
        // 1. Fade out overlay
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';

        // 2. Remove from DOM layout after transition
        setTimeout(() => {
            overlay.style.display = 'none';
            overlay.classList.remove('active'); // Just in case class is used
        }, 500);
        
        // 3. Register User Interaction (Crucial for Audio Autoplay policies)
        hasUserInteracted = true;
        if(player && player.unMute) player.unMute();
        
        // 4. Trigger Play if ready
        if (player && currentVideoId) {
             try { player.playVideo(); } catch(e){}
        } else if (currentQueue.length > 0 && !currentVideoId) {
             // If queue has songs but nothing playing, start the first one
             initiateSongLoad(currentQueue[0]);
        }
    }
});
