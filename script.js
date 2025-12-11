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
const likedRef = db.ref('liked_songs');

let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; 
let activeTab = 'queue'; 
let currentRemoteState = null; 
let isSwitchingSong = false; 
let hasUserInteracted = false; 
let myName = localStorage.getItem('deepSpaceUserName') || ""; 
let unseenChatCount = 0;

// Fallback metadata
let currentSongMeta = { title: "Heart's Rhythm", uploader: "System", thumbnail: "" };

let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 

// --- CLICK ANIMATIONS ---
document.querySelectorAll('.btn-click').forEach(btn => {
    btn.addEventListener('click', function(e) {
        this.style.transform = "scale(0.9)";
        setTimeout(() => this.style.transform = "scale(1)", 150);
    });
});

// --- TABS & NAVIGATION ---
function switchTab(tabName) {
    activeTab = tabName;
    
    // UI Update
    document.querySelectorAll('.tab-pill').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'));

    const btn = document.getElementById('tab-btn-' + tabName);
    if(btn) btn.classList.add('active');
    
    const view = document.getElementById('view-' + tabName);
    if(view) view.classList.add('active');

    // Logic
    if (tabName === 'chat') {
        unseenChatCount = 0;
        updateChatBadge();
        const chatBox = document.getElementById('chat-messages');
        setTimeout(() => chatBox.scrollTop = chatBox.scrollHeight, 100);
    }
}

function updateChatBadge() {
    const badge = document.getElementById('chat-badge');
    if (unseenChatCount > 0) {
        badge.style.display = 'block';
        badge.textContent = unseenChatCount;
    } else {
        badge.style.display = 'none';
    }
}

// --- LIKED SONGS (ROBUST IMPLEMENTATION) ---
document.getElementById('like-btn').addEventListener('click', (e) => {
    if (!currentVideoId || !myName) return;
    
    // Visual Feedback
    const btn = document.getElementById('like-btn');
    const icon = btn.querySelector('i');
    icon.style.transform = 'scale(1.5)';
    setTimeout(() => icon.style.transform = 'scale(1)', 300);

    // Find metadata
    let songObj = currentQueue.find(s => s.videoId === currentVideoId);
    if (!songObj) {
        songObj = { ...currentSongMeta };
    }
    
    if(!songObj.title) return;

    // Database Update
    likedRef.child(currentVideoId).transaction((currentData) => {
        if (currentData === null) {
            return {
                title: songObj.title,
                thumbnail: songObj.thumbnail,
                uploader: songObj.uploader,
                likes: { [myName]: true }
            };
        } else {
            if (!currentData.likes) currentData.likes = {};
            currentData.likes[myName] = true;
            return currentData;
        }
    }, (error, committed) => {
        if (committed) {
            showToast("System", "Song added to Favorites ❤️");
            updateLikeButtonState(true);
        }
    });
});

function updateLikeButtonState(isLiked) {
    const btn = document.getElementById('like-btn');
    const icon = btn.querySelector('i');
    if (isLiked) {
        icon.classList.remove('fa-regular');
        icon.classList.add('fa-solid');
        btn.style.color = '#ff0055';
    } else {
        icon.classList.remove('fa-solid');
        icon.classList.add('fa-regular');
        btn.style.color = 'white';
    }
}

function renderLikedSongs(likedData) {
    const list = document.getElementById('liked-list');
    list.innerHTML = '';
    
    if (!likedData) {
        list.innerHTML = `
            <div class="empty-placeholder">
                <i class="fa-regular fa-heart"></i>
                <p>Songs you like appear here</p>
            </div>`;
        return;
    }

    let delay = 0;
    // Iterate object keys
    Object.keys(likedData).forEach((videoId) => {
        const song = likedData[videoId];
        const likes = song.likes || {};
        const likers = Object.keys(likes);

        let footerText = "";
        if (likers.length > 1) footerText = "Liked by Both";
        else if (likers.includes(myName)) footerText = "Liked by You";
        else footerText = `Liked by ${likers[0]}`;

        const card = document.createElement('div');
        card.className = 'song-card';
        // Add animation staggered
        card.style.animationDelay = `${delay}s`;
        delay += 0.05;

        card.innerHTML = `
            <div class="card-idx"><i class="fa-solid fa-heart" style="color:var(--primary)"></i></div>
            <div class="card-thumb"><img src="${song.thumbnail}"></div>
            <div class="card-info">
                <h4>${song.title}</h4>
                <span class="card-tag" style="color:var(--primary); font-weight:bold;">${footerText}</span>
            </div>
            <button class="card-action"><i class="fa-solid fa-play"></i></button>
        `;
        
        card.onclick = () => {
            // Play logic
            const newKey = queueRef.push().key;
            queueRef.child(newKey).set({ 
                videoId: videoId, title: song.title, uploader: song.uploader, 
                thumbnail: song.thumbnail, addedBy: myName, order: Date.now() 
            }).then(() => initiateSongLoad({ videoId, title: song.title, uploader: song.uploader }));
        };

        list.appendChild(card);
    });
}

