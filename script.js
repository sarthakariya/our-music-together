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

let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; // Prevents interactions during the 2.1s wait

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;

let myName = localStorage.getItem('deepSpaceUserName');
if (!myName) {
    myName = prompt("Enter your name (Sarthak or Reechita):") || "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

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
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(85);
    
    // 1. Broadcaster Loop (Send my state)
    setInterval(heartbeatSync, 1000);
    
    // 2. Receiver Loop (Aggressive Fixer)
    setInterval(monitorSyncHealth, 3000);
    
    // Initial Load
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
}

// --- AD DETECTION LOGIC ---
function detectAd() {
    // Safety checks
    if (!player || typeof player.getVideoData !== 'function' || !currentVideoId) return false;
    
    try {
        const data = player.getVideoData();
        // If the player reports a Video ID that is DIFFERENT from our current global ID, it's an Ad.
        if (data && data.video_id && data.video_id !== currentVideoId) {
            // Only count as Ad if we are actually playing or buffering
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                console.log("Ad Detected: Mismatch", data.video_id, currentVideoId);
                return true;
            }
        }
    } catch (e) {
        console.warn("Ad detect error", e);
    }
    return false;
}

// --- CORE SYNC LOGIC ---

// SENDER: Tell DB what I am doing
function heartbeatSync() {
    // Force UI Update to fix "Spirit of the Button" issues (Ad transition drift)
    if (player && player.getPlayerState) {
        updatePlayPauseButton(player.getPlayerState());
    }

    if (isSwitchingSong) return;

    // Check for Ad first
    if (lastBroadcaster === myName && detectAd()) {
        broadcastState('ad_pause', 0, currentVideoId);
        return;
    }

    // Only broadcast if I am playing AND I am the intended broadcaster
    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            // Check for end of song (auto-next)
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) {
                initiateNextSong(); // This will trigger the 2.1s wait
            } else {
                // Normal Playing Broadcast
                broadcastState('play', current, currentVideoId);
            }
        }
    }
}

// RECEIVER: Automatic Fixer
function monitorSyncHealth() {
    // If I am the broadcaster or currently switching, I don't need to fix myself against the DB
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;

    // If partner is watching ad, do nothing (we should be paused)
    if (currentRemoteState.action === 'ad_pause') return;
    if (currentRemoteState.action === 'switching_pause') return; // Don't fight the switch

    const myState = player.getPlayerState();
    
    // If DB says PLAYING
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        
        let needsFix = false;
        
        // Fix State: If I am NOT playing, force play
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (detectAd()) return; // Local Ad Check

            console.log("⚠️ Sync Monitor: Force Resuming...");
            player.playVideo();
            needsFix = true;
        }
        
        // Fix Time Drift (> 3 seconds)
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3) {
            if (!detectAd()) { 
                player.seekTo(currentRemoteState.time, true);
                needsFix = true;
            }
        }

        if (needsFix) suppressBroadcast(1500); 
    }
    // If DB says PAUSED
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             console.log("⚠️ Sync Monitor: Force Pausing...");
             player.pauseVideo();
             needsFix = true;
             if (needsFix) suppressBroadcast(1500);
         }
    }
}

function updatePlayPauseButton(state) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    
    // Visual logic matching standard media players
    if (state === YT.PlayerState.PLAYING) {
        // If playing, button should show Pause icon
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED || state === YT.PlayerState.ENDED) {
        // If paused/stopped, button should show Play icon
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    } else if (state === YT.PlayerState.BUFFERING) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
}

function onPlayerStateChange(event) {
    const state = event.data;

    // 1. ALWAYS update UI immediately. This fixes the "Spirit of the button" issue.
    // We do this before any checks so the local user always sees reality.
    updatePlayPauseButton(state);

    if (isSwitchingSong) return;

    // 2. If we are programmatically changing state (syncing), do not broadcast
    if (ignoreSystemEvents) {
        return;
    }

    // 3. Ad Detection
    if (state === YT.PlayerState.PLAYING && detectAd()) {
        lastBroadcaster = myName;
        broadcastState('ad_pause', 0, currentVideoId);
        updateSyncStatus();
        return;
    }

    // 4. User Interaction Broadcasting
    // If we are NOT ignoring events, we assume the user clicked something.
    // We claim control and broadcast.
    if (state === YT.PlayerState.PLAYING) {
        lastBroadcaster = myName; 
        broadcastState('play', player.getCurrentTime(), currentVideoId);
    } 
    else if (state === YT.PlayerState.PAUSED) {
        lastBroadcaster = myName; 
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    }
    else if (state === YT.PlayerState.ENDED) {
        initiateNextSong();
    }
    
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || isSwitchingSong) return;
    const state = player.getPlayerState();
    
    lastBroadcaster = myName; 
    
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        // Optimistic UI update
        document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-play"></i>';
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            initiateSongLoad(currentQueue[0]);
        } else if (currentVideoId) {
            player.playVideo();
            // Optimistic UI update
            document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-pause"></i>';
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
}

