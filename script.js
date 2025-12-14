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

let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 

// --- PLAYBACK FLAGS ---
let userIntentionallyPaused = false; 
let bufferingTimeout = null; 
let wasInAd = false; 

// --- LYRICS SYNC VARIABLES ---
let currentLyrics = null;
let lyricsInterval = null;

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 
let syncHealthInterval = null;

// --- HAPTIC FEEDBACK HELPER ---
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(60); 
    }
}

document.addEventListener('click', (e) => {
    if (e.target.closest('button') || 
        e.target.closest('.song-item') || 
        e.target.closest('.nav-tab') || 
        e.target.closest('.mobile-nav-item') ||
        e.target.closest('input') ||
        e.target.closest('.search-submit')) {
        triggerHaptic();
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

function suppressBroadcast(duration = 1000) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
        ignoreSystemEvents = false;
    }, duration);
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

// --- YOUTUBE PLAYER ---
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
    setInterval(heartbeatSync, 1000);
    
    // Check sync health frequently
    if(syncHealthInterval) clearInterval(syncHealthInterval);
    syncHealthInterval = setInterval(monitorSyncHealth, 2000);
    
    // Ad Check Throttled to 1000ms for Battery Saving
    setInterval(monitorAdStatus, 1000);

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
    // 150 = restricted embed, 100 = deleted
    if(event.data === 100 || event.data === 101 || event.data === 150) {
        errorMsg = "Song blocked by owner. Skipping...";
    }
    
    showToast("System", errorMsg);
    updateSyncStatus(); 

    // Fast fail - skip immediately
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

        // 1. ID Mismatch: The most reliable check
        if (currentVideoId && data.video_id && data.video_id !== currentVideoId) {
            return true;
        }

        // 2. Metadata Check: Ads often have weird metadata
        if (data.author === "" && player.getPlayerState() === YT.PlayerState.PLAYING) {
            // Be careful with this, but it's a signal
        }
        
        // 3. Title Keyword Check (Backup)
        if (data.title && (data.title === "Advertisement" || data.title.toLowerCase().startsWith("ad "))) {
            return true;
        }

    } catch(e) {}
    return false;
}

// --- AD MONITOR LOOP ---
function monitorAdStatus() {
    if (!player || !currentVideoId) return;

    const isAd = detectAd();
    
    if (isAd) {
        if (!wasInAd) {
            console.log("Ad Detected! Pausing partner...");
            wasInAd = true;
            lastBroadcaster = myName; // Take control
            broadcastState('ad_pause', 0, currentVideoId, true); // Force broadcast
            updateSyncStatus();
        }
    } else {
        if (wasInAd) {
            console.log("Ad Ended! Resuming sync...");
            wasInAd = false;
            
            // Ad finished transition
            // 1. Force local play if stopped
            if(player.getPlayerState() !== YT.PlayerState.PLAYING) {
                player.playVideo();
            }

            // 2. Tell partner to wake up
            setTimeout(() => {
                 lastBroadcaster = myName;
                 broadcastState('play', player.getCurrentTime(), currentVideoId, true);
            }, 500);
        }
    }
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', function() {
            if(player && player.playVideo) { 
                userIntentionallyPaused = false;
                player.playVideo(); 
                togglePlayPause(); 
            }
        });
        navigator.mediaSession.setActionHandler('pause', function() {
            if(player && player.pauseVideo) { 
                userIntentionallyPaused = true;
                player.pauseVideo(); 
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

// --- AGGRESSIVE BACKGROUND KEEP-ALIVE ---
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        if (player && player.getPlayerState) {
            const state = player.getPlayerState();
            // If playing or buffering, we assume user wants to continue
            if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                userIntentionallyPaused = false; 
            }
            
            // Immediate check: If paused and NOT intentional, Resume.
            if (state === YT.PlayerState.PAUSED && !userIntentionallyPaused && !detectAd()) {
                console.log("Visibility changed to hidden. Resuming...");
                player.playVideo();
            }
        }
    } else {
        // Foreground refresh
        if(currentVideoId) {
             const song = currentQueue.find(s => s.videoId === currentVideoId);
             if(song) updateMediaSessionMetadata(song.title, song.uploader, song.thumbnail);
        }
    }
});

// Safety Interval
setInterval(() => {
    if (document.hidden && player && player.getPlayerState) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PAUSED && !userIntentionallyPaused && !detectAd()) {
            console.log("Background Keep-Alive: Resuming video.");
            player.playVideo();
        }
    }
}, 2000);