function checkCurrentSongLiked() {
    if (!currentVideoId) return;
    likedRef.child(currentVideoId).once('value', snapshot => {
        const val = snapshot.val();
        if (val && val.likes && val.likes[myName]) updateLikeButtonState(true);
        else updateLikeButtonState(false);
    });
}

// --- OPTIMISTIC PLAY/PAUSE ---
function togglePlayPause() {
    if (!player || isSwitchingSong) return;

    // Optimistic UI Update
    const btn = document.getElementById('play-pause-btn');
    const currentState = player.getPlayerState();
    
    lastLocalInteractionTime = Date.now();
    ignoreSystemEvents = false;
    clearTimeout(ignoreTimer);
    lastBroadcaster = myName;

    if (currentState === YT.PlayerState.PLAYING) {
        // Assume pause will succeed
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        // Assume play will succeed
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        player.setVolume(100);
        player.playVideo();
        broadcastState('play', player.getCurrentTime(), currentVideoId, true);
    }
}

// --- QUEUE RENDERER ---
function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-badge').textContent = queueArray.length;
    list.innerHTML = '';

    if (queueArray.length === 0) {
        list.innerHTML = '<div class="empty-placeholder"><p>Queue is empty</p></div>';
        return;
    }

    let delay = 0;
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-card ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.dataset.key = song.key;
        item.draggable = true;
        item.style.animationDelay = `${delay}s`;
        delay += 0.05;

        const isMe = song.addedBy === myName;
        const byText = isMe ? 'You' : song.addedBy;

        item.innerHTML = `
            <div class="card-idx">${index + 1}</div>
            <div class="card-thumb"><img src="${song.thumbnail}"></div>
            <div class="card-info">
                <h4>${song.title}</h4>
                <span class="card-tag">Added by ${byText}</span>
            </div>
            <button class="card-action" onclick="removeFromQueue('${song.key}', event)"><i class="fa-solid fa-trash"></i></button>
        `;
        
        item.onclick = (e) => {
            if(!e.target.closest('.card-action')) initiateSongLoad(song);
        };
        list.appendChild(item);
    });

    // Auto-scroll to playing
    setTimeout(() => {
        const playing = document.querySelector('.song-card.playing');
        if(playing) playing.scrollIntoView({ behavior:'smooth', block:'center'});
    }, 200);

    initDragAndDrop(list);
}

