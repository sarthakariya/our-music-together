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
let currentSongMeta = { title: "Heart's Rhythm", uploader: "System", thumbnail: "" };
let ignoreSystemEvents = false;
let ignoreTimer = null;
let lastLocalInteractionTime = 0; 

// --- TAB SWITCHING ---
function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    if(tabName === 'results') {
        document.getElementById('view-results').classList.add('active');
    } else {
        const btn = document.getElementById('tab-btn-' + tabName);
        if(btn) btn.classList.add('active');
        document.getElementById('view-' + tabName).classList.add('active');
    }
}

// --- QUEUE RENDERING (Screenshot Match) ---
function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-badge').textContent = queueArray.length;
    list.innerHTML = '';

    if (queueArray.length === 0) { 
        list.innerHTML = '<div class="empty-state">Queue is empty.</div>'; 
        return; 
    }

    let delay = 0;
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `queue-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.style.animationDelay = `${delay}s`;
        delay += 0.05;

        // Determine "Added By" text
        const isMe = song.addedBy === myName;
        const addedByText = isMe ? 'Added by You' : `Added by ${song.addedBy}`;
        
        item.innerHTML = `
            <div class="q-index">${index + 1}</div>
            <img src="${song.thumbnail}" class="q-thumb">
            <div class="q-info">
                <h4>${song.title}</h4>
                <span class="q-tag">${addedByText}</span>
            </div>
            <button class="q-action" onclick="removeFromQueue('${song.key}', event)">
                <i class="fa-solid fa-trash"></i>
            </button>
        `;
        
        item.onclick = (e) => {
            if(!e.target.closest('.q-action')) initiateSongLoad(song);
        };
        
        list.appendChild(item);
    });

    setTimeout(() => { 
        const activeItem = document.querySelector('.queue-item.playing'); 
        if(activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
    }, 100);
}

// --- LIKED SONGS RENDERING ---
function renderLikedSongs(likedData) {
    const list = document.getElementById('liked-list');
    list.innerHTML = '';
    
    if (!likedData) {
        list.innerHTML = '<div class="empty-state">No liked songs yet.</div>';
        return;
    }

    let delay = 0;
    Object.keys(likedData).forEach((videoId) => {
        const song = likedData[videoId];
        const likes = song.likes || {};
        const likers = Object.keys(likes);
        
        // Logic for "Liked by..."
        let likedByText = likers.length > 1 ? "Liked by Both" : (likers.includes(myName) ? "Liked by You" : `Liked by ${likers[0]}`);

        const div = document.createElement('div');
        div.className = 'queue-item'; // Reuse queue styling for consistency
        div.style.animationDelay = `${delay}s`;
        delay += 0.05;

        div.innerHTML = `
            <div class="q-index"><i class="fa-solid fa-heart" style="color:var(--primary)"></i></div>
            <img src="${song.thumbnail}" class="q-thumb">
            <div class="q-info">
                <h4>${song.title}</h4>
                <span class="q-tag" style="background:rgba(255,255,255,0.1); color:#fff;">${likedByText}</span>
            </div>
            <button class="q-action" style="color:#fff;">
                <i class="fa-solid fa-play"></i>
            </button>
        `;
        
        div.onclick = () => {
            // Play liked song: Add to queue then play
            const newKey = queueRef.push().key;
            queueRef.child(newKey).set({ 
                videoId: videoId, title: song.title, uploader: song.uploader, 
                thumbnail: song.thumbnail, addedBy: myName, order: Date.now() 
            }).then(() => initiateSongLoad({ videoId, title: song.title, uploader: song.uploader }));
        };
        list.appendChild(div);
    });
}

// --- LIKE BUTTON LOGIC ---
document.getElementById('like-btn').addEventListener('click', (e) => {
    if (!currentVideoId || !myName) return;
    
    // Animate button
    const btn = e.currentTarget;
    btn.style.transform = "scale(1.2)";
    setTimeout(() => btn.style.transform = "scale(1)", 200);

    let songObj = currentQueue.find(s => s.videoId === currentVideoId);
    if (!songObj) songObj = { ...currentSongMeta }; // Fallback

    if (!songObj.title) return;

    likedRef.child(currentVideoId).transaction((currentData) => {
        if (currentData === null) {
            return {
                title: songObj.title, thumbnail: songObj.thumbnail, uploader: songObj.uploader,
                likes: { [myName]: true }
            };
        } else {
            if (!currentData.likes) currentData.likes = {};
            currentData.likes[myName] = true;
            return currentData;
        }
    });
    
    showToast("System", "Added to collection");
    updateLikeButtonState(true);
});

function updateLikeButtonState(isLiked) {
    const btn = document.getElementById('like-btn');
    const icon = btn.querySelector('i');
    if (isLiked) {
        icon.classList.remove('fa-regular');
        icon.classList.add('fa-solid');
        btn.style.color = '#f50057';
    } else {
        icon.classList.remove('fa-solid');
        icon.classList.add('fa-regular');
        btn.style.color = '#fff';
    }
}

function checkCurrentSongLiked() {
    if (!currentVideoId) return;
    likedRef.child(currentVideoId).once('value', snapshot => {
        const val = snapshot.val();
        if (val && val.likes && val.likes[myName]) updateLikeButtonState(true);
        else updateLikeButtonState(false);
    });
}

// --- SEARCH ---
document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    if (query.includes('list=') || query.includes('spotify.com')) {
         showToast("System", "Playlist import not supported in this version."); input.value=''; return;
    }

    switchTab('results');
    const list = document.getElementById('results-list');
    list.innerHTML = '<div style="padding:20px; text-align:center;">Searching...</div>';
    
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        list.innerHTML = '';
        if (!data.items || !data.items.length) { list.innerHTML = '<div class="empty-state">No results.</div>'; return; }

        let delay = 0;
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'queue-item';
            div.style.animationDelay = `${delay}s`; delay += 0.05;
            
            div.innerHTML = `
                <div class="q-index"><i class="fa-solid fa-plus"></i></div>
                <img src="${item.snippet.thumbnails.default.url}" class="q-thumb">
                <div class="q-info">
                    <h4>${item.snippet.title}</h4>
                    <span class="q-tag" style="background:#333; color:#ccc;">${item.snippet.channelTitle}</span>
                </div>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { console.error(e); }
    input.value = '';
}