// --- GRACEFUL SONG SWITCHING LOGIC (2.1s Delay) ---

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

    // 1. Lock functionality
    isSwitchingSong = true;
    lastBroadcaster = myName;

    // 2. Pause Local Player
    if (player && player.pauseVideo) player.pauseVideo();
    
    // 3. UI Feedback
    showToast("System", "Switching track in 2.1s...");
    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    // 4. Broadcast special 'switching_pause' to partner
    // This tells them to pause and wait, not to fight back with 'monitorSyncHealth'
    syncRef.set({ 
        action: 'switching_pause', 
        time: 0, 
        videoId: currentVideoId, // Keep old ID for now
        lastUpdater: myName, 
        timestamp: Date.now() 
    });

    // 5. Wait 2.1 seconds
    setTimeout(() => {
        // 6. Load new song and Restart
        loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
        isSwitchingSong = false;
    }, 2100);
}

// --- DB LISTENER ---
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
            
            // If someone else updated it, apply changes
            if (state.lastUpdater !== myName) {
                lastBroadcaster = state.lastUpdater;
                applyRemoteCommand(state);
            } else {
                lastBroadcaster = myName;
            }
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
        if (msg.user !== myName && activeTab !== 'chat') showToast(msg.user, msg.text);
    });
}
loadInitialData();

function broadcastState(action, time, videoId) {
    if (ignoreSystemEvents) return; 
    syncRef.set({ 
        action, 
        time, 
        videoId, 
        lastUpdater: myName, 
        timestamp: Date.now() 
    });
}

function applyRemoteCommand(state) {
    if (!player) return;
    
    // Silence events while applying remote command
    suppressBroadcast(2500); 
    
    document.getElementById('syncOverlay').classList.remove('active');

    // Handle "switching_pause" specifically
    if (state.action === 'switching_pause') {
        player.pauseVideo();
        showToast("System", "Partner is changing track...");
        updatePlayPauseButton(YT.PlayerState.BUFFERING); // Show spinner
        updateSyncStatus();
        return;
    }

    // Case 1: Video Changed
    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        
        if(state.action === 'play' || state.action === 'restart') player.playVideo();
    } 
    // Case 2: Same Video
    else {
        const playerState = player.getPlayerState();
        
        if (state.action === 'restart') {
            player.seekTo(0, true);
            player.playVideo();
        }
        else if (state.action === 'play') {
            const timeDiff = Math.abs(player.getCurrentTime() - state.time);
            if (timeDiff > 2) player.seekTo(state.time, true);
            
            if (playerState !== YT.PlayerState.PLAYING) {
                player.playVideo();
            }
        }
        else if (state.action === 'pause' || state.action === 'ad_pause') {
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
        } 
    }
}

