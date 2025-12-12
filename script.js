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

// --- LYRICS SYNC VARIABLES ---
let currentLyrics = null;
let lyricsInterval = null;

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 

// --- HAPTIC FEEDBACK HELPER ---
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(5); // Tiny vibration for "click" feel
    }
}

// Attach global click listener for haptics on buttons
document.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.song-item') || e.target.closest('.nav-tab') || e.target.closest('.mobile-nav-item')) {
        triggerHaptic();
    }
});

let myName = localStorage.getItem('deepSpaceUserName');
if (!myName || myName === "null") {
    myName = prompt("Enter your name (Sarthak or Reechita):");
    if(!myName) myName = "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
// Normalize Name
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

// --- PRESENCE SYSTEM ---
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

// --- YOUTUBE PLAYER ---
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin,
            'playsinline': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(100);
    setInterval(heartbeatSync, 1000);
    setInterval(monitorSyncHealth, 2000);
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
    setupMediaSession();
}

function detectAd() {
    if (!player) return false;
    try {
        const playerState = player.getPlayerState();
        const data = player.getVideoData();
        if (currentVideoId && data && data.video_id && data.video_id !== currentVideoId) return true;
    } catch(e) {}
    return false;
}

// --- MEDIA SESSION API ---
function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', function() {
            if(player && player.playVideo) { player.playVideo(); togglePlayPause(); }
        });
        navigator.mediaSession.setActionHandler('pause', function() {
            if(player && player.pauseVideo) { player.pauseVideo(); togglePlayPause(); }
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

// --- BACKGROUND PLAY HACK ---
document.addEventListener('visibilitychange', function() {
    if (document.hidden && player && player.getPlayerState) {
        setTimeout(() => {
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PAUSED && currentVideoId && !isSwitchingSong) {
                if (currentRemoteState && (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart')) {
                     player.playVideo();
                }
            }
        }, 500);
    }
});

// --- CORE SYNC LOGIC ---

function heartbeatSync() {
    // Only update button from heartbeat if user hasn't interacted recently (to avoid flicker)
    if (player && player.getPlayerState && Date.now() - lastLocalInteractionTime > 1000) {
        updatePlayPauseButton(player.getPlayerState());
    }
    
    if (isSwitchingSong) return;

    if (detectAd()) {
        broadcastState('ad_pause', 0, currentVideoId);
        updateSyncStatus();
        return;
    }

    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) initiateNextSong(); 
            else broadcastState('play', current, currentVideoId);
        }
        else if (state === YT.PlayerState.PAUSED) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
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
            player.pauseVideo();
        }
        return; 
    }
    
    if (currentRemoteState.action === 'switching_pause') return;

    const myState = player.getPlayerState();
    
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        let needsFix = false;
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (detectAd()) return; 
            player.playVideo(); needsFix = true;
        }
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3.0) {
            if (!detectAd()) { player.seekTo(currentRemoteState.time, true); needsFix = true; }
        }
        if (needsFix) suppressBroadcast(3000); 
    }
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             player.pauseVideo();
             suppressBroadcast(1000);
         }
    }
}

