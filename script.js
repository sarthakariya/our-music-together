// ==========================================================================
// OUR HEART'S SYNC - MAIN CONTROLLER
// ==========================================================================

// --- CONFIGURATION ---
// Firebase configuration for Realtime Database
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

// YouTube Data API Key
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();
const syncRef = db.ref('sync');
const queueRef = db.ref('queue');
const chatRef = db.ref('chat'); 
const presenceRef = db.ref('presence');

// ==========================================================================
// DOM CACHE & UI REFERENCES
// ==========================================================================
const UI = {
    // Player Components
    player: document.getElementById('player'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    equalizer: document.getElementById('equalizer'),
    songTitle: document.getElementById('current-song-title'),
    syncStatusMsg: document.getElementById('sync-status-msg'),
    
    // Lists & Badges
    queueList: document.getElementById('queue-list'),
    queueBadge: document.getElementById('queue-badge'),
    mobileQueueBadge: document.getElementById('mobile-queue-badge'),
    resultsList: document.getElementById('results-list'),
    
    // Chat Components
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chatInput'),
    chatSendBtn: document.getElementById('chatSendBtn'),
    chatBadge: document.getElementById('chat-badge'),
    mobileChatBadge: document.getElementById('mobile-chat-badge'),
    
    // Search
    searchInput: document.getElementById('searchInput'),
    searchBtn: document.getElementById('search-btn'),
    
    // Overlays & Modals
    toastContainer: document.getElementById('toast-container'),
    lyricsOverlay: document.getElementById('lyricsOverlay'),
    lyricsContent: document.getElementById('lyrics-content-area'),
    lyricsTitle: document.getElementById('lyrics-title'),
    lyricsSearchBar: document.getElementById('lyricsSearchBar'),
    manualLyricsInput: document.getElementById('manualLyricsInput'),
    manualLyricsBtn: document.getElementById('manualLyricsBtn'),
    unsyncLyricsBtn: document.getElementById('unsyncLyricsBtn'),
    closeLyricsBtn: document.getElementById('closeLyricsBtn'),
    
    infoOverlay: document.getElementById('infoOverlay'), 
    closeInfoBtn: document.getElementById('closeInfoBtn'),
    infoBtn: document.getElementById('infoBtn'),
    
    syncOverlay: document.getElementById('syncOverlay'),
    forceSyncBtn: document.getElementById('forceSyncBtn'),
    
    welcomeOverlay: document.getElementById('welcomeOverlay'),
    startSessionBtn: document.getElementById('startSessionBtn'),
    
    // Mobile Sheet Navigation
    mobileSheet: document.getElementById('mobileSheet'),
    mobileSheetTitle: document.getElementById('mobile-sheet-title'),
    mobileSheetClose: document.getElementById('mobileSheetClose'),
    
    // Tabs
    tabs: {
        queue: document.getElementById('tab-btn-queue'),
        results: document.getElementById('tab-btn-results'),
        chat: document.getElementById('tab-btn-chat')
    },
    views: {
        queue: document.getElementById('view-queue'),
        results: document.getElementById('view-results'),
        chat: document.getElementById('view-chat')
    }
};

// ==========================================================================
// STATE MANAGEMENT
// ==========================================================================

// Core Player State
let player;
let currentQueue = [];
let currentVideoId = null;
let activeTab = 'queue'; 

// Sync State
let currentRemoteState = null; 
let lastBroadcaster = "System"; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 
let lastQueueSignature = ""; 

// Playback Flags
let userIntentionallyPaused = false; 
let wasInAd = false; 
let lastAdBroadcastTime = 0;

// --- STRICT TRANSITION GUARD CONFIGURATION ---
const GUARD_INTERVAL_MS = 3500; // Strict 3.5s interval
const SYNC_TOLERANCE = 3.5;     // Max allowed drift in seconds
let guardInterval = null;

// Lyrics State
let currentLyrics = null;
let currentPlainLyrics = "";
let lyricsInterval = null;
let lastLyricsIndex = -1;

// Critical Logic Flags
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 

// Battery Saver Intervals
let smartIntervals = [];

// ==========================================================================
// UTILITY FUNCTIONS & INITIALIZATION
// ==========================================================================

// Battery Saver: Runs intervals slower when tab is hidden
function setSmartInterval(callback, normalMs, hiddenMs) {
    let intervalId = null;
    let currentMs = document.hidden ? hiddenMs : normalMs;
    
    const run = () => {
        if(document.hidden && hiddenMs === Infinity) return;
        callback();
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

// Handle Visibility Changes (Pause visuals, slow down polling)
document.addEventListener('visibilitychange', () => {
    smartIntervals.forEach(h => h.restart());
    if (document.hidden) {
        UI.equalizer.classList.add('paused'); 
        stopLyricsSync(); 
    } else {
        UI.equalizer.classList.remove('paused');
        if (currentVideoId) {
             const song = currentQueue.find(s => s.videoId === currentVideoId);
             if(song) updateMediaSessionMetadata(song.title, song.uploader, song.thumbnail);
        }
        if(currentLyrics) startLyricsSync();
        updateSyncStatus();
    }
});

// Haptic Feedback Wrapper
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(50); 
    }
}

// Global Click Haptics
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('button') || t.closest('.song-item') || t.closest('.nav-tab')) {
        triggerHaptic();
    }
}, {passive: true});

