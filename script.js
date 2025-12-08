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

let player, currentQueue = [], currentVideoId = null, isPartnerPlaying = false, lastBroadcaster = "System", isManualAction = false;
let myName = localStorage.getItem('deepSpaceUserName');
if (!myName) {
    myName = prompt("Enter your name (Sarthak or Reechita):") || "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
const partnerName = (myName.toLowerCase().includes("sarthak")) ? "Reechita" : "Sarthak";

// --- YOUTUBE PLAYER ---
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, // ENABLED SEEK BAR
            'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 0, 'origin': window.location.origin 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(85);
    setInterval(broadcastTimeIfPlaying, 1000);
}

function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        if (state === YT.PlayerState.PLAYING && player.getDuration() - currentTime < 1 && player.getDuration() > 0) {
            playNextSong();
            return;
        }
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
            broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function onPlayerStateChange(event) {
    const btn = document.getElementById('play-pause-btn');
    if (event.data === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        isManualAction = false;
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if ((event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) && !isPartnerPlaying && !isManualAction && lastBroadcaster === myName) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId, true);
        }
        if (event.data === YT.PlayerState.ENDED && !isPartnerPlaying) playNextSong();
    }
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player) return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false);
    } else {
        if (!currentVideoId && currentQueue.length > 0) loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        else if (currentVideoId) {
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
    isManualAction = true;
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        isManualAction = false;
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        setTimeout(() => { if(player.getPlayerState() !== YT.PlayerState.PLAYING) broadcastState('play', 0, videoId, false); }, 800);
        renderQueue(currentQueue, currentVideoId);
    }
}

// --- QUEUE & DATA LISTENERS ---
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
            lastBroadcaster = state.lastUpdater;
            if (state.lastUpdater !== myName) applyRemoteCommand(state);
        } else {
            document.getElementById('syncOverlay').classList.remove('active');
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
    });
}
loadInitialData(); // Load immediately

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, order: Date.now() })
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0) loadAndPlayVideo(videoId, title);
        });
}

function addBatchToQueue(songs) {
    if (!songs.length) return;
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, order: Date.now() + i * 100 };
    });
    queueRef.update(updates).then(() => switchTab('queue'));
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    const song = currentQueue.find(s => s.key === key);
    if (song) {
        queueRef.child(key).remove();
        if (song.videoId === currentVideoId) playNextSong();
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => { updates[`${song.key}/order`] = index; });
    queueRef.update(updates);
}

function playNextSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length];
    if (next) loadAndPlayVideo(next.videoId, next.title);
}

// --- RENDER & DRAG DROP ---
function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    document.getElementById('queue-count').textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-dim);">Queue is empty, my love.</p>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => loadAndPlayVideo(song.videoId, song.title);
        
        item.innerHTML = `
            <span class="song-number">${index + 1}.</span>
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-details"><h4>${song.title}</h4><p>${song.uploader}</p></div>
            <button class="emoji-btn" style="font-size:0.9rem;" onclick="removeFromQueue('${song.key}', event)"><i class="fa-solid fa-trash"></i></button>
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

// --- SEARCH & LINKS (RESTORED PLAYLIST LOGIC) ---
async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    // 1. YouTube Playlist
    if (query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        input.value = ''; return;
    }
    // 2. Spotify
    if (query.includes('spotify.com')) {
        fetchSpotifyData(query);
        input.value = ''; return;
    }

    // 3. Regular Search
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p style="text-align:center; padding:20px;">Searching...</p>';
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
                <button class="emoji-btn" style="color:var(--primary);"><i class="fa-solid fa-plus"></i></button>
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
            for (const t of data.tracks.slice(0, 10)) { // Limit to 10 for API quota safety
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

// --- CHAT & EMOJIS ---
function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    div.innerHTML = `<div class="msg-header">${user}</div>${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

const emojis = ['❤️','💖','🌹','😘','🥰','✨','😍','💕','💍','🧸','🌙','🔥','😂','🥺','🦋','🎶','🥂','💯'];
const picker = document.getElementById('emojiPicker');
emojis.forEach(e => {
    const s = document.createElement('div');
    s.className = 'emoji-item'; s.textContent = e;
    s.onclick = () => { document.getElementById('chatInput').value += e; picker.classList.remove('active'); }
    picker.appendChild(s);
});

// --- EVENT LISTENERS ---
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', () => {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) loadAndPlayVideo(currentQueue[idx-1].videoId, currentQueue[idx-1].title);
});
document.getElementById('next-btn').addEventListener('click', playNextSong);

document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

document.getElementById('chatSendBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }
});
document.getElementById('toggleEmojiBtn').addEventListener('click', () => picker.classList.toggle('active'));

document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));
document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear All?")) queueRef.remove(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId, false);
});
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));

// Helper
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    document.getElementById('queue-list').style.display = tab==='queue'?'block':'none';
    document.getElementById('results-list').style.display = tab==='results'?'block':'none';
}
function broadcastState(action, time, videoId, isAdStall) {
    syncRef.set({ action, time, videoId, isAdStall, lastUpdater: myName, timestamp: Date.now() });
}
function applyRemoteCommand(state) {
    if (!player || !state.videoId) return;
    isPartnerPlaying = true;
    if (state.isAdStall && state.action !== 'play') {
        document.getElementById('syncOverlay').classList.add('active');
        document.getElementById('overlayText').textContent = `${partnerName} is waiting for an ad...`;
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo();
        return;
    }
    document.getElementById('syncOverlay').classList.remove('active');
    if (state.videoId !== currentVideoId) loadAndPlayVideo(state.videoId, "Syncing...");
    else if (Math.abs(player.getCurrentTime() - state.time) > 2) player.seekTo(state.time, true);
    if (state.action === 'play' && player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
    else if (state.action === 'pause' && player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo();
}
function updateSyncStatus() {
    const msg = document.getElementById('sync-status-msg');
    if (document.getElementById('syncOverlay').classList.contains('active')) msg.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Stalled';
    else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) msg.innerHTML = `<i class="fa-solid fa-infinity"></i> Connected`;
    else msg.innerHTML = `<i class="fa-solid fa-pause"></i> Paused`;
}