// --- CORE SYNC LOGIC ---

function heartbeatSync() {
    if (player && player.getPlayerState && Date.now() - lastLocalInteractionTime > 1000) {
        updatePlayPauseButton(player.getPlayerState());
    }
    
    if (isSwitchingSong) return;

    // Redundant check handled by monitorAdStatus, but good for suppressing normal heartbeats
    if (detectAd()) {
        if (lastBroadcaster === myName) {
             updateSyncStatus();
        }
        return;
    }

    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            userIntentionallyPaused = false; 
            
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            // Auto-next if near end
            if (duration > 0 && duration - current < 1) initiateNextSong(); 
            else broadcastState('play', current, currentVideoId);
        }
        else if (state === YT.PlayerState.PAUSED) {
            // Only broadcast pause if USER intended it
            if(userIntentionallyPaused) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId);
            }
        }
    }
}

function monitorSyncHealth() {
    if (!hasUserInteracted) return;
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;
    if (Date.now() - lastLocalInteractionTime < 2000) return;

    if (currentRemoteState.action === 'ad_pause') {
        // Partner has ad. I must pause.
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            console.log("Partner has ad. Pausing...");
            player.pauseVideo();
        }
        updateSyncStatus(); // Ensure UI reflects ad status
        return; 
    }
    
    if (currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 4000) {
            updateSyncStatus(); 
        }
        return;
    }

    const myState = player.getPlayerState();
    
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        let needsFix = false;
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (detectAd()) return; // Don't interrupt my ad
            
            userIntentionallyPaused = false;
            player.playVideo(); 
            needsFix = true;
        }
        
        if (myState === YT.PlayerState.BUFFERING) return;

        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 4.0) {
            if (!detectAd()) { 
                player.seekTo(currentRemoteState.time, true); 
                needsFix = true; 
            }
        }
        if (needsFix) suppressBroadcast(3000); 
    }
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             userIntentionallyPaused = true;
             player.pauseVideo();
             suppressBroadcast(1000);
         }
    }
}