// User Identification
let myName = localStorage.getItem('deepSpaceUserName');
if (!myName || myName === "null") {
    myName = prompt("Enter your name (Sarthak or Reechita):");
    if(!myName) myName = "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

// Online Presence
const sessionKey = presenceRef.push().key;
presenceRef.child(sessionKey).onDisconnect().remove();
presenceRef.child(sessionKey).set({ 
    user: myName, 
    online: true, 
    timestamp: firebase.database.ServerValue.TIMESTAMP 
});

// Helper to suppress self-broadcast loops
function suppressBroadcast(duration = 1000) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
        ignoreSystemEvents = false;
    }, duration);
}

// Helper to decode HTML entities (e.g. &amp; -> &)
function decodeHTMLEntities(text) {
    if (!text) return "";
    const txt = document.createElement("textarea");
    txt.innerHTML = text;
    return txt.value;
}

// ==========================================================================
// NETWORK STATUS HANDLERS
// ==========================================================================
window.addEventListener('online', () => {
    showToast("System", "Back online! Resyncing...");
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
});
window.addEventListener('offline', () => {
    showToast("System", "Connection lost. Trying to keep playing...");
});

// ==========================================================================
// YOUTUBE PLAYER SETUP & EVENT LOOP
// ==========================================================================

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', 
        width: '100%', 
        videoId: '',
        playerVars: { 
            'controls': 1, 
            'disablekb': 0, 
            'rel': 0, 
            'modestbranding': 1, 
            'autoplay': 1, 
            'origin': window.location.origin,
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
    
    // 1. High-Frequency Local Monitor
    // Checks for Ads and updates Play/Pause button UI rapidly
    setSmartInterval(localMonitorLoop, 500, 2000);
    
    // 2. THE TRANSITION GUARD (Strict 3.5s Sync Lock)
    // Runs exactly every 3.5 seconds to verify integrity
    setSmartInterval(runTransitionGuard, GUARD_INTERVAL_MS, GUARD_INTERVAL_MS);

    // Initial Sync Fetch
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
    // Auto-skip on error
    setTimeout(() => { initiateNextSong(); }, 1500);
}

// ==========================================================================
// SYNC LOGIC: PART 1 - DETECTION & BROADCASTING
// ==========================================================================

function detectAd() {
    if (!player) return false;
    try {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) return false;
        const data = player.getVideoData();
        if (!data) return false;
        if (currentVideoId && data.video_id && data.video_id !== currentVideoId) return true;
        if (data.author === "") return true;
        if (data.title && (data.title === "Advertisement" || data.title.toLowerCase().startsWith("ad "))) return true;
    } catch(e) {}
    return false;
}

