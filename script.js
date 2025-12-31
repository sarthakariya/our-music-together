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

// --- DOM CACHE ---
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
    searchInput: document.getElementById('searchInput'),
    resultsList: document.getElementById('results-list')
};

let player;
let currentQueue = []; 
// CRITICAL: This variable holds the "Truth". If the player differs from this, it's an Ad.
let currentVideoId = null; 
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 
let lastQueueSignature = ""; 
let loopMode = 1; 

// --- PLAYBACK FLAGS ---
let userIntentionallyPaused = false; 
let wasInAd = false; 

// --- LYRICS SYNC VARIABLES ---
let currentLyrics = null;
let currentPlainLyrics = "";
let lyricsInterval = null;
let lastLyricsIndex = -1;

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 

// --- UNIVERSAL CLICK HANDLER (Fixes Mobile Buttons) ---
document.addEventListener('click', (e) => {
    const t = e.target;
    // Haptic
    if (t.tagName === 'BUTTON' || t.closest('button') || t.closest('.song-item') || t.closest('.nav-tab')) {
        if (navigator.vibrate) navigator.vibrate(50); 
    }
    // Button Logic
    const btn = t.closest('button') || t;
    if (!btn || !btn.id) return;

    if (btn.id === 'play-pause-btn' || btn.id === 'mobile-play-btn' || btn.classList.contains('play-trigger')) {
        e.preventDefault(); togglePlayPause();
    }
    else if (btn.id === 'next-btn' || btn.id === 'mobile-next-btn') {
        e.preventDefault(); initiateNextSong();
    }
    else if (btn.id === 'prev-btn' || btn.id === 'mobile-prev-btn') {
        e.preventDefault(); initiatePrevSong();
    }
    else if (btn.id === 'search-btn') {
        e.preventDefault(); handleSearch();
    }
});

// --- VISIBILITY ---
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if(UI.equalizer) UI.equalizer.classList.add('paused'); 
        stopLyricsSync(); 
    } else {
        if(UI.equalizer) UI.equalizer.classList.remove('paused');
        if (currentVideoId) {
             const song = currentQueue.find(s => s.videoId === currentVideoId);
             if(song) updateMediaSessionMetadata(song.title, song.uploader, song.thumbnail);
        }
        if(currentLyrics) startLyricsSync();
        updateSyncStatus();
    }
});

let myName = localStorage.getItem('deepSpaceUserName');
if (!myName || myName === "null") {
    myName = prompt("Enter your name (Sarthak or Reechita):");
    if(!myName) myName = "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

const sessionKey = presenceRef.push().key;
presenceRef.child(sessionKey).onDisconnect().remove();
presenceRef.child(sessionKey).set({ user: myName, online: true, timestamp: firebase.database.ServerValue.TIMESTAMP });

// --- FAST BROADCAST SUPPRESSION ---
function suppressBroadcast(duration = 500) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
        ignoreSystemEvents = false;
    }, duration);
}

// --- NETWORK LISTENERS ---
window.addEventListener('online', () => {
    showToast("System", "Back online! Resyncing...");
    if (currentVideoId && player) {
        syncRef.once('value').then(snapshot => {
            const state = snapshot.val();
            if(state) applyRemoteCommand(state);
        });
    }
});
window.addEventListener('offline', () => showToast("System", "Connection lost. Trying to keep playing..."));

// --- YOUTUBE PLAYER SETUP ---
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin, 'playsinline': 1 
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
    
    // --- HIGH SPEED LOOPS ---
    setInterval(heartbeatSync, 400);       
    setInterval(monitorSyncHealth, 750);   
    setInterval(monitorAdStatus, 500); // Check ads every 500ms

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
    if(event.data === 100 || event.data === 101 || event.data === 150) errorMsg = "Song blocked by owner. Skipping...";
    showToast("System", errorMsg);
    updateSyncStatus(); 
    setTimeout(() => initiateNextSong(), 1000);
}