function updateSyncStatus() {
    const msg = document.getElementById('sync-status-msg');
    
    // Check if we are playing
    if (player && player.getPlayerState() === YT.PlayerState.PLAYING && !detectAd()) {
        msg.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Synced`;
        msg.style.background = "#ffd700"; // Gold
        msg.style.color = "#000";
    } else {
        // If remote state says ad_pause OR if I am detecting an ad locally
        if ((currentRemoteState && currentRemoteState.action === 'ad_pause') || detectAd()) {
            msg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Partner watching Ad`;
            msg.style.background = "#ff9800"; // Orange
            msg.style.color = "#fff";
        } 
        else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
            msg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Switching Song...`;
            msg.style.background = "#9c27b0"; // Purple
            msg.style.color = "#fff";
        }
        else {
            const pausedBy = (lastBroadcaster === myName) ? "You" : lastBroadcaster;
            
            if(currentRemoteState && (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart')) {
                 msg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Syncing...`;
                 msg.style.background = "#2979ff";
            } else {
                 msg.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${pausedBy}`;
                 msg.style.background = "#444";
            }
            msg.style.color = "#fff";
        }
    }
}

// --- STANDARD HELPER FUNCTIONS ---

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true) {
    if (player && videoId) {
        
        if (!shouldBroadcast) {
            suppressBroadcast(3000); 
        }

        // New Video Load or Seek
        // NOTE: We always loadVideoById if switching to ensure correct ID is set in player
        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
        } else {
             // Same video, just seek
             if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
             player.playVideo();
        }

        // UPDATE GLOBAL STATE IMMEDIATELY to prevent Ad detection race conditions
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        document.getElementById('current-song-artist').textContent = uploader || "Unknown Artist";
        renderQueue(currentQueue, currentVideoId);
        
        if (shouldBroadcast) {
            lastBroadcaster = myName;
            // 'restart' forces the partner to jump to 0:00 or specific time
            broadcastState('restart', 0, videoId);
        }
    }
}

function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    document.getElementById('tab-btn-' + tabName).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById('view-' + tabName).classList.add('active');
}

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0) initiateSongLoad({videoId, title, uploader});
        });
}

function addBatchToQueue(songs) {
    if (!songs.length) return;
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, addedBy: myName, order: Date.now() + i * 100 };
    });
    queueRef.update(updates).then(() => switchTab('queue'));
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
    list.innerHTML = '';
    badge.textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<div class="empty-state">Your queue is empty. Add songs from Results!</div>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        
        const subtitle = `Added by ${song.addedBy || 'System'}`;
        const number = index + 1;
        
        item.innerHTML = `
            <i class="fa-solid fa-bars drag-handle" title="Drag to order"></i>
            <div class="song-index">${number}</div>
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-details"><h4>${song.title}</h4><p>${subtitle}</p></div>
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

async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    if (query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        input.value = ''; return;
    }
    if (query.includes('spotify.com')) {
        fetchSpotifyData(query);
        input.value = ''; return;
    }

    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p style="text-align:center; padding:30px; color:white;">Searching...</p>';
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        const list = document.getElementById('results-list');
        list.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
                <div class="song-details"><h4>${item.snippet.title}</h4><p>${item.snippet.channelTitle}</p></div>
                <button class="emoji-trigger" style="color:#fff; font-size:1.1rem; position:static; width:auto; height:auto; border:none; background:transparent;"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { console.error(e); }
    input.value = '';
}