// Runs frequently to check for Ads and broadcast "I am playing"
function localMonitorLoop() {
    if (!player || !player.getPlayerState) return;

    const isAd = detectAd();
    
    // AD LOGIC
    if (isAd) {
        if (!wasInAd) {
            wasInAd = true;
            // Immediate Broadcast: "I am having an AD, wait for me!"
            broadcastState('ad_playing', 0, currentVideoId, true);
            lastAdBroadcastTime = Date.now();
            updateSyncStatus();
        }
        // Keep broadcasting AD status every 2s so partner stays locked
        if (Date.now() - lastAdBroadcastTime > 2000) {
            broadcastState('ad_playing', 0, currentVideoId, true);
            lastAdBroadcastTime = Date.now();
        }
    } else {
        if (wasInAd) {
            wasInAd = false;
            // Ad finished, release lock by broadcasting restart
            lastBroadcaster = myName;
            broadcastState('restart', 0, currentVideoId, true);
        }
    }
    
    // REGULAR PLAYBACK BROADCAST
    if (!isAd && !isSwitchingSong && lastBroadcaster === myName && !ignoreSystemEvents) {
        if (player.getPlayerState() === YT.PlayerState.PLAYING) {
             // Broadcast heartbeat every 1s
             if (Date.now() - lastAdBroadcastTime > 1000) {
                 broadcastState('play', player.getCurrentTime(), currentVideoId);
                 lastAdBroadcastTime = Date.now();
             }
             // Auto-Next Check (if < 1s remaining)
             const dur = player.getDuration();
             const curr = player.getCurrentTime();
             if (dur > 0 && dur - curr < 1) initiateNextSong();
        }
    }
    
    // UI Update (Play/Pause Button)
    if (!document.hidden && Date.now() - lastLocalInteractionTime > 1000) {
        updatePlayPauseButton(player.getPlayerState());
    }
}

// ==========================================================================
// SYNC LOGIC: PART 2 - THE TRANSITION GUARD (Strict Gate)
// ==========================================================================

function runTransitionGuard() {
    // If I'm not initialized or user hasn't clicked "Start Session", do nothing.
    if (!player || !currentRemoteState || !hasUserInteracted) return;
    if (ignoreSystemEvents || isSwitchingSong) return;
    
    // If I have an ad, I am the one blocking, so I don't need to guard myself.
    if (detectAd()) return; 

    const myState = player.getPlayerState();
    const remoteAction = currentRemoteState.action;
    
    // ---------------------------------------------------------
    // GUARD 1: AD BLOCKING LOCK
    // If remote says "ad_playing", I MUST PAUSE and WAIT.
    // ---------------------------------------------------------
    if (remoteAction === 'ad_playing' || remoteAction === 'ad_pause') {
        if (myState === YT.PlayerState.PLAYING) {
            console.log("Guard: Partner has Ad. Locking...");
            player.pauseVideo();
            updateSyncStatus();
        }
        return; 
    }

    // ---------------------------------------------------------
    // GUARD 2: SWITCH BLOCKING
    // If remote says "switching_pause", I MUST PAUSE.
    // ---------------------------------------------------------
    if (remoteAction === 'switching_pause') {
        // Respect switching state for up to 5 seconds
        if (Date.now() - (currentRemoteState.timestamp || 0) < 5000) {
            if (myState === YT.PlayerState.PLAYING) {
                console.log("Guard: Partner is switching. Locking...");
                player.pauseVideo();
            }
            updateSyncStatus();
            return;
        }
    }

    // ---------------------------------------------------------
    // GUARD 3: TIMESTAMP INTEGRITY (The Sync Lock)
    // ---------------------------------------------------------
    // Only verify if remote is supposed to be playing
    if (remoteAction === 'play' || remoteAction === 'restart') {
        
        // Calculate where remote *should* be right now
        const elapsedSinceUpdate = (Date.now() - currentRemoteState.timestamp) / 1000;
        const remoteEstimatedTime = currentRemoteState.time + elapsedSinceUpdate;
        const myTime = player.getCurrentTime();
        
        // Calculate difference: (My Time) - (Their Time)
        // Positive = I am Ahead. Negative = I am Behind.
        const diff = myTime - remoteEstimatedTime;

        // LOCK CONDITION: Am I ahead by > 3.5 seconds?
        if (diff > SYNC_TOLERANCE) {
            // I am too fast. Partner is buffering or stuck.
            console.log(`Guard: Ahead by ${diff.toFixed(2)}s. Engaging Lock.`);
            if (myState === YT.PlayerState.PLAYING) {
                player.pauseVideo(); // Pause without broadcasting
                updateSyncStatus();  // Show "Waiting..." overlay text
            }
        }
        // CATCH-UP CONDITION: Am I behind by > 3.5 seconds?
        else if (diff < -SYNC_TOLERANCE) {
             console.log(`Guard: Behind by ${Math.abs(diff).toFixed(2)}s. Seeking.`);
             player.seekTo(remoteEstimatedTime, true);
             if (myState !== YT.PlayerState.PLAYING) player.playVideo();
        }
        // SOFT SYNC: Small Drift Correction (0.5s - 3.5s)
        else if (Math.abs(diff) > 0.5) {
             // Use playback rate for smooth correction
             const rate = diff > 0 ? 0.95 : 1.05; 
             if (player.getPlaybackRate() !== rate) player.setPlaybackRate(rate);
        } 
        else {
             // In sync
             if (player.getPlaybackRate() !== 1) player.setPlaybackRate(1);
        }
        
        // RELEASE LOCK: Resume if I was waiting but now we are close enough
        if (myState === YT.PlayerState.PAUSED && !userIntentionallyPaused && Math.abs(diff) < SYNC_TOLERANCE) {
             player.playVideo();
        }
    }
}