function updatePlayPauseButton(state) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    
    // Don't overwrite spinning state
    if (isSwitchingSong) return;

    if (state === YT.PlayerState.PLAYING) {
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
    // Only update button if not recently interacted locally
    if(Date.now() - lastLocalInteractionTime > 500) {
        updatePlayPauseButton(state);
    }

    if (isSwitchingSong || ignoreSystemEvents) return;

    if (detectAd()) {
        lastBroadcaster = myName;
        broadcastState('ad_pause', 0, currentVideoId);
        updateSyncStatus();
        return;
    }

    if (state === YT.PlayerState.PLAYING) {
        if(player && player.setVolume) player.setVolume(100);
        if (Date.now() - lastLocalInteractionTime > 500) {
             lastBroadcaster = myName; 
             broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.PAUSED) {
        if (Date.now() - lastLocalInteractionTime > 500) {
             lastBroadcaster = myName; 
             broadcastState('pause', player.getCurrentTime(), currentVideoId);
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

    // --- OPTIMISTIC UI UPDATE ---
    // Change icon immediately before player responds
    if (state === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>'; // Turn to Play icon immediately
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>'; // Turn to Pause icon immediately
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
    lastBroadcaster = myName;

    if (player && player.pauseVideo) player.pauseVideo();
    
    showToast("System", "Switching track...");
    // Optimistic loading state
    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    syncRef.set({ 
        action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: Date.now() 
    });

    setTimeout(() => {
        loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
        updateMediaSessionMetadata(songObj.title, songObj.uploader, songObj.thumbnail);
        isSwitchingSong = false;
    }, 500); 
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
        displayChatMessage(msg.user, msg.text, msg.timestamp, msg.image);
        if (msg.user !== myName && activeTab !== 'chat') showToast(msg.user, msg.text);
    });
}
loadInitialData();

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
        player.pauseVideo();
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
            player.setVolume(100);
            player.playVideo();
        }
    } 
    else {
        const playerState = player.getPlayerState();
        if (state.action === 'restart') {
            player.seekTo(0, true); 
            player.setVolume(100);
            player.playVideo();
        }
        else if (state.action === 'play') {
            if (Math.abs(player.getCurrentTime() - state.time) > 3.0) player.seekTo(state.time, true);
            if (playerState !== YT.PlayerState.PLAYING) {
                player.setVolume(100);
                player.playVideo();
            }
        }
        else if (state.action === 'pause') {
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
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
        msgEl.innerHTML = `<i class="fa-solid fa-music"></i> ${currentRemoteState.lastUpdater} picking song...`;
        msgEl.className = 'sync-status-3d status-switching';
        if(eq) eq.classList.remove('active');
        return;
    }

    const playerState = player ? player.getPlayerState() : -1;

    if (playerState === YT.PlayerState.PLAYING) {
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
             if(Math.abs(player.getCurrentTime() - startTime) > 3.0) player.seekTo(startTime, true);
             if(shouldPlay) {
                 player.setVolume(100);
                 player.playVideo();
             }
        }
        
        if(!shouldPlay) {
            setTimeout(() => player.pauseVideo(), 500);
        }

        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        let artwork = 'https://via.placeholder.com/512';
        const currentSong = currentQueue.find(s => s.videoId === videoId);
        if(currentSong && currentSong.thumbnail) artwork = currentSong.thumbnail;
        updateMediaSessionMetadata(title, uploader, artwork);

        renderQueue(currentQueue, currentVideoId);
        
        if (shouldBroadcast) {
            lastBroadcaster = myName;
            broadcastState('restart', 0, videoId, true); 
        }
    }
}

// --- MODIFIED TAB SWITCHING WITH TOGGLE LOGIC ---
function switchTab(tabName) {
    if(window.innerWidth <= 1100) {
        const sheet = document.getElementById('mobileSheet');
        const sheetTitle = document.getElementById('mobile-sheet-title');
        
        if (activeTab === tabName && sheet.classList.contains('active')) {
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

document.getElementById('mobileSheetClose').addEventListener('click', () => {
    document.getElementById('mobileSheet').classList.remove('active');
    document.querySelectorAll('.mobile-nav-item').forEach(btn => btn.classList.remove('active'));
});

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            switchTab('queue');
            // SEND SYSTEM MESSAGE WITH THUMBNAIL
            chatRef.push({ 
                user: "System", 
                text: `Added <b>${title}</b> to the queue.`, 
                image: thumbnail,
                timestamp: Date.now() 
            });
            if (!currentVideoId && currentQueue.length === 0) initiateSongLoad({videoId, title, uploader});
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
    queueRef.update(updates).then(() => {
        switchTab('queue');
        // SEND SYSTEM MESSAGE FOR BATCH (Use 1st song thumb)
        if(songs.length > 0) {
            chatRef.push({ 
                user: "System", 
                text: `Added <b>${songs.length}</b> songs from a playlist.`, 
                image: songs[0].thumbnail,
                timestamp: Date.now() 
            });
        }
    });
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
    const list = document.getElementById('queue-list');
    const badge = document.getElementById('queue-badge');
    const mobileBadge = document.getElementById('mobile-queue-badge');
    
    list.innerHTML = '';
    badge.textContent = queueArray.length;
    if(mobileBadge) mobileBadge.textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Queue is empty.</p></div>';
        return;
    }

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
        list.appendChild(item);
    });

    initDragAndDrop(list);
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
    stopLyricsSync(); // STOP SYNC TO SAVE PERF
});

