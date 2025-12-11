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
let isSwitchingSong = false; 

// --- CRITICAL SYNC FLAGS ---
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; // Timestamp of last user click

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
    setInterval(monitorSyncHealth, 2000);
    
    // Initial Load
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state);
    });
}

// --- AD DETECTION LOGIC ---
function detectAd() {
    if (!player || !currentVideoId) return false;
    try {
        const data = player.getVideoData();
        // If data exists, has a video_id, and that ID is NOT the one we loaded
        // This is the most reliable way to detect YouTube inserting an ad
        if (data && data.video_id && data.video_id !== currentVideoId) {
            return true;
        }
    } catch(e) {}
    return false;
}

// --- CORE SYNC LOGIC ---

// SENDER: Tell DB what I am doing
function heartbeatSync() {
    if (player && player.getPlayerState) updatePlayPauseButton(player.getPlayerState());
    if (isSwitchingSong) return;

    // Check for Ad first - CRITICAL: If I see an ad, I MUST broadcast it.
    if (detectAd()) {
        broadcastState('ad_pause', 0, currentVideoId);
        updateSyncStatus();
        return;
    }

    // Only broadcast if I am the intended broadcaster
    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        
        if (state === YT.PlayerState.PLAYING) {
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) {
                initiateNextSong(); 
            } else {
                broadcastState('play', current, currentVideoId);
            }
        }
        // NEW: If I paused it, I should keep telling the world I paused it.
        // This fixes the issue where the pause attribution disappears or is overwritten.
        else if (state === YT.PlayerState.PAUSED) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
    }
}

// RECEIVER: Automatic Fixer
function monitorSyncHealth() {
    if (lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;

    // Don't fix if I just clicked something recently
    if (Date.now() - lastLocalInteractionTime < 2000) return;

    if (currentRemoteState.action === 'ad_pause') return;
    if (currentRemoteState.action === 'switching_pause') return;

    const myState = player.getPlayerState();
    
    // If DB says PLAYING
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        let needsFix = false;
        
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (detectAd()) return; 
            console.log("⚠️ Sync Monitor: Force Resuming...");
            player.playVideo();
            needsFix = true;
        }
        
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3) {
            if (!detectAd()) { 
                player.seekTo(currentRemoteState.time, true);
                needsFix = true;
            }
        }

        if (needsFix) suppressBroadcast(1000); 
    }
    // If DB says PAUSED
    else if (currentRemoteState.action === 'pause') {
         if (myState === YT.PlayerState.PLAYING) {
             console.log("⚠️ Sync Monitor: Force Pausing...");
             player.pauseVideo();
             needsFix = true;
             if (needsFix) suppressBroadcast(1000);
         }
    }
}

function updatePlayPauseButton(state) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    
    // STRICT RULE: Only show spinner if switching song.
    if (isSwitchingSong) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        return;
    }

    // Otherwise, strictly Play or Pause icon
    if (state === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else {
        // Paused, Buffering, Ended, Cued -> Show Play Icon
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    }
}