// --- CHAT & TOASTS (BUBBLES) ---
function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `chat-bubble ${isMe ? 'me' : 'other'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    
    div.innerHTML = `
        <span class="chat-meta">${user} • ${time}</span>
        ${text}
    `;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function showToast(user, text) {
    const container = document.getElementById('toast-dock');
    
    // STRICT LIMIT: 3 Bubbles
    while (container.children.length >= 3) {
        container.removeChild(container.firstChild);
    }

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = `<strong>${user}</strong><br>${text}`;
    
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// --- STANDARD SYNC LOGIC ---
function suppressBroadcast(duration = 1000) { ignoreSystemEvents = true; clearTimeout(ignoreTimer); ignoreTimer = setTimeout(() => { ignoreSystemEvents = false; }, duration); }
function onYouTubeIframeAPIReady() { player = new YT.Player('player', { height: '100%', width: '100%', videoId: '', playerVars: { 'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin }, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } }); }
function onPlayerReady(event) { if (player && player.setVolume) player.setVolume(100); setInterval(heartbeatSync, 1000); setInterval(monitorSyncHealth, 2000); syncRef.once('value').then(snapshot => { const state = snapshot.val(); if(state) applyRemoteCommand(state); }); }
function detectAd() { try { const data = player.getVideoData(); if (data && data.video_id && data.video_id !== currentVideoId) return true; } catch(e) {} return false; }

function heartbeatSync() {
    if (isSwitchingSong) return;
    if (detectAd()) { broadcastState('ad_pause', 0, currentVideoId); updateSyncStatus(); return; }
    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            const duration = player.getDuration();
            const current = player.getCurrentTime();
            if (duration > 0 && duration - current < 1) initiateNextSong();
            else broadcastState('play', current, currentVideoId);
        } else if (state === YT.PlayerState.PAUSED) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
    }
}

function monitorSyncHealth() {
    if (!hasUserInteracted || lastBroadcaster === myName || isSwitchingSong) return;
    if (!player || !currentRemoteState || !player.getPlayerState) return;
    if (Date.now() - lastLocalInteractionTime < 2000) return;
    if (currentRemoteState.action === 'ad_pause' || currentRemoteState.action === 'switching_pause') return;

    const myState = player.getPlayerState();
    if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') {
        if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) {
            if (!detectAd()) { player.playVideo(); suppressBroadcast(1000); }
        }
        if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3 && !detectAd()) {
            player.seekTo(currentRemoteState.time, true); suppressBroadcast(1000);
        }
    } else if (currentRemoteState.action === 'pause' && myState === YT.PlayerState.PLAYING) {
        player.pauseVideo(); suppressBroadcast(1000);
    }
}

function updatePlayPauseButton(state) {
    const btn = document.getElementById('play-pause-btn');
    if (!btn) return;
    if (isSwitchingSong) { btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>'; return; }
    if (state === YT.PlayerState.PLAYING) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    else btn.innerHTML = '<i class="fa-solid fa-play"></i>';
}

function onPlayerStateChange(event) {
    const state = event.data;
    updatePlayPauseButton(state);
    if (isSwitchingSong || ignoreSystemEvents) return;
    if (detectAd()) { lastBroadcaster = myName; broadcastState('ad_pause', 0, currentVideoId); updateSyncStatus(); return; }
    
    if (state === YT.PlayerState.PLAYING) {
        if(Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('play', player.getCurrentTime(), currentVideoId); }
    } else if (state === YT.PlayerState.PAUSED) {
        if(Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('pause', player.getCurrentTime(), currentVideoId); }
    } else if (state === YT.PlayerState.ENDED) initiateNextSong();
    updateSyncStatus();
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
    if (!songObj) return;
    isSwitchingSong = true; lastBroadcaster = myName;
    currentSongMeta = { title: songObj.title, uploader: songObj.uploader, thumbnail: songObj.thumbnail || "" };
    
    if (player && player.pauseVideo) player.pauseVideo();
    showToast("System", "Switching track...");
    syncRef.set({ action: 'switching_pause', time: 0, videoId: currentVideoId, lastUpdater: myName, timestamp: Date.now() });

    setTimeout(() => {
        loadAndPlayVideo(songObj.videoId, songObj.title, songObj.uploader, 0, true);
        isSwitchingSong = false;
    }, 500); 
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(1500);
        player.loadVideoById({videoId: videoId, startSeconds: startTime});
        player.setVolume(100);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        checkCurrentSongLiked(); renderQueue(currentQueue, currentVideoId);
        if (shouldBroadcast) { lastBroadcaster = myName; broadcastState('restart', 0, videoId, true); }
    }
}

function broadcastState(action, time, videoId, force = false) {
    if (ignoreSystemEvents && !force) return; 
    syncRef.set({ action, time, videoId, lastUpdater: myName, timestamp: Date.now() });
}

function applyRemoteCommand(state) {
    if (!player) return;
    if (Date.now() - lastLocalInteractionTime < 1500) return;
    if (!hasUserInteracted && (state.action === 'play' || state.action === 'restart')) {
        if (state.videoId !== currentVideoId) {
             const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
             const title = songInQueue ? songInQueue.title : "Syncing...";
             const uploader = songInQueue ? songInQueue.uploader : "";
             loadAndPlayVideo(state.videoId, title, uploader, state.time, false, false); 
        }
        return; 
    }
    suppressBroadcast(1000); lastBroadcaster = state.lastUpdater;
    if (state.action === 'switching_pause') {
        player.pauseVideo(); showToast("System", "Partner changing song..."); updateSyncStatus(); return;
    }
    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        if(state.action === 'play' || state.action === 'restart') { player.setVolume(100); player.playVideo(); }
    } else {
        if (state.action === 'restart') { player.seekTo(0, true); player.playVideo(); }
        else if (state.action === 'play') {
            if (Math.abs(player.getCurrentTime() - state.time) > 2) player.seekTo(state.time, true);
            player.playVideo();
        } else if (state.action === 'pause' || state.action === 'ad_pause') {
            player.pauseVideo();
        } 
    }
    updateSyncStatus();
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    const eq = document.getElementById('equalizer');
    
    // Default style
    msgEl.className = 'status-pill';
    
    if (detectAd()) {
        msgEl.innerHTML = '<i class="fa-solid fa-rectangle-ad"></i> Ad';
        eq.classList.remove('active'); return;
    }
    if (isSwitchingSong) {
        msgEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...';
        eq.classList.remove('active'); return;
    }
    
    const playerState = player ? player.getPlayerState() : -1;
    if (playerState === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = '<i class="fa-solid fa-bolt"></i> Vibing';
        msgEl.classList.add('active');
        eq.classList.add('active');
    } else {
        const pauser = (currentRemoteState && currentRemoteState.action === 'pause') ? currentRemoteState.lastUpdater : 'System';
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${pauser}`;
        eq.classList.remove('active');
    }
}