// ==========================================================================
// SYNC LOGIC: PART 3 - APPLYING REMOTE COMMANDS
// ==========================================================================

function broadcastState(action, time, videoId, force = false) {
    if (ignoreSystemEvents && !force) return; 
    syncRef.set({ 
        action, 
        time, 
        videoId, 
        lastUpdater: myName, 
        timestamp: firebase.database.ServerValue.TIMESTAMP 
    });
}

function applyRemoteCommand(state) {
    if (!player) return;
    // Don't apply commands if I just interacted locally
    if (Date.now() - lastLocalInteractionTime < 1000) return;
    
    lastBroadcaster = state.lastUpdater;
    UI.syncOverlay.classList.remove('active');

    // Handle Song Change
    if (state.videoId !== currentVideoId) {
        if (state.action === 'switching_pause') {
            showToast("System", state.lastUpdater + " is changing song...");
            UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            return;
        }
        
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        return;
    }

    // Handle Play/Pause
    if (state.action === 'play' || state.action === 'restart') {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } 
    else if (state.action === 'pause') {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
    updateSyncStatus();
}

// ==========================================================================
// UI UPDATES & STATUS VISUALIZATION
// ==========================================================================

function updateSyncStatus() {
    if (document.hidden) return;

    const msgEl = UI.syncStatusMsg;
    const eq = UI.equalizer;
    
    let icon = '', text = '', className = '';
    let eqActive = false;

    // Determine Status Logic with Guard Awareness
    if (detectAd()) {
        icon = 'fa-rectangle-ad'; text = 'Ad Playing'; className = 'sync-status-3d status-ad';
    } 
    else if (currentRemoteState && (currentRemoteState.action === 'ad_playing' || currentRemoteState.action === 'ad_pause')) {
        icon = 'fa-eye-slash'; text = `Waiting for ${currentRemoteState.lastUpdater}'s Ad...`; className = 'sync-status-3d status-ad-remote';
    }
    else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        icon = 'fa-music'; text = 'Switching Track...'; className = 'sync-status-3d status-switching';
    }
    else {
        // Calculate diff for status text visualization
        let diff = 0;
        if (currentRemoteState && player && currentRemoteState.action === 'play') {
            const remoteTime = currentRemoteState.time + (Date.now() - currentRemoteState.timestamp)/1000;
            diff = player.getCurrentTime() - remoteTime;
        }

        if (diff > SYNC_TOLERANCE) {
             // Guard has locked us
             icon = 'fa-hourglass-half'; text = 'Waiting for Partner...'; className = 'sync-status-3d status-paused';
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
    }

    // Apply classes and text
    const newHTML = `<i class="fa-solid ${icon}"></i> ${text}`;
    if (msgEl.innerHTML !== newHTML) msgEl.innerHTML = newHTML;
    if (msgEl.className !== className) {
        msgEl.className = className;
        msgEl.classList.remove('pop-anim');
        void msgEl.offsetWidth; 
        msgEl.classList.add('pop-anim');
    }

    if (eqActive && !eq.classList.contains('active')) eq.classList.add('active');
    if (!eqActive && eq.classList.contains('active')) eq.classList.remove('active');
}

function updatePlayPauseButton(state) {
    if (!UI.playPauseBtn) return;
    const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
    const iconClass = isPlaying ? 'fa-pause' : 'fa-play';
    if (!UI.playPauseBtn.innerHTML.includes(iconClass)) {
        UI.playPauseBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    }
    if(navigator.mediaSession) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

// ==========================================================================
// PLAYER EVENT HANDLERS & CONTROL
// ==========================================================================

function onPlayerStateChange(event) {
    const state = event.data;

    if (detectAd()) {
        updateSyncStatus();
        return;
    }

    if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) {
        if(player && player.setPlaybackRate) player.setPlaybackRate(1);
    }

    if (state === YT.PlayerState.PLAYING) {
         userIntentionallyPaused = false;
         isSwitchingSong = false;
    }

    if(Date.now() - lastLocalInteractionTime > 500) {
        updatePlayPauseButton(state);
    }

    if (isSwitchingSong || ignoreSystemEvents) return;

    if (state === YT.PlayerState.PLAYING) {
        if(player && player.setVolume) player.setVolume(100);
        if (Date.now() - lastLocalInteractionTime < 2000) {
             lastBroadcaster = myName; 
             broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.PAUSED) {
        if (Date.now() - lastLocalInteractionTime < 2000) {
            lastBroadcaster = myName; 
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.ENDED) {
        initiateNextSong();
    }
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || isSwitchingSong) return;
    triggerHaptic();
    lastLocalInteractionTime = Date.now();
    ignoreSystemEvents = false;
    clearTimeout(ignoreTimer);
    lastBroadcaster = myName; 

    const state = player.getPlayerState();
    const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);

    if (isPlaying) {
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            initiateSongLoad(currentQueue[0]);
        } else if (currentVideoId) {
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId, true);
        }
    }
}