// --- BULLETPROOF AD DETECTION ---
function detectAd() {
    if (!player || !player.getVideoData) return false;
    // Safety: If we haven't selected a song yet, it's not an ad mismatch
    if (!currentVideoId) return false;

    try {
        const playerState = player.getPlayerState();
        // Ads usually play (1) or buffer (3). 
        if (playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) return false;

        const data = player.getVideoData();
        
        // --- THE KEY LOGIC ---
        // If the player's internal video ID does not match our target ID
        // AND we are not currently switching songs... IT IS AN AD.
        if (data && data.video_id && data.video_id !== currentVideoId && !isSwitchingSong) {
            return true;
        }

        // Secondary checks (just in case ID matches but metadata is weird)
        if (data.author === "") return true;
        
    } catch(e) {
        console.error("Ad Check Error:", e);
    }
    return false;
}

function monitorAdStatus() {
    // 1. Skip checks if tab hidden + paused (save battery)
    if (document.hidden && userIntentionallyPaused) return;
    if (!player || !currentVideoId) return;

    const isAd = detectAd();
    
    if (isAd) {
        if (!wasInAd) {
            // --- AD STARTED ---
            wasInAd = true;
            lastBroadcaster = myName; 
            
            // "Ad Shift": Tell partner to WAIT
            broadcastState('ad_wait', 0, currentVideoId, true); 
            updateSyncStatus();
        }
    } else {
        if (wasInAd) {
            // --- AD ENDED ---
            wasInAd = false;
            
            // Double check we are back to the correct video
            const data = player.getVideoData();
            if (data && data.video_id === currentVideoId) {
                // Force seek to start to sync with waiting partner
                player.seekTo(0, true);
                player.playVideo();

                setTimeout(() => {
                     lastBroadcaster = myName;
                     // "Release": Tell everyone to restart together
                     broadcastState('restart', 0, currentVideoId, true);
                     showToast("System", "Ad ended. Resyncing...");
                }, 500);
            }
        }
    }
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', function() {
            if(player && player.playVideo) { userIntentionallyPaused = false; player.playVideo(); togglePlayPause(); }
        });
        navigator.mediaSession.setActionHandler('pause', function() {
            if(player && player.pauseVideo) { userIntentionallyPaused = true; player.pauseVideo(); togglePlayPause(); }
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

// Background Keep-Alive
setInterval(() => {
    if (document.hidden && player && player.getPlayerState) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PAUSED && !userIntentionallyPaused && !detectAd()) {
            player.playVideo();
        }
    }
}, 3000); 

// --- SYNC ENGINE ---
function heartbeatSync() {
    if (isSwitchingSong) return;
    // If I am watching an ad, do not broadcast play/pause
    if (detectAd()) { if (lastBroadcaster === myName) updateSyncStatus(); return; }

    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            userIntentionallyPaused = false; 
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            // Loop instantly at end
            if (duration > 0 && duration - current < 0.5) initiateNextSong(); 
            else broadcastState('play', current, currentVideoId);
        }
        else if (state === YT.PlayerState.PAUSED) {
            if(userIntentionallyPaused) broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
        if(!document.hidden && Date.now() - lastLocalInteractionTime > 1000) updatePlayPauseButton(state);
    }
}

function monitorSyncHealth() {
    if (!hasUserInteracted) return;
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;
    if (Date.now() - lastLocalInteractionTime < 500) return;

    // --- THE AD SHIFT LOGIC (RECEIVER SIDE) ---
    if (currentRemoteState.action === 'ad_wait') {
        const myTime = player.getCurrentTime();
        const myState = player.getPlayerState();
        
        // Partner has Ad. I must NOT play.
        // I "Shift" my waiting position to 0:00
        if (myTime > 0.5 || myState === YT.PlayerState.PLAYING) {
            console.log("Partner has Ad. Holding at start.");
            player.seekTo(0, true);
            player.pauseVideo();
            showToast("System", "Partner has an Ad. Waiting...");
        }
        updateSyncStatus(); 
        return; 
    }
    
    if (currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 4000) updateSyncStatus(); 
        return;
    }

    const myState = player.getPlayerState();
    
    // RESTART (Used after Ad) or PLAY
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        let needsFix = false;
        
        if (currentRemoteState.action === 'restart') {
             // Force reset to 0 if restart command received
             if (Math.abs(player.getCurrentTime()) > 2.0) {
                 player.seekTo(0, true);
                 needsFix = true;
             }
        }

        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (detectAd()) return; 
            userIntentionallyPaused = false;
            player.playVideo(); 
            needsFix = true;
        }
        
        if (myState === YT.PlayerState.BUFFERING) return;
        
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 1.2) {
            if (!detectAd()) { player.seekTo(currentRemoteState.time, true); needsFix = true; }
        }
        
        if (needsFix) suppressBroadcast(2000); 
    }
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             userIntentionallyPaused = true;
             player.pauseVideo();
             suppressBroadcast(500);
         }
    }
}