async function fetchPlaylist(playlistId, pageToken = '', allSongs = []) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const songs = data.items.filter(i=>i.snippet.resourceId.kind==='youtube#video').map(i => ({
            videoId: i.snippet.resourceId.videoId,
            title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url
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
            for (const t of data.tracks.slice(0, 10)) { 
                const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(t.artist + ' ' + t.title)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`);
                const sData = await sRes.json();
                if(sData.items.length) {
                    const i = sData.items[0];
                    songs.push({ videoId: i.id.videoId, title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url });
                }
            }
            addBatchToQueue(songs);
        }
    } catch(e) { console.error(e); }
}

function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    div.innerHTML = `<div class="msg-header">${user} <span style="font-size:0.85em;">${time}</span></div>${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function showToast(user, text) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fa-solid fa-comment-dots"></i>
        <div class="toast-body">
            <h4>${user}</h4>
            <p>${text.substring(0, 30)}${text.length>30?'...':''}</p>
        </div>
    `;
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity='0'; setTimeout(()=>toast.remove(), 400); }, 4000);
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
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));// --- CONFIGURATION ---
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

let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; // Prevents interactions during the 2.1s wait

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;

let myName = localStorage.getItem('deepSpaceUserName');
if (!myName) {
    myName = prompt("Enter your name (Sarthak or Reechita):") || "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

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
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(85);
    
    // 1. Broadcaster Loop (Send my state)
    setInterval(heartbeatSync, 1000);
    
    // 2. Receiver Loop (Aggressive Fixer)
    setInterval(monitorSyncHealth, 3000);
    
    // Initial Load
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
}

// --- AD DETECTION LOGIC ---
function detectAd() {
    // Safety checks
    if (!player || typeof player.getVideoData !== 'function' || !currentVideoId) return false;
    
    try {
        const data = player.getVideoData();
        // If the player reports a Video ID that is DIFFERENT from our current global ID, it's an Ad.
        if (data && data.video_id && data.video_id !== currentVideoId) {
            // Only count as Ad if we are actually playing or buffering
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
                console.log("Ad Detected: Mismatch", data.video_id, currentVideoId);
                return true;
            }
        }
    } catch (e) {
        console.warn("Ad detect error", e);
    }
    return false;
}

// --- CORE SYNC LOGIC ---

// SENDER: Tell DB what I am doing
function heartbeatSync() {
    if (isSwitchingSong) return;

    // Check for Ad first
    if (lastBroadcaster === myName && detectAd()) {
        broadcastState('ad_pause', 0, currentVideoId);
        return;
    }

    // Only broadcast if I am playing AND I am the intended broadcaster
    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            // Check for end of song (auto-next)
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) {
                initiateNextSong(); // This will trigger the 2.1s wait
            } else {
                // Normal Playing Broadcast
                broadcastState('play', current, currentVideoId);
            }
        }
    }
}

// RECEIVER: Automatic Fixer
function monitorSyncHealth() {
    // If I am the broadcaster or currently switching, I don't need to fix myself against the DB
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;

    // If partner is watching ad, do nothing (we should be paused)
    if (currentRemoteState.action === 'ad_pause') return;
    if (currentRemoteState.action === 'switching_pause') return; // Don't fight the switch

    const myState = player.getPlayerState();
    
    // If DB says PLAYING
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        
        let needsFix = false;
        
        // Fix State: If I am NOT playing, force play
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            // Local Ad Check
            if (detectAd()) return; 

            console.log("⚠️ Sync Monitor: Force Resuming...");
            player.playVideo();
            needsFix = true;
        }
        
        // Fix Time Drift (> 3 seconds)
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3) {
            if (!detectAd()) { 
                player.seekTo(currentRemoteState.time, true);
                needsFix = true;
            }
        }

        if (needsFix) suppressBroadcast(1500); 
    }
}

function onPlayerStateChange(event) {
    if (ignoreSystemEvents || isSwitchingSong) return;

    const btn = document.getElementById('play-pause-btn');
    const state = event.data;

    if (state === YT.PlayerState.PLAYING) {
        if (detectAd()) {
            lastBroadcaster = myName;
            broadcastState('ad_pause', 0, currentVideoId);
            return;
        }

        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        
        lastBroadcaster = myName;
        broadcastState('play', player.getCurrentTime(), currentVideoId);

    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        if (state === YT.PlayerState.PAUSED) {
            if (lastBroadcaster === myName) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId);
            }
        }
        
        if (state === YT.PlayerState.ENDED) {
             initiateNextSong();
        }
    }
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || isSwitchingSong) return;
    const btn = document.getElementById('play-pause-btn');
    const state = player.getPlayerState();
    
    lastBroadcaster = myName; 
    
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            initiateSongLoad(currentQueue[0]);
        } else if (currentVideoId) {
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
}

// --- GRACEFUL SONG SWITCHING LOGIC (2.1s Delay) ---

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

    // 1. Lock functionality
    isSwitchingSong = true;
    lastBroadcaster = myName;

    // 2. Pause Local Player
    if (player && player.pauseVideo) player.pauseVideo();
    
    // 3. UI Feedback
    showToast("System", "Switching track in 2s...");
    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    // 4. Broadcast special 'switching_pause' to partner
    // This tells them to pause and wait, not to fight back with 'monitorSyncHealth'
    syncRef.set({ 
        action: 'switching_pause', 
        time: 0, 
        videoId: currentVideoId, // Keep old ID for now
        lastUpdater: myName, 
        timestamp: Date.now() 
    });

    // 5. Wait 2.1 seconds
    setTimeout(() => {
        // 6. Load new song and Restart
        loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
        isSwitchingSong = false;
    }, 2100);
}

// --- DB LISTENER ---
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
            
            // If someone else updated it, apply changes
            if (state.lastUpdater !== myName) {
                lastBroadcaster = state.lastUpdater;
                applyRemoteCommand(state);
            } else {
                lastBroadcaster = myName;
            }
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
        if (msg.user !== myName && activeTab !== 'chat') showToast(msg.user, msg.text);
    });
}
loadInitialData();

function broadcastState(action, time, videoId) {
    if (ignoreSystemEvents) return; 
    syncRef.set({ 
        action, 
        time, 
        videoId, 
        lastUpdater: myName, 
        timestamp: Date.now() 
    });
}

function applyRemoteCommand(state) {
    if (!player) return;
    
    // Silence events while applying remote command
    suppressBroadcast(2500); 
    
    document.getElementById('syncOverlay').classList.remove('active');

    // Handle "switching_pause" specifically
    if (state.action === 'switching_pause') {
        player.pauseVideo();
        showToast("System", "Partner is changing track...");
        return;
    }

    // Case 1: Video Changed
    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        
        if(state.action === 'play' || state.action === 'restart') player.playVideo();
    } 
    // Case 2: Same Video
    else {
        const playerState = player.getPlayerState();
        
        if (state.action === 'restart') {
            player.seekTo(0, true);
            player.playVideo();
        }
        else if (state.action === 'play') {
            const timeDiff = Math.abs(player.getCurrentTime() - state.time);
            if (timeDiff > 2) player.seekTo(state.time, true);
            
            if (playerState !== YT.PlayerState.PLAYING) {
                player.playVideo();
            }
        }
        else if (state.action === 'pause' || state.action === 'ad_pause') {
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
        } 
    }
}

function updateSyncStatus() {
    const msg = document.getElementById('sync-status-msg');
    
    // Check if we are playing
    if (player && player.getPlayerState() === YT.PlayerState.PLAYING && !detectAd()) {
        msg.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Synced`;
        msg.style.background = "#ffd700"; // Gold
        msg.style.color = "#000";
    } else {
        // If remote state says ad_pause OR if I am detecting an ad locally
        if ((currentRemoteState && currentRemoteState.action === 'ad_pause') || detectAd()) {
            msg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Partner watching Ad`;
            msg.style.background = "#ff9800"; // Orange
            msg.style.color = "#fff";
        } 
        else if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
            msg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Switching Song...`;
            msg.style.background = "#9c27b0"; // Purple
            msg.style.color = "#fff";
        }
        else {
            const pausedBy = (lastBroadcaster === myName) ? "You" : lastBroadcaster;
            
            if(currentRemoteState && (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart')) {
                 msg.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Syncing...`;
                 msg.style.background = "#2979ff";
            } else {
                 msg.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${pausedBy}`;
                 msg.style.background = "#444";
            }
            msg.style.color = "#fff";
        }
    }
}

// --- STANDARD HELPER FUNCTIONS ---

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true) {
    if (player && videoId) {
        
        if (!shouldBroadcast) {
            suppressBroadcast(3000); 
        }

        // New Video Load or Seek
        // NOTE: We always loadVideoById if switching to ensure correct ID is set in player
        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
        } else {
             // Same video, just seek
             if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
             player.playVideo();
        }

        // UPDATE GLOBAL STATE IMMEDIATELY to prevent Ad detection race conditions
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        document.getElementById('current-song-artist').textContent = uploader || "Unknown Artist";
        renderQueue(currentQueue, currentVideoId);
        
        if (shouldBroadcast) {
            lastBroadcaster = myName;
            // 'restart' forces the partner to jump to 0:00 or specific time
            broadcastState('restart', 0, videoId);
        }
    }
}

function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    document.getElementById('tab-btn-' + tabName).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById('view-' + tabName).classList.add('active');
}

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0) initiateSongLoad({videoId, title, uploader});
        });
}