function initiateNextSong() {
    console.log("Song Ended. Initiating Next...");
    if (currentQueue.length === 0) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    let nextIndex = 0;
    if (idx !== -1) {
        nextIndex = idx + 1;
        if (nextIndex >= currentQueue.length) nextIndex = 0; 
    }
    const nextSong = currentQueue[nextIndex];
    if (nextSong) initiateSongLoad(nextSong);
}

function initiatePrevSong() {
    triggerHaptic();
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) initiateSongLoad(currentQueue[idx-1]);
}

function initiateSongLoad(songObj) {
    if (!songObj) return;

    isSwitchingSong = true;
    userIntentionallyPaused = false; 
    lastBroadcaster = myName;
    
    showToast("System", "Playing: " + songObj.title);
    UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    // Broadcast "Switching" state immediately to Trigger GUARD on partner
    syncRef.set({ 
        action: 'switching_pause', 
        time: 0, 
        videoId: songObj.videoId, 
        lastUpdater: myName, 
        timestamp: firebase.database.ServerValue.TIMESTAMP 
    });

    loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
    
    setTimeout(() => { isSwitchingSong = false; }, 3000);
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(2000); 

        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
        } else {
             player.seekTo(startTime, true);
             player.playVideo();
        }
        
        currentVideoId = videoId;
        const decodedTitle = decodeHTMLEntities(title);
        UI.songTitle.textContent = decodedTitle;
        
        let artwork = 'https://via.placeholder.com/512';
        const currentSong = currentQueue.find(s => s.videoId === videoId);
        if(currentSong && currentSong.thumbnail) artwork = currentSong.thumbnail;
        updateMediaSessionMetadata(decodedTitle, uploader, artwork);

        renderQueue(currentQueue, currentVideoId);
        
        if (shouldBroadcast) {
            lastBroadcaster = myName;
            setTimeout(() => {
                broadcastState('play', 0, videoId, true); 
            }, 500);
        }
    }
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', function() { if(player) player.playVideo(); });
        navigator.mediaSession.setActionHandler('pause', function() { if(player) player.pauseVideo(); });
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