function updatePlayPauseButton(state) {
    if (!UI.playPauseBtn) return;
    if (isSwitchingSong) return;
    const isPlaying = (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING);
    const iconClass = isPlaying ? 'fa-pause' : 'fa-play';
    // Update main desktop button
    if (!UI.playPauseBtn.innerHTML.includes(iconClass)) UI.playPauseBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    
    // Update mobile button if exists
    const mobileBtn = document.getElementById('mobile-play-btn');
    if (mobileBtn && !mobileBtn.innerHTML.includes(iconClass)) mobileBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;

    if(navigator.mediaSession) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

function onPlayerStateChange(event) {
    const state = event.data;
    if (detectAd()) { updateSyncStatus(); return; }
    if (state === YT.PlayerState.BUFFERING) { updateSyncStatus(); return; }

    if (state === YT.PlayerState.PLAYING) {
         userIntentionallyPaused = false;
         if (isSwitchingSong) { isSwitchingSong = false; updateSyncStatus(); }
    }
    if (state === YT.PlayerState.PAUSED && document.hidden && !userIntentionallyPaused) {
        player.playVideo(); return; 
    }
    if(Date.now() - lastLocalInteractionTime > 300) updatePlayPauseButton(state);
    if (isSwitchingSong || ignoreSystemEvents) return;

    if (state === YT.PlayerState.PLAYING) {
        if(player && player.setVolume) player.setVolume(100);
        if (Date.now() - lastLocalInteractionTime > 300) {
             lastBroadcaster = myName; 
             broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.PAUSED) {
        if (Date.now() - lastLocalInteractionTime > 300) {
            if (!document.hidden || userIntentionallyPaused) {
                lastBroadcaster = myName; 
                broadcastState('pause', player.getCurrentTime(), currentVideoId);
            }
        }
    }
    else if (state === YT.PlayerState.ENDED) {
        initiateNextSong();
    }
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
        if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; 
        userIntentionallyPaused = true; 
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>'; 
        userIntentionallyPaused = false; 
        if (!currentVideoId && currentQueue.length > 0) initiateSongLoad(currentQueue[0]);
        else if (currentVideoId) {
            player.setVolume(100);
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId, true);
        }
    }
}

function initiateNextSong() {
    if (isSwitchingSong) return;
    if (currentQueue.length === 0) return;
    
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    let nextIndex;
    // ALWAYS LOOP QUEUE
    nextIndex = (idx + 1) % currentQueue.length;

    const next = currentQueue[nextIndex];
    if (next) initiateSongLoad(next);
}

function initiatePrevSong() {
    if (isSwitchingSong) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) initiateSongLoad(currentQueue[idx-1]);
    else if(currentQueue.length > 0) initiateSongLoad(currentQueue[currentQueue.length - 1]); 
}

function initiateSongLoad(songObj) {
    if (!songObj) return;
    isSwitchingSong = true;
    userIntentionallyPaused = false; 
    lastBroadcaster = myName;
    
    // --- CRITICAL: UPDATE TARGET ID BEFORE LOADING ---
    currentVideoId = songObj.videoId;

    showToast("System", "Switching track...");
    if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    syncRef.set({ action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: Date.now() });

    setTimeout(() => {
        if (isSwitchingSong) { isSwitchingSong = false; if(player) player.playVideo(); }
    }, 3000);

    loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
    updateMediaSessionMetadata(songObj.title, songObj.uploader, songObj.thumbnail);
    setTimeout(() => { isSwitchingSong = false; }, 100); 
}

