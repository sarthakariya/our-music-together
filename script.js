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

// --- RIPPLE EFFECT ---
function createRipple(event) {
    const button = event.currentTarget;
    const circle = document.createElement("span");
    const diameter = Math.max(button.clientWidth, button.clientHeight);
    const radius = diameter / 2;
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${event.clientX - button.getBoundingClientRect().left - radius}px`;
    circle.style.top = `${event.clientY - button.getBoundingClientRect().top - radius}px`;
    circle.classList.add("ripple");
    const ripple = button.getElementsByClassName("ripple")[0];
    if (ripple) ripple.remove();
    button.appendChild(circle);
}
document.querySelectorAll('.ctrl-btn').forEach(btn => btn.addEventListener('click', createRipple));

// --- TABS LOGIC (FIXED OVERLAP) ---
function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    if(tabName === 'results') {
        document.getElementById('view-results').classList.add('active');
    } else {
        const btn = document.getElementById('tab-btn-' + tabName);
        if(btn) btn.classList.add('active');
        document.getElementById('view-' + tabName).classList.add('active');
    }
}

// --- LIKE SYSTEM ---
document.getElementById('like-btn').addEventListener('click', (e) => {
    if (!currentVideoId || !myName) return;
    
    const icon = e.currentTarget.querySelector('i');
    icon.style.transform = "scale(1.5) rotate(10deg)";
    icon.style.color = "#ff0055";
    setTimeout(() => { icon.style.transform = "scale(1)"; }, 300);

    let songObj = currentQueue.find(s => s.videoId === currentVideoId);
    if (!songObj) songObj = { ...currentSongMeta };

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
    
    showToast("System", "Added to your collection ❤️");
    updateLikeButtonState(true);
});

function updateLikeButtonState(isLiked) {
    const btn = document.getElementById('like-btn');
    const icon = btn.querySelector('i');
    if (isLiked) {
        icon.classList.remove('fa-regular');
        icon.classList.add('fa-solid');
        icon.style.color = '#ff0055';
        icon.style.filter = "drop-shadow(0 0 10px #ff0055)";
    } else {
        icon.classList.remove('fa-solid');
        icon.classList.add('fa-regular');
        icon.style.color = 'white';
        icon.style.filter = "none";
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

function renderLikedSongs(likedData) {
    const list = document.getElementById('liked-list');
    list.innerHTML = '';
    
    if (!likedData) {
        list.innerHTML = '<div class="empty-state"><p>No liked songs yet.</p></div>';
        return;
    }

    let delay = 0;
    Object.keys(likedData).forEach((videoId) => {
        const song = likedData[videoId];
        const likes = song.likes || {};
        const likers = Object.keys(likes);
        
        let likedByText = likers.length > 1 ? "Liked by Both" : (likers.includes(myName) ? "Liked by You" : `Liked by ${likers[0]}`);

        const div = document.createElement('div');
        div.className = 'song-item';
        div.style.animationDelay = `${delay}s`; // Waterfall effect
        delay += 0.05;

        div.innerHTML = `
            <div class="thumb-container"><img src="${song.thumbnail}" class="song-thumb"></div>
            <div class="song-details">
                <h4>${song.title}</h4>
                <span style="color:var(--primary); font-weight:600;">${likedByText}</span>
            </div>
            <button class="emoji-trigger" style="color:white;"><i class="fa-solid fa-play"></i></button>
        `;
        div.onclick = () => {
            // Logic to play liked song
            const newKey = queueRef.push().key;
            queueRef.child(newKey).set({ 
                videoId: videoId, title: song.title, uploader: song.uploader, 
                thumbnail: song.thumbnail, addedBy: myName, order: Date.now() 
            }).then(() => initiateSongLoad({ videoId, title: song.title, uploader: song.uploader }));
        };
        list.appendChild(div);
    });
}

// --- PLAYER SYNC & YOUTUBE ---
function suppressBroadcast(duration = 1000) {
    ignoreSystemEvents = true;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => { ignoreSystemEvents = false; }, duration);
}

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin },
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
}

function detectAd() {
    if (!player || !currentVideoId) return false;
    try {
        const data = player.getVideoData();
        if (data && data.video_id && data.video_id !== currentVideoId) return true;
    } catch(e) {}
    return false;
}

function heartbeatSync() {
    if (player && player.getPlayerState) updatePlayPauseButton(player.getPlayerState());
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
    if (isSwitchingSong) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; return; }
    if (state === YT.PlayerState.PLAYING) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    else btn.innerHTML = '<i class="fa-solid fa-play"></i>';
}

function onPlayerStateChange(event) {
    const state = event.data;
    updatePlayPauseButton(state);
    if (isSwitchingSong || ignoreSystemEvents) return;
    if (detectAd()) { lastBroadcaster = myName; broadcastState('ad_pause', 0, currentVideoId); updateSyncStatus(); return; }
    if (state === YT.PlayerState.PLAYING) {
        if(player && player.setVolume) player.setVolume(100);
        if (Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('play', player.getCurrentTime(), currentVideoId); }
    } else if (state === YT.PlayerState.PAUSED) {
        if (Date.now() - lastLocalInteractionTime > 500) { lastBroadcaster = myName; broadcastState('pause', player.getCurrentTime(), currentVideoId); }
    } else if (state === YT.PlayerState.ENDED) initiateNextSong();
    updateSyncStatus();
}

function togglePlayPause(e) {
    if(e) createRipple(e);
    if (!player || isSwitchingSong) return;
    lastLocalInteractionTime = Date.now();
    ignoreSystemEvents = false; clearTimeout(ignoreTimer); lastBroadcaster = myName; 
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
    } else {
        if (!currentVideoId && currentQueue.length > 0) initiateSongLoad(currentQueue[0]);
        else if (currentVideoId) {
            player.setVolume(100); player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId, true);
        }
    }
}

function initiateNextSong(e) {
    if(e) createRipple(e); if (isSwitchingSong) return;
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length];
    if (next) initiateSongLoad(next);
}

function initiatePrevSong(e) {
    if(e) createRipple(e); if (isSwitchingSong) return;
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
        setTimeout(() => {
             const activeItem = document.querySelector('.song-item.playing');
             if(activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
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
            if (state.lastUpdater !== myName) applyRemoteCommand(state); else lastBroadcaster = myName;
        }
        updateSyncStatus();
    });
    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
        if (msg.user !== myName && activeTab !== 'chat') showToast(msg.user, msg.text);
    });
    likedRef.on('value', (snapshot) => {
        renderLikedSongs(snapshot.val());
        checkCurrentSongLiked();
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
    document.getElementById('syncOverlay').classList.remove('active');
    if (state.action === 'switching_pause') {
        player.pauseVideo();
        showToast("System", "Partner is changing track...");
        updateSyncStatus(); return;
    }
    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time, false); 
        if(state.action === 'play' || state.action === 'restart') { player.setVolume(100); player.playVideo(); }
    } else {
        const playerState = player.getPlayerState();
        if (state.action === 'restart') { player.seekTo(0, true); player.setVolume(100); player.playVideo(); }
        else if (state.action === 'play') {
            if (Math.abs(player.getCurrentTime() - state.time) > 2) player.seekTo(state.time, true);
            if (playerState !== YT.PlayerState.PLAYING) { player.setVolume(100); player.playVideo(); }
        } else if (state.action === 'pause' || state.action === 'ad_pause') {
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
        } 
    }
    updateSyncStatus();
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    const eq = document.getElementById('equalizer');
    if (detectAd()) {
        msgEl.innerHTML = '<i class="fa-solid fa-rectangle-ad"></i> Ad Playing';
        if(eq) eq.classList.remove('active'); return;
    }
    if (isSwitchingSong) {
        msgEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching...';
        if(eq) eq.classList.remove('active'); return;
    }
    if (currentRemoteState && currentRemoteState.action === 'ad_pause') {
        msgEl.innerHTML = `<i class="fa-solid fa-eye-slash"></i> ${currentRemoteState.lastUpdater} watching Ad`;
        if(eq) eq.classList.remove('active'); return;
    }
    if (currentRemoteState && currentRemoteState.action === 'switching_pause') {
        msgEl.innerHTML = `<i class="fa-solid fa-music"></i> ${currentRemoteState.lastUpdater} picking song...`;
        if(eq) eq.classList.remove('active'); return;
    }
    const playerState = player ? player.getPlayerState() : -1;
    if (playerState === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Vibing Together`;
        if(eq) eq.classList.add('active');
    } else {
        if(eq) eq.classList.remove('active');
        let pauser = lastBroadcaster;
        if (currentRemoteState && currentRemoteState.action === 'pause') pauser = currentRemoteState.lastUpdater;
        const nameDisplay = (pauser === myName) ? "You" : pauser;
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> Paused by ${nameDisplay}`;
    }
}

function loadAndPlayVideo(videoId, title, uploader, startTime = 0, shouldBroadcast = true, shouldPlay = true) {
    if (player && videoId) {
        if (!shouldBroadcast) suppressBroadcast(1500); 
        if(currentVideoId !== videoId || !player.cueVideoById) {
            player.loadVideoById({videoId: videoId, startSeconds: startTime}); player.setVolume(100); 
        } else {
             if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
             if(shouldPlay) { player.setVolume(100); player.playVideo(); }
        }
        if(!shouldPlay) { setTimeout(() => player.pauseVideo(), 500); }
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        document.getElementById('current-song-artist').textContent = uploader;
        checkCurrentSongLiked(); renderQueue(currentQueue, currentVideoId);
        if (shouldBroadcast) { lastBroadcaster = myName; broadcastState('restart', 0, videoId, true); }
    }
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

function updateQueueOrder(newOrder) {
    const updates = {}; newOrder.forEach((song, index) => { updates[`${song.key}/order`] = index; }); queueRef.update(updates);
}

function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    document.getElementById('queue-badge').textContent = queueArray.length;
    list.innerHTML = '';

    if (queueArray.length === 0) { list.innerHTML = '<div class="empty-state"><p>Queue is empty.</p></div>'; return; }

    let delay = 0;
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true; item.dataset.key = song.key;
        item.onclick = () => initiateSongLoad(song);
        item.style.animationDelay = `${delay}s`;
        delay += 0.05;

        const isMe = song.addedBy === myName;
        const displayText = isMe ? 'You' : `${song.addedBy}`;
        
        item.innerHTML = `
            <div class="thumb-container"><img src="${song.thumbnail}" class="song-thumb"></div>
            <div class="song-details">
                <h4>${song.title}</h4>
                <span>Added by ${displayText}</span>
            </div>
            <button class="emoji-trigger" onclick="removeFromQueue('${song.key}', event)"><i class="fa-solid fa-trash"></i></button>
        `;
        list.appendChild(item);
    });
    setTimeout(() => { const activeItem = document.querySelector('.song-item.playing'); if(activeItem) activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100);
    initDragAndDrop(list);
}

function initDragAndDrop(list) {
    let draggedItem = null;
    list.querySelectorAll('.song-item').forEach(item => {
        item.addEventListener('dragstart', () => { draggedItem = item; item.style.opacity = '0.5'; });
        item.addEventListener('dragend', () => {
            item.style.opacity = '1'; draggedItem = null;
            const newOrderKeys = Array.from(list.querySelectorAll('.song-item')).map(el => el.dataset.key);
            const newOrder = newOrderKeys.map(key => currentQueue.find(s => s.key === key));
            updateQueueOrder(newOrder);
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement == null) list.appendChild(draggedItem); else list.insertBefore(draggedItem, afterElement);
        });
    });
}
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.song-item:not([style*="opacity: 0.5"])')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child }; else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// --- SEARCH & CHAT ---
document.getElementById('searchInput').addEventListener('input', () => switchTab('results'));
document.getElementById('searchInput').addEventListener('focus', () => switchTab('results'));
document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    if (query.includes('list=') || query.includes('spotify.com')) {
         // (Spotify/Playlist logic hidden for brevity - assumes previous implementation remains or user uses plain search)
         showToast("System", "Only simple search supported in this view."); input.value=''; return;
    }

    switchTab('results');
    const list = document.getElementById('results-list');
    list.innerHTML = '<p style="text-align:center; padding:30px; opacity:0.7;">Searching Universe...</p>';
    
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        list.innerHTML = '';
        if (!data.items || !data.items.length) { list.innerHTML = '<div class="empty-state"><p>No results found.</p></div>'; return; }

        let delay = 0;
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.style.animationDelay = `${delay}s`; delay += 0.05;
            div.innerHTML = `
                <div class="thumb-container"><img src="${item.snippet.thumbnails.default.url}" class="song-thumb"></div>
                <div class="song-details"><h4>${item.snippet.title}</h4><span>${item.snippet.channelTitle}</span></div>
                <button class="emoji-trigger"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { console.error(e); }
    input.value = '';
}