function addBatchToQueue(songs) {
    if (!songs.length) return;
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, addedBy: myName, order: Date.now() + i * 100 };
    });
    queueRef.update(updates).then(() => switchTab('queue'));
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
    list.innerHTML = '';
    badge.textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<div class="empty-state">Your queue is empty. Add songs from Results!</div>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        
        const subtitle = `Added by ${song.addedBy || 'System'}`;
        const number = index + 1;
        
        item.innerHTML = `
            <i class="fa-solid fa-bars drag-handle" title="Drag to order"></i>
            <div class="song-index">${number}</div>
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-details"><h4>${song.title}</h4><p>${subtitle}</p></div>
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

async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    if (query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        input.value = ''; return;
    }
    if (query.includes('spotify.com')) {
        fetchSpotifyData(query);
        input.value = ''; return;
    }

    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p style="text-align:center; padding:30px; color:white;">Searching...</p>';
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        const list = document.getElementById('results-list');
        list.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
                <div class="song-details"><h4>${item.snippet.title}</h4><p>${item.snippet.channelTitle}</p></div>
                <button class="emoji-trigger" style="color:#fff; font-size:1.1rem; position:static; width:auto; height:auto; border:none; background:transparent;"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { console.error(e); }
    input.value = '';
}

async function fetchPlaylist(playlistId, pageToken = '', allSongs = []) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const songs = data.items.filter(i=>i.snippet.resourceId.kind==='youtube#video').map(i => ({
            videoId: i.snippet.resourceId.videoId,
            title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url
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
            for (const t of data.tracks.slice(0, 10)) { 
                const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(t.artist + ' ' + t.title)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`);
                const sData = await sRes.json();
                if(sData.items.length) {
                    const i = sData.items[0];
                    songs.push({ videoId: i.id.videoId, title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url });
                }
            }
            addBatchToQueue(songs);
        }
    } catch(e) { console.error(e); }
}

function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    div.innerHTML = `<div class="msg-header">${user} <span style="font-size:0.85em;">${time}</span></div>${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function showToast(user, text) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fa-solid fa-comment-dots"></i>
        <div class="toast-body">
            <h4>${user}</h4>
            <p>${text.substring(0, 30)}${text.length>30?'...':''}</p>
        </div>
    `;
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity='0'; setTimeout(()=>toast.remove(), 400); }, 4000);
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