function loadInitialData() {
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

    syncRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (state) {
            currentRemoteState = state; 
            if (state.lastUpdater !== myName) applyRemoteCommand(state);
            else lastBroadcaster = myName;
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        const key = snapshot.key;
        displayChatMessage(key, msg.user, msg.text, msg.timestamp, msg.image, msg.seen);
        if (msg.user !== myName && isChatActive() && !msg.seen) chatRef.child(key).update({ seen: true });
        calculateUnreadCount();
        if (msg.user !== myName && !isChatActive()) {
            const isRecent = (Date.now() - msg.timestamp) < 30000; 
            if(isRecent) showToast(msg.user, msg.text);
        }
    });
    
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
        if(UI.chatBadge) { UI.chatBadge.textContent = count; UI.chatBadge.style.display = 'inline-block'; }
        if(UI.mobileChatBadge) { UI.mobileChatBadge.textContent = count; UI.mobileChatBadge.style.display = 'block'; }
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
            if (msg.user !== myName && !msg.seen) updates[`${child.key}/seen`] = true;
        });
        if(Object.keys(updates).length > 0) chatRef.update(updates);
    });
}

function isChatActive() {
    const isMobile = window.innerWidth <= 1100;
    if (isMobile) return activeTab === 'chat' && UI.mobileSheet && UI.mobileSheet.classList.contains('active');
    return activeTab === 'chat';
}

function forceChatScroll() {
    if(UI.chatMessages) {
        UI.chatMessages.scrollTop = UI.chatMessages.scrollHeight;
        requestAnimationFrame(() => { UI.chatMessages.scrollTop = UI.chatMessages.scrollHeight; });
    }
}

function broadcastState(action, time, videoId, force = false) {
    if (ignoreSystemEvents && !force) return; 
    syncRef.set({ action, time, videoId, lastUpdater: myName, timestamp: Date.now() });
}

function applyRemoteCommand(state) {
    if (!player) return;
    if (Date.now() - lastLocalInteractionTime < 500) return;
    
    // PARTNER HAS AD: We must FREEZE
    if (state.action === 'ad_wait') {
        suppressBroadcast(2000);
        lastBroadcaster = state.lastUpdater;
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
            showToast("System", "Partner has an Ad. Waiting...");
        }
        updateSyncStatus(); return;
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
    
    suppressBroadcast(400); 
    lastBroadcaster = state.lastUpdater;
    if(UI.syncOverlay) UI.syncOverlay.classList.remove('active');

    if (state.action === 'switching_pause') {
        if (Date.now() - (state.timestamp || 0) > 4000) return;
        showToast("System", "Partner is changing track...");
        if(UI.playPauseBtn) UI.playPauseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        updateSyncStatus(); return;
    }

    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        if(state.action === 'play' || state.action === 'restart') {
            userIntentionallyPaused = false;
            player.setVolume(100);
            player.playVideo();
        }
    } 
    else {
        const playerState = player.getPlayerState();
        if (state.action === 'restart') {
            // RESTART COMMAND (Post-Ad Sync)
            player.seekTo(0, true); 
            userIntentionallyPaused = false;
            player.setVolume(100);
            player.playVideo();
        }
        else if (state.action === 'play') {
            if (Math.abs(player.getCurrentTime() - state.time) > 1.2) player.seekTo(state.time, true);
            if (playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) {
                userIntentionallyPaused = false;
                player.setVolume(100);
                player.playVideo();
            }
        }
        else if (state.action === 'pause') {
            if (playerState !== YT.PlayerState.PAUSED) {
                userIntentionallyPaused = true; 
                player.pauseVideo();
            }
        } 
    }
    updateSyncStatus();
}