// --- INIT ---
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
            if (state.lastUpdater !== myName) applyRemoteCommand(state); else lastBroadcaster = myName;
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
        if (msg.user !== myName && activeTab !== 'chat') {
            unseenChatCount++;
            updateChatBadge();
            showToast(msg.user, msg.text);
        }
    });
    
    likedRef.on('value', (snapshot) => {
        renderLikedSongs(snapshot.val());
        checkCurrentSongLiked();
    });
}
loadInitialData();

// --- SEARCH & UTILS ---
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', initiatePrevSong);
document.getElementById('next-btn').addEventListener('click', initiateNextSong);
document.getElementById('chatSendBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }
});
document.getElementById('chatInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('chatSendBtn').click(); });
document.getElementById('startSessionBtn').addEventListener('click', () => {
    const val = document.getElementById('welcomeNameInput').value.trim();
    if(!val) return;
    myName = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
    localStorage.setItem('deepSpaceUserName', myName);
    hasUserInteracted = true;
    document.getElementById('welcomeOverlay').classList.remove('active');
    if(currentRemoteState && currentRemoteState.action !== 'pause') player.playVideo();
});
document.getElementById('welcomeNameInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('startSessionBtn').click(); });

// Search Logic
document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });
async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;
    
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<div class="empty-placeholder"><p>Searching Universe...</p></div>';
    
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        const list = document.getElementById('results-list');
        list.innerHTML = '';
        
        if (!data.items || !data.items.length) { list.innerHTML = '<div class="empty-placeholder"><p>No results found</p></div>'; return; }
        
        let delay = 0;
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-card';
            div.style.animationDelay = `${delay}s`; delay += 0.05;
            div.innerHTML = `
                <div class="card-idx"><i class="fa-solid fa-plus"></i></div>
                <div class="card-thumb"><img src="${item.snippet.thumbnails.default.url}"></div>
                <div class="card-info"><h4>${item.snippet.title}</h4><span class="card-tag">${item.snippet.channelTitle}</span></div>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) {}
    input.value = '';
}

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0) initiateSongLoad({videoId, title, uploader});
        });
}
function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    const song = currentQueue.find(s => s.key === key);
    if (song) { queueRef.child(key).remove(); if (song.videoId === currentVideoId) initiateNextSong(); }
}
function initDragAndDrop(list) {
    let draggedItem = null;
    list.querySelectorAll('.song-card').forEach(item => {
        item.addEventListener('dragstart', () => { draggedItem = item; item.style.opacity = '0.5'; });
        item.addEventListener('dragend', () => { item.style.opacity = '1'; draggedItem = null; const newOrderKeys = Array.from(list.querySelectorAll('.song-card')).map(el => el.dataset.key); const newOrder = newOrderKeys.map(key => currentQueue.find(s => s.key === key)); const updates = {}; newOrder.forEach((s, i) => { updates[`${s.key}/order`] = i; }); queueRef.update(updates); });
        item.addEventListener('dragover', (e) => { e.preventDefault(); const afterElement = getDragAfterElement(list, e.clientY); if (afterElement == null) list.appendChild(draggedItem); else list.insertBefore(draggedItem, afterElement); });
    });
}
function getDragAfterElement(container, y) { const draggableElements = [...container.querySelectorAll('.song-card:not([style*="opacity: 0.5"])')]; return draggableElements.reduce((closest, child) => { const box = child.getBoundingClientRect(); const offset = y - box.top - box.height / 2; if (offset < 0 && offset > closest.offset) return { offset: offset, element: child }; else return closest; }, { offset: Number.NEGATIVE_INFINITY }).element; }

// Modals
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));
document.getElementById('closeLyricsBtn').addEventListener('click', () => document.getElementById('lyricsOverlay').classList.remove('active'));
document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear All?")) queueRef.remove(); });
document.getElementById('lyrics-btn').addEventListener('click', () => {
    document.getElementById('lyricsOverlay').classList.add('active');
    document.getElementById('lyrics-content-area').innerHTML = '<p style="text-align:center; margin-top:50px;">Lyrics feature is ready.<br>Search Google for now while API connects.</p>';
});