// ==========================================================================
// DATA LOADING (QUEUE, CHAT, REMOTE)
// ==========================================================================

function loadInitialData() {
    // 1. Queue Listener
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const data = snapshot.val();
        let list = [];
        if (data) Object.keys(data).forEach(k => list.push({ ...data[k], key: k }));
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = list;
        
        // Optimize rendering: Only re-render if keys change
        const signature = JSON.stringify(list.map(s => s.key));
        if (signature !== lastQueueSignature) {
            lastQueueSignature = signature;
            renderQueue(currentQueue, currentVideoId);
        }
    });

    // 2. Sync Listener
    syncRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (state) {
            currentRemoteState = state; 
            if (state.lastUpdater !== myName) {
                applyRemoteCommand(state);
            }
        }
        updateSyncStatus();
    });

    // 3. Chat Listener (Added)
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
    
    // 4. Chat Listener (Changed - for seen ticks)
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

// ==========================================================================
// QUEUE & DRAG-DROP
// ==========================================================================

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
        const isPlaying = song.videoId === currentVideoId;
        item.className = `song-item ${isPlaying ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        
        const user = song.addedBy || 'System';
        const isMe = user === myName;
        const badgeClass = isMe ? 'is-me' : 'is-other';
        const displayText = isMe ? 'You' : `${user}`;
        const number = index + 1;
        
        let statusIndicator = '';
        if (isPlaying) {
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

function scrollToCurrentSong() {
    if (window.innerWidth <= 1100) {
        if (!UI.mobileSheet || !UI.mobileSheet.classList.contains('active')) return;
    }
    setTimeout(() => {
        const activeItem = document.querySelector('.song-item.playing');
        if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

// ==========================================================================
// LYRICS ENGINE
// ==========================================================================

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
    const searchBar = UI.lyricsSearchBar;
    const lyricsTitle = UI.lyricsTitle;
    const unsyncBtn = UI.unsyncLyricsBtn;
    
    let searchWords = "";
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
        if(titleEl && titleEl.textContent !== "Heart's Rhythm") rawTitle = titleEl.textContent;
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
            searchBar.style.display = 'none';
        } else {
            throw new Error("No lyrics found");
        }
    } catch (e) {
        stopLyricsSync();
        searchBar.style.display = 'block';
        UI.lyricsContent.innerHTML = `
            <p style="opacity:0.7; margin-bottom: 5px;">Lyrics not found via API.</p>
            <p style="font-size:0.9rem; color:#aaa; margin-bottom:20px;">Use the search bar above to try manually.</p>
        `;
    }
}

// ==========================================================================
// SEARCH & PLAYLIST
// ==========================================================================

async function handleSearch() {
    const input = UI.searchInput;
    const query = input.value.trim();
    if (!query) return;
    
    // Check for Playlist Link
    const ytPlaylistMatch = query.match(/[?&]list=([^#\&\?]+)/);
    if (ytPlaylistMatch) {
        showToast("System", "Fetching YouTube Playlist..."); 
        fetchPlaylist(ytPlaylistMatch[1]);
        input.value = ''; return;
    }

    switchTab('results', true);
    UI.resultsList.innerHTML = '<p style="text-align:center; padding:30px; color:white;">Searching...</p>';
    
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(searchUrl);
        const data = await res.json();
        const list = UI.resultsList;
        list.innerHTML = '';
        
        if (!data.items || data.items.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>No results found.</p></div>';
            return;
        }

        const videoIds = data.items.map(item => item.id.videoId).join(',');
        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
        const detailsRes = await fetch(detailsUrl);
        const detailsData = await detailsRes.json();
        
        const durationMap = {};
        detailsData.items.forEach(v => {
            durationMap[v.id] = parseDuration(v.contentDetails.duration);
        });

        const fragment = document.createDocumentFragment();
        data.items.forEach(item => {
            const vid = item.id.videoId;
            if(!vid) return;
            const duration = durationMap[vid] || "";
            const shortTitle = smartCleanTitle(item.snippet.title);
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <div class="thumb-container">
                    <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
                    <div class="song-duration-badge">${duration}</div>
                </div>
                <div class="song-details">
                    <h4>${shortTitle}</h4>
                    <p>${item.snippet.channelTitle}</p>
                </div>
                <button class="emoji-trigger" style="color:#fff;"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(vid, shortTitle, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            fragment.appendChild(div);
        });
        list.appendChild(fragment);
    } catch(e) { console.error(e); }
    input.value = '';
}

function parseDuration(pt) {
    let match = pt.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return "";
    let h = match[1] ? parseInt(match[1]) : 0;
    let m = match[2] ? parseInt(match[2]) : 0;
    let s = match[3] ? parseInt(match[3]) : 0;
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m}:${s.toString().padStart(2,'0')}`;
}