function onPlayerStateChange(event) {
    const state = event.data;
    updatePlayPauseButton(state);

    if (isSwitchingSong) return;
    if (ignoreSystemEvents) return;

    if (detectAd()) {
        lastBroadcaster = myName;
        broadcastState('ad_pause', 0, currentVideoId);
        updateSyncStatus();
        return;
    }

    // Detect native player clicks (if user clicks video instead of button)
    // If state changed and we aren't suppressed, we assume it's a user action
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.PAUSED) {
        // Only claim if it wasn't a recent sync event
        if (Date.now() - lastLocalInteractionTime > 500) {
             lastBroadcaster = myName; 
             broadcastState(state === YT.PlayerState.PLAYING ? 'play' : 'pause', player.getCurrentTime(), currentVideoId);
        }
    }
    else if (state === YT.PlayerState.ENDED) {
        initiateNextSong();
    }
    
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || isSwitchingSong) return;
    
    // --- GOD MODE INTERACTION ---
    // 1. Mark interaction time to ignore incoming syncs for 1s
    lastLocalInteractionTime = Date.now();
    
    // 2. Clear any suppression so we can broadcast immediately
    ignoreSystemEvents = false;
    clearTimeout(ignoreTimer);

    // 3. Claim control
    lastBroadcaster = myName; 

    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        // Optimistic UI
        document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-play"></i>';
        // Force broadcast with explicit name
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            initiateSongLoad(currentQueue[0]);
        } else if (currentVideoId) {
            player.playVideo();
            // Optimistic UI
            document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-pause"></i>';
            // Force broadcast
            broadcastState('play', player.getCurrentTime(), currentVideoId, true);
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

    isSwitchingSong = true;
    lastBroadcaster = myName;

    if (player && player.pauseVideo) player.pauseVideo();
    
    showToast("System", "Switching track in 2.1s...");
    document.getElementById('play-pause-btn').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    syncRef.set({ 
        action: 'switching_pause', 
        time: 0, 
        videoId: currentVideoId, 
        lastUpdater: myName, 
        timestamp: Date.now() 
    });

    setTimeout(() => {
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
                applyRemoteCommand(state);
            } else {
                // If I updated it, just confirm I am broadcaster
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

// ADDED: force parameter to bypass suppression
function broadcastState(action, time, videoId, force = false) {
    if (ignoreSystemEvents && !force) return; 
    
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

    // Protection: If I just clicked a button < 1.5s ago, ignore incoming remote events
    if (Date.now() - lastLocalInteractionTime < 1500) {
        console.log("Ignoring remote command due to recent local interaction");
        return;
    }
    
    // Silence events while applying remote command
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
    updateSyncStatus();
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    const container = document.querySelector('.video-wrapper');
    
    // Animation trigger (remove and re-add class logic handled by CSS animations on change)
    // To restart animation, we use a small reflow hack
    msgEl.classList.remove('pop-anim');
    void msgEl.offsetWidth; // trigger reflow
    msgEl.classList.add('pop-anim');

    // 1. Local Ad?
    if (detectAd()) {
        msgEl.innerHTML = '<i class="fa-solid fa-rectangle-ad"></i> Ad Playing';
        msgEl.className = 'sync-status-3d status-ad';
        return;
    }

    // 2. Switching?
    if (isSwitchingSong) {
        msgEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching...';
        msgEl.className = 'sync-status-3d status-switching';
        return;
    }

    // 3. Remote Ad?
    if (currentRemoteState && currentRemoteState.action === 'ad_pause') {
        // If remote is watching ad, we are paused.
        msgEl.innerHTML = `<i class="fa-solid fa-eye-slash"></i> ${currentRemoteState.lastUpdater} watching Ad`;
        msgEl.className = 'sync-status-3d status-ad-remote';
        return;
    }

    // 4. Remote Switching?
    if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        msgEl.innerHTML = `<i class="fa-solid fa-music"></i> ${currentRemoteState.lastUpdater} picking song...`;
        msgEl.className = 'sync-status-3d status-switching';
        return;
    }

    const playerState = player ? player.getPlayerState() : -1;

    // 5. Playing
    if (playerState === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Vibing Together`;
        msgEl.className = 'sync-status-3d status-playing';
        if(container) container.classList.add('glow-active');
    } 
    // 6. Paused
    else {
        if(container) container.classList.remove('glow-active');
        
        // Determine who paused by prioritising the DB record if the action was a pause
        let pauser = lastBroadcaster;
        if (currentRemoteState && currentRemoteState.action === 'pause') {
            pauser = currentRemoteState.lastUpdater;
        }
        // Handle case where system might be the updater (e.g. initial load)
        const nameDisplay = (pauser === myName) ? "You" : pauser;
        
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${nameDisplay}`;
        msgEl.className = 'sync-status-3d status-paused';
    }
}

// --- STANDARD HELPER FUNCTIONS ---

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true) {
    if (player && videoId) {
        
        if (!shouldBroadcast) {
            suppressBroadcast(1500); 
        }

        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime});
        } else {
             if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
             player.playVideo();
        }

        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        document.getElementById('current-song-artist').textContent = uploader || "Unknown Artist";
        renderQueue(currentQueue, currentVideoId);
        
        if (shouldBroadcast) {
            lastBroadcaster = myName;
            broadcastState('restart', 0, videoId, true); // force=true
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