// --- SMART TITLE CLEANER (AI-MIMIC) ---
function smartCleanTitle(title) {
    let processed = title.replace(/\s*[\(\[].*?[\)\]]/g, '');
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

// --- SYNCED LYRICS LOGIC ---

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
    
    // Find active line based on current time
    let activeIndex = -1;
    for(let i = 0; i < currentLyrics.length; i++) {
        if(currentLyrics[i].time <= time) {
            activeIndex = i;
        } else {
            break;
        }
    }
    
    if(activeIndex !== -1) {
        // Reset previous active lines
        const allLines = document.querySelectorAll('.lyrics-line');
        allLines.forEach(l => l.classList.remove('active'));
        
        const activeLine = document.getElementById('lyric-line-' + activeIndex);
        if(activeLine) {
            activeLine.classList.add('active');
            activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

async function fetchLyrics() {
    const titleEl = document.getElementById('current-song-title');
    const lyricsContentArea = document.getElementById('lyrics-content-area');
    const lyricsTitle = document.getElementById('lyrics-title');
    
    let rawTitle = "Heart's Rhythm";
    if(titleEl && titleEl.textContent !== "Heart's Rhythm") {
        rawTitle = titleEl.textContent;
    }
    
    const cleanTitle = smartCleanTitle(rawTitle);
    const searchWords = cleanTitle.split(/\s+/).slice(0, 8).join(" ");

    lyricsTitle.textContent = "Lyrics: " + cleanTitle;
    lyricsContentArea.innerHTML = '<div style="margin-top:20px; width:40px; height:40px; border:4px solid rgba(245,0,87,0.2); border-top:4px solid #f50057; border-radius:50%; animation: spin 1s infinite linear;"></div>';

    try {
        const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchWords)}`;
        const res = await fetch(searchUrl);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            // Prefer synced lyrics
            const song = data.find(s => s.syncedLyrics) || data[0];
            
            if (song.syncedLyrics) {
                // FOUND SYNCED LYRICS!
                currentLyrics = parseSyncedLyrics(song.syncedLyrics);
                renderSyncedLyrics(currentLyrics);
                startLyricsSync();
            } else {
                // Fallback to plain text
                currentLyrics = null;
                stopLyricsSync();
                const text = song.plainLyrics || "Instrumental";
                lyricsContentArea.innerHTML = `<div class="lyrics-text-block" style="text-align:center;">${text.replace(/\n/g, "<br>")}</div>`;
            }
        } else {
            throw new Error("No lyrics found");
        }
    } catch (e) {
        stopLyricsSync();
        lyricsContentArea.innerHTML = `
            <p>Lyrics could not be loaded automatically.</p>
            <p style="font-size:0.9rem; color:#aaa;">Searched for: "${cleanTitle}"</p>
            <a href="https://www.google.com/search?q=${encodeURIComponent(cleanTitle + ' lyrics')}" target="_blank" class="google-lyrics-btn">
               <i class="fa-brands fa-google"></i> Search on Google
            </a>
        `;
    }
}

document.getElementById('searchInput').addEventListener('input', (e) => {
    switchTab('results'); 
});
document.getElementById('searchInput').addEventListener('focus', (e) => {
    switchTab('results');
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

    // --- ENHANCED PLAYLIST DETECTION ---
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
    
    // Check for YouTube Music links which are video links in disguise
    if (query.includes('music.youtube.com') || query.includes('youtube.com/watch')) {
        const vidMatch = query.match(/[?&]v=([^#\&\?]+)/);
        if(vidMatch) {
             // Treat as a direct ID search logic if needed, 
             // but standard search API handles this okay usually. 
             // We can strip the ID and search, OR just let the API find it.
             // Let's pass it to search to find metadata.
        }
    }

    switchTab('results');
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
            
            // --- CLEAN TITLE FOR DISPLAY & ADDING ---
            const rawTitle = item.snippet.title;
            const shortTitle = smartCleanTitle(rawTitle); // Use the cleaner!

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
            // Add SHORT title to queue
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
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    }
    return `${m}:${s.toString().padStart(2,'0')}`;
}

async function fetchPlaylist(playlistId, pageToken = '', allSongs = []) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const songs = data.items.filter(i=>i.snippet.resourceId.kind==='youtube#video').map(i => ({
            videoId: i.snippet.resourceId.videoId,
            // Clean titles in playlists too? Maybe safer to keep original here for identification, 
            // but let's clean them for consistency with user request
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
            // Limit to 20 to avoid rate limits on big playlists
            for (const t of data.tracks.slice(0, 20)) { 
                const query = t.artist + ' ' + t.title;
                const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`);
                const sData = await sRes.json();
                if(sData.items.length) {
                    const i = sData.items[0];
                    songs.push({ 
                        videoId: i.id.videoId, 
                        title: smartCleanTitle(i.snippet.title), // Clean title
                        uploader: i.snippet.channelTitle, 
                        thumbnail: i.snippet.thumbnails.default.url 
                    });
                }
            }
            addBatchToQueue(songs);
        }
    } catch(e) { console.error(e); }
}

function displayChatMessage(user, text, timestamp, image = null) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    let content = `<div class="msg-header">${user} <span style="font-size:0.85em;">${time}</span></div>${text}`;
    
    // --- IMAGE SUPPORT ---
    if(image) {
        content += `<img src="${image}" class="chat-message-thumb" alt="Song thumbnail">`;
    }

    div.innerHTML = content;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function showToast(user, text) {
    const container = document.getElementById('toast-container');
    
    // LIMIT TOASTS TO 3
    if (container.children.length >= 3) {
        container.removeChild(container.firstChild);
    }

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
    container.appendChild(toast);
    
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
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }
});
document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') document.getElementById('chatSendBtn').click();
});

document.getElementById('nativeEmojiBtn').addEventListener('click', () => {
    document.getElementById('chatInput').focus();
});

document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear the entire queue?")) queueRef.remove(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId);
});
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));