async function fetchPlaylist(playlistId, pageToken = '', allSongs = []) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const songs = data.items.filter(i=>i.snippet.resourceId.kind==='youtube#video').map(i => ({
            videoId: i.snippet.resourceId.videoId,
            title: smartCleanTitle(i.snippet.title), 
            uploader: i.snippet.channelTitle, 
            thumbnail: i.snippet.thumbnails.default.url
        }));
        allSongs = [...allSongs, ...songs];
        if (data.nextPageToken) fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        else addBatchToQueue(allSongs);
    } catch(e) { console.error(e); }
}

function smartCleanTitle(title) {
    let processed = decodeHTMLEntities(title);
    processed = processed.replace(/\s*[\(\[].*?[\)\]]/g, '');
    processed = processed.replace(/\s(ft\.|feat\.|featuring)\s.*/gi, '');
    const artifacts = ["official video", "official audio", "official music video", "lyric video", "visualizer", "official", "video", "audio", "lyrics", "hq", "hd", "4k", "remastered", "live", "mv"];
    const artifactRegex = new RegExp(`\\b(${artifacts.join('|')})\\b`, 'gi');
    processed = processed.replace(artifactRegex, '');
    processed = processed.replace(/\|/g, ' '); 
    processed = processed.replace(/-/g, ' '); 
    processed = processed.replace(/\s+/g, ' ').trim();
    return processed;
}

// ==========================================================================
// CHAT & UI HELPERS
// ==========================================================================

function displayChatMessage(key, user, text, timestamp, image = null, seen = false) {
    const box = UI.chatMessages;
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = user;
    div.appendChild(sender);
    const body = document.createElement('div');
    body.className = 'msg-text-content';
    body.textContent = text;
    if(image) {
        const img = document.createElement('img');
        img.src = image;
        img.className = 'chat-message-thumb';
        body.appendChild(img);
    }
    div.appendChild(body);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    meta.appendChild(timeSpan);
    if (isMe) {
        const tickSpan = document.createElement('span');
        tickSpan.id = `tick-${key}`;
        tickSpan.className = `msg-tick ${seen ? 'seen' : ''}`;
        tickSpan.innerHTML = seen ? '<i class="fa-solid fa-check-double"></i>' : '<i class="fa-solid fa-check"></i>';
        meta.appendChild(tickSpan);
    }
    div.appendChild(meta);
    box.appendChild(div);
    if(isChatActive()) forceChatScroll();
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
    const disp = count > 0 ? 'inline-block' : 'none';
    if(UI.chatBadge) { UI.chatBadge.textContent = count; UI.chatBadge.style.display = disp; }
    if(UI.mobileChatBadge) { UI.mobileChatBadge.textContent = count; UI.mobileChatBadge.style.display = disp; }
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
    }
}

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