function updateSyncStatus() {
    if (document.hidden) return;
    if (!UI.syncStatusMsg) return;

    const msgEl = UI.syncStatusMsg;
    const eq = UI.equalizer;
    let icon = '', text = '', className = '';
    let eqActive = false;

    if (detectAd()) { icon = 'fa-rectangle-ad'; text = 'Ad Playing'; className = 'sync-status-3d status-ad'; }
    else if (isSwitchingSong) { icon = 'fa-spinner fa-spin'; text = 'Switching...'; className = 'sync-status-3d status-switching'; }
    else if (currentRemoteState && currentRemoteState.action === 'ad_wait') { icon = 'fa-eye-slash'; text = `${currentRemoteState.lastUpdater} has Ad. Waiting...`; className = 'sync-status-3d status-ad-remote'; }
    else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 4000) { icon = 'fa-pause'; text = 'Ready'; className = 'sync-status-3d status-paused'; } 
        else { icon = 'fa-music'; text = `${currentRemoteState.lastUpdater} picking song...`; className = 'sync-status-3d status-switching'; }
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
        void msgEl.offsetWidth; 
        msgEl.classList.add('pop-anim');
    }

    if (eq) {
        if (eqActive && !eq.classList.contains('active')) eq.classList.add('active');
        if (!eqActive && eq.classList.contains('active')) eq.classList.remove('active');
    }
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true, shouldPlay = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(2000); 
        
        // UPDATE GLOBAL ID TARGET
        currentVideoId = videoId;

        if(!player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
            player.setVolume(100); 
        } else {
             if(Math.abs(player.getCurrentTime() - startTime) > 1.2) player.seekTo(startTime, true);
             if(shouldPlay) { player.setVolume(100); player.playVideo(); }
             else player.loadVideoById({videoId: videoId, startSeconds: startTime});
        }
        
        if(!shouldPlay) setTimeout(() => player.pauseVideo(), 500);

        const decodedTitle = decodeHTMLEntities(title);
        if(UI.songTitle) UI.songTitle.textContent = decodedTitle;
        
        let artwork = 'https://via.placeholder.com/512';
        const currentSong = currentQueue.find(s => s.videoId === videoId);
        if(currentSong && currentSong.thumbnail) artwork = currentSong.thumbnail;
        updateMediaSessionMetadata(decodedTitle, uploader, artwork);

        renderQueue(currentQueue, currentVideoId);
        
        isSwitchingSong = false;
        userIntentionallyPaused = false; 

        if (shouldBroadcast) {
            lastBroadcaster = myName;
            setTimeout(() => { broadcastState('restart', 0, videoId, true); }, 100);
        }
    }
}