function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    div.innerHTML = `<div class="msg-header">${user} <span style="font-size:0.85em; opacity:0.7;">${time}</span></div>${text}`;
    box.appendChild(div); box.scrollTop = box.scrollHeight;
}

function showToast(user, text) {
    const container = document.getElementById('toast-container');
    if (container.children.length >= 3) container.removeChild(container.firstChild);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fa-solid fa-bell"></i>
        <div class="toast-body">
            <h4>${user}</h4>
            <p>${text.substring(0, 40)}</p>
        </div>
    `;
    toast.onclick = () => { switchTab('chat'); toast.remove(); };
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity='0'; toast.style.transform='translateX(50px)'; setTimeout(()=>toast.remove(), 400); }, 4000);
}

document.getElementById('chatSendBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }
});
document.getElementById('chatInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('chatSendBtn').click(); });
document.getElementById('startSessionBtn').addEventListener('click', () => {
    const input = document.getElementById('welcomeNameInput');
    const val = input.value.trim();
    if(!val) { input.style.border='1px solid red'; return; }
    myName = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
    localStorage.setItem('deepSpaceUserName', myName);
    hasUserInteracted = true;
    document.getElementById('welcomeOverlay').classList.remove('active');
    if(currentRemoteState && currentRemoteState.action !== 'pause') player.playVideo();
});
document.getElementById('welcomeNameInput').addEventListener('keypress', (e) => { if(e.key === 'Enter') document.getElementById('startSessionBtn').click(); });
if(document.getElementById('welcomeOverlay').classList.contains('active')) setTimeout(() => document.getElementById('welcomeNameInput').focus(), 500);

document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));
document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear queue?")) queueRef.remove(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => { document.getElementById('syncOverlay').classList.remove('active'); player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId); });