function showToast(user, text) {
    const container = UI.toastContainer;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fa-solid fa-comment-dots" style="color:#ff4081; font-size:1.4rem;"></i>
        <div class="toast-body">
            <h4>${user}</h4>
            <p>${text.substring(0, 40)}${text.length>40?'...':''}</p>
        </div>
    `;
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.prepend(toast);
    while (container.children.length > 3) container.removeChild(container.lastChild);
    setTimeout(() => { 
        toast.style.opacity='0'; 
        toast.style.transform='translateX(50px)';
        setTimeout(()=> { if(toast.parentElement) toast.remove(); }, 400); 
    }, 4000);
}

// ==========================================================================
// EVENT LISTENERS
// ==========================================================================

// Playback
UI.playPauseBtn.addEventListener('click', togglePlayPause);
UI.prevBtn.addEventListener('click', initiatePrevSong);
UI.nextBtn.addEventListener('click', initiateNextSong);

// Search
UI.searchBtn.addEventListener('click', handleSearch);
UI.searchInput.addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });
UI.searchInput.addEventListener('input', () => { if(document.activeElement===UI.searchInput) switchTab('results', true); });

// Chat
UI.chatSendBtn.addEventListener('click', () => {
    const val = UI.chatInput.value.trim();
    if(val) { 
        chatRef.push({ user: myName, text: val, timestamp: Date.now(), seen: false }); 
        UI.chatInput.value=''; 
    }
});
UI.chatInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') UI.chatSendBtn.click();
});

// Queue Actions
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

// Modals & Overlays
UI.startSessionBtn.addEventListener('click', () => {
    hasUserInteracted = true;
    UI.welcomeOverlay.classList.remove('active');
    if (player && player.playVideo) player.playVideo();
});

UI.lyricsOverlay.addEventListener('click', (e) => { if(e.target === UI.lyricsOverlay) UI.lyricsOverlay.classList.remove('active'); });
document.getElementById('lyrics-btn').addEventListener('click', () => { UI.lyricsOverlay.classList.add('active'); fetchLyrics(); });
UI.closeLyricsBtn.addEventListener('click', () => { UI.lyricsOverlay.classList.remove('active'); stopLyricsSync(); });
UI.manualLyricsBtn.addEventListener('click', () => { const val = UI.manualLyricsInput.value.trim(); if(val) fetchLyrics(val); });
UI.manualLyricsInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') UI.manualLyricsBtn.click(); });
UI.unsyncLyricsBtn.addEventListener('click', () => {
    stopLyricsSync();
    currentLyrics = null;
    UI.unsyncLyricsBtn.style.display = 'none';
    if(currentPlainLyrics) {
         UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center; padding-bottom:50px;">${currentPlainLyrics.replace(/\n/g, "<br>")}</div>`;
    } else {
         const lines = document.querySelectorAll('.lyrics-line');
         let text = "";
         lines.forEach(l => text += l.textContent + "\n");
         UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center; padding-bottom:50px;">${text.replace(/\n/g, "<br>")}</div>`;
    }
    showToast("System", "Lyrics sync disabled.");
});

UI.forceSyncBtn.addEventListener('click', () => {
    UI.syncOverlay.classList.remove('active');
    player.playVideo(); 
    broadcastState('play', player.getCurrentTime(), currentVideoId);
});

if(UI.infoBtn) UI.infoBtn.addEventListener('click', () => UI.infoOverlay.classList.add('active'));
if(UI.closeInfoBtn) UI.closeInfoBtn.addEventListener('click', () => UI.infoOverlay.classList.remove('active'));

UI.mobileSheetClose.addEventListener('click', () => {
    UI.mobileSheet.classList.remove('active');
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
});

// END OF SCRIPT