// --- TOASTS (Chat Bubble Style) ---
function showToast(user, text) {
    const container = document.getElementById('toast-container');
    if (container.children.length >= 3) container.removeChild(container.firstChild);

    const toast = document.createElement('div');
    toast.className = 'toast-bubble';
    
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    toast.innerHTML = `
        <div class="tb-header"><span>${user}</span><span>${time}</span></div>
        <div class="tb-content">${text}</div>
    `;
    
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.appendChild(toast);
    
    setTimeout(() => { 
        toast.style.opacity = '0'; 
        toast.style.transform = 'translateY(10px)'; 
        setTimeout(() => toast.remove(), 300); 
    }, 4000);
}

// --- PLAYER & SYNC CORE ---
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

// --- STANDARD SYNC BOILERPLATE ---
function suppressBroadcast(duration = 1000) { ignoreSystemEvents = true; clearTimeout(ignoreTimer); ignoreTimer = setTimeout(() => { ignoreSystemEvents = false; }, duration); }
function onYouTubeIframeAPIReady() { player = new YT.Player('player', { height: '100%', width: '100%', videoId: '', playerVars: { 'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin }, events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange } }); }
function onPlayerReady(event) { if (player && player.setVolume) player.setVolume(100); setInterval(heartbeatSync, 1000); setInterval(monitorSyncHealth, 2000); syncRef.once('value').then(snapshot => { const state = snapshot.val(); if(state) applyRemoteCommand(state); }); }
function detectAd() { try { const data = player.getVideoData(); if (data && data.video_id && data.video_id !== currentVideoId) return true; } catch(e) {} return false; }
function heartbeatSync() { if (player && player.getPlayerState) updatePlayPauseButton(player.getPlayerState()); if (isSwitchingSong) return; if (detectAd()) { broadcastState('ad_pause', 0, currentVideoId); updateSyncStatus(); return; } if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName && !ignoreSystemEvents) { const state = player.getPlayerState(); if (state === YT.PlayerState.PLAYING) { const duration = player.getDuration(); const current = player.getCurrentTime(); if (duration > 0 && duration - current < 1) initiateNextSong(); else broadcastState('play', current, currentVideoId); } else if (state === YT.PlayerState.PAUSED) { broadcastState('pause', player.getCurrentTime(), currentVideoId); } } }
function monitorSyncHealth() { if (!hasUserInteracted || lastBroadcaster === myName || isSwitchingSong) return; if (!player || !currentRemoteState || !player.getPlayerState) return; if (Date.now() - lastLocalInteractionTime < 2000) return; if (currentRemoteState.action === 'ad_pause' || currentRemoteState.action === 'switching_pause') return; const myState = player.getPlayerState(); if (currentRemoteState.action === 'play' || currentRemoteState.action === 'restart') { if (myState !== YT.PlayerState.PLAYING && myState !== YT.PlayerState.BUFFERING) { if (!detectAd()) { player.playVideo(); suppressBroadcast(1000); } } if (Math.abs(player.getCurrentTime() - currentRemoteState.time) > 3 && !detectAd()) { player.seekTo(currentRemoteState.time, true); suppressBroadcast(1000); } } else if (currentRemoteState.action === 'pause' && myState === YT.PlayerState.PLAYING) { player.pauseVideo(); suppressBroadcast(1000); } }
function updatePlayPauseButton(state) { const btn = document.getElementById('play-pause-btn'); if (!btn) return; if (isSwitchingSong) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; return; } if (state === YT.PlayerState.PLAYING) btn.innerHTML = '<i class="fa-solid fa-pause"></i>'; else btn.innerHTML = '<i class="fa-solid fa-play"></i>'; }
function onPlayerStateChange(event) { const state = event.data; updatePlayPauseButton(state); if (isSwitchingSong || ignoreSystemEvents) return; if (detectAd()) { lastBroadcaster = myName; broadcastState('ad_pause', 0, currentVideoId); updateSyncStatus(); return; } if (state === YT.PlayerState.PLAYING) { if(player && player.setVolume) player.setVolume(100); if (Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('play', player.getCurrentTime(), currentVideoId); } } else if (state === YT.PlayerState.PAUSED) { if (Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('pause', player.getCurrentTime(), currentVideoId); } } else if (state === YT.PlayerState.ENDED) initiateNextSong(); updateSyncStatus(); }
function togglePlayPause(e) { if (!player || isSwitchingSong) return; lastLocalInteractionTime = Date.now(); ignoreSystemEvents = false; clearTimeout(ignoreTimer); lastBroadcaster = myName; const state = player.getPlayerState(); if (state === YT.PlayerState.PLAYING) { player.pauseVideo(); broadcastState('pause', player.getCurrentTime(), currentVideoId, true); } else { if (!currentVideoId && currentQueue.length > 0) initiateSongLoad(currentQueue[0]); else if (currentVideoId) { player.setVolume(100); player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId, true); } } }
function initiateNextSong() { const idx = currentQueue.findIndex(s => s.videoId === currentVideoId); const next = currentQueue[(idx + 1) % currentQueue.length]; if (next) initiateSongLoad(next); }
function initiatePrevSong() { const idx = currentQueue.findIndex(s => s.videoId === currentVideoId); if(idx > 0) initiateSongLoad(currentQueue[idx-1]); }
function broadcastState(action, time, videoId, force = false) { if (ignoreSystemEvents && !force) return; syncRef.set({ action, time, videoId, lastUpdater: myName, timestamp: Date.now() }); }
function applyRemoteCommand(state) { if (!player) return; if (Date.now() - lastLocalInteractionTime < 1500) return; if (!hasUserInteracted && (state.action === 'play' || state.action === 'restart')) { if (state.videoId !== currentVideoId) { const songInQueue = currentQueue.find(s => s.videoId === state.videoId); const title = songInQueue ? songInQueue.title : "Syncing..."; const uploader = songInQueue ? songInQueue.uploader : ""; loadAndPlayVideo(state.videoId, title, uploader, state.time, false); } return; } suppressBroadcast(1000); lastBroadcaster = state.lastUpdater; document.getElementById('syncOverlay').classList.remove('active'); if (state.action === 'switching_pause') { player.pauseVideo(); showToast("System", "Partner is changing track..."); updateSyncStatus(); return; } if (state.videoId !== currentVideoId) { const songInQueue = currentQueue.find(s => s.videoId === state.videoId); const title = songInQueue ? songInQueue.title : "Syncing..."; const uploader = songInQueue ? songInQueue.uploader : ""; loadAndPlayVideo(state.videoId, title, uploader, state.time, false); if(state.action === 'play' || state.action === 'restart') { player.setVolume(100); player.playVideo(); } } else { if (state.action === 'restart') { player.seekTo(0, true); player.setVolume(100); player.playVideo(); } else if (state.action === 'play') { if (Math.abs(player.getCurrentTime() - state.time) > 2) player.seekTo(state.time, true); if (player.getPlayerState() !== YT.PlayerState.PLAYING) { player.setVolume(100); player.playVideo(); } } else if (state.action === 'pause' || state.action === 'ad_pause') { if (player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo(); } } updateSyncStatus(); }
function updateSyncStatus() { const msgEl = document.getElementById('sync-status-msg'); const statusText = (currentRemoteState && currentRemoteState.action === 'pause') ? `Paused by ${currentRemoteState.lastUpdater}` : (player && player.getPlayerState() === YT.PlayerState.PLAYING ? 'Vibing Together' : 'Paused'); msgEl.innerHTML = `<i class="fa-solid fa-link"></i> ${statusText}`; }

// --- INIT ---
function loadInitialData() {
    queueRef.orderByChild('order').on('value', (snapshot) => { const data = snapshot.val(); let list = []; if (data) Object.keys(data).forEach(k => list.push({ ...data[k], key: k })); list.sort((a, b) => (a.order || 0) - (b.order || 0)); currentQueue = list; renderQueue(currentQueue, currentVideoId); });
    syncRef.on('value', (snapshot) => { const state = snapshot.val(); if (state) { currentRemoteState = state; if (state.lastUpdater !== myName) applyRemoteCommand(state); else lastBroadcaster = myName; } updateSyncStatus(); });
    chatRef.limitToLast(50).on('child_added', (snapshot) => { const msg = snapshot.val(); displayChatMessage(msg.user, msg.text, msg.timestamp); if (msg.user !== myName && activeTab !== 'chat') showToast(msg.user, msg.text); });
    likedRef.on('value', (snapshot) => { renderLikedSongs(snapshot.val()); checkCurrentSongLiked(); });
}
function displayChatMessage(user, text, timestamp) { const box = document.getElementById('chat-messages'); const isMe = user === myName; const div = document.createElement('div'); div.className = `chat-msg ${isMe ? 'me' : 'them'}`; div.innerText = `${user}: ${text}`; box.appendChild(div); box.scrollTop = box.scrollHeight; }

document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', initiatePrevSong);
document.getElementById('next-btn').addEventListener('click', initiateNextSong);
document.getElementById('chatSendBtn').addEventListener('click', () => { const val = document.getElementById('chatInput').value.trim(); if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }});
document.getElementById('startSessionBtn').addEventListener('click', () => { const val = document.getElementById('welcomeNameInput').value.trim(); if(!val) return; myName = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase(); localStorage.setItem('deepSpaceUserName', myName); hasUserInteracted = true; document.getElementById('welcomeOverlay').classList.remove('active'); if(currentRemoteState && currentRemoteState.action !== 'pause') player.playVideo(); });
document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear queue?")) queueRef.remove(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => { document.getElementById('syncOverlay').classList.remove('active'); player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId); });
document.getElementById('closeLyricsBtn').addEventListener('click', () => document.getElementById('lyricsOverlay').classList.remove('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));

loadInitialData();