function switchTab(tabName, forceOpen = false) {
    if(window.innerWidth <= 1100 && UI.mobileSheet) {
        if (!forceOpen && activeTab === tabName && UI.mobileSheet.classList.contains('active')) {
             UI.mobileSheet.classList.remove('active');
             document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
             return; 
        }

        if(tabName === 'queue' && UI.mobileSheetTitle) UI.mobileSheetTitle.textContent = "Queue";
        else if(tabName === 'results' && UI.mobileSheetTitle) UI.mobileSheetTitle.textContent = "Search Music";
        else if(tabName === 'chat' && UI.mobileSheetTitle) UI.mobileSheetTitle.textContent = "Chat";
        
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
    const viewEl = document.getElementById('view-' + tabName);
    if(viewEl) viewEl.classList.add('active');
}

if(window.innerWidth <= 1100 && UI.mobileSheet) {
    UI.mobileSheet.classList.remove('active');
}

const sheetClose = document.getElementById('mobileSheetClose');
if(sheetClose) {
    sheetClose.addEventListener('click', () => {
        if(UI.mobileSheet) UI.mobileSheet.classList.remove('active');
        document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
    });
}

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
        if (activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

function renderQueue(queueArray, currentVideoId) {
    const list = UI.queueList;
    if(UI.queueBadge) UI.queueBadge.textContent = queueArray.length;
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
            statusIndicator = `<div class="mini-eq-container"><div class="mini-eq-bar"></div><div class="mini-eq-bar"></div><div class="mini-eq-bar"></div></div>`;
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

const lyricsBtn = document.getElementById('lyrics-btn');
if(lyricsBtn) lyricsBtn.addEventListener('click', () => { if(UI.lyricsOverlay) UI.lyricsOverlay.classList.add('active'); fetchLyrics(); });

const closeLyrics = document.getElementById('closeLyricsBtn');
if(closeLyrics) closeLyrics.addEventListener('click', () => { if(UI.lyricsOverlay) UI.lyricsOverlay.classList.remove('active'); stopLyricsSync(); });

const manualLyricsBtn = document.getElementById('manualLyricsBtn');
if(manualLyricsBtn) manualLyricsBtn.addEventListener('click', () => {
    const input = document.getElementById('manualLyricsInput');
    if(input) fetchLyrics(input.value.trim());
});

const dedicateBtn = document.getElementById('dedicateBtn');
if (dedicateBtn) {
    dedicateBtn.addEventListener('click', () => {
        const title = UI.songTitle ? UI.songTitle.textContent : "";
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
    const msgs = [`Vibing with ${emoji}`, `Sending ${emoji}`, `${emoji} ${emoji} ${emoji}`];
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
    const artifacts = ["official video", "official audio", "official music video", "official lyric video", "music video", "lyric video", "visualizer", "official", "video", "audio", "lyrics", "lyric", "hq", "hd", "4k", "remastered", "live", "performance", "mv", "with", "prod\\.", "dir\\."];
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
            const time = parseFloat(match[1]) * 60 + parseFloat(match[2]);
            const text = line.replace(timeReg, '').trim();
            if(text) result.push({ time, text });
        }
    });
    return result;
}

function renderSyncedLyrics(lyrics) {
    if(!UI.lyricsContent) return;
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
    if(UI.lyricsOverlay && UI.lyricsOverlay.classList.contains('active')) {
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
    const searchBar = document.getElementById('lyricsSearchBar');
    const lyricsTitle = document.getElementById('lyrics-title');
    const unsyncBtn = document.getElementById('unsyncLyricsBtn');
    
    let searchWords = "";
    if(searchBar) searchBar.style.display = 'none'; 
    if(unsyncBtn) unsyncBtn.style.display = 'none';
    lastLyricsIndex = -1; 
    currentPlainLyrics = ""; 
    
    if(manualQuery) {
        searchWords = manualQuery;
        if(lyricsTitle) lyricsTitle.textContent = "Search: " + manualQuery;
    } else {
        const titleEl = UI.songTitle;
        let rawTitle = "Heart's Rhythm";
        if(titleEl && titleEl.textContent !== "Heart's Rhythm") rawTitle = titleEl.textContent;
        const cleanTitle = smartCleanTitle(rawTitle);
        searchWords = cleanTitle.split(/\s+/).slice(0, 5).join(" ");
        if(lyricsTitle) lyricsTitle.textContent = "Lyrics: " + cleanTitle;
    }

    if(UI.lyricsContent) UI.lyricsContent.innerHTML = '<div style="margin-top:20px; width:40px; height:40px; border:4px solid rgba(245,0,87,0.2); border-top:4px solid #f50057; border-radius:50%; animation: spin 1s infinite linear;"></div>';

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
                if(unsyncBtn) unsyncBtn.style.display = 'grid';
            } else {
                currentLyrics = null;
                stopLyricsSync();
                const text = song.plainLyrics || "Instrumental";
                if(UI.lyricsContent) UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${text.replace(/\n/g, "<br>")}</div>`;
            }
        } else throw new Error("No lyrics found");
    } catch (e) {
        stopLyricsSync();
        if(searchBar) searchBar.style.display = 'block';
        if(UI.lyricsContent) UI.lyricsContent.innerHTML = `<p style="opacity:0.7;">Lyrics not found via API.</p>`;
    }
}

if(document.getElementById('unsyncLyricsBtn')) {
    document.getElementById('unsyncLyricsBtn').addEventListener('click', () => {
        stopLyricsSync();
        currentLyrics = null;
        document.getElementById('unsyncLyricsBtn').style.display = 'none';
        if(UI.lyricsContent) UI.lyricsContent.innerHTML = `<div class="lyrics-text-block" style="text-align:center; padding-bottom:50px;">${(currentPlainLyrics || "Lyrics Disabled").replace(/\n/g, "<br>")}</div>`;
        showToast("System", "Lyrics sync disabled.");
    });
}

if(UI.searchInput) {
    UI.searchInput.addEventListener('input', () => { if(document.activeElement === UI.searchInput) switchTab('results', true); });
    UI.searchInput.addEventListener('focus', () => switchTab('results', true));
    UI.searchInput.addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });
}

if(document.getElementById('startSessionBtn')) {
    document.getElementById('startSessionBtn').addEventListener('click', () => {
        hasUserInteracted = true;
        if(UI.welcomeOverlay) UI.welcomeOverlay.classList.remove('active');
        if (player && player.playVideo) player.playVideo();
    });
}

async function handleSearch() {
    const input = UI.searchInput;
    const query = input.value.trim();
    if (!query) return;

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
        detailsData.items.forEach(v => { durationMap[v.id] = parseDuration(v.contentDetails.duration); });

        const fragment = document.createDocumentFragment();
        data.items.forEach(item => {
            const vid = item.id.videoId;
            const duration = durationMap[vid] || "";
            const shortTitle = smartCleanTitle(item.snippet.title);
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <div class="thumb-container"><img src="${item.snippet.thumbnails.default.url}" class="song-thumb"><div class="song-duration-badge">${duration}</div></div>
                <div class="song-details"><h4>${shortTitle}</h4><p>${item.snippet.channelTitle}</p></div>
                <button class="emoji-trigger" style="color:#fff; border:none; background:transparent;"><i class="fa-solid fa-plus"></i></button>
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

function displayChatMessage(key, user, text, timestamp, image = null, seen = false) {
    if(!UI.chatMessages) return;
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
    if(image) { const img = document.createElement('img'); img.src = image; img.className = 'chat-message-thumb'; body.appendChild(img); }
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

function showToast(user, text) {
    if(!UI.toastContainer) return;
    const container = UI.toastContainer;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fa-solid fa-comment-dots" style="color:#ff4081; font-size:1.4rem;"></i><div class="toast-body"><h4>${user}</h4><p>${text.substring(0, 40)}${text.length>40?'...':''}</p></div>`;
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.prepend(toast);
    while (container.children.length > 3) container.removeChild(container.lastChild);
    setTimeout(() => { toast.style.opacity='0'; toast.style.transform='translateX(50px)'; setTimeout(()=> { if(toast.parentElement) toast.remove(); }, 400); }, 4000);
}

// --- SAFE EVENT LISTENERS ---
if(document.getElementById('chatSendBtn')) {
    document.getElementById('chatSendBtn').addEventListener('click', () => {
        const input = document.getElementById('chatInput');
        if(input && input.value.trim()) { 
            chatRef.push({ user: myName, text: input.value.trim(), timestamp: Date.now(), seen: false }); 
            input.value=''; 
        }
    });
}
if(document.getElementById('chatInput')) document.getElementById('chatInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('chatSendBtn').click(); });

if(document.getElementById('clearQueueBtn')) document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear the entire queue?")) queueRef.remove(); });
if(document.getElementById('shuffleQueueBtn')) document.getElementById('shuffleQueueBtn').addEventListener('click', () => {
    if (currentQueue.length < 2) { showToast("System", "Not enough songs to shuffle."); return; }
    let playingSong = null;
    let songsToShuffle = [];
    if (currentVideoId) { playingSong = currentQueue.find(s => s.videoId === currentVideoId); songsToShuffle = currentQueue.filter(s => s.videoId !== currentVideoId); } 
    else { songsToShuffle = [...currentQueue]; }
    if (songsToShuffle.length === 0) return;
    for (let i = songsToShuffle.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [songsToShuffle[i], songsToShuffle[j]] = [songsToShuffle[j], songsToShuffle[i]]; }
    const newOrderList = playingSong ? [playingSong, ...songsToShuffle] : songsToShuffle;
    updateQueueOrder(newOrderList);
    showToast("System", "Queue shuffled!");
    triggerHaptic();
});

if(document.getElementById('forceSyncBtn')) document.getElementById('forceSyncBtn').addEventListener('click', () => {
    if(UI.syncOverlay) UI.syncOverlay.classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId);
});

const infoBtn = document.getElementById('infoBtn');
if(infoBtn && UI.infoOverlay) infoBtn.addEventListener('click', () => UI.infoOverlay.classList.add('active'));

const closeInfoBtn = document.getElementById('closeInfoBtn');
if(closeInfoBtn && UI.infoOverlay) closeInfoBtn.addEventListener('click', () => UI.infoOverlay.classList.remove('active'));