function updatePlayPauseButton(state) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    
    if (isSwitchingSong) return;

    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        if(navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
    }
    else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if(navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
    }
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
        player.playVideo();
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
    const btn = document.getElementById('play-pause-btn');

    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>'; 
        userIntentionallyPaused = true; 
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>'; 
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
    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    syncRef.set({ 
        action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: Date.now() 
    });

    setTimeout(() => {
        if (isSwitchingSong) {
            isSwitchingSong = false;
            if(player) player.playVideo();
        }
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
        renderQueue(currentQueue, currentVideoId);
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
        if (msg.user !== myName && isChatActive() && !msg.seen) {
             chatRef.child(key).update({ seen: true });
        }
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
             tickEl.className = msg.seen ? 'tick-status seen' : 'tick-status';
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
    const desktopBadge = document.getElementById('chat-badge');
    const mobileBadge = document.getElementById('mobile-chat-badge');
    
    if (count > 0) {
        if(desktopBadge) {
            desktopBadge.textContent = count;
            desktopBadge.style.display = 'inline-block';
        }
        if(mobileBadge) {
            mobileBadge.textContent = count;
            mobileBadge.style.display = 'block';
        }
    } else {
        if(desktopBadge) desktopBadge.style.display = 'none';
        if(mobileBadge) mobileBadge.style.display = 'none';
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
    const sheet = document.getElementById('mobileSheet');
    if (isMobile) return activeTab === 'chat' && sheet.classList.contains('active');
    return activeTab === 'chat';
}

function forceChatScroll() {
    const box = document.getElementById('chat-messages');
    if(box) {
        box.scrollTop = box.scrollHeight;
        requestAnimationFrame(() => {
            box.scrollTop = box.scrollHeight;
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
            player.pauseVideo();
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
    
    document.getElementById('syncOverlay').classList.remove('active');

    if (state.action === 'switching_pause') {
        if (Date.now() - (state.timestamp || 0) > 4000) {
            return;
        }
        showToast("System", "Partner is changing track...");
        document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        updateSyncStatus();
        return;
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
            player.seekTo(0, true); 
            userIntentionallyPaused = false;
            player.setVolume(100);
            player.playVideo();
        }
        else if (state.action === 'play') {
            if (Math.abs(player.getCurrentTime() - state.time) > 4.0) player.seekTo(state.time, true);
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
    const msgEl = document.getElementById('sync-status-msg');
    const eq = document.getElementById('equalizer');
    
    msgEl.classList.remove('pop-anim');
    void msgEl.offsetWidth; 
    msgEl.classList.add('pop-anim');

    // Use internal check or remote state
    if (detectAd()) {
        msgEl.innerHTML = '<i class="fa-solid fa-rectangle-ad"></i> Ad Playing';
        msgEl.className = 'sync-status-3d status-ad';
        if(eq) eq.classList.remove('active');
        return;
    }

    if (isSwitchingSong) {
        msgEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching...';
        msgEl.className = 'sync-status-3d status-switching';
        if(eq) eq.classList.remove('active');
        return;
    }

    if (currentRemoteState && currentRemoteState.action === 'ad_pause') {
        msgEl.innerHTML = `<i class="fa-solid fa-eye-slash"></i> ${currentRemoteState.lastUpdater} having Ad...`;
        msgEl.className = 'sync-status-3d status-ad-remote';
        if(eq) eq.classList.remove('active');
        return;
    }

    if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        if (Date.now() - (currentRemoteState.timestamp || 0) > 4000) {
            msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> Ready`;
            msgEl.className = 'sync-status-3d status-paused';
            return;
        }
        msgEl.innerHTML = `<i class="fa-solid fa-music"></i> ${currentRemoteState.lastUpdater} picking song...`;
        msgEl.className = 'sync-status-3d status-switching';
        if(eq) eq.classList.remove('active');
        return;
    }

    const playerState = player ? player.getPlayerState() : -1;

    if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
        msgEl.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Vibing Together`;
        msgEl.className = 'sync-status-3d status-playing';
        if(eq) eq.classList.add('active');
    } 
    else {
        if(eq) eq.classList.remove('active');
        let pauser = lastBroadcaster;
        if (currentRemoteState && currentRemoteState.action === 'pause') {
            pauser = currentRemoteState.lastUpdater;
        }
        const nameDisplay = (pauser === myName) ? "You" : pauser;
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${nameDisplay}`;
        msgEl.className = 'sync-status-3d status-paused';
    }
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true, shouldPlay = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(3000); 

        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
            player.setVolume(100); 
        } else {
             if(Math.abs(player.getCurrentTime() - startTime) > 4.0) player.seekTo(startTime, true);
             if(shouldPlay) {
                 player.setVolume(100);
                 player.playVideo();
             }
        }
        
        if(!shouldPlay) {
            setTimeout(() => player.pauseVideo(), 500);
        }

        currentVideoId = videoId;
        const decodedTitle = decodeHTMLEntities(title);
        document.getElementById('current-song-title').textContent = decodedTitle;
        
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

// --- MODIFIED TAB SWITCHING ---
function switchTab(tabName, forceOpen = false) {
    if(window.innerWidth <= 1100) {
        const sheet = document.getElementById('mobileSheet');
        const sheetTitle = document.getElementById('mobile-sheet-title');
        
        if (!forceOpen && activeTab === tabName && sheet.classList.contains('active')) {
             sheet.classList.remove('active');
             document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
             return; 
        }

        if(tabName === 'queue') sheetTitle.textContent = "Queue";
        else if(tabName === 'results') sheetTitle.textContent = "Search Music";
        else if(tabName === 'chat') sheetTitle.textContent = "Chat";
        
        sheet.classList.add('active');
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
    document.getElementById('mobileSheet').classList.remove('active');
}

document.getElementById('mobileSheetClose').addEventListener('click', () => {
    document.getElementById('mobileSheet').classList.remove('active');
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
});

// Queue helper functions
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
        const sheet = document.getElementById('mobileSheet');
        if (!sheet || !sheet.classList.contains('active')) return;
    }

    setTimeout(() => {
        const activeItem = document.querySelector('.song-item.playing');
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 100);
}

function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    const badge = document.getElementById('queue-badge');
    const mobileBadge = document.getElementById('mobile-queue-badge');
    
    badge.textContent = queueArray.length;
    if(mobileBadge) mobileBadge.textContent = queueArray.length;

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

document.getElementById('lyrics-btn').addEventListener('click', () => {
    document.getElementById('lyricsOverlay').classList.add('active');
    fetchLyrics();
});
document.getElementById('closeLyricsBtn').addEventListener('click', () => {
    document.getElementById('lyricsOverlay').classList.remove('active');
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

// --- SYNCED LYRICS ---
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
    const container = document.getElementById('lyrics-content-area');
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'synced-lyrics-wrapper';
    
    lyrics.forEach((line, index) => {
        const p = document.createElement('p');
        p.className = 'lyrics-line';
        p.id = 'lyric-line-' + index;
        p.textContent = line.text;
        wrapper.appendChild(p);
    });
    container.appendChild(wrapper);
}

function startLyricsSync() {
    if(lyricsInterval) clearInterval(lyricsInterval);
    lyricsInterval = setInterval(syncLyricsDisplay, 300); 
}

function stopLyricsSync() {
    if(lyricsInterval) clearInterval(lyricsInterval);
}

function syncLyricsDisplay() {
    if(!player || !player.getCurrentTime || !currentLyrics) return;
    const time = player.getCurrentTime();
    
    let activeIndex = -1;
    for(let i = 0; i < currentLyrics.length; i++) {
        if(currentLyrics[i].time <= time) {
            activeIndex = i;
        } else {
            break;
        }
    }
    
    if(activeIndex !== -1) {
        const allLines = document.querySelectorAll('.lyrics-line');
        allLines.forEach(l => l.classList.remove('active'));
        
        const activeLine = document.getElementById('lyric-line-' + activeIndex);
        if(activeLine) {
            activeLine.classList.add('active');
            activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

async function fetchLyrics(manualQuery = null) {
    const lyricsContentArea = document.getElementById('lyrics-content-area');
    const lyricsTitle = document.getElementById('lyrics-title');
    const searchBar = document.getElementById('lyricsSearchBar');
    
    let searchWords = "";
    searchBar.classList.remove('visible');
    searchBar.style.display = 'none'; 
    
    if(manualQuery) {
        searchWords = manualQuery;
        lyricsTitle.textContent = "Search: " + manualQuery;
    } else {
        const titleEl = document.getElementById('current-song-title');
        let rawTitle = "Heart's Rhythm";
        if(titleEl && titleEl.textContent !== "Heart's Rhythm") {
            rawTitle = titleEl.textContent;
        }
        const cleanTitle = smartCleanTitle(rawTitle);
        searchWords = cleanTitle.split(/\s+/).slice(0, 5).join(" ");
        lyricsTitle.textContent = "Lyrics: " + cleanTitle;
    }

    lyricsContentArea.innerHTML = '<div style="margin-top:20px; width:40px; height:40px; border:4px solid rgba(245,0,87,0.2); border-top:4px solid #f50057; border-radius:50%; animation: spin 1s infinite linear;"></div>';

    try {
        const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchWords)}`;
        const res = await fetch(searchUrl);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const song = data.find(s => s.syncedLyrics) || data[0];
            
            if (song.syncedLyrics) {
                currentLyrics = parseSyncedLyrics(song.syncedLyrics);
                renderSyncedLyrics(currentLyrics);
                startLyricsSync();
            } else {
                currentLyrics = null;
                stopLyricsSync();
                const text = song.plainLyrics || "Instrumental";
                lyricsContentArea.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${text.replace(/\n/g, "<br>")}</div>`;
            }
            searchBar.classList.remove('visible');
            setTimeout(() => { if(!searchBar.classList.contains('visible')) searchBar.style.display = 'none'; }, 500);

        } else {
            throw new Error("No lyrics found");
        }
    } catch (e) {
        if(!manualQuery) {
            try {
                const titleText = document.getElementById('current-song-title').textContent;
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
                        lyricsContentArea.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${fData.lyrics.replace(/\n/g, "<br>")}</div>`;
                        return; 
                   }
                   fallbackUrl = `https://api.lyrics.ovh/v1/${encodeURIComponent(p2)}/${encodeURIComponent(p1)}`;
                   fRes = await fetch(fallbackUrl);
                   fData = await fRes.json();
                   if(fData.lyrics) {
                        currentLyrics = null;
                        stopLyricsSync();
                        lyricsContentArea.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${fData.lyrics.replace(/\n/g, "<br>")}</div>`;
                        return;
                   }
                }
            } catch(err) { console.log("Fallback lyrics failed"); }
        }
        stopLyricsSync();
        searchBar.style.display = 'block';
        setTimeout(() => searchBar.classList.add('visible'), 10);
        
        lyricsContentArea.innerHTML = `
            <p style="opacity:0.7; margin-bottom: 5px;">Lyrics not found via API.</p>
            <p style="font-size:0.9rem; color:#aaa; margin-bottom:20px;">Use the search bar above to try manually.</p>
        `;
    }
}

document.getElementById('searchInput').addEventListener('input', (e) => {
    if(document.activeElement === document.getElementById('searchInput')) {
        switchTab('results', true); 
    }
});
document.getElementById('searchInput').addEventListener('focus', (e) => {
    switchTab('results', true);
});

document.getElementById('startSessionBtn').addEventListener('click', () => {
    hasUserInteracted = true;
    document.getElementById('welcomeOverlay').classList.remove('active');
    
    if (player && player.playVideo) player.playVideo();
    
    if(currentVideoId) {
        const currentSong = currentQueue.find(s => s.videoId === currentVideoId);
        if(currentSong) {
             updateMediaSessionMetadata(currentSong.title, currentSong.uploader, currentSong.thumbnail);
        }
    }
});

async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    const ytPlaylistMatch = query.match(/[?&]list=([^#\&\?]+)/);
    if (ytPlaylistMatch) {
        showToast("System", "Fetching YouTube Playlist..."); 
        fetchPlaylist(ytPlaylistMatch[1]);
        input.value = ''; return;
    }
    
    if (query.includes('spotify.com')) {
        showToast("System", "Fetching Spotify Data..."); 
        fetchSpotifyData(query);
        input.value = ''; return;
    }
    
    switchTab('results', true);
    document.getElementById('results-list').innerHTML = '<p style="text-align:center; padding:30px; color:white;">Searching...</p>';
    
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(searchUrl);
        const data = await res.json();
        const list = document.getElementById('results-list');
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

        data.items.forEach(item => {
            const vid = item.id.videoId;
            const duration = durationMap[vid] || "";
            const rawTitle = item.snippet.title;
            const shortTitle = smartCleanTitle(rawTitle);

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
                <button class="emoji-trigger" style="color:#fff; font-size:1.1rem; position:static; width:auto; height:auto; border:none; background:transparent;"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(vid, shortTitle, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
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

async function fetchSpotifyData(link) {
    const proxy = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;
    try {
        const res = await fetch(proxy);
        const data = await res.json();
        if(data.tracks) {
            const songs = [];
            for (const t of data.tracks.slice(0, 20)) { 
                const query = t.artist + ' ' + t.title;
                const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`);
                const sData = await sRes.json();
                if(sData.items.length) {
                    const i = sData.items[0];
                    songs.push({ 
                        videoId: i.id.videoId, 
                        title: smartCleanTitle(i.snippet.title), 
                        uploader: i.snippet.channelTitle, 
                        thumbnail: i.snippet.thumbnails.default.url 
                    });
                }
            }
            addBatchToQueue(songs);
        }
    } catch(e) { console.error(e); }
}

function displayChatMessage(key, user, text, timestamp, image = null, seen = false) {
    const box = document.getElementById('chat-messages');
    
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const header = document.createElement('div');
    header.className = 'msg-header';
    
    const infoSpan = document.createElement('span');
    infoSpan.style.display = 'flex';
    infoSpan.style.alignItems = 'center';
    
    const userSpan = document.createElement('strong');
    userSpan.textContent = user + " ";
    const timeSpan = document.createElement('span');
    timeSpan.style.fontSize = "0.85em";
    timeSpan.style.fontWeight = "400";
    timeSpan.style.marginLeft = "5px";
    timeSpan.textContent = time;
    
    infoSpan.appendChild(userSpan);
    infoSpan.appendChild(timeSpan);
    
    header.appendChild(infoSpan);
    
    if (isMe) {
        const tickSpan = document.createElement('span');
        tickSpan.id = `tick-${key}`;
        tickSpan.className = seen ? 'tick-status seen' : 'tick-status';
        tickSpan.innerHTML = seen ? '<i class="fa-solid fa-check-double"></i>' : '<i class="fa-solid fa-check"></i>';
        header.appendChild(tickSpan);
    }

    const body = document.createElement('div');
    body.className = 'msg-text-content';
    body.textContent = text; 
    
    div.appendChild(header);
    div.appendChild(body);
    
    if(image) {
        const img = document.createElement('img');
        img.src = image;
        img.className = 'chat-message-thumb';
        div.appendChild(img);
    }

    box.appendChild(div);
    if(isChatActive()) {
        forceChatScroll();
    }
}

function showToast(user, text) {
    const container = document.getElementById('toast-container');
    
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

    while (container.children.length > 3) {
        container.removeChild(container.lastChild);
    }
    
    setTimeout(() => { 
        toast.style.opacity='0'; 
        toast.style.transform='translateX(50px)';
        setTimeout(()=> {
            if(toast.parentElement) toast.remove();
        }, 400); 
    }, 4000);
}

document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', initiatePrevSong);
document.getElementById('next-btn').addEventListener('click', initiateNextSong);

document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

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
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId);
});
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));
